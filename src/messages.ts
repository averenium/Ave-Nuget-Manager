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
  VersionFlag,
  ScopeChoices,
} from './types';
import type { SkillFamily, SkillInstallRow } from './agentSkillInstall';
import type { RoslynCap } from './roslynSdkCap';
import type { CascadeMode, CascadeResult } from './cascadeResult';

/** What a person can do with a dependents proposal, on either surface that shows it (#109). */
export type CascadeAction = 'take-all' | 'update-only' | 'update-anyway' | 'block' | 'cancel' | 'never-offer';

// ─────────────────────────────────────────────
// Webview → Extension Host
// ─────────────────────────────────────────────

export type WebviewMessage =
  // Initialisation
  | { type: 'WEBVIEW_READY' }

  // Packages tab
  | { type: 'SEARCH_PACKAGES'; query: string; enabledSourceNames: string[]; prerelease: boolean }
  | { type: 'SET_PRERELEASE_SETTING'; prerelease: boolean }
  // `projectPath` is sent only when `version` is exactly the version already
  // installed there — it lets the host prefer that project's local .nuspec
  // (offline, complete) over the search response for the Info panel (#86).
  /**
   * `prerelease` travels with the request rather than being read on the host
   * from the settings store, the same way `GET_ALL_VERSIONS` already carries
   * it (#128). The picker and this request are asked from the same effect,
   * keyed on the same local value; reading the host's own setting instead
   * would open a window right after the toggle changes — the webview's state
   * flips synchronously, but the write to the settings store is asynchronous
   * — in which this request could still read the old value for one send.
   */
  | { type: 'GET_PACKAGE_METADATA'; packageId: string; version?: string; configFiles: string[]; projectPath?: string; prerelease: boolean }
  | { type: 'GET_ALL_VERSIONS'; packageId: string; configFiles: string[]; prerelease: boolean }
  /**
   * An implicit row for this id scrolled into view (#118). The feed is only
   * ever asked about a package somebody references directly — the enrich wave
   * never reaches a transitive id — so this is what asks on its behalf,
   * lazily, the moment its row is actually looked at rather than for every
   * transitive id a solution resolves.
   */
  | { type: 'WATCH_IMPLICIT_PACKAGE'; packageId: string }
  /** The row from `WATCH_IMPLICIT_PACKAGE` scrolled back out before it answered — cancel it (#118). */
  | { type: 'UNWATCH_IMPLICIT_PACKAGE'; packageId: string }
  /**
   * Everything that would change by taking this version, asked once (#114).
   *
   * Its own message rather than a field on the metadata answer, because the two
   * are about different versions. The Info panel describes the version that is
   * installed; the question here is about the version the selector is offering,
   * which on entry is the newest rather than the installed one. Tying the
   * comparison to the metadata compared the installed version with itself.
   *
   * The licence and the dependency difference are the same question about the
   * same two versions, answered from the same registration pages — two requests
   * for them would be two round trips, two debounces and two cancellations for
   * one user action. They travel together and are rendered apart: the licence in
   * Problems, where #89 put it, and the rest in its own band.
   */
  | { type: 'GET_VERSION_DIFF'; packageId: string; version: string; configFiles: string[] }

  /**
   * Ask which of a batch's packages would change licence, before the first
   * `dotnet add` (#89). Sent on the "update all" click; the batch waits for the
   * answer, and the answer always comes — an unknown never blocks a batch.
   */
  | {
      type: 'CHECK_BATCH_LICENSES';
      /** Echoed back, so an answer to a click the user has already moved past is ignored. */
      requestId: string;
      configFiles: string[];
      items: Array<{ packageId: string; fromVersion: string; toVersion: string }>;
    }

  /**
   * Which other installed packages have to move with this bump (#109). Sent
   * while an apply waits (`apply`, cases 1–2: a resolved version outside a
   * declared range) or when the person asks about a row (`asked`, case 3).
   * Echoed back so an answer to a click the person has moved past is ignored.
   */
  | {
      type: 'CHECK_DEPENDENTS';
      requestId: string;
      packageId: string;
      fromVersion: string;
      toVersion: string;
      projectPath: string;
      /** Every framework the project references this package under. */
      frameworks: string[];
      mode: CascadeMode;
      prerelease: boolean;
      configFiles: string[];
    }
  /**
   * Open (or reveal) the page that reviews the closure `requestId` answered
   * with (#109). `waiting` says a write is held for the answer, which decides
   * the actions the page offers and what closing it means.
   */
  | { type: 'CASCADE_OPEN_PAGE'; requestId: string; waiting: boolean }
  /**
   * Sent from the page itself, never from the panel. `recompute` asks for the
   * closure again with the same question; every other action is passed on to
   * the panel, which is where every write runs, and closes the page.
   */
  | { type: 'CASCADE_PAGE_ACTION'; requestId: string; action: CascadeAction | 'recompute' | 'close' }
  /** The panel has moved on from what the open page was computed for (#109). */
  | { type: 'CASCADE_PAGE_STALE'; requestId: string }

  // Install / Remove — Project scope (single project)
  // `framework` confines the write to one conditional PackageReference group,
  // for a project that pins this package per target framework (#82).
  // `acrossLines` writes conditional groups outside this version's major line
  // as well — only ever set after the user confirmed what that crosses (#82).
  | {
      type: 'INSTALL_PACKAGE';
      projectPath: string;
      packageId: string;
      version: string;
      framework?: string;
      acrossLines?: boolean;
    }
  /**
   * Turn one unconditional PackageReference into one per target framework, with
   * `framework` moving to `version` and the rest staying where they are (#82).
   * `dotnet add --framework` cannot do this on its own — it would edit the
   * shared line and move every framework with it.
   */
  | {
      type: 'SPLIT_PACKAGE_REFERENCE';
      projectPath: string;
      packageId: string;
      frameworks: string[];
      framework: string;
      version: string;
    }
  | { type: 'REMOVE_PACKAGE'; projectPath: string; packageId: string }

  // Install / Remove — Solution scope (after popup confirmation)
  // `frameworks` names one target framework for some of the projects (#82);
  // the rest are written the way they always were.
  | {
      type: 'INSTALL_PACKAGE_MULTI';
      projects: string[];
      packageId: string;
      version: string;
      /**
       * Target frameworks to write, per project (#82). Present only for a
       * project narrowed to some of its frameworks — a project taking the
       * package everywhere is absent here and written plainly, exactly as
       * before, so an ordinary install never starts growing conditional groups.
       */
      frameworks?: Record<string, string[]>;
      acrossLines?: boolean;
    }
  | { type: 'REMOVE_PACKAGE_MULTI'; projects: string[]; packageId: string }

  /** Switch the check before a write on or off (#109); written to the user's settings, or the workspace's when it already has a value. */
  | { type: 'SET_OFFER_DEPENDENT_UPDATES'; enabled: boolean }

  /** Restore project files snapshotted before a failed add (`onFailedUpdate: keep`). */
  | { type: 'ROLLBACK_FAILED_UPDATE' }

  /** Bump many packages; each item uses its own target version (prerelease already applied in latest). */
  | {
      type: 'UPDATE_PACKAGES_BATCH';
      kind: 'all' | 'family' | 'other';
      family?: string;
      includePrerelease: boolean;
      items: BatchUpdateItem[];
      /**
       * The items only make sense as one change (#109): each is written without
       * restoring, and the project is restored once when all are in. Written one
       * by one, the first is refused by NuGet for disagreeing with a package that
       * has not moved yet — a downgrade of a package its dependent still needs.
       */
      together?: boolean;
    }
  | { type: 'CANCEL_BATCH_UPDATE' }

  // Refresh
  | { type: 'REFRESH_PACKAGES' }
  | { type: 'RESTORE_PACKAGES' }  // list + restore, keeps latest-version cache
  | { type: 'FORCE_REFRESH' }   // clears cache then refreshes

  // Sources tab
  | { type: 'OPEN_CONFIG_FILE'; filePath: string; sourceName?: string }

  /**
   * Open the licence file an installed package carries (#89). The path is one
   * the extension host found inside the extracted package, never one the
   * webview composed.
   */
  | { type: 'OPEN_LICENSE_FILE'; filePath: string }
  /**
   * Open the changelog the installed package shipped (#125). Same read-only
   * contract as `OPEN_LICENSE_FILE`, and the same reason for a message of its
   * own rather than reusing that one: the path is one the extension host
   * found, never one the webview composed.
   */
  | { type: 'OPEN_CHANGELOG_FILE'; filePath: string }
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
      type: 'SET_SOURCE_MAPPING';
      name: string;
      configFilePath: string;
      /** Empty clears this source's block — the whole `packageSourceMapping` section is removed if nothing else is left. */
      patterns: string[];
    }
  | {
      type: 'ADD_PACKAGE_SOURCE';
      configFilePath: string;
      name: string;
      url: string;
      protocolVersion?: '2' | '3';
    }
  | { type: 'REMOVE_PACKAGE_SOURCE'; configFilePath: string; name: string }
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
  /** Sanitizes `text` (same redaction as a trace zip — paths, hostname, proxy creds) and copies it (#58). */
  | { type: 'COPY_LOG_SANITIZED'; text: string }
  /** Reveals the unbounded Output Channel (#58). */
  | { type: 'OPEN_LOG_OUTPUT' }
  /**
   * Click the solution/project name in the panel tab bar (#113). Host answers
   * with `SCOPE_CHOICES` — the same in-panel chooser opens whether this is the
   * very first pick or changing an existing scope later.
   */
  | { type: 'SELECT_SCOPE' }
  /** A solution or project row picked in the folder-scope chooser (#113). */
  | { type: 'PICK_SCOPE'; path: string }
  /** The "All N projects in this folder" row picked in the chooser (#113). */
  | { type: 'PICK_SCOPE_FOLDER'; folderPath: string }
  /** Add/remove an id in workspace `blockedPackages`. */
  | { type: 'SET_PACKAGE_BLOCKED'; packageId: string; blocked: boolean }
  /** Host `showInformationMessage` (toast). */
  | { type: 'SHOW_TOAST'; message: string }
  /** Agents tab — Install… (QuickPick) or Update in place when `updateExisting`. */
  | { type: 'INSTALL_AGENT_SKILL'; updateExisting?: boolean }
  /**
   * Something the person did in the panel, for the log (#27 follow-up).
   *
   * The log records everything the extension does — every `dotnet` call, every
   * request — and nothing about what was asked of it. That gap cost a whole
   * investigation: a search that plainly should have matched an installed
   * package reported none, and the record could not say what the panel had been
   * given or what it made of it.
   */
  | {
      type: 'WEBVIEW_ACTION';
      /**
       * `search` and `select` record what was asked for; `confirm` and `apply`
       * record a decision that leaves no other trace. Installing and removing
       * are not here — `dotnet add`/`remove` already write their own rows with
       * the version and the framework, and a second row would only repeat them.
       */
      action: 'search' | 'select' | 'confirm' | 'apply';
      /** What was typed, exactly as the panel holds it — quoted in the row, so stray spaces show. */
      query?: string;
      packageId?: string;
      version?: string;
      /** How the panel read its own lists at that moment: matches out of total. */
      counts?: { installed: [number, number]; implicit: [number, number]; available: number };
      /** Already-worded parts of the row: what was decided, over what. */
      detail?: string[];
    }
  /** React / window crash in the webview — host writes Output Channel. */
  | { type: 'WEBVIEW_ERROR'; source: string; message: string; stack?: string };

