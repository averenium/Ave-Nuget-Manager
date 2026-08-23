import type {
  WorkspaceScope,
  InstalledPackage,
  ImplicitPackage,
  AvailablePackage,
  PackageMetadata,
  PackageSource,
  NuGetConfigFile,
  SourcesSnapshot,
  LogEntry,
  OperationFailure,
  BatchUpdateItem,
  BatchUpdateJob,
  BatchItemStatus,
  VulnerabilityFinding,
} from './types';
import type { SkillFamily, SkillInstallRow } from './agentSkillInstall';
import type { RoslynCap } from './roslynSdkCap';

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

  /** Restore project files snapshotted before a failed add (`onFailedUpdate: keep`). */
  | { type: 'ROLLBACK_FAILED_UPDATE' }

  /** Bump many packages; each item uses its own target version (prerelease already applied in latest). */
  | {
      type: 'UPDATE_PACKAGES_BATCH';
      kind: 'all' | 'family' | 'other';
      family?: string;
      includePrerelease: boolean;
      items: BatchUpdateItem[];
    }
  | { type: 'CANCEL_BATCH_UPDATE' }

  // Refresh
  | { type: 'REFRESH_PACKAGES' }
  | { type: 'RESTORE_PACKAGES' }  // list + restore, keeps latest-version cache
  | { type: 'FORCE_REFRESH' }   // clears cache then refreshes

  // Sources tab
  | { type: 'OPEN_CONFIG_FILE'; filePath: string; sourceName?: string }
  | { type: 'COPY_TEXT'; text: string }
  | { type: 'OPEN_URL'; url: string }
  | { type: 'SET_SOURCE_ENABLED'; name: string; configFilePath: string; enabled: boolean; kind?: 'package' | 'audit'; url?: string }
  | {
      type: 'SET_SOURCE_CONNECTION_FLAGS';
      name: string;
      configFilePath: string;
      allowInsecureConnections: boolean;
      disableTlsCertificateValidation: boolean;
    }
  | {
      type: 'SET_SOURCE_SECRETS';
      name: string;
      configFilePath: string;
      url: string;
      username?: string;
      /** Empty = keep existing password. */
      password?: string;
      /** Empty = keep existing API key. */
      apiKey?: string;
      clearCredentials?: boolean;
      clearApiKey?: boolean;
    }

  // Log tab
  | { type: 'GET_LOG_ENTRIES' }
  | { type: 'START_TRACE' }
  | { type: 'STOP_TRACE' }
  | { type: 'CLEAR_LOG' }
  /** Click the solution/project name in the panel tab bar. */
  | { type: 'SELECT_SCOPE' }
  /** Add/remove an id in workspace `blockedPackages`. */
  | { type: 'SET_PACKAGE_BLOCKED'; packageId: string; blocked: boolean }
  /** Host `showInformationMessage` (toast). */
  | { type: 'SHOW_TOAST'; message: string }
  /** Agents tab — Install… (QuickPick) or Update in place when `updateExisting`. */
  | { type: 'INSTALL_AGENT_SKILL'; updateExisting?: boolean }
  /** React / window crash in the webview — host writes Output Channel. */
  | { type: 'WEBVIEW_ERROR'; source: string; message: string; stack?: string };

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
      snapshot: SourcesSnapshot;
      includePrerelease: boolean;
      blockedPackages: string[];
      traceRecording: boolean;
      bundledVersion: string;
      detected: SkillFamily[];
      installs: SkillInstallRow[];
      /** `null` when `csc -version` failed — Groups omit CodeAnalysis ids. */
      roslynCap: RoslynCap | null;
      /** Host OS is Windows — `<apikeys>` DPAPI works; Copy / `<clearTextApiKeys>` UI is hidden. */
      isWindows: boolean;
    }

  // Packages
  | { type: 'INSTALLED_PACKAGES'; packages: InstalledPackage[] }
  | { type: 'IMPLICIT_PACKAGES'; packages: ImplicitPackage[] }
  | { type: 'INSTALLED_PACKAGES_PATCH'; packages: InstalledPackage[] }
  | { type: 'PACKAGE_INFO_UPDATE'; packageId: string; latestVersion: string; sourceName: string; versions?: string[] }
  | { type: 'ENRICH_PROGRESS'; done: number; total: number }
  | { type: 'VULNERABILITIES'; findings: VulnerabilityFinding[] }
  /** Quiet hint when `dotnet list --vulnerable` was skipped (Nexus / no VDB). */
  | {
      type: 'VULN_SCAN_HINT'; 
      show: boolean;
      fingerprint: string;
      message: string;
      configFilePath?: string;
    }
  | { type: 'BLOCKED_PACKAGES'; packageIds: string[] }
  | { type: 'SEARCH_RESULTS'; query: string; packages: AvailablePackage[] }
  | { type: 'PACKAGE_METADATA'; metadata: PackageMetadata }
  | { type: 'ALL_VERSIONS'; packageId: string; versions: string[] }

  /** Restore / Force refresh re-read of the SDK compiler. */
  | { type: 'ROSLYN_CAP'; cap: RoslynCap | null }

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
      rollbackMode?: 'rollback' | 'keep';
      rollbackApplied?: boolean;
      canRollback?: boolean;
    }
  | { type: 'ROLLBACK_COMPLETE'; packageId: string }
  | { type: 'OPERATION_TIMEOUT'; command: string }

  | { type: 'BATCH_UPDATE_STARTED'; job: BatchUpdateJob }
  | {
      type: 'BATCH_UPDATE_ITEM';
      jobId: string;
      packageId: string;
      status: BatchItemStatus;
      succeededProjects: string[];
      /** Finished project attempts (success or fail). Falls back to succeededProjects. */
      completedProjects?: string[];
      error?: string;
    }
  | { type: 'BATCH_UPDATE_FINISHED'; jobId: string; canRollback?: boolean; cancelled?: boolean }

  /** Restore/force refresh began — drop the previous operation banner so restore can replace it. */
  | { type: 'REFRESH_STARTED'; kind: 'restore' | 'refresh' }
  /** Restore + package list + vuln list finished. Enrich may still run after `kind: 'refresh'`. */
  | { type: 'REFRESH_FINISHED' }

  // Sources
  | {
      type: 'CONFIG_CHAIN_UPDATE';
      configChain: NuGetConfigFile[];
      sources: PackageSource[];
      snapshot: SourcesSnapshot;
    }

  // Log
  | { type: 'LOG_ENTRIES'; entries: LogEntry[] }
  | { type: 'LOG_ENTRY_ADDED'; entry: LogEntry }
  | { type: 'LOG_CLEARED' }
  | { type: 'TRACE_STATE'; recording: boolean }
  | { type: 'SKILL_STATUS'; bundledVersion: string; detected: SkillFamily[]; installs: SkillInstallRow[] }

  // Errors
  | { type: 'DOTNET_NOT_FOUND' }
  | { type: 'ERROR'; message: string; details?: string };
