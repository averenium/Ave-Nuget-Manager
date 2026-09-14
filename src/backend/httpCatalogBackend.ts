/**
 * The HTTP catalog, wrapped around the CLI backend it replaces piece by piece (#27).
 *
 * This is a decorator, not a second backend: every method delegates, and only
 * the ones already proved over HTTP are answered here. That shape is what makes
 * the feature switchable off in the strict sense — with the flag off, or with
 * anything at all unanswered, the call reaches exactly the CLI code that runs
 * today, and the user sees what they saw before.
 *
 * Two rules decide when the CLI is skipped, and both are conservative:
 *
 * - **Per config file, not per source.** The CLI is invoked with one config
 *   file and answers for every source that file enables, so it can be skipped
 *   only when *all* of those sources answered over HTTP. One unanswered source
 *   and the file goes to the CLI as before; the HTTP answers are then merged
 *   with its output rather than thrown away.
 * - **Never lose the per-version labels.** The version picker marks versions
 *   the feed calls vulnerable or deprecated, and those come from the metadata
 *   resource — the very resource the CLI itself reads. So a source that
 *   publishes that resource must answer through it; if it cannot this time, the
 *   file falls back to the CLI instead of showing an unlabelled list. A source
 *   with no metadata resource can be answered from the plain version list,
 *   because the CLI would have had no labels to show either.
 */

import type {
  AvailablePackage,
  CliResult,
  EnrichedPackageInfo,
  ImplicitPackage,
  InstalledPackage,
  PackageListResult,
  PackageMetadata,
  SearchedVersionMetadata,
  VulnerabilityFinding,
} from '../types';
import type { INuGetBackend } from './INuGetBackend';
import { getConfig } from '../config';
import { compareSemVer, versionsEqual } from '../semver';
import { severityFromInt } from '../nugetHttpCacheVdb';
import type { CatalogVersionEntry, CatalogDeprecation } from '../nugetRegistration';
import { normalizeSourceKey, type ProbeTarget, type SourceCapabilityStore } from '../nugetSourceCapabilities';
import type { VersionLadder } from '../nugetVersionLadder';
import { looksLikePackageId, type PackageSearch } from '../nugetSearch';

/** The sources one config file enables, already resolved from that file. */
export interface ResolvedConfigSources {
  /** Feeds reachable over HTTP, in the order the configuration lists them. */
  targets: ProbeTarget[];
  /** True when the file also enables something HTTP cannot serve — a folder, a share. */
  hasNonHttpSource: boolean;
}

export type ConfigSourceResolver = (configFile: string) => Promise<ResolvedConfigSources>;

interface VersionAnswer {
  versions: string[];
  versionFlags: Record<string, SearchedVersionMetadata>;
}

/** The label text the picker shows; the feed's own words when it gave any. */
function deprecationText(deprecation: CatalogDeprecation): string {
  if (deprecation.message) return deprecation.message;
  const alternate = deprecation.alternatePackage?.id;
  const reasons = deprecation.reasons.join(', ');
  return alternate ? `Deprecated (${reasons}). Use ${alternate} instead.` : `Deprecated (${reasons})`;
}

function flagsFrom(entry: CatalogVersionEntry): SearchedVersionMetadata | undefined {
  const deprecation = entry.deprecation ? deprecationText(entry.deprecation) : undefined;
  // The advisories are carried, not reduced to a flag. The version dropdown
  // needs only the flag, but the details panel has to name which advisory and
  // how bad — and the feed states both, per version, for free.
  const advisories = entry.vulnerabilities?.map((v) => ({
    url: v.advisoryUrl,
    severity: severityFromInt(v.severity ?? -1),
  }));
  const vulnerable = (advisories?.length ?? 0) > 0;
  if (!vulnerable && !deprecation) return undefined;
  return { vulnerable: vulnerable || undefined, deprecation, advisories };
}

/**
 * A catalog entry as the details panel wants it. Two fields exist here that the
 * CLI path cannot produce at all: the publication date, and the licence as an
 * expression rather than a link (#89). Everything still absent — copyright,
 * owners, the repository — is absent from search too, so this is no loss
 * against what runs today; the package's own nuspec is where those live.
 */
