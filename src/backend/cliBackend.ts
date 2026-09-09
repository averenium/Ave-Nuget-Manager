import * as fs from 'fs/promises';
import * as path from 'path';
import type { CliRunner } from '../cliRunner';
import type {
  InstalledPackage,
  ImplicitPackage,
  AvailablePackage,
  PackageMetadata,
  CliResult,
  PackageListResult,
  VulnerabilityFinding,
  EnrichedPackageInfo,
  SearchedVersionMetadata,
} from '../types';
import type { INuGetBackend } from './INuGetBackend';
import { extractJsonObject, summarizeDotnetFailure, summarizeListProblems } from '../dotnetOutput';
import { stampListedDependencies, attachAssetsDependencies } from '../projectAssets';
import { parseDotnetVulnerableJson } from '../vulnerabilities';
import { delayInstallRetry, INSTALL_RETRY_EXTRA_ATTEMPTS } from '../cliRetry';
import { searchedMetadataToPackageMetadata } from '../searchMetadataMapping';
import { classifyConfigSources } from '../localPackageSources';

// ─── dotnet JSON output shapes ────────────────────────────────────────────────

interface DotnetListOutput {
  version: number;
  parameters: string;
  problems?: Array<{ text?: string; level?: string }>;
  projects?: Array<{
    path: string;
    frameworks?: Array<{
      framework: string;
      topLevelPackages?: Array<{
        id: string;
        requestedVersion: string;
        resolvedVersion: string;
        /** "true" when the package is auto-referenced by the SDK (not user-managed) */
        autoReferenced?: string;
      }>;
      transitivePackages?: Array<{
        id: string;
        resolvedVersion: string;
      }>;
    }>;
  }>;
}

interface DotnetSearchOutput {
  version: number;
  problems?: unknown[];
  searchResult?: Array<{
    sourceName: string;
    packages?: Array<{
      id: string;
      // Regular search: latestVersion field
      // --exact-match: each package entry has version field (one per version)
      latestVersion?: string;
      version?: string;
      description?: string;
      authors?: string;
      projectUrl?: string;
      licenseUrl?: string;
      tags?: string;
      // `--verbosity detailed` only — a feed answer (deprecation status,
      // whether this exact version is flagged vulnerable), never present in
      // a nuspec. Present per version at `--exact-match`, not just latest.
      vulnerable?: boolean;
      deprecation?: string;
      // Older SDK format: nested versions array
      versions?: Array<{ version: string }>;
    }>;
  }>;
}

const TIMEOUT_MS = 30_000;
/** add / remove / restore include NuGet restore — 30s is too tight under load. */
const MUTATION_TIMEOUT_MS = 120_000;
/**
 * `dotnet list --include-transitive` (and `--vulnerable`) scales with the
 * number of projects being listed, unlike the feed/network-bound calls
 * `TIMEOUT_MS` covers (a single package's search/metadata round-trip) — a
 * large `.slnx` can legitimately take longer than 30s just to list. Scale the
 * budget with the project count instead of paying the same 120s ceiling for
 * a single-project list too (#72).
 */
const LIST_TIMEOUT_MIN_MS = 30_000;
const LIST_TIMEOUT_MAX_MS = 120_000;
/** Extra budget per project beyond the first, up to the max above. */
const LIST_TIMEOUT_PER_PROJECT_MS = 2_000;

function listTimeoutMs(projectCount = 1): number {
  const extra = Math.max(0, projectCount - 1) * LIST_TIMEOUT_PER_PROJECT_MS;
  return Math.min(LIST_TIMEOUT_MAX_MS, LIST_TIMEOUT_MIN_MS + extra);
}

/** Skip implicit restore (.NET 10+ fails the whole list when restore errors, e.g. NU1605). */
function listPackageArgs(targetPath: string, includeTransitive: boolean): string[] {
  const args = ['list', targetPath, 'package'];
  if (includeTransitive) args.push('--include-transitive');
  args.push('--format', 'json', '--no-restore');
  return args;
}

export class CliBackend implements INuGetBackend {
  constructor(private readonly runner: CliRunner) {}

