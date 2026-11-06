/**
 * The dependents that have to move with a bump (#109).
 *
 * Bumping a package can leave another installed package built against the old
 * one: `RabbitMQ.Client` 6.8.1 → 7.2.2 satisfies every range NuGet checks, and
 * `EasyNetQ` 7.8.0, built against the 6.x client, breaks at runtime. The answer
 * the person needs is one line — `EasyNetQ` has to go to 8.1.1 — and this module
 * computes it: the reverse walk over the restore graph, and for each dependent
 * the version closest to where it already sits among those that admit the
 * target.
 *
 * Everything here is pure. What the feed says about a package's versions comes
 * in through {@link VersionsLookup}, so the walk can be tested without a network
 * and the host can decide where the answer is read from.
 */

import { dependentsOf, findLibrary, floorsOn, type AssetsLibrary, type AssetsTarget } from './assetsEdgeTable';
import { frameworkKey } from './frameworkMoniker';
import { pathsEqual } from './pathCompare';
import { selectCompatibleGroup } from './frameworkCompatibility';
import { versionDependencyDiff } from './packageVersionDiff';
import { classifyDependencyRow, parseNuGetVersionRange, versionSatisfiesRange } from './packageVersionRanges';
import { packageIdKey, packageIdsEqual } from './pathCompare';
import { compareSemVer, isPrerelease, versionsEqual } from './semver';
import type { DeclaredDependencyGroup } from './types';
import {
  type CascadeConstraint,
  type CascadeMode,
  type CascadeNode,
  type CascadeOutcome,
  type CascadeResult,
  type UnknownCode,
  type UnknownReason,
  type WindowEntry,
} from './cascadeResult';

export {
  CASCADE_POPUP_ROWS,
  impliedCount,
  isLargeClosure,
  movesOf,
  type CascadeMode,
  type CascadeNode,
  type CascadeNodeStatus,
  type CascadeOutcome,
  type CascadeResult,
  type UnknownCode,
  type UnknownReason,
  type WindowEntry,
} from './cascadeResult';

/** The walk is guarded in both directions; neither has a job in the presentation. */
export const CASCADE_MAX_DEPTH = 10;
export const CASCADE_MAX_PACKAGES = 200;
/** How many versions a dependent's window shows on the page. */
const WINDOW_VERSIONS_SHOWN = 60;

export interface VersionFlagForCascade {
  vulnerable?: boolean;
  deprecation?: string;
  listed?: boolean;
  declaredDependencies?: DeclaredDependencyGroup[];
}

export interface PackageVersions {
  versions: string[];
  flags: Record<string, VersionFlagForCascade | undefined>;
  sourceName?: string;
}

export type VersionsAnswer =
  | { kind: 'ok'; info: PackageVersions }
  | { kind: 'unknown'; reason: UnknownReason };

/** What the feed says about every version of one package, or why it could not say. */
export type VersionsLookup = (packageId: string) => Promise<VersionsAnswer>;

/** One project's restore graph for one framework — a place a package can be, and be required. */
export interface CascadeScope {
  projectPath: string;
  target: AssetsTarget;
  /** Ids (as {@link packageIdKey}) the project references directly. */
  directIds: ReadonlySet<string>;
}

export interface CascadeInput {
  target: AssetsTarget;
  /** Ids (as {@link packageIdKey}) the project references directly. */
  directIds: ReadonlySet<string>;
  /**
   * More (project, framework) pairs under the same central version. Under
   * central package management one `PackageVersion` governs every framework of
   * every project beneath it, so the answer is one closure that has to restore
   * in all of them at once — the union of the pairs, not a choice among them.
   */
  others?: CascadeScope[];
  packageId: string;
  fromVersion: string;
  toVersion: string;
  projectPath: string;
  mode: CascadeMode;
  /** A pre-release is only ever proposed when the toggle is on. */
  includePrerelease: boolean;
  lookup: VersionsLookup;
}

const scopesOf = (input: CascadeInput): CascadeScope[] => [
  { projectPath: input.projectPath, target: input.target, directIds: input.directIds },
  ...(input.others ?? []),
];

/** The frameworks of all the scopes, once each — a version has to serve every one. */
function frameworksOf(scopes: CascadeScope[]): string[] {
  const out: string[] = [];
  for (const { target } of scopes) {
    if (!out.some((f) => frameworkKey(f) === frameworkKey(target.framework))) out.push(target.framework);
  }
  return out;
}

const isMulti = (scopes: CascadeScope[]): boolean =>
  scopes.some((s) => !pathsEqual(s.projectPath, scopes[0].projectPath));

const isDirect = (scopes: CascadeScope[], id: string): boolean =>
  scopes.some((s) => s.directIds.has(packageIdKey(id)));

const uniquePaths = (paths: string[]): string[] => {
  const out: string[] = [];
  for (const p of paths) if (!out.some((o) => pathsEqual(o, p))) out.push(p);
  return out;
};

/** Where a row is: the projects that hold it, and one that references it directly, for the write. */
function placeOf(scopes: CascadeScope[], id: string, holding: string[]): { projects?: string[]; writeIn?: string } {
  if (!isMulti(scopes)) return {};
  const direct = scopes.find((s) => s.directIds.has(packageIdKey(id)) && findLibrary(s.target, id));
  return { projects: uniquePaths(holding), writeIn: direct?.projectPath };
}

