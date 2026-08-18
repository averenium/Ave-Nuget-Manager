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
}

export interface ImplicitPackage {
  id: string;
  resolvedVersion: string;
  projectPath: string;
  /** Direct parent package that pulled this in */
  dependsOn?: string;
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
}

export interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// ─────────────────────────────────────────────
// Operations
// ─────────────────────────────────────────────

export interface OperationFailure {
  projectPath: string;
  stderr: string;
  exitCode: number | null;
}