  /**
   * `dotnet list` (with or without `--vulnerable`) scales with repo size, not
   * with anything transient like a network hiccup — a timeout there is not
   * flaky the way a feed request is, but a large solution can legitimately
   * need more than one run's worth of patience under load. One extra attempt
   * after a timeout only (not a plain non-zero exit) mirrors the install
   * retry in `cliRetry.ts` rather than inventing a separate mechanism (#72).
   */
  private async _runList(args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CliResult> {
    let result = await this.runner.run({ args, cwd, timeoutMs, signal });
    for (
      let extra = 0;
      extra < INSTALL_RETRY_EXTRA_ATTEMPTS && result.timedOut && !signal?.aborted;
      extra++
    ) {
      await delayInstallRetry(signal);
      if (signal?.aborted) break;
      result = await this.runner.run({ args, cwd, timeoutMs, signal });
    }
    return result;
  }

  // ── listAllForSolution ─────────────────────────────────────────────────────

  async listAllForSolution(solutionPath: string, projectCount?: number): Promise<PackageListResult> {
    // One call: --include-transitive returns both topLevelPackages and transitivePackages
    const result = await this._runList(
      listPackageArgs(solutionPath, true), path.dirname(solutionPath), listTimeoutMs(projectCount),
    );

    const baseDir = path.dirname(solutionPath);
    const listed = this._toListResult(
      result,
      this._parseAllProjectsInstalled(result.stdout, baseDir),
      this._parseAllProjectsTransitive(result.stdout, baseDir),
    );
    const stamped = await stampListedDependencies(listed.installed, listed.implicit);
    listed.installed = stamped.installed;
    listed.implicit = stamped.implicit;
    return listed;
  }

  // ── listAllForProject ──────────────────────────────────────────────────────

  async listAllForProject(projectPath: string): Promise<PackageListResult> {
    const result = await this._runList(listPackageArgs(projectPath, true), path.dirname(projectPath), listTimeoutMs());

    const listed = this._toListResult(
      result,
      this._parseInstalledPackages(result.stdout, projectPath),
      this._parseTransitivePackages(result.stdout, projectPath),
    );
    const stamped = await stampListedDependencies(listed.installed, listed.implicit);
    listed.installed = stamped.installed;
    listed.implicit = stamped.implicit;
    return listed;
  }

  // ── listVulnerable ─────────────────────────────────────────────────────────

  async listVulnerable(
    projectOrSolutionPath: string,
    signal?: AbortSignal,
    projectCount?: number,
  ): Promise<VulnerabilityFinding[]> {
    const result = await this._runList(
      [
        'list', projectOrSolutionPath, 'package',
        '--vulnerable', '--include-transitive',
        '--format', 'json', '--no-restore',
      ],
      path.dirname(projectOrSolutionPath),
      listTimeoutMs(projectCount),
      signal,
    );
    return parseDotnetVulnerableJson(result.stdout);
  }

  // ── listInstalled ──────────────────────────────────────────────────────────

  async listInstalled(projectPath: string): Promise<InstalledPackage[]> {
    const result = await this._runList(listPackageArgs(projectPath, false), path.dirname(projectPath), listTimeoutMs());

    if (result.timedOut || result.exitCode !== 0) {
      return [];
    }

    return attachAssetsDependencies(this._parseInstalledPackages(result.stdout, projectPath));
  }

  // ── listTransitive ─────────────────────────────────────────────────────────

  async listTransitive(projectPath: string): Promise<ImplicitPackage[]> {
    const result = await this._runList(listPackageArgs(projectPath, true), path.dirname(projectPath), listTimeoutMs());

    if (result.timedOut || result.exitCode !== 0) {
      return [];
    }

    return this._parseTransitivePackages(result.stdout, projectPath);
  }

  // ── searchPackages ─────────────────────────────────────────────────────────

  async searchPackages(
    query: string,
    configFiles: string[],
    enabledSourceNames: string[],
    prerelease = false,
  ): Promise<AvailablePackage[]> {
    const enabledSet = new Set(enabledSourceNames.map((n) => n.toLowerCase()));

    // Run one search per config file in parallel
    const perFileResults = await Promise.all(
      configFiles.map((cf) => this._searchWithConfigFile(query, cf, enabledSet, prerelease)),
    );

    // Merge and deduplicate by package id (first-found source has priority)
    const seen = new Set<string>();
    const merged: AvailablePackage[] = [];

    for (const packages of perFileResults) {
      for (const pkg of packages) {
        const key = pkg.id.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(pkg);
        }
      }
    }

    return merged;
  }

  // ── getAllVersions ─────────────────────────────────────────────────────────