/** Every package that declares an edge to `id` in any scope, with where and at what version it sits. */
function dependentsAcross(
  scopes: CascadeScope[],
  id: string,
): Array<{ library: AssetsLibrary; edges: Array<{ range: string; version: string; project: string }> }> {
  const merged = new Map<string, { library: AssetsLibrary; edges: Array<{ range: string; version: string; project: string }> }>();
  for (const scope of scopes) {
    for (const dependent of dependentsOf(scope.target, id)) {
      const key = packageIdKey(dependent.library.id);
      const entry = merged.get(key) ?? { library: dependent.library, edges: [] };
      entry.edges.push({ range: dependent.range, version: dependent.library.version, project: scope.projectPath });
      merged.set(key, entry);
    }
  }
  return [...merged.values()];
}

/**
 * Whether a package that declares `range` for the package now going to
 * `version` has to move.
 *
 * Out of range is a restore warning in both modes; a bare minimum the version
 * crosses by a major is the quiet case, and only counts when it was asked for.
 */
export function rangeForcesMove(range: string, version: string, mode: CascadeMode): boolean {
  if (!versionSatisfiesRange(version, parseNuGetVersionRange(range))) return true;
  return mode === 'asked' && classifyDependencyRow(range, version).status === 'major-lifted';
}

const reason = (code: UnknownCode, label: string, detail: string): UnknownReason => ({ code, label, detail });

function flagOf(flag: VersionFlagForCascade | undefined): 'deprecated' | 'vulnerable' | undefined {
  if (flag?.vulnerable) return 'vulnerable';
  if (flag?.deprecation) return 'deprecated';
  return undefined;
}

/** What one version declares for `parentId` under `framework`: undefined range = no such dependency. */
function declaredFor(
  flag: VersionFlagForCascade | undefined,
  framework: string,
  parentId: string,
): { usable: boolean; range?: string; unstated?: boolean } {
  const groups = flag?.declaredDependencies;
  // The feed said nothing about this version's dependencies: not a claim either way.
  // Not a statement that the version has no dependencies: a registration entry
  // that carries no `dependencyGroups` key may be a package with none, or a feed
  // that did not say. Told apart from "no group serves this framework", which is
  // a statement, because only the latter can rule a version out.
  if (!groups) return { usable: false, unstated: true };
  const group = selectCompatibleGroup(groups, framework);
  // The version declares groups and none of them serves this framework: it would not restore here.
  if (!group) return { usable: false };
  const dep = group.dependencies.find((d) => packageIdsEqual(d.id, parentId));
  return { usable: true, range: dep?.range ?? (dep ? '0.0.0' : undefined) };
}

/**
 * One package's new version declaring a range for another (`by` at `byVersion`
 * declares `id` in `range`): the other has to end up inside it. Found by the
 * forward step, and fed back into the next pass of the walk.
 */
interface Requirement {
  id: string;
  by: string;
  byVersion: string;
  range: string;
  /** Under a central version, the projects the mover is in. */
  projects?: string[];
}

const sameRequirement = (a: Requirement, b: Requirement): boolean =>
  packageIdsEqual(a.id, b.id) && packageIdsEqual(a.by, b.by) && versionsEqual(a.byVersion, b.byVersion) && a.range === b.range;

/** What binds the version of one row: the edge it hangs from, what movers require of it, and what stays put. */
interface Spec {
  /** A dependent: its version must declare a range for the package it hangs from that admits the one that package goes to. */
  parent?: { id: string; version: string; projects?: string[] };
  /** Ranges movers declare for it: its version must satisfy every one. */
  requirements: Requirement[];
  /** Versions that do not move: a candidate must not declare a range that leaves one out. */
  fixed: Array<{ id: string; version: string }>;
  /** What referenced projects require of it: a candidate must not be below one. */
  floors: Array<{ project: string; range: string; in?: string[] }>;
  /**
   * The step the person asked for, for a family that moves in lockstep: a package
   * sitting at the version the root leaves goes to the version the root goes to,
   * when that version exists and stands.
   */
  align?: { from: string; to: string };
}

interface Candidate {
  /** How many versions stated nothing about their dependencies, so none of them could be ruled out. */
  unstated: number;
  /** How many versions were ruled out only because they leave a fixed version out. */
  rejectedByFixed: number;
  /** The distinct ranges those versions declare for it. */
  fixedRanges: string[];
  /** The floors that ruled out at least one version, so a dead end can name the projects that hold them. */
  rejectingFloors: Array<{ project: string; range: string; in?: string[] }>;
  window: WindowEntry[];
  windowOlder: number;
  windowNewer: number;
  proposed?: { version: string; range?: string; flagged?: 'deprecated' | 'vulnerable' };
  deadEndRanges: string[];
}

/**
 * The window of `info`'s versions that can stand, and the version to propose
 * from it.
 *
 * A version stands when it satisfies every constraint of `spec`. For a dependent
 * that is "its declared range admits the parent's new version" — and the
 * admitting versions are a window, not a ray: a dependent's own floor climbs
 * with its version, so past some point it stops admitting the target from
 * above, exactly as it did not from below. For a package a mover requires it is
 * "the version satisfies the range the mover declares". After that the choice is
 * one rule: the version closest to where the package already sits, ties to the
 * higher — least disturbance, not "lowest" — and an unmarked version beats a
 * withdrawn, deprecated or vulnerable one however far it sits.
 */
