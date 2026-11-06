/**
 * The host side of the dependents proposal (#109): reads the project's restore
 * graph, asks the feed what each dependent's versions declare, runs the walk,
 * and keeps the last few answers so a page can be opened on one of them.
 *
 * Kept out of the message broker, which is already 4,500 lines: the broker only
 * routes. Everything this needs from outside comes in through
 * {@link CascadeServiceDeps}.
 */

import { findLibrary, parseEdgeTable, type AssetsTarget } from './assetsEdgeTable';
import * as path from 'path';
import type { INuGetBackend } from './backend/INuGetBackend';
import {
  computeCascade,
  movesOf,
  type CascadeScope,
  type CascadeMode,
  type CascadeResult,
  type PackageVersions,
  type UnknownReason,
  type VersionsAnswer,
  type VersionsLookup,
} from './dependentCascade';
import { frameworkKey } from './frameworkMoniker';
import { MAX_REGISTRATION_PAGES } from './nugetVersionLadder';
import { sortTargetFrameworksDesc } from './targetFrameworks';
import { packageIdKey, pathsEqual } from './pathCompare';
import type { VersionFlag } from './types';
import type { ReleaseNotesLink } from './packageLinks';
import { runWithConcurrency } from './concurrency';
import type { CascadeNode } from './cascadeResult';

export interface CascadeRequest {
  requestId: string;
  packageId: string;
  fromVersion: string;
  toVersion: string;
  projectPath: string;
  /** Every framework the project references this package under; empty means every target in the file. */
  frameworks: string[];
  mode: CascadeMode;
  prerelease: boolean;
  configFiles: string[];
}

export interface CascadeAnswer {
  /** `null` when there is no restore graph to walk; `unavailable` says why. */
  result: CascadeResult | null;
  unavailable?: string;
}

export interface CascadeServiceDeps {
  backend: INuGetBackend;
  /** One row on the Log tab: the package, the source and the rung that declined go here. */
  log: (command: string, args: string[], kind?: 'info' | 'error') => void;
  readAssets: (projectPath: string) => Promise<unknown | null>;
  /** The packages a project references itself, for a restore file that does not say. */
  directIdsOf: (projectPath: string) => string[];
  /**
   * Whether updates to this id are blocked. A batch silently skips a blocked
   * package, so proposing it would write half a closure and leave the break
   * the proposal exists to prevent.
   */
  isBlocked?: (packageId: string) => boolean;
  /**
   * The proposed version's release-notes link, for the page's detail pane. It
   * costs a nuspec per dependent, so it is read after the walk, a few at a time,
   * and only until `releaseNotesBudgetMs` is spent.
   */
  releaseNotesFor?: (packageId: string, version: string, configFiles: string[], signal?: AbortSignal) => Promise<ReleaseNotesLink | undefined>;
  releaseNotesBudgetMs?: number;
  /**
   * The version the project restored for this reference now, when it is still
   * referenced. A page asks again after the world has moved on, and the same
   * question with the old `fromVersion` would describe a step already taken.
   */
  installedVersionOf?: (packageId: string, projectPath: string) => string | undefined;
  /**
   * When the project's versions are held centrally, the props file and every
   * project beneath it that references the package. Under central package
   * management one version governs all of them, so a write moves them all.
   */
  centralSet?: (projectPath: string, packageId: string) => Promise<{ propsFile: string; projects: string[] } | null>;
}

/** A lookup that asks the feed once per package however many walks reach it. */
function memoised(lookup: VersionsLookup): VersionsLookup {
  const answers = new Map<string, Promise<VersionsAnswer>>();
  return (id) => {
    const key = packageIdKey(id);
    let answer = answers.get(key);
    if (!answer) {
      answer = lookup(id);
      answers.set(key, answer);
    }
    return answer;
  };
}

/** How many answers are held for a page to be opened on. */
const KEPT = 8;

export class DependentCascadeService {
  private readonly _kept = new Map<string, CascadeRequest & { result: CascadeResult }>();

  constructor(private readonly _deps: CascadeServiceDeps) {}

  /** The request and result a page was asked to show, or undefined once it has been forgotten. */
  recall(requestId: string): (CascadeRequest & { result: CascadeResult }) | undefined {
    return this._kept.get(requestId);
  }