  async getAllVersions(
    packageId: string,
    configFiles: string[],
    prerelease = false,
  ): Promise<{ versions: string[]; versionFlags: Record<string, SearchedVersionMetadata> }> {
    const perFile = await Promise.all(
      configFiles.map((cf) => this._fetchVersionsFromConfigFile(packageId, cf, prerelease)),
    );

    const seen = new Set<string>();
    const all: string[] = [];
    const versionFlags: Record<string, SearchedVersionMetadata> = {};
    for (const { versions, versionFlags: flags } of perFile) {
      for (const v of versions) {
        if (!seen.has(v)) {
          seen.add(v);
          all.push(v);
        }
      }
      Object.assign(versionFlags, flags);
    }

    // Sort descending by SemVer
    return { versions: all.sort((a, b) => compareSemVerDesc(a, b)), versionFlags };
  }

  /**
   * True when this config file provably cannot answer for `packageId`: every
   * source it enables is a local folder, and none of those folders holds a
   * directory by that id — which is how a folder source stores what it serves
   * (#91). Skipping it saves a ~250ms process launch per package.
   *
   * Not cached: reading the config and listing a folder costs well under a
   * millisecond against that, and staying stateless means a package dropped
   * into the folder is picked up at once instead of after a cache expiry.
   * Anything unexpected — an unreadable config, a feed among the sources —
   * answers false, because a wasted call is cheaper than a package the panel
   * wrongly reports as missing.
   */
  private async _configCannotAnswer(configFile: string, packageId: string): Promise<boolean> {
    try {
      const { folders, hasNonLocal } = classifyConfigSources(await fs.readFile(configFile, 'utf8'), configFile);
      if (hasNonLocal || folders.length === 0) return false;

      const wanted = packageId.toLowerCase();
      for (const folder of folders) {
        const entries = await fs.readdir(folder).catch(() => [] as string[]);
        if (entries.some((entry) => entry.toLowerCase() === wanted)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  // ── search (shared by getMetadata + enrichPackage) ──────────────────────────

  /**
   * `dotnet package search <id> --exact-match [--prerelease] --configfile <cf>
   * [--verbosity detailed] --format json`, tried against each config file in
   * order, stopping at the first one that returns at least one entry for
   * this exact id. `--exact-match` returns one entry per published version;
   * `--verbosity detailed` adds `description`/`projectUrl` to each at no
   * extra round trip (#86 Part 1) — `enrichPackage` already pays for this
   * call to build the version list, so `getMetadata` reuses the identical
   * command instead of being a separate, lighter, wasted second call.
   */
  private async _searchExactMatch(
    packageId: string,
    configFiles: string[],
    prerelease: boolean,
    detailed: boolean,
  ): Promise<{ sourceName: string; entries: Array<SearchedVersionMetadata & { version: string }> } | null> {
    for (const cf of configFiles) {
      if (await this._configCannotAnswer(cf, packageId)) continue;
      const args = [
        'package', 'search', packageId,
        '--exact-match',
        '--configfile', cf,
        '--format', 'json',
      ];
      if (prerelease) args.push('--prerelease');
      if (detailed) args.push('--verbosity', 'detailed');

      const result = await this.runner.run({
        args,
        cwd: path.dirname(cf),
        timeoutMs: TIMEOUT_MS,
      });

      if (result.timedOut || result.exitCode !== 0) continue;

      let output: DotnetSearchOutput;
      try { output = JSON.parse(result.stdout) as DotnetSearchOutput; }
      catch { continue; }

      let sourceName = '';
      const entries: Array<SearchedVersionMetadata & { version: string }> = [];
      for (const sourceResult of output.searchResult ?? []) {
        for (const pkg of sourceResult.packages ?? []) {
          if (pkg.id.toLowerCase() !== packageId.toLowerCase()) continue;
          // Each entry is one version (--exact-match format)
          const version = pkg.version ?? pkg.latestVersion ?? '';
          if (!version) continue;
          entries.push({
            version,
            description: pkg.description,
            projectUrl: pkg.projectUrl,
            authors: pkg.authors,
            licenseUrl: pkg.licenseUrl,
            tags: pkg.tags,
            vulnerable: pkg.vulnerable,
            deprecation: pkg.deprecation,
          });
          if (!sourceName && sourceResult.sourceName) sourceName = sourceResult.sourceName;
        }
      }

      if (entries.length > 0) return { sourceName, entries };
    }
    return null;
  }

  // ── getMetadata ────────────────────────────────────────────────────────────

  async getMetadata(
    packageId: string,
    version: string,
    configFiles: string[],
  ): Promise<PackageMetadata> {
    const fallback: PackageMetadata = {
      id: packageId,
      version,
      authors: '',
      description: '',
      tags: [],
    };

    const result = await this._searchExactMatch(packageId, configFiles, true, true);
    if (!result || result.entries.length === 0) return fallback;

    // Pick the entry matching the requested version; if none was requested,
    // pick the newest — never "whichever happens to come first in dotnet's
    // own JSON output", which for --exact-match is oldest-first.
    const sorted = [...result.entries].sort((a, b) => compareSemVerDesc(a.version, b.version));
    const entry = (version ? sorted.find((e) => e.version === version) : undefined) ?? sorted[0];

    return searchedMetadataToPackageMetadata(packageId, entry.version, entry);
  }

  // ── enrichPackage ─────────────────────────────────────────────────────────

  async enrichPackage(
    packageId: string,
    configFiles: string[],
    prerelease = false,
  ): Promise<EnrichedPackageInfo> {
    // `dotnet package search` has no TFM: latest is feed-highest, not
    // "restores on this project". `dotnet list --outdated` would be
    // framework-aware; this CLI path does not call it.
    const result = await this._searchExactMatch(packageId, configFiles, prerelease, true);
    if (!result) return { latestVersion: '', sourceName: '', versions: [], metadataByVersion: {} };

    const versions = [...new Set(result.entries.map((e) => e.version))].sort(compareSemVerDesc);
    const metadataByVersion: Record<string, SearchedVersionMetadata> = {};
    for (const e of result.entries) {
      metadataByVersion[e.version] = {
        description: e.description,
        projectUrl: e.projectUrl,
        authors: e.authors,
        licenseUrl: e.licenseUrl,
        tags: e.tags,
        vulnerable: e.vulnerable,
        deprecation: e.deprecation,
      };
    }
    return { latestVersion: versions[0] ?? '', sourceName: result.sourceName, versions, metadataByVersion };
  }

  // ── installPackage ─────────────────────────────────────────────────────────

  async installPackage(
    projectPath: string,
    packageId: string,
    version: string,
    signal?: AbortSignal,
  ): Promise<CliResult> {
    return this.runner.run({
      args: ['add', projectPath, 'package', packageId, '--version', version],
      cwd: path.dirname(projectPath),
      timeoutMs: MUTATION_TIMEOUT_MS,
      signal,
    });
  }

  // ── installPackageNoRestore ──────────────────────────────────────────────────

  async installPackageNoRestore(
    projectPath: string,
    packageId: string,
    version: string,
    signal?: AbortSignal,
  ): Promise<CliResult> {
    return this.runner.run({
      args: ['add', projectPath, 'package', packageId, '--version', version, '--no-restore'],
      cwd: path.dirname(projectPath),
      timeoutMs: MUTATION_TIMEOUT_MS,
      signal,
    });
  }

  // ── removePackage ─────────────────────────────────────────────────────────

  async removePackage(projectPath: string, packageId: string): Promise<CliResult> {
    return this.runner.run({
      args: ['remove', projectPath, 'package', packageId],
      cwd: path.dirname(projectPath),
      timeoutMs: MUTATION_TIMEOUT_MS,
    });
  }

  // ── restoreProject ─────────────────────────────────────────────────────────

  async restoreProject(projectOrSolutionPath: string, signal?: AbortSignal): Promise<CliResult> {
    return this.runner.run({
      args: ['restore', projectOrSolutionPath],
      cwd: path.dirname(projectOrSolutionPath),
      timeoutMs: MUTATION_TIMEOUT_MS,
      signal,
    });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * `dotnet list` without `--no-restore` (SDK 10+) exits 1 after a failed restore
   * with `{ problems: [...] }` and no projects. Callers must not treat that as
   * “solution has zero packages”.
   */
  private _toListResult(
    result: CliResult,
    installed: InstalledPackage[],
    implicit: ImplicitPackage[],
  ): PackageListResult {
    const hasPackages = installed.length > 0 || implicit.length > 0;
    if (hasPackages) return { installed, implicit };

    if (result.timedOut) {
      return { installed, implicit, error: 'dotnet list timed out' };
    }

    const problemText = summarizeListProblems(result.stdout);
    if (result.exitCode !== 0 || problemText) {
      return {
        installed,
        implicit,
        error: problemText
          || summarizeDotnetFailure(result.stdout, result.stderr)
          || 'dotnet list failed',
      };
    }

    return { installed, implicit };
  }

  private _parseListJson(stdout: string): DotnetListOutput | null {
    const raw = extractJsonObject(stdout) ?? stdout.trim();
    if (!raw) return null;
    try { return JSON.parse(raw) as DotnetListOutput; }
    catch { return null; }
  }

  private _resolveReportedProjectPath(reported: string, baseDir: string): string {
    if (!reported) return reported;
    return path.normalize(path.resolve(baseDir, reported));
  }

  private _parseAllProjectsInstalled(stdout: string, baseDir: string): InstalledPackage[] {
    const output = this._parseListJson(stdout);
    if (!output) return [];

    const packages: InstalledPackage[] = [];
    for (const project of output.projects ?? []) {
      const projectPath = this._resolveReportedProjectPath(project.path, baseDir);
      for (const fw of project.frameworks ?? []) {
        for (const pkg of fw.topLevelPackages ?? []) {
          if (pkg.autoReferenced === 'true') continue;
          packages.push({
            id: pkg.id,
            requestedVersion: pkg.requestedVersion,
            resolvedVersion: pkg.resolvedVersion,
            projectPath,
            framework: fw.framework || undefined,
          });
        }
      }
    }
    return packages;
  }

  private _parseAllProjectsTransitive(stdout: string, baseDir: string): ImplicitPackage[] {
    const output = this._parseListJson(stdout);
    if (!output) return [];

    const packages: ImplicitPackage[] = [];
    for (const project of output.projects ?? []) {
      const projectPath = this._resolveReportedProjectPath(project.path, baseDir);
      for (const fw of project.frameworks ?? []) {
        for (const pkg of fw.transitivePackages ?? []) {
          packages.push({
            id: pkg.id,
            resolvedVersion: pkg.resolvedVersion,
            projectPath,
            framework: fw.framework || undefined,
          });
        }
      }
    }
    return packages;
  }

  private _parseInstalledPackages(
    stdout: string,
    projectPath: string,
  ): InstalledPackage[] {
    const output = this._parseListJson(stdout);
    if (!output) return [];

    const packages: InstalledPackage[] = [];
    for (const project of output.projects ?? []) {
      for (const fw of project.frameworks ?? []) {
        for (const pkg of fw.topLevelPackages ?? []) {
          // Skip auto-referenced SDK packages — not user-managed
          if (pkg.autoReferenced === 'true') continue;
          packages.push({
            id: pkg.id,
            requestedVersion: pkg.requestedVersion,
            resolvedVersion: pkg.resolvedVersion,
            projectPath,
            framework: fw.framework || undefined,
          });
        }
      }
    }
    return packages;
  }

  private _parseTransitivePackages(
    stdout: string,
    projectPath: string,
  ): ImplicitPackage[] {
    const output = this._parseListJson(stdout);
    if (!output) return [];

    const packages: ImplicitPackage[] = [];
    for (const project of output.projects ?? []) {
      for (const fw of project.frameworks ?? []) {
        for (const pkg of fw.transitivePackages ?? []) {
          packages.push({
            id: pkg.id,
            resolvedVersion: pkg.resolvedVersion,
            projectPath,
            framework: fw.framework || undefined,
          });
        }
      }
    }
    return packages;
  }

  private async _searchWithConfigFile(
    query: string,
    configFile: string,
    enabledSet: Set<string>,
    prerelease = false,
  ): Promise<AvailablePackage[]> {
    const args = [
      'package', 'search', query,
      '--configfile', configFile,
      '--format', 'json',
    ];
    if (prerelease) args.push('--prerelease');

    const result = await this.runner.run({
      args,
      cwd: path.dirname(configFile),
      timeoutMs: TIMEOUT_MS,
    });

    if (result.timedOut || result.exitCode !== 0) return [];

    let output: DotnetSearchOutput;
    try {
      output = JSON.parse(result.stdout) as DotnetSearchOutput;
    } catch {
      return [];
    }

    const packages: AvailablePackage[] = [];
    for (const sourceResult of output.searchResult ?? []) {
      const srcLower = sourceResult.sourceName.toLowerCase();
      // Only include if this source is in the active filter
      if (enabledSet.size > 0 && !enabledSet.has(srcLower)) continue;

      for (const pkg of sourceResult.packages ?? []) {
        const displayVersion = pkg.latestVersion ?? pkg.version ?? '';
        if (!displayVersion) continue;
        packages.push({
          id: pkg.id,
          latestVersion: displayVersion,
          sourceName: sourceResult.sourceName,
          description: pkg.description,
        });
      }
    }
    return packages;
  }

  private async _fetchVersionsFromConfigFile(
    packageId: string,
    configFile: string,
    prerelease = false,
  ): Promise<{ versions: string[]; versionFlags: Record<string, SearchedVersionMetadata> }> {
    const args = [
      'package', 'search', packageId,
      '--exact-match',
      '--configfile', configFile,
      // A version the feed already flags vulnerable/deprecated is worth
      // marking right in this dropdown, before it's even chosen (#86) — the
      // same free-with-`--verbosity detailed` fields Part 1 uses.
      '--verbosity', 'detailed',
      '--format', 'json',
    ];
    if (prerelease) args.push('--prerelease');

    const empty = { versions: [] as string[], versionFlags: {} as Record<string, SearchedVersionMetadata> };
    // The version list asks every config file in the chain rather than stopping
    // at the first hit, so this is where a folder source that cannot hold the
    // package costs a process launch for every package (#91).
    if (await this._configCannotAnswer(configFile, packageId)) return empty;

    const result = await this.runner.run({
      args,
      cwd: path.dirname(configFile),
      timeoutMs: TIMEOUT_MS,
    });

    if (result.timedOut || result.exitCode !== 0) return empty;

    let output: DotnetSearchOutput;
    try {
      output = JSON.parse(result.stdout) as DotnetSearchOutput;
    } catch {
      return empty;
    }

    const versions: string[] = [];
    const versionFlags: Record<string, SearchedVersionMetadata> = {};
    for (const sourceResult of output.searchResult ?? []) {
      for (const pkg of sourceResult.packages ?? []) {
        if (pkg.id.toLowerCase() !== packageId.toLowerCase()) continue;

        // Format 1 (--exact-match): each package object = one version, field is "version"
        if (pkg.version) {
          if (!versions.includes(pkg.version)) versions.push(pkg.version);
          if (pkg.vulnerable || pkg.deprecation) {
            versionFlags[pkg.version] = { vulnerable: pkg.vulnerable, deprecation: pkg.deprecation };
          }
        }
        // Format 2 (regular search, nested array): versions: [{version: "x.y.z"}] — no per-version flags in this shape
        for (const v of pkg.versions ?? []) {
          if (!versions.includes(v.version)) versions.push(v.version);
        }
        // Format 3 (regular search): single latestVersion field
        if (pkg.latestVersion && !versions.includes(pkg.latestVersion)) {
          versions.push(pkg.latestVersion);
        }
      }
    }
    return { versions, versionFlags };
  }

}

// ─── SemVer comparison helpers ────────────────────────────────────────────────

/**
 * Compare two version strings for descending sort (newest first).
 * Handles standard SemVer (1.2.3) and pre-release suffixes (1.2.3-alpha.1).
 */
export function compareSemVerDesc(a: string, b: string): number {
  return compareSemVer(b, a);
}

export function compareSemVer(a: string, b: string): number {
  const pa = parseSemVer(a);
  const pb = parseSemVer(b);

  for (let i = 0; i < 4; i++) {
    const diff = (pa[i] as number) - (pb[i] as number);
    if (diff !== 0) return diff;
  }
  // Pre-release suffix: no suffix > has suffix (release > pre-release)
  if (pa[4] === pb[4]) return 0;
  if (pa[4] === '') return 1;   // a is release, b is pre-release
  if (pb[4] === '') return -1;
  return pa[4] < pb[4] ? -1 : 1;
}

function parseSemVer(v: string): [number, number, number, number, string] {
  const m = v.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:[.-](.*))?$/);
  if (!m) return [0, 0, 0, 0, v];
  return [
    parseInt(m[1] ?? '0', 10),
    parseInt(m[2] ?? '0', 10),
    parseInt(m[3] ?? '0', 10),
    parseInt(m[4] ?? '0', 10),
    m[5] ?? '',
  ];
}