function searchWindow(
  info: PackageVersions,
  installedVersion: string,
  spec: Spec,
  frameworks: string[],
  mode: CascadeMode,
  includePrerelease: boolean,
): Candidate {
  const pool = [...new Set(info.versions)]
    .filter((v) => info.flags[v]?.listed !== false)
    .filter((v) => includePrerelease || !isPrerelease(v) || versionsEqual(v, installedVersion))
    .sort(compareSemVer);
  // The installed version has a place in the ordering even when the feed no longer lists it.
  if (!pool.some((v) => versionsEqual(v, installedVersion))) {
    pool.push(installedVersion);
    pool.sort(compareSemVer);
  }
  const installedIndex = pool.findIndex((v) => versionsEqual(v, installedVersion));

  const entries: IndexedEntry[] = [];
  let unstated = 0;
  let rejectedByFixed = 0;
  const fixedRanges: string[] = [];
  const rejectingFloors: Array<{ project: string; range: string; in?: string[] }> = [];
  pool.forEach((version, index) => {
    const flag = info.flags[version];
    // A version has to serve every framework of every project the closure is
    // asked about: under central package management one version governs them all.
    const perFramework = spec.parent ? frameworks.map((f) => declaredFor(flag, f, spec.parent!.id)) : [];
    const declared = spec.parent
      ? {
        usable: perFramework.every((d) => d.usable),
        range: perFramework.find((d) => d.usable)?.range,
        unstated: perFramework.some((d) => d.unstated),
      }
      : { usable: true, range: undefined as string | undefined, unstated: false };
    if (spec.parent && declared.unstated && !versionsEqual(version, installedVersion)) unstated += 1;

    let admits = true;
    if (spec.parent) {
      admits = declared.usable && perFramework.every((d) => (
        d.range === undefined
          // No dependency on the parent violates nothing, but it is a candidate
          // only when it is newer: a package that dropped the dependency in a
          // later release genuinely works with anything, while one from before
          // the dependency existed merely does not use it, and comes with
          // everything else rolled back. A dependency is normally added and
          // kept, so the versions lacking it are the old ones.
          ? compareSemVer(version, installedVersion) > 0
          : !rangeForcesMove(d.range, spec.parent!.version, mode)
      ));
    }
    if (admits) {
      admits = spec.requirements.every((r) => versionSatisfiesRange(version, parseNuGetVersionRange(r.range)));
    }
    if (admits) {
      for (const fixed of spec.fixed) {
        const excluded = frameworks
          .map((f) => declaredFor(flag, f, fixed.id))
          .find((o) => o.usable && o.range !== undefined && !versionSatisfiesRange(fixed.version, parseNuGetVersionRange(o.range)));
        if (excluded) {
          admits = false;
          rejectedByFixed += 1;
          if (!fixedRanges.includes(excluded.range!)) fixedRanges.push(excluded.range!);
          break;
        }
      }
    }
    if (admits) {
      for (const floor of spec.floors) {
        const min = parseNuGetVersionRange(floor.range);
        if (!min.minVersion) continue;
        const cmp = compareSemVer(version, min.minVersion);
        if (min.minInclusive ? cmp < 0 : cmp <= 0) {
          admits = false;
          if (!rejectingFloors.some((f) => f.project === floor.project && f.range === floor.range)) rejectingFloors.push(floor);
          break;
        }
      }
    }
    entries.push({
      version,
      index,
      usable: declared.usable,
      range: declared.range,
      admits,
      flagged: flagOf(flag),
    });
  });

  const admitting = entries.filter((e) => e.admits && !versionsEqual(e.version, installedVersion));
  const closest = (list: typeof admitting) => [...list].sort((a, b) => {
    const da = Math.abs(a.index - installedIndex);
    const db = Math.abs(b.index - installedIndex);
    return da !== db ? da - db : compareSemVer(b.version, a.version);
  })[0];
  // A family released in lockstep — every member shares the root's version
  // numbers — is taken to the root's version when that member has it: nobody
  // wants 10.0.0 of a package whose siblings are on 10.0.14. It is an exception to
  // "closest", not the rule: only a package that sits exactly where the root sits,
  // only the exact version the root goes to, and never a marked one.
  const aligned = spec.align && versionsEqual(installedVersion, spec.align.from)
    ? admitting.find((e) => !e.flagged && versionsEqual(e.version, spec.align!.to))
    : undefined;
  const pick = aligned ?? closest(admitting.filter((e) => !e.flagged)) ?? closest(admitting);

  const usable = entries.filter((e) => e.usable);
  const deadEndRanges = pick || !spec.parent ? [] : distinctRanges(usable);

  return {
    unstated,
    rejectedByFixed,
    fixedRanges: fixedRanges.slice(0, 3),
    rejectingFloors,
    ...windowToShow(entries.filter((e) => e.usable), installedIndex),
    proposed: pick ? { version: pick.version, range: pick.range, flagged: pick.flagged } : undefined,
    deadEndRanges,
  };
}

function distinctRanges(entries: Array<{ range?: string }>): string[] {
  const seen: string[] = [];
  for (const { range } of entries) {
    if (range !== undefined && !seen.includes(range)) seen.push(range);
  }
  return seen.slice(-3).reverse();
}

interface IndexedEntry extends WindowEntry {
  index: number;
  usable: boolean;
}