  async check(request: CascadeRequest, signal?: AbortSignal): Promise<CascadeAnswer> {
    const assets = await this._deps.readAssets(request.projectPath);
    if (!assets) {
      this._deps.log(
        `Dependents of ${request.packageId}: no restore graph`,
        [`project: ${request.projectPath}`, 'obj/project.assets.json is missing or unreadable — restore the project first'],
      );
      return { result: null, unavailable: 'the project has no restore graph yet — restore it first' };
    }

    const set = await this._deps.centralSet?.(request.projectPath, request.packageId);
    if (set && set.projects.length > 1) return this._checkCentral(request, assets, set, signal);

    const table = parseEdgeTable(assets);
    // One memo for every framework of the project: a package reached under two of
    // them is read from the feed once, not once per framework.
    const lookup = memoised(this._lookup(request, signal));
    const frameworks = sortTargetFrameworksDesc(
      request.frameworks.length > 0 ? request.frameworks : table.targets.map((t) => t.framework),
    );
    const results: CascadeResult[] = [];
    for (const framework of frameworks) {
      const target = table.targets.find((t) => frameworkKey(t.framework) === frameworkKey(framework));
      if (!target) continue;
      results.push(await computeCascade({
        target,
        directIds: this._directIds(target, request.projectPath),
        packageId: request.packageId,
        fromVersion: request.fromVersion,
        toVersion: request.toVersion,
        projectPath: request.projectPath,
        mode: request.mode,
        includePrerelease: request.prerelease,
        lookup,
      }));
    }
    if (results.length === 0) {
      return { result: null, unavailable: `the restore graph has no target for ${frameworks.join(', ') || 'this project'}` };
    }

    const chosen = results.find((r) => r.outcome !== 'clear') ?? results[0];
    const signature = (r: CascadeResult): string => JSON.stringify([r.outcome, movesOf(r)]);
    const differing = results
      .filter((r) => r !== chosen && r.outcome !== 'clear' && signature(r) !== signature(chosen))
      .map((r) => r.framework);
    const result: CascadeResult = differing.length > 0 ? { ...chosen, otherFrameworks: differing } : chosen;

    this._deps.log(
      `Dependents of ${request.packageId} ${request.fromVersion} → ${request.toVersion}: ${result.outcome}`,
      [
        `project: ${request.projectPath}`,
        `framework: ${result.framework}${differing.length ? ` (differs for ${differing.join(', ')})` : ''}`,
        `mode: ${request.mode}`,
        `${result.moves} to move, ${result.unknowns} could not be established, ${result.leftOut} left out`,
      ],
    );
    this._keep(request, result);
    return { result };
  }