function toPackageMetadata(packageId: string, entry: CatalogVersionEntry): PackageMetadata {
  return {
    id: packageId,
    version: entry.version,
    authors: entry.authors ?? '',
    projectUrl: entry.projectUrl,
    licenseUrl: entry.licenseUrl,
    license: entry.licenseExpression ? { type: 'expression', value: entry.licenseExpression } : undefined,
    description: entry.description ?? '',
    tags: entry.tags ?? [],
    published: entry.published,
    deprecation: entry.deprecation ? deprecationText(entry.deprecation) : undefined,
  };
}

export interface CatalogBackendOptions {
  isEnabled?: () => boolean;
  /** Leave unset to keep search on the CLI while the rest moves to HTTP. */
  search?: PackageSearch;
}

export class HttpCatalogBackend implements INuGetBackend {
  private readonly _isEnabled: () => boolean;
  /** Omitted to keep search on the CLI while the rest moves to HTTP. */
  private readonly _search?: PackageSearch;

  constructor(
    private readonly _inner: INuGetBackend,
    private readonly _ladder: VersionLadder,
    private readonly _capabilities: SourceCapabilityStore,
    private readonly _resolveSources: ConfigSourceResolver,
    options: CatalogBackendOptions = {},
  ) {
    this._isEnabled = options.isEnabled ?? (() => getConfig().experimentalHttpCatalog);
    this._search = options.search;
  }

  // ── the one method answered over HTTP ──────────────────────────────────────

  async getAllVersions(
    packageId: string,
    configFiles: string[],
    prerelease = false,
  ): Promise<VersionAnswer> {
    if (!this._isEnabled()) return this._inner.getAllVersions(packageId, configFiles, prerelease);

    const answers: VersionAnswer[] = [];
    const stillNeedCli: string[] = [];
    // One feed enabled by two configuration files is one feed. Without this,
    // every source common to the chain was asked once per file — two identical
    // rounds of requests for the same answer.
    const asked = new Set<string>();

    for (const configFile of configFiles) {
      const answer = await this._fromHttp(packageId, configFile, prerelease, asked);
      if (answer) answers.push(answer);
      else stillNeedCli.push(configFile);
    }

    if (stillNeedCli.length > 0) {
      answers.push(await this._inner.getAllVersions(packageId, stillNeedCli, prerelease));
    }
    return merge(answers);
  }

  /**
   * One config file, answered entirely over HTTP or not at all. `undefined`
   * means the CLI must handle this file — for a source that did not answer, for
   * a source whose labels could not be read, or for anything HTTP cannot serve.
   */
  private async _fromHttp(
    packageId: string,
    configFile: string,
    prerelease: boolean,
    asked: Set<string>,
  ): Promise<VersionAnswer | undefined> {
    let resolved: ResolvedConfigSources;
    try {
      resolved = await this._resolveSources(configFile);
    } catch {
      return undefined;
    }
    // A folder or a share is served by the CLI, and it answers for the whole
    // file at once, so there is nothing left for HTTP to save here.
    if (resolved.hasNonHttpSource || resolved.targets.length === 0) return undefined;

    const query = { packageId, includePrerelease: prerelease };

    // Deduplication happens before anything starts, so the feeds can be asked
    // at once: this answer is a union and the order sources are visited in does
    // not affect it. (Where order *is* the semantics — the first source holding
    // a package wins — the walk stays sequential; see `_firstCatalog`.)
    const fresh = resolved.targets.filter((target) => {
      const key = normalizeSourceKey(target.url);
      if (asked.has(key)) return false;
      asked.add(key);
      return true;
    });

    const answers = await Promise.all(fresh.map((target) => this._versionsFrom(target, query)));

    const versions = new Set<string>();
    const versionFlags: Record<string, SearchedVersionMetadata> = {};
    for (const answer of answers) {
      if (!answer) return undefined;
      for (const version of answer.versions) versions.add(version);
      Object.assign(versionFlags, answer.versionFlags);
    }
    return { versions: [...versions], versionFlags };
  }