const shown = ({ version, range, admits, flagged }: IndexedEntry): WindowEntry => ({ version, range, admits, flagged });

/** Versions of context shown beyond the edge of the window, each side. */
const WINDOW_CONTEXT = 2;

/**
 * Newest first, trimmed to the neighbourhood of the window — from a couple of
 * versions below the lower of the installed one and the window to a couple above
 * the higher — so a long history does not travel whole. What was cut is counted.
 */
function windowToShow(
  entries: IndexedEntry[],
  installedIndex: number,
): { window: WindowEntry[]; windowOlder: number; windowNewer: number } {
  const admitIdx = entries.filter((e) => e.admits).map((e) => e.index);
  const lo = Math.min(installedIndex, ...(admitIdx.length ? admitIdx : [installedIndex]));
  const hi = Math.max(installedIndex, ...(admitIdx.length ? admitIdx : [installedIndex]));
  const positions = entries.map((e) => e.index);
  let from = Math.max(0, positions.findIndex((p) => p >= lo - WINDOW_CONTEXT));
  let to = positions.length - 1;
  for (let i = positions.length - 1; i >= 0; i -= 1) {
    if (positions[i] <= hi + WINDOW_CONTEXT) { to = i; break; }
  }
  if (to - from + 1 > WINDOW_VERSIONS_SHOWN) to = from + WINDOW_VERSIONS_SHOWN - 1;
  from = Math.min(from, to);
  return {
    window: entries.slice(from, to + 1).reverse().map(shown),
    windowOlder: from,
    windowNewer: entries.length - 1 - to,
  };
}

/** How many times the walk is redone with what the movers required of each other before it is said not to settle. */
const CASCADE_MAX_PASSES = 6;

/**
 * What a package's new version declares, restricted to what the project
 * references directly: a forward edge to anything else needs nothing from us,
 * since NuGet resolves a transitive up to the declared floor by itself.
 */
function declaredDependenciesOf(
  info: PackageVersions,
  version: string,
  frameworks: string[],
  isDirectId: (id: string) => boolean,
  selfId: string,
): Array<{ id: string; range: string }> {
  const key = Object.keys(info.flags).find((k) => versionsEqual(k, version));
  const groups = key === undefined ? undefined : info.flags[key]?.declaredDependencies;
  if (!groups) return [];
  const out: Array<{ id: string; range: string }> = [];
  for (const framework of frameworks) {
    const group = selectCompatibleGroup(groups, framework);
    if (!group) continue;
    for (const d of group.dependencies) {
      if (!isDirectId(d.id) || packageIdsEqual(d.id, selfId)) continue;
      const range = d.range ?? '0.0.0';
      if (!out.some((o) => packageIdsEqual(o.id, d.id) && o.range === range)) out.push({ id: d.id, range });
    }
  }
  return out;
}

interface Walked {
  result: CascadeResult;
  emitted: Requirement[];
  byKey: Map<string, CascadeNode>;
}

/**
 * The closure of `input`, in both directions: who depends on a package that
 * moves, and what a package that moves now requires. Both ask what else has to
 * move so that this set restores, over the same data, in the same closure.
 *
 * The walk is repeated until what the movers require of each other no longer
 * changes the answer. A package that holds both roles, or is required by two
 * movers, is still one row, and its version has to satisfy all of them at once;
 * a requirement found late is fed into the next pass, and an empty set of
 * versions is a dead end that names every constraint.
 */
export async function computeCascade(input: CascadeInput): Promise<CascadeResult> {
  // Memoised, because a package reached from two places is asked about once —
  // across passes as well, which is what keeps repeating the walk cheap.
  const answers = new Map<string, Promise<VersionsAnswer>>();
  const lookup = (id: string): Promise<VersionsAnswer> => {
    const key = packageIdKey(id);
    let answer = answers.get(key);
    if (!answer) {
      answer = input.lookup(id).catch((error: unknown) => ({
        kind: 'unknown' as const,
        reason: reason('unreachable', 'could not be read', `its versions could not be read (${error instanceof Error ? error.message : String(error)})`),
      }));
      answers.set(key, answer);
    }
    return answer;
  };

  let req: Requirement[] = [];
  let walked: Walked | undefined;
  for (let pass = 0; pass < CASCADE_MAX_PASSES; pass += 1) {
    walked = await walk(input, lookup, req);
    const { emitted, byKey } = walked;
    // A requirement the final versions do not meet means the walk chose a version
    // before it knew; one that nobody makes any more means it chose under a
    // requirement of a version that has since moved on.
    const unmet = emitted.some((e) => requirementUnmet(e, byKey, input.packageId));
    const stale = req.some((r) => !emitted.some((e) => sameRequirement(e, r)));
    if (!unmet && !stale) return walked.result;
    req = emitted.filter((e, i) => emitted.findIndex((o) => sameRequirement(o, e)) === i);
  }

  // The constraints kept changing the answer. Say so rather than hand back a
  // version the next pass would have taken away.
  const result = walked!.result;
  result.root.children.push({
    id: '(requirements)', installedVersion: '', parentId: result.root.id, status: 'unknown', children: [],
    reason: reason('too-many', 'did not settle', `what the packages that move require of each other kept changing the answer after ${CASCADE_MAX_PASSES} passes`),
  });
  result.unknowns += 1;
  if (result.outcome === 'clear') result.outcome = 'unknown';
  return result;
}

