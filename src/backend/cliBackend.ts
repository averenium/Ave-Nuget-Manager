import * as path from 'path';
import type { CliRunner } from '../cliRunner';
import type {
  InstalledPackage,
  ImplicitPackage,
  AvailablePackage,
  PackageMetadata,
  FrameworkDependencies,
  CliResult,
} from '../types';
import type { INuGetBackend } from './INuGetBackend';

// ─── dotnet JSON output shapes ────────────────────────────────────────────────

interface DotnetListOutput {
  version: number;
  parameters: string;
  problems?: unknown[];
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
      // Older SDK format: nested versions array
      versions?: Array<{ version: string }>;
    }>;
  }>;
}

const TIMEOUT_MS = 30_000;

export class CliBackend implements INuGetBackend {
  constructor(private readonly runner: CliRunner) {}

  // ── listAllForSolution ─────────────────────────────────────────────────────

  async listAllForSolution(solutionPath: string): Promise<{
    installed: InstalledPackage[];
    implicit: ImplicitPackage[];
  }> {
    // One call: --include-transitive returns both topLevelPackages and transitivePackages
    const result = await this.runner.run({
      args: ['list', solutionPath, 'package', '--include-transitive', '--format', 'json'],
      cwd: path.dirname(solutionPath),
      timeoutMs: TIMEOUT_MS,
    });

    if (result.timedOut || result.exitCode !== 0) {
      return { installed: [], implicit: [] };
    }

    return {
      installed: this._parseAllProjectsInstalled(result.stdout),
      implicit:  this._parseAllProjectsTransitive(result.stdout),
    };
  }

  // ── listAllForProject ──────────────────────────────────────────────────────

  async listAllForProject(projectPath: string): Promise<{
    installed: InstalledPackage[];
    implicit: ImplicitPackage[];
  }> {
    const result = await this.runner.run({
      args: ['list', projectPath, 'package', '--include-transitive', '--format', 'json'],
      cwd: path.dirname(projectPath),
      timeoutMs: TIMEOUT_MS,
    });

    if (result.timedOut || result.exitCode !== 0) {
      return { installed: [], implicit: [] };
    }

    return {
      installed: this._parseInstalledPackages(result.stdout, projectPath),
      implicit:  this._parseTransitivePackages(result.stdout, projectPath),
    };
  }

  // ── listInstalled ──────────────────────────────────────────────────────────

  async listInstalled(projectPath: string): Promise<InstalledPackage[]> {
    const result = await this.runner.run({
      args: ['list', projectPath, 'package', '--format', 'json'],
      cwd: path.dirname(projectPath),
      timeoutMs: TIMEOUT_MS,
    });

    if (result.timedOut || result.exitCode !== 0) {
      return [];
    }

    return this._parseInstalledPackages(result.stdout, projectPath);
  }

  // ── listTransitive ─────────────────────────────────────────────────────────

