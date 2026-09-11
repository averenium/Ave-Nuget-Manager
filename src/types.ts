// ─────────────────────────────────────────────
// Workspace Scope
// ─────────────────────────────────────────────

export interface ProjectInfo {
  /** Display name without extension */
  name: string;
  /** Path relative to the solution directory */
  relativePath: string;
  /** Absolute path to the .csproj / .fsproj file */
  absolutePath: string;
}

export type WorkspaceScope =
  | { kind: 'solution'; solutionPath: string; projects: ProjectInfo[] }
  | { kind: 'project'; projectPath: string }
  /** A folder containing multiple projects with no .sln/.slnx to tie them together. */
  | { kind: 'folder'; folderPath: string; projects: ProjectInfo[] };

// ─────────────────────────────────────────────
// Packages
// ─────────────────────────────────────────────

export interface InstalledPackage {
  id: string;
  /** Version explicitly requested in .csproj / project file */
  requestedVersion: string;
  /** Version actually resolved by NuGet */
  resolvedVersion: string;
  projectPath: string;
  /** Source name (lowercase) — may be missing when dotnet list doesn't report it */
  sourceName?: string;
  /** Latest available version from configured sources — undefined until fetched */
  latestVersion?: string;
  /** Enrich version list (prerelease already applied). Used to cap Groups targets. */
  versions?: string[];
  /** Implicit (transitive) versions derived from this package */
  implicitVersions?: string[];
  /** Restore-graph deps reachable among installed + implicit ids. */
  dependencies?: string[];
  /** TFM from `dotnet list` (`net8.0`). RID is not in list JSON. */
  framework?: string;
}

export type VulnerabilitySeverity = 'critical' | 'high' | 'moderate' | 'low' | 'unknown';

/**
 * One advisory for an installed or transitive package.
 * Built-in `dotnet list --vulnerable` and user scripts both emit this shape.
 */
export interface VulnerabilityFinding {
  packageId: string;
  /** Resolved version this finding applies to; omit if it applies to any installed version. */
  version?: string;
  severity: VulnerabilitySeverity;
  /** Advisory id (GHSA-…, CVE-…) when the source provides one. */
  id?: string;
  title?: string;
  url?: string;
  /** Provider id: `dotnet`, script basename, or a custom source string. */
  source: string;
}

export interface ImplicitPackage {
  id: string;
  resolvedVersion: string;
  projectPath: string;
  /** Direct parent package that pulled this in */
  dependsOn?: string;
  /** Restore-graph deps reachable among installed + implicit ids. */
  dependencies?: string[];
  /** TFM from `dotnet list` (`net8.0`). RID is not in list JSON. */
  framework?: string;
}

/** Result of `dotnet list … package`. `error` means the CLI failed and lists could not be parsed. */
export interface PackageListResult {
  installed: InstalledPackage[];
  implicit: ImplicitPackage[];
  /**
   * Every target framework each project declares, keyed by project path (#82).
   * `dotnet list` reports a project's frameworks whether or not any of them
   * holds a package — measured — so this is the one place the full set is known
   * without reading the project file, and it is what says a package could be
   * referenced from a framework it is currently missing from.
   */
  projectFrameworks?: Record<string, string[]>;
  error?: string;
}

export interface AvailablePackage {
  id: string;
  latestVersion: string;
  sourceName: string;
  description?: string;
}

/** Search-derived fields for one specific version, as returned alongside `enrichPackage`'s version list (#86 Part 1) — not the full `PackageMetadata` shape, since search never has authors/license/tags/dependencies. */
export interface SearchedVersionMetadata {
  description?: string;
  projectUrl?: string;
  authors?: string;
  licenseUrl?: string;
  tags?: string;
  /** This exact version, as flagged by the feed at search time — not from the restore-graph vulnerability scan (`dotnet list --vulnerable`), which stays the source of severity/advisory-id detail and the only thing that catches a transitive package. */
  vulnerable?: boolean;
  /** Feed answer, present only when the package (as of this version) is deprecated — the upstream text usually names the replacement. Never in a nuspec. */
  deprecation?: string;
}

export interface EnrichedPackageInfo {
  latestVersion: string;
  sourceName: string;
  versions: string[];
  /** Keyed by exact version string — `--verbosity detailed` returns these per version at no extra round trip, since `enrichPackage` already fetches the version list this way (#86). Optional so existing callers/mocks that only care about the version list need not construct it. */
  metadataByVersion?: Record<string, SearchedVersionMetadata>;
}

/** One row in the Dependencies section (#86), resolved from `project.assets.json` — declared range plus what actually resolved, recursively. */
export interface DependencyRow {
  id: string;
  /** Absent only for a dependency whose own library entry wasn't found in this target (e.g. a project reference). */
  resolvedVersion?: string;
  declaredRange: string;
  status: 'ok' | 'outside-range' | 'major-lifted';
  showDeclared: boolean;
  children: DependencyRow[];
}