function requirementUnmet(e: Requirement, byKey: Map<string, CascadeNode>, rootId: string): boolean {
  // The root stays where the person put it; a candidate that leaves it out never stands.
  if (packageIdsEqual(e.id, rootId)) return false;
  const node = byKey.get(packageIdKey(e.id));
  return !!node && node.status === 'moves' && !!node.proposedVersion
    && !versionSatisfiesRange(node.proposedVersion, parseNuGetVersionRange(e.range));
}

async function walk(input: CascadeInput, lookup: VersionsLookup, req: Requirement[]): Promise<Walked> {
  const { packageId, fromVersion, toVersion, mode } = input;
  const scopes = scopesOf(input);
  const frameworks = frameworksOf(scopes);
  const root: CascadeNode = {
    id: packageId, installedVersion: fromVersion, proposedVersion: toVersion, status: 'moves', children: [],
    ...placeOf(scopes, packageId, scopes.filter((s) => findLibrary(s.target, packageId)).map((s) => s.projectPath)),
  };
  // The version the person chose is the one thing in the closure that is not
  // revisable. Raising it under them to satisfy a package they did not name
  // would be worse than refusing.
  const rootFixed = { id: packageId, version: toVersion };
  const requirementsOn = (id: string) => req.filter((r) => packageIdsEqual(r.id, id));
  const fixedFor = (parent: CascadeNode) => (packageIdsEqual(parent.id, packageId) ? [] : [rootFixed]);

  const listed = new Set<string>([packageIdKey(packageId)]);
  const byKey = new Map<string, CascadeNode>();
  /** Virtual rows that force at least one package to move, listed already or not. */
  const drives = new Set<CascadeNode>();
  const emitted: Requirement[] = [];
  const all: CascadeNode[] = [root];
  let frontier: Array<{ node: CascadeNode; depth: number }> = [{ node: root, depth: 0 }];
  let deadEnd: CascadeNode | undefined;
  let capped = false;

  /**
   * Whether a project holds `dep` directly at a version its range leaves out, and
   * what that version is. A forward edge to a package nobody references directly
   * needs nothing from us.
   */
  const raisingOf = (dep: { id: string; range: string }): { version: string; holding: string[] } | undefined => {
    if (packageIdsEqual(dep.id, packageId) || listed.has(packageIdKey(dep.id))) return undefined;
    const range = parseNuGetVersionRange(dep.range);
    const violating = scopes
      .filter((s) => s.directIds.has(packageIdKey(dep.id)))
      .map((s) => ({ scope: s, library: findLibrary(s.target, dep.id) }))
      .find((x) => x.library && !versionSatisfiesRange(x.library.version, range));
    if (!violating) return undefined;
    return {
      version: violating.library!.version,
      holding: scopes.filter((s) => findLibrary(s.target, dep.id)).map((s) => s.projectPath),
    };
  };

  while (frontier.length > 0 && !capped) {
    const next: typeof frontier = [];

    // Ask the feed about the whole level at once. Each question is a walk of a
    // registration, up to eleven pages for one package, and awaiting them one by
    // one is what makes a long chain slower than the patience of the write that
    // waits on it. The judging below stays in order and reads the answers from
    // the same memo, so the result does not depend on which came back first.
    //
    // What a package that moves requires of the others is read from the feed's
    // entry for the version it moves to; that question goes out with the rest.
    const asking = frontier.map(({ node }) => lookup(node.id));
    let budget = CASCADE_MAX_PACKAGES - all.length;
    for (const { node } of frontier) {
      for (const dependent of dependentsAcross(scopes, node.id)) {
        const key = packageIdKey(dependent.library.id);
        if (budget <= 0) break;
        if (listed.has(key)) continue;
        if (!dependent.edges.some((e) => rangeForcesMove(e.range, node.proposedVersion!, mode))) continue;
        // A transitive is read only when a real restore warning reaches it: that is
        // when its version decides which direct packages have to move.
        if (!isDirect(scopes, key) && dependent.edges.every((e) => versionSatisfiesRange(node.proposedVersion!, parseNuGetVersionRange(e.range)))) continue;
        budget -= 1;
        void lookup(dependent.library.id);
      }
    }
    const needs = new Map<CascadeNode, Array<{ id: string; range: string }>>();
    const answered = await Promise.all(asking);
    frontier.forEach(({ node }, i) => {
      const answer = answered[i];
      needs.set(node, answer.kind === 'ok'
        ? declaredDependenciesOf(answer.info, node.proposedVersion!, frameworks, (id) => isDirect(scopes, id), node.id)
        : []);
    });
    for (const { node } of frontier) {
      for (const dep of needs.get(node)!) {
        if (budget <= 0) break;
        if (!raisingOf(dep)) continue;
        budget -= 1;
        void lookup(dep.id);
      }
    }

    for (const { node, depth } of frontier) {
      const newVersion = node.proposedVersion!;

      // The reverse step: packages that depend on this one and can no longer.
      for (const dependent of dependentsAcross(scopes, node.id)) {
        // Forced when any project's graph holds a range the new version leaves out.
        const forcing = dependent.edges.find((e) => rangeForcesMove(e.range, newVersion, mode));
        if (!forcing) continue;
        if (node.virtual) drives.add(node);
        const key = packageIdKey(dependent.library.id);
        if (listed.has(key)) continue;

        if (depth + 1 > CASCADE_MAX_DEPTH || all.length >= CASCADE_MAX_PACKAGES) {
          capped = true;
          node.children.push(capMarker(node, depth, packageId));
          all.push(node.children[node.children.length - 1]);
          break;
        }
        listed.add(key);

        const child = await judgeDependent(
          input, lookup, dependent.library.id, forcing.version, forcing.range, node, newVersion,
          requirementsOn(dependent.library.id), fixedFor(node), dependent.edges.map((e) => e.project),
        );
        if (!child) {
          // Nothing to move for this parent. Not listed, so another parent that
          // does force it can still reach it.
          listed.delete(key);
          continue;
        }
        node.children.push(child);
        all.push(child);
        byKey.set(key, child);
        if (child.status === 'dead-end') deadEnd ??= child;
        if (child.status === 'moves') next.push({ node: child, depth: depth + 1 });
      }
      if (capped) break;

      // The forward step: packages this one's new version requires at a higher
      // (or lower) version than the project has. A floor above the direct
      // reference is NU1605, a ceiling below it NU1608 — a failed restore, so it
      // counts in both modes, and a satisfied floor has nothing to second-guess.
      for (const dep of needs.get(node)!) {
        emitted.push({ id: dep.id, by: node.id, byVersion: newVersion, range: dep.range, projects: node.projects });
        const raising = raisingOf(dep);
        if (!raising) continue;
        if (depth + 1 > CASCADE_MAX_DEPTH || all.length >= CASCADE_MAX_PACKAGES) {
          capped = true;
          node.children.push(capMarker(node, depth, packageId));
          all.push(node.children[node.children.length - 1]);
          break;
        }
        const key = packageIdKey(dep.id);
        listed.add(key);
        const primary: Requirement = { id: dep.id, by: node.id, byVersion: newVersion, range: dep.range, projects: node.projects };
        const requirements = [primary, ...requirementsOn(dep.id).filter((r) => !sameRequirement(r, primary))];
        const child = await judgeRequired(
          input, lookup, dep.id, raising.version, node, requirements, fixedFor(node), raising.holding,
        );
        node.children.push(child);
        all.push(child);
        byKey.set(key, child);
        if (child.status === 'dead-end') deadEnd ??= child;
        if (child.status === 'moves') next.push({ node: child, depth: depth + 1 });
      }
      if (capped) break;
    }
    frontier = next;
  }

  settleVirtual(root, scopes, drives);
  noteSharedEdges(root, all, input.target);

  const moves = all.filter((n) => n !== root && n.status === 'moves' && !n.virtual).length;
  const unknowns = all.filter((n) => n.status === 'unknown').length;
  const leftOut = all.filter((n) => n.status === 'left-out').length;
  const dependents = all.length - 1;
  const outcome: CascadeOutcome = deadEnd ? 'dead-end'
    : dependents === 0 ? 'clear'
    : moves === 0 ? 'unknown'
    : 'proposal';

  return {
    result: {
      outcome, mode, packageId, fromVersion, toVersion,
      projectPath: input.projectPath, framework: input.target.framework,
      root, moves, unknowns, leftOut, deadEnd,
    },
    emitted,
    byKey,
  };
}