  /** One source's versions with whatever labels it can state, or nothing. */
  private async _versionsFrom(
    target: ProbeTarget,
    query: { packageId: string; includePrerelease: boolean },
  ): Promise<VersionAnswer | undefined> {
    const catalog = await this._ladder.catalogFromSource(target, query);
    if (catalog) {
      const versions: string[] = [];
      const versionFlags: Record<string, SearchedVersionMetadata> = {};
      for (const entry of catalog) {
        // A version withdrawn from the feed never appears in the CLI answer,
        // because search does not return unlisted packages at all.
        if (entry.listed === false) continue;
        versions.push(entry.version);
        const flags = flagsFrom(entry);
        if (flags) versionFlags[entry.version] = flags;
      }
      return { versions, versionFlags };
    }

    // The metadata resource is where the CLI reads its labels. If this source
    // has one and it did not answer, an HTTP answer would silently drop the
    // marks the picker shows today.
    if (this._capabilities.resourceUrls(target.url, 'RegistrationsBaseUrl').length > 0) return undefined;

    const listing = await this._ladder.versionsFromSource(target, query);
    return listing ? { versions: listing.versions, versionFlags: {} } : undefined;
  }

  // ── delegated unchanged ────────────────────────────────────────────────────

  listAllForSolution(solutionPath: string, projectCount?: number): Promise<PackageListResult> {
    return this._inner.listAllForSolution(solutionPath, projectCount);
  }

  listAllForProject(projectPath: string): Promise<PackageListResult> {
    return this._inner.listAllForProject(projectPath);
  }

  listInstalled(projectPath: string): Promise<InstalledPackage[]> {
    return this._inner.listInstalled(projectPath);
  }

  listTransitive(projectPath: string): Promise<ImplicitPackage[]> {
    return this._inner.listTransitive(projectPath);
  }

  /**
   * Search, plus the exact lookup search cannot replace.
   *
   * A repository fronting an upstream answers a search from what it has already
   * cached, so a package nobody has pulled through it is invisible to search
   * while being perfectly installable from it. When the query could be an
   * identifier, the version ladder is asked for exactly that id as well, and
   * the result is placed first — that is the only path to such a package.
   *
   * A source whose search resource is missing is left out of the results rather
   * than failing the search: the CLI would have found nothing there either.
   */
  async searchPackages(
    query: string,
    configFiles: string[],
    enabledSourceNames: string[],
    prerelease = false,
  ): Promise<AvailablePackage[]> {
    if (!this._isEnabled() || !this._search) {
      return this._inner.searchPackages(query, configFiles, enabledSourceNames, prerelease);
    }

    const enabled = new Set(enabledSourceNames.map((n) => n.toLowerCase()));
    const wanted = query.trim().toLowerCase();
    const hits: AvailablePackage[] = [];
    const stillNeedCli: string[] = [];
    const asked = new Set<string>();

    for (const configFile of configFiles) {
      let resolved: ResolvedConfigSources;
      try {
        resolved = await this._resolveSources(configFile);
      } catch {
        stillNeedCli.push(configFile);
        continue;
      }
      if (resolved.hasNonHttpSource) {
        stillNeedCli.push(configFile);
        continue;
      }

      // Deduplicated and filtered before anything starts, so the feeds are
      // searched at once rather than one waiting on the next.
      const fresh = resolved.targets.filter((target) => {
        const sourceName = target.name ?? target.url;
        if (enabled.size > 0 && !enabled.has(sourceName.toLowerCase())) return false;
        const key = normalizeSourceKey(target.url);
        if (asked.has(key)) return false;
        asked.add(key);
        return true;
      });

      const searched = await Promise.all(fresh.map(async (target) => {
        await this._capabilities.ensure(target);
        // No search resource at all: nothing to fall back to, and nothing lost.
        if (!this._search?.hasSearch(target)) return { target, found: undefined, searchable: false };
        const found = await this._search.searchSource(target, { query, prerelease });
        return { target, found, searchable: true };
      }));

      let fileFailed = false;
      for (const { target, found, searchable } of searched) {
        const sourceName = target.name ?? target.url;
        if (searchable && !found) {
          // A feed that has search and could not answer sends its whole file to
          // the CLI, and nothing after it is worth asking.
          fileFailed = true;
          break;
        }
        for (const hit of found ?? []) hits.push({ ...hit, sourceName });

        // The exact lookup exists for one situation: a feed whose search sees
        // only what it has already cached, where a package can be installable
        // and invisible at the same time. A search that returns ids *containing*
        // the query proves it is not blind to this namespace — so if the package
        // existed there, search would have returned it, and the lookup is a
        // request for nothing.
        //
        // `startsWith` was too narrow to show that. On a query where every
        // result merely ended with it, the guard never fired: the lookup ran,
        // and what it found was a placeholder package at version 0.0.0 that then
        // outranked the one with three hundred million downloads. Containment is
        // the signal that matters, and it also stops a 404 on every intermediate
        // letter of a name being typed.
        //
        // This pass stays sequential: whether the lookup is needed at all
        // depends on what the sources before it already produced.
        const coveredBySearch = found?.some((hit) => hit.id.toLowerCase().includes(wanted));
        if (!coveredBySearch && !hits.some((hit) => hit.id.toLowerCase() === wanted)) {
          const exact = await this._exactHit(target, query, prerelease, sourceName);
          if (exact) hits.push(exact);
        }
      }
      if (fileFailed) stillNeedCli.push(configFile);
    }

    if (stillNeedCli.length > 0) {
      hits.push(...await this._inner.searchPackages(query, stillNeedCli, enabledSourceNames, prerelease));
    }

    // First source wins on a duplicate id, exactly as the CLI path merges.
    const seen = new Set<string>();
    const merged: AvailablePackage[] = [];
    for (const hit of hits) {
      const key = hit.id.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(hit);
    }
    // A package named outright by the query belongs at the top, wherever in the
    // merge it landed; source priority decides everything below it.
    const exactAt = merged.findIndex((hit) => hit.id.toLowerCase() === wanted);
    if (exactAt > 0) merged.unshift(...merged.splice(exactAt, 1));
    return merged;
  }