export interface PackageDependencyInfo {
  framework: string;
  /** The TFM folder actually selected under `lib/`, e.g. "net10.0" — from `compile`/`runtime` asset paths. */
  selectedAsset?: string;
  rows: DependencyRow[];
}

export interface PackageLicense {
  /** `expression` = SPDX string (e.g. "MIT"), nothing to link. `file` = a relative path to a license file bundled in the package — also nothing to link unless `licenseUrl` is present too. */
  type: 'expression' | 'file';
  value: string;
}

export interface PackageRepository {
  url: string;
  /** Commit hash the package was built from, when the publisher included one. */
  commit?: string;
}

export interface PackageMetadata {
  id: string;
  version: string;
  authors: string;
  /** Comma-separated in the source `.nuspec`/feed field; kept as one string like `authors`. */
  owners?: string;
  projectUrl?: string;
  /** Deprecated by NuGet; kept as a fallback link when `license` is absent or is a `file` reference. */
  licenseUrl?: string;
  license?: PackageLicense;
  copyright?: string;
  repository?: PackageRepository;
  description: string;
  tags: string[];
  /** ISO 8601 publication date. Feed-only — never derived from a local file timestamp. */
  published?: string;
  /** Feed-only deprecation notice for this exact version (usually names the replacement package). A nuspec never has this — same as `published`. */
  deprecation?: string;
  /** `lib/<tfm>/` folders the resolved package declares support for, from `project.assets.json`'s `libraries[id/version].files` — installed packages only (#86); absent for a not-installed / search-only package, which search cannot supply this for. */
  supportedFrameworks?: string[];
  /** RIDs the package ships native assets for — directory names under the extracted package folder's `runtimes/`. Installed packages only. */
  runtimeIdentifiers?: string[];
  /** This package's own dependency tree (declared range vs. resolved version), from `project.assets.json`. Installed packages only — a not-yet-installed package has no restore graph to read one from. */
  dependencyTree?: PackageDependencyInfo;
}

// ─────────────────────────────────────────────
// Sources / NuGet Config
// ─────────────────────────────────────────────

export interface PackageSource {
  name: string;
  url: string;
  enabled: boolean;
  /** Path to the nuget.config file that declared this source */
  configFilePath: string;
  /** `allowInsecureConnections="true"` on this `<add>` (HTTP). */
  allowInsecureConnections?: boolean;
  /** `disableTLSCertificateValidation="true"` on this `<add>`. */
  disableTlsCertificateValidation?: boolean;
  /** Explicit `protocolVersion` on this `<add>`, if 2 or 3. */
  protocolVersion?: '2' | '3';
}

export interface NuGetConfigFile {
  filePath: string;
  sources: PackageSource[];
  /** `<clear />` in `<packageSources>` — farther files do not contribute package sources. */
  packageSourcesCleared?: boolean;
  /** `<auditSources>` in this file (not inherited). */
  auditSources?: PackageSource[];
  /** `<clear />` in `<auditSources>` — farther files do not contribute audit sources. */
  auditSourcesCleared?: boolean;
  /** Keys under `<packageSourceCredentials>` — names only, never passwords. */
  credentialKeys?: string[];
  /** Username per source key; passwords are never stored here. */
  credentialUsernames?: Record<string, string>;
  /** `<apikeys>` keys (feed URLs). Values are never stored. */
  apiKeyUrls?: string[];
  /**
   * Entries from `<disabledPackageSources>`. `disabled: false` is an explicit
   * re-enable (`value="false"`) that overrides a farther file.
   */
  disabledPackageSources?: Array<{ name: string; disabled: boolean }>;
  /** `<clear />` in `<disabledPackageSources>` — ignore farther disable lists. */
  disabledPackageSourcesCleared?: boolean;
  /** `<packageSourceMapping>` for this file (not yet merged). */
  packageSourceMapping?: PackageSourceMapping[];
  /** `<clear />` in `<packageSourceMapping>` — ignore farther mappings. */
  packageSourceMappingCleared?: boolean;
  /** Computer-level file under Program Files / `/etc/opt/NuGet/Config`. */
  isMachineWide?: boolean;
  /** Set when the file could not be read or parsed */
  parseError?: string;
}

export interface PackageSourceMapping {
  sourceName: string;
  patterns: string[];
}

export type FeedKind = 'nuget.org' | 'data.nuget.org' | 'http' | 'local';

export interface EffectiveSourceRow {
  name: string;
  url: string;
  enabled: boolean;
  kind: FeedKind;
  hasCredentials: boolean;
  /** Username from config, if present. Password is never sent. */
  username?: string;
  hasApiKey: boolean;
  allowInsecureConnections?: boolean;
  disableTlsCertificateValidation?: boolean;
  configFilePath: string;
  /** Patterns from effective `<packageSourceMapping>` for this source. Empty when mapping is off or this source is unmapped. */
  mappingPatterns?: string[];
  /** Unexpanded `value` from XML when it contained `%VAR%`. */
  urlRaw?: string;
  /** Effective NuGet protocol for HTTP feeds. UI badges only `2`. */
  protocolVersion?: '2' | '3';
}