/**
 * A transitive that moves is only worth a row when some package has to move
 * because of it. When nothing below it does — a ceiling NuGet answers with a
 * warning, a floor every holder already satisfies — there is nothing to follow
 * and nobody to move, and the row says what it said before the walk went through
 * transitives: the package that brings it in is the one to move.
 */
function settleVirtual(root: CascadeNode, scopes: CascadeScope[], drives: ReadonlySet<CascadeNode>): void {
  const actionable = (node: CascadeNode): boolean => {
    let found = false;
    for (const child of node.children) {
      // Children first, so a virtual row that turns out to be empty is not counted.
      const childActionable = actionable(child);
      if (child.status === 'dead-end' || child.status === 'unknown') found = true;
      else if (child.status === 'moves' && (!child.virtual || childActionable)) found = true;
    }
    if (node.virtual && node.status === 'moves' && !found && !drives.has(node)) {
      const bringer = bringerOf(scopes, node.id);
      node.status = 'left-out';
      node.virtual = undefined;
      node.proposedVersion = undefined;
      node.range = undefined;
      node.window = undefined;
      node.diff = undefined;
      node.reason = reason(
        'not-direct', 'not a direct reference',
        bringer
          ? `${node.id} is not referenced by this project; it comes in with ${bringer}, so move ${bringer}`
          : `${node.id} is not referenced by this project; it moves with the package that brings it in`,
      );
    }
    return found;
  };
  actionable(root);
}

function capMarker(node: CascadeNode, depth: number, packageId: string): CascadeNode {
  const marker = depth + 1 > CASCADE_MAX_DEPTH
    ? reason('too-deep', 'too deep to follow', `the walk stops ${CASCADE_MAX_DEPTH} levels from ${packageId}`)
    : reason('too-many', 'too many to follow', `the walk stops at ${CASCADE_MAX_PACKAGES} packages`);
  return {
    id: '(further dependents)', installedVersion: '', parentId: node.id,
    status: 'unknown', reason: marker, children: [],
  };
}