  /**
   * A version held centrally governs every framework of every project beneath
   * the props file, so there is one closure for the whole set, not a choice among
   * the frameworks of one project. Every (project, framework) pair contributes
   * its edges, its floors and the places a package can be required; the walk
   * asks the feed once per package however many projects reach it.
   *
   * A project that references the package but has no restore graph cannot be
   * judged. It stays in the answer as a row of its own — the rest of the answer
   * stands, and it is incomplete, which is told, not hidden.
   */
  private async _checkCentral(
    request: CascadeRequest,
    primaryAssets: unknown,
    set: { propsFile: string; projects: string[] },
    signal?: AbortSignal,
  ): Promise<CascadeAnswer> {
    const ordered = [request.projectPath, ...set.projects.filter((p) => !pathsEqual(p, request.projectPath))];
    const read = await Promise.all(ordered.map(async (projectPath) => ({
      projectPath,
      assets: pathsEqual(projectPath, request.projectPath) ? primaryAssets : await this._deps.readAssets(projectPath),
    })));

    const scopes: CascadeScope[] = [];
    const notRestored: string[] = [];
    for (const { projectPath, assets } of read) {
      if (!assets) {
        notRestored.push(projectPath);
        continue;
      }
      const table = parseEdgeTable(assets);
      const order = sortTargetFrameworksDesc(table.targets.map((t) => t.framework));
      const targets = order
        .map((framework) => table.targets.find((t) => frameworkKey(t.framework) === frameworkKey(framework)))
        .filter((t): t is AssetsTarget => !!t);
      for (const target of targets) {
        // Only a graph that holds the package is a place the version is used.
        if (!findLibrary(target, request.packageId)) continue;
        scopes.push({ projectPath, target, directIds: this._directIds(target, projectPath) });
      }
    }
    if (scopes.length === 0) {
      return { result: null, unavailable: 'none of the projects that use this version has a restore graph that holds it — restore them first' };
    }

    const primary = scopes.find((s) => pathsEqual(s.projectPath, request.projectPath)) ?? scopes[0];
    const others = scopes.filter((s) => s !== primary);
    const result = await computeCascade({
      target: primary.target,
      directIds: primary.directIds,
      others,
      packageId: request.packageId,
      fromVersion: request.fromVersion,
      toVersion: request.toVersion,
      projectPath: primary.projectPath,
      mode: request.mode,
      includePrerelease: request.prerelease,
      lookup: this._lookup(request, signal),
    });

    // A project that could not be judged is a row of its own, so the answer says
    // which part of the set it does not cover.
    for (const projectPath of notRestored) {
      const name = path.basename(projectPath).replace(/\.(cs|fs|vb)proj$/i, '');
      result.root.children.push({
        id: name, installedVersion: '', parentId: result.root.id, status: 'unknown', project: true,
        projects: [projectPath], children: [],
        reason: {
          code: 'not-restored', label: 'not restored',
          detail: 'it references the package but has not been restored, so it has no restore graph',
        },
      });
      result.unknowns += 1;
    }
    if (notRestored.length > 0 && result.outcome === 'clear') result.outcome = 'unknown';

    const walked = [...new Set(scopes.map((s) => s.projectPath))];
    result.central = {
      propsFile: set.propsFile,
      projects: [...walked, ...notRestored],
      frameworks: [...new Set(scopes.map((s) => s.target.framework))],
    };

    this._deps.log(
      `Dependents of ${request.packageId} ${request.fromVersion} → ${request.toVersion}: ${result.outcome} (central, ${result.central.projects.length} projects)`,
      [
        `props: ${set.propsFile}`,
        `projects: ${walked.join(', ')}`,
        ...(notRestored.length > 0 ? [`not restored: ${notRestored.join(', ')}`] : []),
        `mode: ${request.mode}`,
        `${result.moves} to move, ${result.unknowns} could not be established, ${result.leftOut} left out`,
      ],
    );
    this._keep(request, result);
    return { result };
  }

  /**
   * The same question asked again, from where the project stands now (#109).
   * Used by the page's Recompute: it is offered when the panel has moved on, and
   * a write that landed in the meantime changed the version the closure starts
   * from. A reference that is gone, or already on the target, has nothing left
   * to move and answers as clear.
   */
  async recheck(requestId: string, signal?: AbortSignal): Promise<CascadeAnswer | undefined> {
    const kept = this._kept.get(requestId);
    if (!kept) return undefined;
    const { result: _previous, ...request } = kept;
    const installed = this._deps.installedVersionOf?.(request.packageId, request.projectPath);
    return this.check({ ...request, fromVersion: installed ?? request.fromVersion }, signal);
  }

