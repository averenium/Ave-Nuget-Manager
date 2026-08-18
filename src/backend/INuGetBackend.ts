import type {
  InstalledPackage,
  ImplicitPackage,
  AvailablePackage,
  PackageMetadata,
  CliResult,
} from '../types';

/**
 * Abstraction over all NuGet data operations.
 * Current implementation: CliBackend (dotnet CLI).
 * Future: HttpBackend (NuGet HTTP API v3).
 *
 * All consumer code (NugetManagerViewProvider, WebviewMessageBroker) depends
 * exclusively on this interface — never on CliBackend directly.
 */
export interface INuGetBackend {
  /**
   * List all installed AND transitive packages for a solution in one CLI call.
   * CLI: `dotnet list <solutionPath> package --include-transitive --format json`
   */
  listAllForSolution(solutionPath: string): Promise<{
    installed: InstalledPackage[];
    implicit: ImplicitPackage[];
  }>;

  /**
   * List all installed AND transitive packages for a project in one CLI call.
   * CLI: `dotnet list <projectPath> package --include-transitive --format json`
   */
  listAllForProject(projectPath: string): Promise<{
    installed: InstalledPackage[];
    implicit: ImplicitPackage[];
  }>;

  /**
   * List packages explicitly referenced in a project file.
   * CLI: `dotnet list <projectPath> package --format json`
   * @deprecated Use listAllForProject for efficiency.
   */
  listInstalled(projectPath: string): Promise<InstalledPackage[]>;

  /**
   * List all transitive (implicit) packages for a project.
   * CLI: `dotnet list <projectPath> package --include-transitive --format json`
   */
  listTransitive(projectPath: string): Promise<ImplicitPackage[]>;

  /**
   * Search available packages across the given nuget.config files.
   * CLI: `dotnet package search <query> --configfile <path> --format json`
   * Called once per configFile; results are merged and deduplicated by id.
   *
   * @param query              Search string (≥2 chars enforced by the UI layer)
   * @param configFiles        Absolute paths to nuget.config files in the chain
   * @param enabledSourceNames Source names that are selected in the UI filter
   */
  searchPackages(
    query: string,
    configFiles: string[],
    enabledSourceNames: string[],
    prerelease?: boolean,
  ): Promise<AvailablePackage[]>;

  /**
   * Get all available versions of a package.
   * CLI: `dotnet package search <id> --exact-match --prerelease --configfile <path> --format json`
   * Results are merged across all config files and sorted descending by SemVer.
   */
  getAllVersions(packageId: string, configFiles: string[], prerelease?: boolean): Promise<string[]>;

  /**
   * Retrieve rich metadata for a specific package version.
   * CLI: `dotnet package search <id> --exact-match --prerelease --configfile <path> --format json`
   * Metadata beyond what dotnet CLI exposes (dependencies, frameworks) is
   * parsed from the NuGet v3 registration endpoint if needed.
   */
  getMetadata(
    packageId: string,
    version: string,
    configFiles: string[],
  ): Promise<PackageMetadata>;

  /**
   * Fetch latest version and source name for a single package in one CLI call.
   * CLI: `dotnet package search <id> --exact-match --prerelease --configfile <path> --format json`
   * Called once per configFile; results are merged across the chain.
   * Returns { latestVersion, sourceName } — used for enriching installed packages.
   */
  enrichPackage(
    packageId: string,
    configFiles: string[],
    prerelease?: boolean,
  ): Promise<{ latestVersion: string; sourceName: string; versions: string[] }>;

  /**
   * Install or update a package in a project.
   * CLI: `dotnet add <projectPath> package <packageId> --version <version>`
   */
  installPackage(
    projectPath: string,
    packageId: string,
    version: string,
  ): Promise<CliResult>;

  /**
   * Remove a package from a project.
   * CLI: `dotnet remove <projectPath> package <packageId>`
   */
  removePackage(projectPath: string, packageId: string): Promise<CliResult>;
}