function constraintsOf(spec: Spec, found: Candidate): CascadeConstraint[] {
  return [
    ...(spec.parent
      ? [{ id: spec.parent.id, version: spec.parent.version, kind: 'admits' as const, ...(spec.parent.projects ? { projects: spec.parent.projects } : {}) }]
      : []),
    ...spec.requirements.map((r) => ({
      id: r.by, version: r.byVersion, kind: 'requires' as const, range: r.range, ...(r.projects ? { projects: r.projects } : {}),
    })),
    ...(found.rejectedByFixed > 0
      ? spec.fixed.map((f) => ({
        id: f.id, version: f.version, kind: 'fixed' as const,
        ...(found.fixedRanges.length > 0 ? { range: found.fixedRanges.join(', ') } : {}),
      }))
      : []),
    ...found.rejectingFloors.map((f) => ({
      id: f.project, kind: 'floor' as const, range: f.range, ...(f.in ? { projects: f.in } : {}),
    })),
  ];
}

async function judgeDependent(
  input: CascadeInput,
  lookup: VersionsLookup,
  dependentId: string,
  installedVersion: string,
  installedRange: string,
  parent: CascadeNode,
  parentVersion: string,
  requirements: Requirement[],
  fixed: Spec['fixed'],
  holding: string[],
): Promise<CascadeNode | null> {
  const scopes = scopesOf(input);
  const frameworks = frameworksOf(scopes);
  const base = {
    id: dependentId, installedVersion, installedRange, parentId: parent.id, children: [] as CascadeNode[],
    ...placeOf(scopes, dependentId, holding),
  };

  // Only a direct reference can be proposed for update. A transitive can only
  // be moved by moving its parent, or by adding a direct reference — a
  // different decision, and not one to make silently.
  const direct = isDirect(scopes, dependentId);
  // A bare minimum crossed by a major (case 3) gives no row for a package that
  // cannot be moved on its own. It is a heuristic that needs the feed to be
  // confirmed, and the feed is not read for a package nobody can act on: a
  // transitive with a bare `[2.0.0, )` would otherwise put a row on every
  // major bump of a lockstep family. A real restore warning keeps its row.
  if (!direct && versionSatisfiesRange(parentVersion, parseNuGetVersionRange(installedRange))) return null;

  // What a transitive says when no version can be found for it, or the walk
  // below it finds nothing to move: the package that brings it in is the one to move.
  const leftOutTransitive = (): CascadeNode => {
    const bringer = bringerOf(scopes, dependentId);
    return {
      ...base, status: 'left-out',
      reason: reason(
        'not-direct', 'not a direct reference',
        bringer
          ? `${dependentId} is not referenced by this project; it comes in with ${bringer}, so move ${bringer}`
          : `${dependentId} is not referenced by this project; it moves with the package that brings it in`,
      ),
    };
  };

  const answer = await lookup(dependentId);
  if (!direct && answer.kind === 'unknown') return leftOutTransitive();
  if (answer.kind === 'unknown') {
    // A blocked package was judged and is left out; any other reason is that the
    // feed could not say.
    return { ...base, status: answer.reason.code === 'blocked' ? 'left-out' : 'unknown', reason: answer.reason };
  }

  const { info } = answer;
  const anyDeclared = info.versions.some((v) => info.flags[v]?.declaredDependencies);
  if (!anyDeclared) {
    if (!direct) return leftOutTransitive();
    return {
      ...base, status: 'unknown', sourceName: info.sourceName,
      reason: reason('no-dependency-data', 'no dependency data', `its feed did not say what any version of ${dependentId} depends on`),
    };
  }

  const spec: Spec = {
    parent: { id: parent.id, version: parentVersion, projects: base.projects }, requirements, fixed,
    floors: floorsAcross(scopes, dependentId),
    align: { from: input.fromVersion, to: input.toVersion },
  };
  const found = searchWindow(info, installedVersion, spec, frameworks, input.mode, input.includePrerelease);
  const constrained = requirements.length > 0 || found.rejectedByFixed > 0 || found.rejectingFloors.length > 0;
  // Case 3 — a bare minimum the target crosses by a major — is a heuristic that
  // an old assertion of forward compatibility has gone stale, and the evidence is
  // a later version that names the new major. With none, there is nothing to
  // correct and nothing to propose, and calling that a dead end would offer to
  // block an update on the strength of an absence. The edge is clear. Not when
  // something else binds this row: that is a conflict, not an absence.
  if (!found.proposed && !constrained && versionSatisfiesRange(parentVersion, parseNuGetVersionRange(installedRange))) return null;
  if (!direct && !found.proposed) return leftOutTransitive();
  if (!found.proposed && found.unstated > 0) {
    // Nothing that stated its dependencies admits the target, but some versions
    // stated nothing, and a dead end claims every version was checked. It
    // proposes `Block this update`; taking that on the strength of a feed that
    // left a field out would block updates for the wrong reason.
    return {
      ...base, status: 'unknown', sourceName: info.sourceName,
      reason: reason(
        'no-dependency-data', 'some versions state no dependencies',
        `${found.unstated} ${found.unstated === 1 ? 'version' : 'versions'} of ${dependentId} state nothing about their dependencies, so none of them could be ruled out`,
      ),
    };
  }
  if (!found.proposed) {
    return {
      ...base, status: 'dead-end', window: found.window, windowOlder: found.windowOlder, windowNewer: found.windowNewer,
      ...(constrained ? { constraints: constraintsOf(spec, found) } : { deadEndRanges: found.deadEndRanges }),
      requirements: requirements.length > 0 ? requirementsView(requirements) : undefined,
      sourceName: info.sourceName,
    };
  }

  const group = (v: string) => info.flags[v]?.declaredDependencies;
  return {
    ...base,
    status: 'moves',
    proposedVersion: found.proposed.version,
    range: found.proposed.range,
    flagged: found.proposed.flagged,
    window: found.window,
    windowOlder: found.windowOlder,
    windowNewer: found.windowNewer,
    sourceName: info.sourceName,
    requirements: requirements.length > 0 ? requirementsView(requirements) : undefined,
    diff: versionDependencyDiff(group(installedVersion), group(found.proposed.version), frameworks),
    // A transitive moves so that the walk can find the direct packages that hold
    // it; nothing is written for it.
    ...(direct ? {} : { virtual: true }),
  };
}