export type ChainChangeKind =
  | 'added'
  | 'replaced'
  | 'disabled'
  | 'cleared-package'
  | 'cleared-audit'
  | 'overridden';

export interface ChainChange {
  kind: ChainChangeKind;
  sourceKind?: 'package' | 'audit';
  name?: string;
  url?: string;
  previousUrl?: string;
  byFilePath?: string;
}

export interface ConfigChainFileView {
  filePath: string;
  displayPath: string;
  isGlobal: boolean;
  isMachineWide?: boolean;
  parseError?: string;
  packageChanges: ChainChange[];
  auditChanges: ChainChange[];
  /** Sources declared in this file (host-expanded URLs). */
  packageSources: EffectiveSourceRow[];
  auditSources: EffectiveSourceRow[];
}

export type ExtraConfigRole = 'on-chain' | 'applies' | 'dead';

export interface ExtraConfigFileView {
  filePath: string;
  displayPath: string;
  isGlobal: boolean;
  isMachineWide?: boolean;
  role: ExtraConfigRole;
  appliesToProjectNames: string[];
  parseError?: string;
  /** Sources declared in this file (host-expanded URLs). Empty when the file is only a path stub. */
  packageSources: EffectiveSourceRow[];
  auditSources: EffectiveSourceRow[];
}

export type ConfigConflictKind =
  | 'same-key-different-url'
  | 'same-url-different-keys'
  | 'clear-drops-parent'
  | 'audit-mismatch'
  | 'off-chain-applies';

export interface ConfigConflict {
  kind: ConfigConflictKind;
  message: string;
  filePaths: string[];
}

export interface SourcesSnapshot {
  effectivePackageSources: EffectiveSourceRow[];
  effectiveAuditSources: EffectiveSourceRow[];
  chain: ConfigChainFileView[];
  extraConfigs: ExtraConfigFileView[];
  /** True when the workspace nuget.config scan hit the find-files cap. */
  extraConfigsTruncated?: boolean;
  conflicts: ConfigConflict[];
  /** Merged `<packageSourceMapping>`. Empty means mapping is not in effect. */
  packageSourceMapping: PackageSourceMapping[];
}

// ─────────────────────────────────────────────
// Log
// ─────────────────────────────────────────────

/**
 * `cli` — a real `dotnet` subprocess. `edit` — a synthetic, non-CLI file
 * mutation (PackageReference, nuget.config). `scan` — a vulnerability-scan
 * decision (e.g. skipped). `info`/`error` — routed from `Logger.info`/`error`,
 * previously Output-Channel-only (#58).
 */
export type LogEntryKind = 'cli' | 'edit' | 'scan' | 'info' | 'error';

export interface LogEntry {
  id: string;
  timestamp: string;
  kind: LogEntryKind;
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** Elapsed time in milliseconds */
  durationMs: number;
}

// ─────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────

export interface CliCommand {
  /** Arguments passed to `dotnet` (first element onwards), e.g. ['list', '/path', 'package'] */
  args: string[];
  /** Working directory for the child process */
  cwd: string;
  timeoutMs: number;
  /** Kill the process when aborted (batch Stop). */
  signal?: AbortSignal;
}

export interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when `signal` aborted the process (not a timeout). */
  cancelled?: boolean;
}

// ─────────────────────────────────────────────
// Operations
// ─────────────────────────────────────────────

export interface OperationFailure {
  projectPath: string;
  stderr: string;
  exitCode: number | null;
  /** Version in the project file before the failed add; `null` if it was a new install. */
  previousVersion?: string | null;
  attemptedVersion?: string;
}

export type BatchUpdateKind = 'all' | 'family' | 'other';

export type BatchItemStatus = 'pending' | 'running' | 'ok' | 'error' | 'timeout' | 'cancelled';

/** One package to bump in a batch (possibly several projects). */
export interface BatchUpdateItem {
  packageId: string;
  fromVersion: string;
  toVersion: string;
  projects: string[];
  /**
   * TFM this item is confined to, for a package pinned per target framework
   * (#82). Absent for every ordinary item, which is nearly all of them.
   */
  framework?: string;
}

export interface BatchUpdateItemView extends BatchUpdateItem {
  status: BatchItemStatus;
  succeededProjects: string[];
  /** Projects whose install attempt finished (ok or fail), for live progress. */
  completedProjects: string[];
  error?: string;
}

export interface BatchUpdateJob {
  id: string;
  kind: BatchUpdateKind;
  family?: string;
  includePrerelease: boolean;
  startedAt: number;
  finishedAt?: number;
  /** After force refresh the result rows stay visible but lose success/fail colour. */
  stale?: boolean;
  items: BatchUpdateItemView[];
}