  /**
   * Gives each dependent that moves the link to its proposed version's release
   * notes, on the answer the service kept for `requestId`. Best effort and
   * bounded: only the page shows these links, so they are read when it opens and
   * never before — a popup that interrupts a write should not wait for them. A
   * pane that lacks a link is a pane that lacks a link, not a failed check.
   *
   * Returns the kept result, or `undefined` when it was forgotten or there was
   * nothing to read.
   */
  async attachReleaseNotes(requestId: string, signal?: AbortSignal): Promise<CascadeResult | undefined> {
    const kept = this._kept.get(requestId);
    const lookup = this._deps.releaseNotesFor;
    if (!kept || !lookup) return undefined;
    const { result, configFiles } = kept;
    const nodes: CascadeNode[] = [];
    const walk = (node: CascadeNode): void => {
      if (node !== result.root && node.status === 'moves' && node.proposedVersion) nodes.push(node);
      node.children.forEach(walk);
    };
    walk(result.root);
    if (nodes.length === 0 || nodes.every((n) => n.releaseNotes)) return undefined;

    const work = runWithConcurrency(nodes.map((node) => async () => {
      try {
        node.releaseNotes ??= await lookup(node.id, node.proposedVersion!, configFiles, signal);
      } catch {
        /* a missing link is not a failed check */
      }
    }), 4);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this._deps.releaseNotesBudgetMs ?? 6000);
    });
    await Promise.race([work, budget]);
    if (timer) clearTimeout(timer);
    return result;
  }

  private _keep(request: CascadeRequest, result: CascadeResult): void {
    this._kept.set(request.requestId, { ...request, result });
    while (this._kept.size > KEPT) this._kept.delete(this._kept.keys().next().value as string);
  }

  private _directIds(target: AssetsTarget, projectPath: string): Set<string> {
    if (target.directIds.size > 0) return target.directIds;
    return new Set(this._deps.directIdsOf(projectPath).map(packageIdKey));
  }

  /**
   * What the feed says about a dependent's versions — or, when it cannot say,
   * why. The reason matters more than the fact: a refused credential and a
   * registration past the page cap are different things to do something about,
   * and both are different from a dependent that was checked and found to have
   * no version that fits (which is a dead end, and decided elsewhere).
   */
  private _lookup(request: CascadeRequest, signal?: AbortSignal): VersionsLookup {
    return async (packageId: string): Promise<VersionsAnswer> => {
      if (this._deps.isBlocked?.(packageId)) {
        return this._unknown(packageId, {
          code: 'blocked', label: 'updates blocked',
          detail: `updates to ${packageId} are blocked in this workspace; unblock it from the right-click menu on its row to include it`,
        });
      }
      try {
        const { versions, versionFlags } = await this._deps.backend.getAllVersions(
          packageId, request.configFiles, request.prerelease, signal,
        );
        const flags: PackageVersions['flags'] = {};
        for (const [version, flag] of Object.entries(versionFlags)) {
          const f = flag as VersionFlag;
          flags[version] = {
            vulnerable: f.vulnerable, deprecation: f.deprecation, listed: f.listed,
            declaredDependencies: f.declaredDependencies,
          };
        }
        const dependencyData = versions.some((v) => flags[v]?.declaredDependencies);
        if (!dependencyData) {
          const { reason, notes } = this._explainMissingData(packageId);
          return this._unknown(packageId, reason, 'info', notes);
        }
        return { kind: 'ok', info: { versions, flags } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return this._unknown(packageId, {
          code: 'unreachable', label: 'could not be read', detail: `its versions could not be read (${message}; versions lookup)`,
        }, 'error');
      }
    };
  }

  /**
   * The reason as the page says it — a label for the row, one plain clause for
   * the pane — and, apart from it, what only the Log carries: the source and the
   * step that gave up.
   */
  private _explainMissingData(packageId: string): { reason: UnknownReason; notes: string[] } {
    const decline = this._deps.backend.catalogDecline?.(packageId);
    if (decline) {
      const status = decline.status === undefined ? '' : ` (${decline.status})`;
      const notes = [`source: ${decline.source}`, `step: ${decline.rung} rung — ${decline.detail}`];
      switch (decline.code) {
        case 'registration-too-large':
          return {
            reason: {
              code: decline.code, label: 'registration too large',
              detail: `its registration lists more than ${MAX_REGISTRATION_PAGES} pages, so its versions were not read`,
            },
            notes,
          };
        case 'credential-refused':
          return {
            reason: {
              code: decline.code, label: `credential refused${status}`,
              detail: `${decline.source} refused the credential${status}`,
            },
            notes,
          };
        default:
          return { reason: { code: decline.code, label: 'feed error', detail: decline.detail }, notes };
      }
    }
    return {
      reason: {
        code: 'no-dependency-data',
        label: 'no dependency data',
        detail: `its feed did not say what any version of ${packageId} depends on (no registration answered)`,
      },
      notes: [],
    };
  }

  private _unknown(packageId: string, reason: UnknownReason, kind: 'info' | 'error' = 'info', notes: string[] = []): VersionsAnswer {
    this._deps.log(
      `Dependents: ${reason.code === 'blocked' ? 'left out' : 'could not establish'} ${packageId} — ${reason.label}`,
      [`package: ${packageId}`, reason.detail, ...notes],
      kind,
    );
    return { kind: 'unknown', reason };
  }
}