  /** The package named by the query, when the query names one at all. */
  private async _exactHit(
    target: ProbeTarget,
    query: string,
    prerelease: boolean,
    sourceName: string,
  ): Promise<AvailablePackage | undefined> {
    if (!looksLikePackageId(query)) return undefined;
    const listing = await this._ladder.versionsFromSource(target, {
      packageId: query.trim(),
      includePrerelease: prerelease,
    });
    const latestVersion = listing?.versions[0];
    if (!latestVersion) return undefined;
    // The id is echoed as the user typed it: the cheap rung answers with
    // version strings only, and the feed's own casing is not in that answer.
    return { id: query.trim(), latestVersion, sourceName };
  }

  /**
   * The details panel for one version. The metadata resource states more than
   * the CLI path can: it carries the publication date and the licence
   * expression, neither of which search returns at all.
   *
   * Unlisted versions are *not* filtered here, unlike in the version lists — a
   * version asked for by name is one the caller already has, and hiding its
   * description would leave the panel emptier than the CLI leaves it.
   */
  async getMetadata(
    packageId: string,
    version: string,
    configFiles: string[],
  ): Promise<PackageMetadata> {
    if (!this._isEnabled()) return this._inner.getMetadata(packageId, version, configFiles);

    const found = await this._firstCatalog(
      packageId,
      configFiles,
      true,
      (entries) => !version || entries.some((e) => versionsEqual(e.version, version)),
      // Naming the version lets the reader fetch the one page that covers it
      // instead of the whole paged history. This method answers about exactly
      // one version either way, so when none is named the newest will do — and
      // that lives on the last page. The flag is set here, where the contract
      // is known, and never derived inside the walk, which serves callers that
      // do need every page.
      { version, newestOnly: !version },
    );
    if (!found) return this._inner.getMetadata(packageId, version, configFiles);

    const sorted = [...found.entries].sort((a, b) => compareSemVer(b.version, a.version));
    // The requested version came from the project or the restore graph and the
    // catalog version came from the feed; the two spell the same version
    // differently often enough that string identity would send a full metadata
    // download to waste.
    const entry = (version ? sorted.find((e) => versionsEqual(e.version, version)) : undefined) ?? sorted[0];
    if (!entry) return this._inner.getMetadata(packageId, version, configFiles);
    return toPackageMetadata(packageId, entry);
  }

