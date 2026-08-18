import type {
  WorkspaceScope,
  InstalledPackage,
  ImplicitPackage,
  AvailablePackage,
  PackageMetadata,
  PackageSource,
  NuGetConfigFile,
  LogEntry,
  OperationFailure,
} from './types';

// ─────────────────────────────────────────────
// Webview → Extension Host
// ─────────────────────────────────────────────

export type WebviewMessage =
  // Initialisation
  | { type: 'WEBVIEW_READY' }

  // Packages tab
  | { type: 'SEARCH_PACKAGES'; query: string; enabledSourceNames: string[]; prerelease: boolean }
  | { type: 'SET_PRERELEASE_SETTING'; prerelease: boolean }
  | { type: 'GET_PACKAGE_METADATA'; packageId: string; version?: string; configFiles: string[] }
  | { type: 'GET_ALL_VERSIONS'; packageId: string; configFiles: string[]; prerelease: boolean }

  // Install / Remove — Project scope (single project)
  | { type: 'INSTALL_PACKAGE'; projectPath: string; packageId: string; version: string }
  | { type: 'REMOVE_PACKAGE'; projectPath: string; packageId: string }

  // Install / Remove — Solution scope (after popup confirmation)
  | { type: 'INSTALL_PACKAGE_MULTI'; projects: string[]; packageId: string; version: string }
  | { type: 'REMOVE_PACKAGE_MULTI'; projects: string[]; packageId: string }

  // Refresh
  | { type: 'REFRESH_PACKAGES' }
  | { type: 'FORCE_REFRESH' }   // clears cache then refreshes

  // Sources tab
  | { type: 'OPEN_CONFIG_FILE'; filePath: string }

  // Log tab
  | { type: 'GET_LOG_ENTRIES' };

// ─────────────────────────────────────────────
// Extension Host → Webview
// ─────────────────────────────────────────────

export type ExtensionMessage =
  // Initialisation — sent in response to WEBVIEW_READY
  | {
      type: 'INIT_STATE';
      scope: WorkspaceScope;
      sources: PackageSource[];
      configChain: NuGetConfigFile[];
      includePrerelease: boolean;
    }

  // Packages
  | { type: 'INSTALLED_PACKAGES'; packages: InstalledPackage[] }
  | { type: 'IMPLICIT_PACKAGES'; packages: ImplicitPackage[] }
  | { type: 'PACKAGE_INFO_UPDATE'; packageId: string; latestVersion: string; sourceName: string }
  | { type: 'ENRICH_PROGRESS'; done: number; total: number }
  | { type: 'SEARCH_RESULTS'; query: string; packages: AvailablePackage[] }
  | { type: 'PACKAGE_METADATA'; metadata: PackageMetadata }
  | { type: 'ALL_VERSIONS'; packageId: string; versions: string[] }

  // Operation results
  | {
      type: 'OPERATION_SUCCESS';
      operation: 'install' | 'remove';
      packageId: string;
      affectedProjects: string[];
    }
  | {
      type: 'OPERATION_ERROR';
      operation: 'install' | 'remove';
      packageId: string;
      failures: OperationFailure[];
      /** Projects that succeeded despite others failing */
      succeededProjects: string[];
    }
  | { type: 'OPERATION_TIMEOUT'; command: string }

  // Sources
  | { type: 'CONFIG_CHAIN_UPDATE'; configChain: NuGetConfigFile[] }

  // Log
  | { type: 'LOG_ENTRIES'; entries: LogEntry[] }
  | { type: 'LOG_ENTRY_ADDED'; entry: LogEntry }

  // Errors
  | { type: 'DOTNET_NOT_FOUND' }
  | { type: 'ERROR'; message: string; details?: string };