const requirementsView = (requirements: Requirement[]): NonNullable<CascadeNode['requirements']> =>
  requirements.map((r) => ({ id: r.by, version: r.byVersion, range: r.range }));

/**
 * A package a mover's new version requires at a version the project does not
 * have. The mirror of {@link judgeDependent}: the same choice of version, with
 * one predicate swapped — "does this version satisfy the range the mover
 * declares" in place of "does this version's range admit the mover's version".
 */
async function judgeRequired(
  input: CascadeInput,
  lookup: VersionsLookup,
  id: string,
  installedVersion: string,
  parent: CascadeNode,
  requirements: Requirement[],
  fixed: Spec['fixed'],
  holding: string[],
): Promise<CascadeNode> {
  const scopes = scopesOf(input);
  const frameworks = frameworksOf(scopes);
  const base = {
    id, installedVersion, parentId: parent.id, direction: 'forward' as const,
    requirements: requirementsView(requirements), children: [] as CascadeNode[],
    ...placeOf(scopes, id, holding),
  };
  const answer = await lookup(id);
  if (answer.kind === 'unknown') {
    // Blocked: the batch would skip it and write half the set, so it is left out
    // and the row says so. Anything else is that the feed could not say.
    return { ...base, status: answer.reason.code === 'blocked' ? 'left-out' : 'unknown', reason: answer.reason };
  }
  const { info } = answer;
  const spec: Spec = { requirements, fixed, floors: floorsAcross(scopes, id), align: { from: input.fromVersion, to: input.toVersion } };
  const found = searchWindow(info, installedVersion, spec, frameworks, input.mode, input.includePrerelease);
  if (!found.proposed) {
    return {
      ...base, status: 'dead-end', window: found.window, windowOlder: found.windowOlder, windowNewer: found.windowNewer,
      constraints: constraintsOf(spec, found), sourceName: info.sourceName,
    };
  }
  const group = (v: string) => info.flags[v]?.declaredDependencies;
  return {
    ...base,
    status: 'moves',
    proposedVersion: found.proposed.version,
    range: requirements[0].range,
    flagged: found.proposed.flagged,
    window: found.window,
    windowOlder: found.windowOlder,
    windowNewer: found.windowNewer,
    sourceName: info.sourceName,
    diff: versionDependencyDiff(group(installedVersion), group(found.proposed.version), frameworks),
  };
}

/** What every referenced project requires of `id`, once each. */
function floorsAcross(scopes: CascadeScope[], id: string): Array<{ project: string; range: string; in?: string[] }> {
  const multi = isMulti(scopes);
  const out: Array<{ project: string; range: string; in?: string[] }> = [];
  for (const scope of scopes) {
    for (const floor of floorsOn(scope.target, id)) {
      const found = out.find((o) => o.project === floor.project && o.range === floor.range);
      if (!found) out.push({ ...floor, ...(multi ? { in: [scope.projectPath] } : {}) });
      else if (found.in && !found.in.some((p) => pathsEqual(p, scope.projectPath))) found.in.push(scope.projectPath);
    }
  }
  return out;
}

/**
 * The direct reference a package comes in with: the nearest one up the graph,
 * so that the row can say what to move. Read from the table already in hand.
 */
function bringerOf(scopes: CascadeScope[], id: string): string | undefined {
  for (const scope of scopes) {
    const seen = new Set<string>([packageIdKey(id)]);
    let level = [id];
    while (level.length > 0) {
      const next: string[] = [];
      for (const current of level) {
        for (const above of dependentsOf(scope.target, current)) {
          const key = packageIdKey(above.library.id);
          if (seen.has(key)) continue;
          seen.add(key);
          if (scope.directIds.has(key)) return above.library.id;
          next.push(above.library.id);
        }
      }
      level = next;
    }
  }
  return undefined;
}

/**
 * The walk lists a dependent once, under the first package it was reached from,
 * but the page's detail pane also wants the other edges it declares into the
 * closure. Read after the fact from the same table.
 */
function noteSharedEdges(root: CascadeNode, all: CascadeNode[], target: AssetsTarget): void {
  const members = new Set(all.map((n) => packageIdKey(n.id)));
  for (const node of all) {
    if (node === root || node.status === 'unknown' || node.status === 'left-out') continue;
    const library = findLibrary(target, node.id);
    if (!library) continue;
    const others = library.edges.filter((e) =>
      members.has(packageIdKey(e.id)) && !(node.parentId && packageIdsEqual(e.id, node.parentId)));
    if (others.length > 0) node.alsoDeclared = others.map((e) => ({ id: e.id, range: e.range }));
  }
}