  async listTransitive(projectPath: string): Promise<ImplicitPackage[]> {
    const result = await this.runner.run({
      args: ['list', projectPath, 'package', '--include-transitive', '--format', 'json'],
      cwd: path.dirname(projectPath),
      timeoutMs: TIMEOUT_MS,
    });

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
    prerelease = true,
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

  async getAllVersions(packageId: string, configFiles: string[], prerelease = true): Promise<string[]> {
    const versionSets = await Promise.all(
      configFiles.map((cf) => this._fetchVersionsFromConfigFile(packageId, cf, prerelease)),
    );

    const seen = new Set<string>();
    const all: string[] = [];
    for (const vs of versionSets) {
      for (const v of vs) {
        if (!seen.has(v)) {
          seen.add(v);
          all.push(v);
        }
      }
    }

    // Sort descending by SemVer
    return all.sort((a, b) => compareSemVerDesc(a, b));
  }

  // ── getMetadata ────────────────────────────────────────────────────────────

  async getMetadata(
    packageId: string,
    version: string,
    configFiles: string[],
  ): Promise<PackageMetadata> {
    // dotnet package search returns limited metadata; use first config file
    // that yields a result for the exact package+version.
    for (const cf of configFiles) {
      const result = await this.runner.run({
        args: [
          'package', 'search', packageId,
          '--exact-match',
          '--prerelease',
          '--configfile', cf,
          '--format', 'json',
        ],
        cwd: path.dirname(cf),
        timeoutMs: TIMEOUT_MS,
      });

      if (result.timedOut || result.exitCode !== 0) continue;

      const metadata = this._parseMetadata(result.stdout, packageId, version);
      if (metadata) return metadata;
    }

    // Fallback: return a minimal metadata object
    return {
      id: packageId,
      version,
      authors: '',
      description: '',
      tags: [],
      dependencies: [],
      targetFrameworks: [],
    };
  }

  // ── enrichPackage ─────────────────────────────────────────────────────────

  async enrichPackage(
    packageId: string,
    configFiles: string[],
    prerelease = true,
  ): Promise<{ latestVersion: string; sourceName: string; versions: string[] }> {
    // One search per configFile, stop at first hit to avoid redundant calls
    for (const cf of configFiles) {
      const args = [
        'package', 'search', packageId,
        '--exact-match',
        '--configfile', cf,
        '--format', 'json',
      ];
      if (prerelease) args.push('--prerelease');

      const result = await this.runner.run({
        args,
        cwd: path.dirname(cf),
        timeoutMs: TIMEOUT_MS,
      });

      if (result.timedOut || result.exitCode !== 0) continue;

      let output: DotnetSearchOutput;
      try { output = JSON.parse(result.stdout) as DotnetSearchOutput; }
      catch { continue; }

      // Collect all versions from this response, find the highest
      const versions: string[] = [];
      let sourceName = '';

      for (const sourceResult of output.searchResult ?? []) {
        for (const pkg of sourceResult.packages ?? []) {
          if (pkg.id.toLowerCase() !== packageId.toLowerCase()) continue;
          // Each entry is one version (--exact-match format)
          const v = pkg.version ?? pkg.latestVersion ?? '';
          if (v && !versions.includes(v)) versions.push(v);
          if (!sourceName && sourceResult.sourceName) {
            sourceName = sourceResult.sourceName;
          }
        }
      }

      if (versions.length > 0) {
        const sorted = versions.sort((a, b) => compareSemVerDesc(a, b));
        return { latestVersion: sorted[0], sourceName, versions: sorted };
      }
    }

    return { latestVersion: '', sourceName: '', versions: [] };
  }

  // ── installPackage ─────────────────────────────────────────────────────────

  async installPackage(
    projectPath: string,
    packageId: string,
    version: string,
  ): Promise<CliResult> {
    return this.runner.run({
      args: ['add', projectPath, 'package', packageId, '--version', version],
      cwd: path.dirname(projectPath),
      timeoutMs: TIMEOUT_MS,
    });
  }

  // ── removePackage ─────────────────────────────────────────────────────────

  async removePackage(projectPath: string, packageId: string): Promise<CliResult> {
    return this.runner.run({
      args: ['remove', projectPath, 'package', packageId],
      cwd: path.dirname(projectPath),
      timeoutMs: TIMEOUT_MS,
    });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private _parseAllProjectsInstalled(stdout: string): InstalledPackage[] {
    let output: DotnetListOutput;
    try { output = JSON.parse(stdout) as DotnetListOutput; }
    catch { return []; }

    const packages: InstalledPackage[] = [];
    for (const project of output.projects ?? []) {
      for (const fw of project.frameworks ?? []) {
        for (const pkg of fw.topLevelPackages ?? []) {
          if (pkg.autoReferenced === 'true') continue;
          packages.push({
            id: pkg.id,
            requestedVersion: pkg.requestedVersion,
            resolvedVersion: pkg.resolvedVersion,
            projectPath: project.path,
          });
        }
      }
    }
    return packages;
  }

  private _parseAllProjectsTransitive(stdout: string): ImplicitPackage[] {
    let output: DotnetListOutput;
    try { output = JSON.parse(stdout) as DotnetListOutput; }
    catch { return []; }

    const packages: ImplicitPackage[] = [];
    for (const project of output.projects ?? []) {
      for (const fw of project.frameworks ?? []) {
        for (const pkg of fw.transitivePackages ?? []) {
          packages.push({
            id: pkg.id,
            resolvedVersion: pkg.resolvedVersion,
            projectPath: project.path,
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
    let output: DotnetListOutput;
    try {
      output = JSON.parse(stdout) as DotnetListOutput;
    } catch {
      return [];
    }

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
    let output: DotnetListOutput;
    try {
      output = JSON.parse(stdout) as DotnetListOutput;
    } catch {
      return [];
    }

    const packages: ImplicitPackage[] = [];
    for (const project of output.projects ?? []) {
      for (const fw of project.frameworks ?? []) {
        for (const pkg of fw.transitivePackages ?? []) {
          packages.push({
            id: pkg.id,
            resolvedVersion: pkg.resolvedVersion,
            projectPath,
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
    prerelease = true,
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
    prerelease = true,
  ): Promise<string[]> {
    const args = [
      'package', 'search', packageId,
      '--exact-match',
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

    const versions: string[] = [];
    for (const sourceResult of output.searchResult ?? []) {
      for (const pkg of sourceResult.packages ?? []) {
        if (pkg.id.toLowerCase() !== packageId.toLowerCase()) continue;

        // Format 1 (--exact-match): each package object = one version, field is "version"
        if (pkg.version) {
          if (!versions.includes(pkg.version)) versions.push(pkg.version);
        }
        // Format 2 (regular search, nested array): versions: [{version: "x.y.z"}]
        for (const v of pkg.versions ?? []) {
          if (!versions.includes(v.version)) versions.push(v.version);
        }
        // Format 3 (regular search): single latestVersion field
        if (pkg.latestVersion && !versions.includes(pkg.latestVersion)) {
          versions.push(pkg.latestVersion);
        }
      }
    }
    return versions;
  }

  private _parseMetadata(
    stdout: string,
    packageId: string,
    _version: string,
  ): PackageMetadata | null {
    let output: DotnetSearchOutput;
    try {
      output = JSON.parse(stdout) as DotnetSearchOutput;
    } catch {
      return null;
    }

    for (const sourceResult of output.searchResult ?? []) {
      for (const pkg of sourceResult.packages ?? []) {
        if (pkg.id.toLowerCase() !== packageId.toLowerCase()) continue;

        const tags = pkg.tags
          ? pkg.tags.split(/[\s,]+/).filter(Boolean)
          : [];

        // dotnet package search doesn't return per-framework dependencies;
        // we return an empty dependency list here. A future HttpBackend will
        // populate this from the NuGet v3 registration API.
        const dependencies: FrameworkDependencies[] = [];
        const targetFrameworks: string[] = [];

        return {
          id: pkg.id,
          version: pkg.latestVersion ?? pkg.version ?? _version,
          authors: pkg.authors ?? '',
          projectUrl: pkg.projectUrl,
          licenseUrl: pkg.licenseUrl,
          description: pkg.description ?? '',
          tags,
          dependencies,
          targetFrameworks,
        };
      }
    }
    return null;
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