// ─────────────────────────────────────────────
// Extension Host → Webview
// ─────────────────────────────────────────────

export type ExtensionMessage =
  // Initialisation — sent in response to WEBVIEW_READY
  | {
      type: 'INIT_STATE';
      /** `null` when the workspace is ambiguous and nothing has been picked yet (#113). */
      scope: WorkspaceScope | null;
      /** Present only alongside a `null` scope — what the folder-scope chooser needs to ask. */
      scopeChoices?: ScopeChoices | null;
      sources: PackageSource[];
      configChain: NuGetConfigFile[];
      snapshot: SourcesSnapshot;
      includePrerelease: boolean;
      blockedPackages: string[];
      traceRecording: boolean;
      /** Stop was pressed and the zip is not written yet (#131). */
      tracePacking: boolean;
      bundledVersion: string;
      detected: SkillFamily[];
      installs: SkillInstallRow[];
      /** `null` when `csc -version` failed — Groups omit CodeAnalysis ids. */
      roslynCap: RoslynCap | null;
      /** Host OS is Windows — `<apikeys>` DPAPI works; Copy / `<clearTextApiKeys>` UI is hidden. */
      isWindows: boolean;
      /** The experimental HTTP catalog is on — the dependents proposal exists only then (#109). */
      httpCatalog: boolean;
      /** The check before a write is switched on (`offerDependentUpdates`, #109). */
      offerDependentUpdates: boolean;
    }

  /**
   * Answer to `SELECT_SCOPE` (#113) — what the in-panel folder-scope chooser
   * needs to ask, freshly scanned. `currentPath` marks the row for the live
   * scope so the chooser can check it rather than hide it.
   */
  | { type: 'SCOPE_CHOICES'; choices: ScopeChoices; currentPath: string | null }

  // Packages
  // `projectFrameworks` is every TFM each project declares (#82) — including the
  // ones this package is not referenced from, which is what makes adding it
  // there possible at all.
  | {
      type: 'INSTALLED_PACKAGES';
      packages: InstalledPackage[];
      projectFrameworks?: Record<string, string[]>;
      /**
       * References the projects declare that restore could not resolve (#138).
       * Apart from `packages` on purpose: they are not installed, and nothing that
       * reads the installed list is meant to see them.
       */
      unresolved?: InstalledPackage[];
    }
  | { type: 'IMPLICIT_PACKAGES'; packages: ImplicitPackage[] }
  | { type: 'INSTALLED_PACKAGES_PATCH'; packages: InstalledPackage[] }
  | {
      type: 'PACKAGE_INFO_UPDATE';
      packageId: string;
      /**
       * The conservative id-wide answer — compatible with every project this
       * id is referenced from at once — used for a row this id's own project
       * map below says nothing about.
       */
      latestVersion: string;
      sourceName: string;
      versions?: string[];
      /**
       * `latestVersion`, computed per project instead of once for the whole
       * id (#107) — keyed by absolute project path, present only when more
       * than one project references this id and their own frameworks could
       * disagree. Without this, one broadcast answering for every row that
       * shares an id had no way to tell a net10.0 project's own real update
       * apart from a net9.0 sibling's — the reducer applied one answer to
       * both, undoing whatever a fresher per-row computation (`INSTALLED_PACKAGES`)
       * had just gotten right.
       */
      latestVersionByProject?: Record<string, string>;
      /**
       * What the feed marks about this package's versions — vulnerable,
       * deprecated — trimmed to the versions it marks at all. The enrich wave
       * covers every installed package, so this is what lets the package list
       * mark a row before anything is selected; `ALL_VERSIONS` carries the same
       * shape for one package at a time.
       */
      versionFlags?: Record<string, VersionFlag>;
    }
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
  | {
      type: 'PACKAGE_METADATA';
      metadata: PackageMetadata;
    }
  // `versionFlags` marks versions the feed already reports as vulnerable or
  // deprecated, keyed by exact version string — best-effort (only present
  // for versions a detailed search actually returned flags for) so the
  // version dropdown can warn before a version is even chosen (#86).
  | {
      type: 'VERSION_DIFF';
      packageId: string;
      /** The version asked about — an answer can arrive after the selection moved on. */
      version: string;
      /** Absent when the licence does not change, or cannot be compared. */
      license?: import('./packageLicense').LicenseChange;
      /** Absent when nothing about the dependencies would move, or neither side was described. */
      dependencies?: import('./packageVersionDiff').VersionDependencyDiff;
      /** The "What changes" band's own link (#125) — absent when the package names neither its release notes nor a recognised repository. */
      releaseNotesLink?: import('./packageLinks').ReleaseNotesLink;
      /** A changelog the *installed* version shipped, absolute path (#125) — absent when it ships none of the conventional names. */
      changelogPath?: string;
    }
  | {
      type: 'BATCH_LICENSE_CHANGES';
      requestId: string;
      /**
       * Empty both when no licence moves and when the check could not be
       * finished in time — the batch proceeds either way, and the skip is
       * recorded in the log rather than shown as a question with no answer.
       */
      findings: import('./packageLicense').BatchLicenseFinding[];
    }
  | {
    type: 'ALL_VERSIONS';
    packageId: string;
    versions: string[];
    versionFlags?: Record<string, VersionFlag>;
  }

  /**
   * The experimental HTTP catalog is switched on or off (#109). The dependents
   * proposal needs the registration data only that path reads, so what it
   * offers follows this flag; it is also sent with `INIT_STATE`.
   */
  | { type: 'HTTP_CATALOG_STATE'; enabled: boolean }
  /** `offerDependentUpdates` changed — from the popup's menu or from Settings (#109). */
  | { type: 'DEPENDENTS_OFFER_STATE'; enabled: boolean }
  /**
   * The answer to `CHECK_DEPENDENTS` (#109). `result` is `null` when there was
   * no restore graph to walk, and `unavailable` says so in the extension's words.
   */
  | { type: 'DEPENDENT_CASCADE'; requestId: string; result: CascadeResult | null; unavailable?: string }
  /**
   * The page the panel asked for is open, or has closed (#109). `requestId` is
   * the closure it shows; `acted` is true when the page closed because a
   * decision was taken on it, false when it was simply closed.
   */
  | {
      type: 'CASCADE_PAGE_STATE';
      requestId: string;
      open: boolean;
      acted?: boolean;
      /**
       * Sent when the page was recomputed (#109): the version the closure now
       * starts from. The panel measures "has moved on" against it, not against
       * the version the page was first opened with.
       */
      fromVersion?: string;
    }
  /**
   * A decision taken on the page, handed to the panel to carry out (#109). The
   * moves travel with it: the page may have recomputed since the panel last
   * heard an answer, and what is written is what the person was shown.
   */
  | {
      type: 'CASCADE_DECISION';
      requestId: string;
      action: CascadeAction;
      packageId: string;
      projectPath: string;
      framework: string;
      moves: Array<{ packageId: string; fromVersion: string; toVersion: string; writeIn?: string }>;
    }
  /** To the page: what to show (#109). Sent on open and again on every recompute. */
  | {
      type: 'CASCADE_PAGE_SNAPSHOT';
      requestId: string;
      result: CascadeResult;
      waiting: boolean;
      stale: boolean;
    }
  /** To the page: the panel moved on; keep the snapshot, mark it (#109). */
  | { type: 'CASCADE_PAGE_MARK_STALE'; requestId: string }

  /** Restore / Force refresh re-read of the SDK compiler. */
  | { type: 'ROSLYN_CAP'; cap: RoslynCap | null }

  /** One project of a multi-project install/remove finished — the rest are still running (#104). */
  | {
      type: 'PROJECT_OPERATION_DONE';
      operation: 'install' | 'remove';
      packageId: string;
      projectPath: string;
      ok: boolean;
    }

  // Operation results
  | {
      type: 'OPERATION_SUCCESS';
      operation: 'install' | 'remove';
      packageId: string;
      affectedProjects: string[];
      /**
       * Whether a package-list refresh follows. False when nothing was actually
       * written — every project already on the target version — and the
       * progress strip then has nothing left to wait for (#82). Without it the
       * strip sat in its `refresh` phase forever, since the refresh that clears
       * it never runs.
       */
      refreshing?: boolean;
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
  | { type: 'TRACE_STATE'; recording: boolean; packing: boolean }
  | { type: 'SKILL_STATUS'; bundledVersion: string; detected: SkillFamily[]; installs: SkillInstallRow[] }

  // Errors
  | { type: 'DOTNET_NOT_FOUND' }
  | { type: 'ERROR'; message: string; details?: string };