  /**
   * The version list plus per-version fields for the picker. Follows the CLI's
   * own rule of stopping at the first source that holds the package rather than
   * unioning every feed — that is what makes the reported source name mean
   * something.
   */
  async enrichPackage(
    packageId: string,
    configFiles: string[],
    prerelease = false,
  ): Promise<EnrichedPackageInfo> {
    if (!this._isEnabled()) return this._inner.enrichPackage(packageId, configFiles, prerelease);

    const found = await this._firstCatalog(packageId, configFiles, prerelease);
    if (!found) return this._inner.enrichPackage(packageId, configFiles, prerelease);

    const listed = found.entries.filter((e) => e.listed !== false);
    const versions = [...new Set(listed.map((e) => e.version))].sort((a, b) => compareSemVer(b, a));
    const metadataByVersion: Record<string, SearchedVersionMetadata> = {};
    for (const entry of listed) {
      metadataByVersion[entry.version] = {
        description: entry.description,
        projectUrl: entry.projectUrl,
        authors: entry.authors,
        licenseUrl: entry.licenseUrl,
        license: entry.licenseExpression ? { type: 'expression', value: entry.licenseExpression } : undefined,
        tags: entry.tags?.join(' '),
        ...flagsFrom(entry),
      };
    }
    return {
      latestVersion: versions[0] ?? '',
      sourceName: found.sourceName,
      versions,
      metadataByVersion,
    };
  }

  /**
   * The first source holding this package, in configuration order. `undefined`
   * means the CLI must answer: a file that could not be read, a source type
   * HTTP does not serve, a resource that did not answer, or a package no
   * configured feed admits to having — the last of which the CLI confirms,
   * since a wrong "not found" is worse than the call it saves.
   */
  private async _firstCatalog(
    packageId: string,
    configFiles: string[],
    prerelease: boolean,
    accept: (entries: CatalogVersionEntry[]) => boolean = (entries) => entries.length > 0,
    /**
     * How much of a paged history this caller needs. The default — nothing —
     * is every page, which is what the version list and the enrich answer
     * require; only a caller that answers about one version narrows it.
     */
    scope: { version?: string; newestOnly?: boolean } = {},
  ): Promise<{ entries: CatalogVersionEntry[]; sourceName: string } | undefined> {
    const query = { packageId, includePrerelease: prerelease, ...scope };
    const asked = new Set<string>();
    for (const configFile of configFiles) {
      let resolved: ResolvedConfigSources;
      try {
        resolved = await this._resolveSources(configFile);
      } catch {
        return undefined;
      }
      if (resolved.hasNonHttpSource) return undefined;

      for (const target of resolved.targets) {
        const key = normalizeSourceKey(target.url);
        if (asked.has(key)) continue;
        asked.add(key);

        const entries = await this._ladder.catalogFromSource(target, query);
        if (!entries) return undefined;
        if (entries.length === 0 || !accept(entries)) continue;
        return { entries, sourceName: target.name ?? target.url };
      }
    }
    return undefined;
  }

  installPackage(
    projectPath: string,
    packageId: string,
    version: string,
    signal?: AbortSignal,
    framework?: string,
  ): Promise<CliResult> {
    return this._inner.installPackage(projectPath, packageId, version, signal, framework);
  }

  installPackageNoRestore(
    projectPath: string,
    packageId: string,
    version: string,
    signal?: AbortSignal,
    framework?: string,
  ): Promise<CliResult> {
    return this._inner.installPackageNoRestore(projectPath, packageId, version, signal, framework);
  }

  removePackage(projectPath: string, packageId: string): Promise<CliResult> {
    return this._inner.removePackage(projectPath, packageId);
  }

  restoreProject(projectPath: string, signal?: AbortSignal): Promise<CliResult> {
    return this._inner.restoreProject(projectPath, signal);
  }

  listVulnerable(
    projectOrSolutionPath: string,
    signal?: AbortSignal,
    projectCount?: number,
  ): Promise<VulnerabilityFinding[]> {
    return this._inner.listVulnerable(projectOrSolutionPath, signal, projectCount);
  }
}

/**
 * Unions what several files answered, newest first — the same union the CLI
 * path performs, because one package can exist on several feeds with different
 * version sets and the picker must show all of them.
 */
function merge(answers: readonly VersionAnswer[]): VersionAnswer {
  const versions = new Set<string>();
  const versionFlags: Record<string, SearchedVersionMetadata> = {};
  for (const answer of answers) {
    for (const version of answer.versions) versions.add(version);
    Object.assign(versionFlags, answer.versionFlags);
  }
  return { versions: [...versions].sort((a, b) => compareSemVer(b, a)), versionFlags };
}
