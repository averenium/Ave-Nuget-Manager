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
  | { kind: 'project'; projectPath: string };

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
  error?: string;
}

export interface AvailablePackage {
  id: string;
  latestVersion: string;
  sourceName: string;
  description?: string;
}

export interface FrameworkDependencies {
  framework: string;
  packages: Array<{ id: string; versionRange: string }>;
}

export interface PackageMetadata {
  id: string;
  version: string;
  authors: string;
  projectUrl?: string;
  licenseUrl?: string;
  description: string;
  tags: string[];
  /** ISO 8601 publication date */
  published?: string;
  dependencies: FrameworkDependencies[];
  targetFrameworks: string[];
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
}

export interface NuGetConfigFile {
  filePath: string;
  sources: PackageSource[];
  /** Set when the file could not be read or parsed */
  parseError?: string;
}

// ─────────────────────────────────────────────
// Log
// ─────────────────────────────────────────────

export interface LogEntry {
  id: string;
  timestamp: string;
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
