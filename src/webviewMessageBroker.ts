import * as vscode from 'vscode';
import * as path from 'path';
import { createConcurrencyGate, runWithConcurrency, type ConcurrencyGate } from './concurrency';
import { getConfig, setIncludePrerelease, getBlockedPackages, setPackageBlocked } from './config';
import type { NugetManagerViewProvider } from './nugetManagerViewProvider';
import type { INuGetBackend } from './backend/INuGetBackend';
import type { SolutionParser } from './solutionParser';
import {
  uniqueEnabledAuditSources,
  uniqueEnabledPackageSources,
  uniquePackageSources,
  parseNuGetConfig,
  parseNuGetConfigXml,
  isGlobalNuGetConfigPath,
  isMachineWideNuGetConfigPath,
  type NuGetConfigChainResolver,
} from './nugetConfigChainResolver';
import type { Logger } from './logger';
import type { TraceController } from './traceController';
import { sanitizeCtx } from './traceController';
import { sanitizeText, type FileAlias, type SanitizeContext } from './traceSanitize';
import { collectScopeSnapshotFiles } from './tracePack';
import type { WebviewMessage } from './messages';
import { EMPTY_SKILL_STATUS, type SkillStatus } from './agentSkillInstall';
import type { WorkspaceScope, CliResult, OperationFailure, PackageListResult, InstalledPackage, ImplicitPackage, PackageSource, VulnerabilityFinding, BatchUpdateItem, BatchUpdateJob, BatchItemStatus, NuGetConfigFile, VersionFlag, ScopeChoices } from './types';
import type { PackageLicense } from './types';
import { licenseChange } from './packageLicense';
import { isEmptyDiff, versionDependencyDiff } from './packageVersionDiff';
import { versionsEqual } from './semver';
import { isCliOperationSuccess, summarizeDotnetFailure, cliOutputText, mergeCliResults } from './dotnetOutput';
import { mergeFindings } from './vulnerabilities';
import { delayInstallRetry, INSTALL_RETRY_EXTRA_ATTEMPTS, isRetryableCliFailure } from './cliRetry';
import { BLOCKED_UPDATES_TOOLTIP, isPackageBlocked, withoutBlocked } from './blockedPackages';
import { pathsEqual, normalizeFsPath, packageIdsEqual } from './pathCompare';
import { resolveVersionSpread } from './packageResolvedVersions';
import { compareSemVer } from './semver';
import {
  listWorkspaceNuGetConfigFiles,
  scopeFromDotnetFile,
  scopeFromFolder,
  findSolutionsInFolder,
  findProjectsInFolder,
  NUGET_CONFIG_GLOB,
} from './dotnetWorkspace';
import { buildScopeChoices } from './scopeChoices';
import { resolveRememberedChoice, type RememberedScopeChoice, type ScopeChoiceMemory } from './scopeChoiceMemory';
import { readProjectAssets, readPackageFolders, readAssetsJson } from './projectAssets';
import { findMissingCompileAssets } from './missingCompileAssets';
import { highestCompatibleVersion } from './frameworkCompatibility';
import { projectFrameworkKey } from './frameworkPins';
import { computeEntangledCluster } from './batchUpdates';
import { findNuspecFile, findLicenseFile, listRuntimeIdentifiers } from './nuspecLocator';
import { parseNuspec } from './nuspecParser';
import { searchedMetadataToPackageMetadata } from './searchMetadataMapping';
import { resolvePackageDependencyTree, packageSupportedFrameworks } from './packageDependencyTree';
import { promises as fs } from 'fs';

/** Which target framework in `assetsJson` actually resolved `packageId`@`resolvedVersion` — a package can appear under only one TFM per project, but a multi-targeted project's assets.json has one `targets` entry per TFM. */
function findFrameworkForPackage(assetsJson: unknown, packageId: string, resolvedVersion: string): string | undefined {
  const targets = (assetsJson as { targets?: Record<string, Record<string, unknown>> })?.targets;
  if (!targets) return undefined;
  const want = `${packageId}/${resolvedVersion}`.toLowerCase();
  for (const [tfm, target] of Object.entries(targets)) {
    if (Object.keys(target).some((k) => k.toLowerCase() === want)) return tfm;
  }
  return undefined;
}

/** Absolute path uniquely identifying a scope — solution/folder path, or the single project. */
function scopeIdentityPath(scope: WorkspaceScope): string {
  if (scope.kind === 'solution') return scope.solutionPath;
  if (scope.kind === 'folder') return scope.folderPath;
  return scope.projectPath;
}

/**
 * The feed's own per-version marks, without the rest of the enrich answer.
 *
 * `enrichPackage` returns a description, authors and links for every version,
 * which the panel reads one version at a time and the package list never reads
 * at all. Sending that for each of a solution's packages would be a large
 * message carrying almost nothing the list can use, so only the fields that say
 * something about a version travel: what the feed calls vulnerable, what it
 * calls deprecated, and when it says the version was published (#114 — the
 * panel needs the newest version's date, which is not the version it fetched
 * metadata for). Versions the feed says none of those about are left out.
 */
export function feedFlags(
  metadataByVersion: Record<string, import('./types').SearchedVersionMetadata> | undefined,
): Record<string, VersionFlag> | undefined {
  if (!metadataByVersion) return undefined;
  const flags: Record<string, VersionFlag> = {};
  for (const [version, metadata] of Object.entries(metadataByVersion)) {
    if (!metadata?.vulnerable && !metadata?.deprecation && !metadata?.published) continue;
    flags[version] = {
      vulnerable: metadata.vulnerable,
      deprecation: metadata.deprecation,
      advisories: metadata.advisories,
      published: metadata.published,
    };
  }
  return Object.keys(flags).length > 0 ? flags : undefined;
}

/** Absolute project paths covered by a scope — a project scope is a single-element list. */
function scopeProjectPaths(scope: WorkspaceScope): string[] {
  if (scope.kind === 'project') return scope.projectPath ? [scope.projectPath] : [];
  return scope.projects.map((p) => p.absolutePath);
}
import {
  snapshotProjectFiles,
  restoreFileSnapshots,
  readPackageVersionFromSnapshots,
  hasCentralPackageManagement,
  type FileSnapshot,
} from './projectFileSnapshot';
import {
  detectProjectPackageStyle,
  isSdkStyleProject,
  packagesConfigExists,
  PACKAGES_CONFIG_SKIP,
} from './projectPackageStyle';
import {
  countPackageReferences,
  findPackageReferenceSpans,
  removePackageReferences,
  upsertPackageReference,
  writeProjectXml,
} from './legacyPackageReference';
import {
  declaredFrameworks,
  frameworksToUpdate,
  hasSharedReference,
  isFrameworkScopedReference,
  versionForFramework,
} from './frameworkConditions';
import {
  collectVulnerabilityFindings,
  DotnetVulnerableProvider,
} from './vulnerabilityProvider';
import { UserScriptVulnerabilityProvider } from './userScriptVulnerabilities';
import {
  roslynCapRejectMessage,
  withoutOverRoslynCap,
  type RoslynCap,
} from './roslynSdkCap';
import {
  AUDIT_SOURCES_HINT,
  databaseSpeaksForTheCli,
  shouldRunDotnetListVulnerable,
} from './vulnerabilityScanPolicy';
import { findingsFromNuGetHttpCache, nugetHttpCacheDirs } from './nugetHttpCacheVdb';
import { parseRestoreAuditWarnings } from './restoreAuditWarnings';
import { buildSourcesSnapshot, EMPTY_SOURCES_SNAPSHOT } from './sourcesSnapshot';
import {
  patchNuGetConfigFile,
  replaceAuditSources,
  removeAuditSource,
  upsertAuditSource,
  setPackageSourceConnectionFlags,
  setPackageSourceDisabled,
  setPackageSourceMappingPatterns,
  addPackageSource,
  removePackageSourceEntry,
  findPackageSourceLine,
} from './nugetConfigEdit';
import { encryptNuGetConfigPassword, supportsEncryptedNuGetPasswords } from './nugetConfigDpapi';
import { ensureNuGetConfigFile, ensureUserNuGetConfigFile, resolveUserNuGetConfigPath, writeSourceSecrets } from './nugetConfigSecretTarget';
import { planEffectiveAuditToggle } from './auditSourceToggle';
import { searchableConfigFiles } from './searchConfigFiles';

function cliFailure(
  projectPath: string,
  result: CliResult,
  extras?: { previousVersion?: string | null; attemptedVersion?: string },
): OperationFailure {
  const summary = result.timedOut
    ? ['Operation timed out', summarizeDotnetFailure(result.stdout, result.stderr)]
        .filter((s) => s.trim().length > 0)
        .join('\n')
    : summarizeDotnetFailure(result.stdout, result.stderr);
  return {
    projectPath,
    stderr: summary || 'dotnet command failed',
    exitCode: result.exitCode,
    ...extras,
  };
}

interface InstallAttempt {
  projectPath: string;
  snapshots: FileSnapshot[];
  previousVersion: string | null;
  result: CliResult;
  skipped?: boolean;
  /** False when the project file was not changed (e.g. packages.config skip). */
  mutated?: boolean;
  /** packages.config skip: not a failed update in Groups. */
  skippedUnsupported?: boolean;
  /**
   * Conditional groups this write landed in (#82). Absent for an ordinary
   * unconditional reference, which is every project that does not pin per
   * framework.
   */
  frameworks?: string[];
}

function skippedInstallResult(): CliResult {
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
}

interface BatchItemOutcome {
  status: BatchItemStatus;
  succeeded: string[];
  error?: string;
}

/**
 * How long the licence check may stand between the "update all" click and the
 * first `dotnet add` (#89).
 *
 * Most of the work is free — the catalog states an expression per version and
 * the version walk already has those pages — so the budget only ever bites when
 * several packages declare no expression and each costs a nuspec. When it does
 * bite there is no popup and the batch proceeds: a batch must never be blocked
 * on an unknown, and a user who clicked update is entitled to have it happen.
 */
const BATCH_LICENSE_BUDGET_MS = 8_000;

/** Worst status wins, in this order — matches how a partial multi-project failure already reads. */
const BATCH_STATUS_RANK: Record<BatchItemStatus, number> = {
  error: 4, timeout: 3, cancelled: 2, running: 1, pending: 1, ok: 0,
};

/**
 * #38: a batch item can be split across an entangled-cluster pre-pass (some
 * of its projects) and the normal per-item flow (the rest) — merge their
 * independently-computed outcomes into the one status `_postBatchItem` reports.
 */
function mergeOutcomes(outcomes: BatchItemOutcome[]): BatchItemOutcome {
  const succeeded = outcomes.flatMap((o) => o.succeeded);
  const worst = outcomes.reduce((acc, o) =>
    BATCH_STATUS_RANK[o.status] > BATCH_STATUS_RANK[acc.status] ? o : acc);
  const errors = outcomes.map((o) => o.error).filter((e): e is string => !!e);
  return { status: worst.status, succeeded, error: errors.length > 0 ? errors.join('\n\n') : undefined };
}

interface CacheEntry {
  latestVersion: string;
  sourceName: string;
  fetchedAt: number;
  /** Full sorted version list — cached for instant detail panel population */
  versions: string[];
  /** Per-version description/projectUrl/etc. from the same detailed search that built `versions` (#86) — absent when this entry only came from the lighter `getAllVersions` path. */
  metadataByVersion?: Record<string, import('./types').SearchedVersionMetadata>;
  /**
   * The feed's per-version marks, kept apart from `metadataByVersion` on
   * purpose.
   *
   * They cannot simply be folded into that map: `_getSearchMetadata` reads any
   * entry there as a complete search result, so a flags-only entry would cost
   * that version its description the next time the Info panel asked (#86). But
   * they must be kept *somewhere*, because an entry built by `getAllVersions`
   * alone has no `metadataByVersion` at all — and without this the marks a
   * selection had just shown were reported as "none" on the next selection,
   * blanking the ⚠ in the version dropdown until the window was reloaded.
   */
  versionFlags?: Record<string, VersionFlag>;
}

type RefreshOpts = {
  notifyListError?: boolean;
  restore?: boolean;
  listAfterRestore?: boolean;
  awaitVuln?: boolean;
  /** Restore: stamp latest from cache and skip cache-hit PACKAGE_INFO_UPDATE so counts do not jump. */
  quietEnrich?: boolean;
};

export class WebviewMessageBroker {
  private _messageDisposable?: vscode.Disposable;
  private _logDisposable?: vscode.Disposable;
  private _configDisposable?: vscode.Disposable;

  /** packageId (lowercase) → cached enrichment data */
  private readonly _cache = new Map<string, CacheEntry>();

  /** Installed ids from the last successful list — used to allow first-time install of a blocked id. */
  private _installedIds = new Set<string>();

  /** Cancellation token for the current enrich job — replaced on each new job */
  private _enrichAbort: AbortController = new AbortController();
  private _vulnAbort: AbortController = new AbortController();
  /** The licence question in flight (#89) — replaced, not queued, as the selection moves. */
  private _licenseAbort: AbortController = new AbortController();
  /**
   * The search in flight — replaced, not queued, as the box is typed through
   * (#116). Superseding a search used to leave the old request running to
   * completion with nowhere to attach a signal; the webview already drops a
   * stale answer on arrival (#121), but the request itself kept costing the
   * feed and the socket until this existed.
   */
  private _searchAbort: AbortController = new AbortController();
  /**
   * The version-list request in flight (#116) — replaced, not queued, the
   * same way `_licenseAbort` already covers the licence half of a selection
   * that moves on before this one answers.
   */
  private _versionsAbort: AbortController = new AbortController();
  /** The metadata request in flight (#116) — replaced, not queued; see `_versionsAbort`. */
  private _metadataAbort: AbortController = new AbortController();
  /**
   * Implicit rows currently asking the feed about their own id, keyed
   * lowercase (#118). Unlike the single-slot tokens above, several of these
   * run at once — one per visible row — so a newer one never supersedes an
   * older one for a *different* id; each is only ever cancelled by its own
   * row leaving view, or dropped wholesale on a scope switch or a refresh.
   */
  private readonly _implicitWatches = new Map<string, AbortController>();
  /**
   * Bounds how many implicit-row watches run at once, to `dotnetConcurrency`
   * (#118) — the same number the enrich wave itself is capped to, and for the
   * same reason: on the CLI backend, every `enrichPackage` call is its own
   * `dotnet` process. Without this, a panel with twenty-five implicit rows on
   * screen started twenty-five processes at once — the exact fan-out
   * `dotnetConcurrency` exists to prevent, and worse than the wave it was
   * meant to be cheaper than.
   */
  private readonly _implicitWatchGate: ConcurrencyGate = createConcurrencyGate(() => getConfig().dotnetConcurrency);
  /**
   * The config chain last resolved for an implicit-row watch, kept until the
   * chain might actually differ (#118). `NuGetConfigChainResolver.resolve`
   * walks the directory tree and reparses every file on each call — cheap
   * once, not forty times over one scroll through the Implicit list, when
   * nothing on disk changed between one row and the next.
   */
  private _implicitConfigFiles?: { startDir: string; files: string[] };
  /** Field rather than a bare constant so a test can shorten the wait it is about. */
  private _licenseBudgetMs = BATCH_LICENSE_BUDGET_MS;
  /** Bumped on every `_cancelVulnScan()` — belt-and-suspenders against a
   *  superseded scan posting stale findings after a newer one already did,
   *  the same shape as `_restoreGeneration`/`_beginRestore` (#53). Needed
   *  because the fallback branch's own file I/O (`findingsFromNuGetHttpCache`)
   *  has no fixed duration, so two scans in flight back-to-back are not
   *  guaranteed to resolve in start order even though the second one aborts
   *  the first's signal. */
  private _vulnScanGeneration = 0;
  /**
   * Bumped at the start of every `_updateMissingCompileAssetDiagnostics` call
   * — the same shape as `_vulnScanGeneration`, for the same reason: the
   * `readAssetsJson` reads it awaits have no fixed duration, so two calls
   * back-to-back (two lists in quick succession) are not guaranteed to finish
   * in start order, and an older one finishing last would `clear()` the
   * collection right after a newer one had already set it correctly (#107).
   */
  private _compileAssetDiagnosticsGeneration = 0;

  /** Snapshots from the last failed add, used by the Rollback button (`onFailedUpdate: keep`). */
  private _pendingRollback: { packageId: string; attempts: InstallAttempt[] } | null = null;

  private _batchRunning = false;
  private _batchAbort: AbortController | null = null;

  /** Probe result for Groups. `undefined` = not probed (tests without a probe). */
  private _roslynCap: RoslynCap | null | undefined = undefined;
  private _restoreInFlight?: Promise<CliResult>;
  private _restoreGeneration = 0;
  private _lastRestoreText = '';
  /** Last package list handed to `_scanVulnerabilities` — reused to rescan
   *  without a fresh `dotnet list` when only the source config changed (#53). */
  private _lastListed?: PackageListResult;
  /** `scopeIdentityPath` of the last scope `_initForScope` actually ran a
   *  restore for — lets a re-init tell a real scope change apart from the
   *  view simply being relocated (panel/sidebar/window), which tears down
   *  and recreates the `WebviewView` without the scope changing at all (#71). */
  private _lastInitScopePath?: string;
  /** `_buildSourcesPayload` result from the last real init for `_lastInitScopePath`
   *  — replayed as-is on a same-scope re-init instead of re-resolving the
   *  nuget.config chain and re-scanning project files for no reason (#71). */
  private _lastInitPayload?: Awaited<ReturnType<WebviewMessageBroker['_buildSourcesPayload']>>;
  /** Last VULNERABILITIES/VULN_SCAN_HINT payload posted from a real scan —
   *  replayed as-is on a same-scope re-init instead of re-running one (#71). */
  private _lastVulnPost?: {
    findings: Awaited<ReturnType<typeof collectVulnerabilityFindings>>;
    hint: { show: boolean; fingerprint: string; message: string; configFilePath?: string };
  };

  private _nugetConfigWatcher?: vscode.FileSystemWatcher;
  private _nugetConfigWatchSubs: vscode.Disposable[] = [];
  private _configChainTimer?: ReturnType<typeof setTimeout>;
  private _lastSnapshotJson = '';

  constructor(
    private readonly provider: NugetManagerViewProvider,
    private readonly backend: INuGetBackend,
    private readonly solutionParser: SolutionParser,
    private readonly configResolver: NuGetConfigChainResolver,
    private readonly logger: Logger,
    /** SDK check — runs on first WEBVIEW_READY, not during activate(). */
    private readonly onFirstWebviewReady?: () => Promise<void>,
    private readonly trace?: TraceController,
    private readonly skill?: {
      readStatus: () => Promise<SkillStatus>;
      install: (opts?: { updateExisting?: boolean }) => Promise<void>;
    },
    private readonly roslyn?: { probe: (cwd: string) => Promise<RoslynCap | null> },
    private readonly vulnScan?: {
      httpCacheDir?: () => string;
      /**
       * Reads the vulnerability database over HTTP (#27). `undefined` means it
       * could not be read at all; an empty array means it was read and nothing
       * in this project matches, which is an answer.
       */
      fromDatabase?: (
        sources: { packageSources: PackageSource[]; auditSources: PackageSource[] },
        installed: InstalledPackage[],
        implicit: ImplicitPackage[],
        signal?: AbortSignal,
      ) => Promise<VulnerabilityFinding[] | undefined>;
    },
    /**
     * The experimental HTTP catalog (#27), which holds state derived from the
     * configuration: probe verdicts, cached responses, credentials. Any edit to
     * a `nuget.config` invalidates all three — without this a source edited in
     * the Sources tab would keep answering from what was true before it.
     */
    private readonly httpCatalog?: { invalidate: () => void },
    /**
     * The licence a version declares, for a version nobody has installed (#89).
     * Only consulted when the catalog's own answer states none, which is the
     * one case a feed's metadata cannot settle.
     */
    private readonly licenseLookup?: {
      forVersion: (
        packageId: string,
        version: string,
        configFiles: string[],
        signal?: AbortSignal,
      ) => Promise<PackageLicense | undefined>;
    },
    /** Remembers a folder's chooser pick across sessions (#113 item 4). */
    private readonly scopeMemory?: ScopeChoiceMemory,
    /**
     * Where a package restored with no compile asset for a project's target
     * framework is reported (#107 Part 1) — a disk fact read from
     * `project.assets.json` after every list/restore, costing no network call.
     * Owned by the caller, which disposes it; `undefined` in tests that don't
     * exercise this.
     */
    private readonly diagnostics?: vscode.DiagnosticCollection,
  ) {
  }

  private async _skillFields(): Promise<SkillStatus> {
    if (!this.skill) return EMPTY_SKILL_STATUS;
    try {
      return await this.skill.readStatus();
    } catch {
      return EMPTY_SKILL_STATUS;
    }
  }

  async postSkillStatus(): Promise<void> {
    const status = await this._skillFields();
    this.provider.postMessage({ type: 'SKILL_STATUS', ...status });
  }

  private _probeCwd(): string {
    const scope = this.provider.getCurrentScope();
    const startDir = scope ? this._scopeStartDir(scope) : undefined;
    return startDir ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  private async _refreshRoslynCap(post: boolean): Promise<void> {
    if (!this.roslyn) return;
    try {
      this._roslynCap = await this.roslyn.probe(this._probeCwd());
    } catch {
      this._roslynCap = null;
    }
    if (post) {
      this.provider.postMessage({ type: 'ROSLYN_CAP', cap: this._roslynCap ?? null });
    }
  }

  attach(): void {
    // Subscribe to webview messages (safe before view is resolved)
    this._messageDisposable = this.provider.onDidReceiveMessage(
      (raw) => void this._handle(raw as WebviewMessage),
    );

    // Subscribe to new log entries → push LOG_ENTRY_ADDED to webview
    this._logDisposable = this.logger.subscribe((entry) => {
      this.provider.postMessage({ type: 'LOG_ENTRY_ADDED', entry });
    });

    this._configDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('averenium.nugetManager.blockedPackages')) return;
      this._postBlockedPackages();
    });

    this._ensureNuGetConfigWatcher();

    // When the view is first resolved (or already is), nothing extra needed —
    // the webview will fire WEBVIEW_READY itself after React mounts.
    // But if setScope was called before the view resolved, we need to push
    // init state when the view becomes ready.
    this.provider.setOnViewReady(() => {
      // If we already have a scope (set before view resolved), push it now.
      // The webview sends WEBVIEW_READY on mount which also triggers _handleWebviewReady,
      // so this is a belt-and-suspenders guard for when WEBVIEW_READY fires before
      // the message handler was registered.
      // In practice WEBVIEW_READY is the canonical trigger — no-op here.
    });
  }

  detach(): void {
    this._cancelEnrich();
    this._cancelVulnScan();
    this._cancelLicenseLookup();
    this._cancelSearch();
    this._cancelVersionsLookup();
    this._cancelMetadataLookup();
    this._cancelImplicitWatches();
    this._batchAbort?.abort();
    this._messageDisposable?.dispose();
    this._messageDisposable = undefined;
    this._logDisposable?.dispose();
    this._logDisposable = undefined;
    this._configDisposable?.dispose();
    this._configDisposable = undefined;
    this._disposeNuGetConfigWatcher();
  }

  /**
   * Called by CommandRegistrar after resolving the target file.
   * If the webview React client is already up, push INIT_STATE immediately.
   * Otherwise WEBVIEW_READY will run _initForScope once the UI is listening.
   */
  async activateScope(scope: WorkspaceScope): Promise<void> {
    this._cancelEnrich();
    this._cancelVulnScan();
    this._cancelImplicitWatches();
    this.provider.setScope(scope);
    if (this.provider.isClientReady) {
      await this._initForScope(scope);
    }
  }

  /** Abort any in-progress enrichment job and issue a fresh token. */
  private _cancelEnrich(): void {
    this._enrichAbort.abort();
    this._enrichAbort = new AbortController();
  }

  private _cancelVulnScan(): void {
    this._vulnAbort.abort();
    this._vulnAbort = new AbortController();
    this._vulnScanGeneration++;
  }

  /** Drop the licence lookup still in flight and issue a fresh token (#89). */
  private _cancelLicenseLookup(): void {
    this._licenseAbort.abort();
    this._licenseAbort = new AbortController();
  }

  /** Stop the search still in flight and issue a fresh token (#116). */
  private _cancelSearch(): void {
    this._searchAbort.abort();
    this._searchAbort = new AbortController();
  }

  /** Stop the version-list request still in flight and issue a fresh token (#116). */
  private _cancelVersionsLookup(): void {
    this._versionsAbort.abort();
    this._versionsAbort = new AbortController();
  }

  /** Stop the metadata request still in flight and issue a fresh token (#116). */
  private _cancelMetadataLookup(): void {
    this._metadataAbort.abort();
    this._metadataAbort = new AbortController();
  }

  /** Stops every implicit-row watch in flight — the ids they asked about belong to a scope or a package list that is going away (#118). */
  private _cancelImplicitWatches(): void {
    for (const controller of this._implicitWatches.values()) controller.abort();
    this._implicitWatches.clear();
    this._implicitConfigFiles = undefined;
  }

  private _postBlockedPackages(): void {
    this.provider.postMessage({ type: 'BLOCKED_PACKAGES', packageIds: getBlockedPackages() });
  }

  private async _handleSetPackageBlocked(packageId: string, blocked: boolean): Promise<void> {
    const packageIds = await setPackageBlocked(packageId, blocked);
    this.provider.postMessage({ type: 'BLOCKED_PACKAGES', packageIds });
  }


  /**
   * A decision that leaves no other trace (#27 follow-up).
   *
   * Installing and removing already write their own rows — `dotnet add` carries
   * the version and the framework it landed on. What had no record at all was a
   * click that produced nothing: an update refused because the package is
   * blocked, or skipped because the file already says what was asked for. From
   * the log those were indistinguishable from never having clicked.
   */
  private _logDecision(command: string, args: string[]): void {
    this.logger.logCliOperation({
      timestamp: new Date(),
      kind: 'ui',
      command,
      args,
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      durationMs: 0,
    });
  }

  /** True when this id is blocked and already installed — first-time install stays allowed. */
  private _rejectBlockedVersionChange(packageId: string): boolean {
    if (!isPackageBlocked(packageId, getBlockedPackages())) return false;
    if (!this._installedIds.has(packageId.toLowerCase())) return false;
    this._logDecision('update refused', [packageId, 'updates blocked in this workspace']);
    void vscode.window.showInformationMessage(
      `${packageId}: ${BLOCKED_UPDATES_TOOLTIP}`,
    );
    return true;
  }

  // ─── Message router ────────────────────────────────────────────────────────

  private async _handle(msg: WebviewMessage): Promise<void> {
    try {
      await this._route(msg);
    } catch (err) {
      this.logger.error(`host handler ${msg.type} failed`, err);
      this.logger.show();
    }
  }

  private async _route(msg: WebviewMessage): Promise<void> {
    this.trace?.recordWebview(msg);
    switch (msg.type) {
      case 'WEBVIEW_READY':
        await this._handleWebviewReady();
        break;

      case 'SEARCH_PACKAGES':
        await this._handleSearch(msg.query, msg.enabledSourceNames, msg.prerelease);
        break;

      case 'GET_PACKAGE_METADATA':
        await this._handleGetMetadata(msg.packageId, msg.version, msg.configFiles, msg.projectPath);
        break;

      case 'GET_VERSION_DIFF': {
        // One question at a time: scrolling the version list asks about every
        // version it passes, and each may cost a request to the feed. The
        // answer to a version already left behind is of no use to anyone, so
        // the previous lookup is dropped rather than raced.
        this._cancelLicenseLookup();
        const signal = this._licenseAbort.signal;
        const [license, dependencies] = await Promise.all([
          this._licenseChangeFor(msg.packageId, msg.version, msg.configFiles, signal),
          this._dependencyDiffFor(msg.packageId, msg.version, msg.configFiles, signal),
        ]);
        if (signal.aborted) break;
        this.provider.postMessage({
          type: 'VERSION_DIFF',
          packageId: msg.packageId,
          version: msg.version,
          license,
          dependencies,
        });
        break;
      }

      case 'CHECK_BATCH_LICENSES':
        this.provider.postMessage({
          type: 'BATCH_LICENSE_CHANGES',
          requestId: msg.requestId,
          findings: await this._batchLicenseChanges(msg.items, msg.configFiles),
        });
        break;

      case 'GET_ALL_VERSIONS':
        await this._handleGetAllVersions(msg.packageId, msg.configFiles, msg.prerelease);
        break;

      case 'WATCH_IMPLICIT_PACKAGE':
        await this._handleWatchImplicitPackage(msg.packageId);
        break;

      case 'UNWATCH_IMPLICIT_PACKAGE':
        this._handleUnwatchImplicitPackage(msg.packageId);
        break;

      case 'INSTALL_PACKAGE':
        await this._handleInstallSingle(
          msg.projectPath, msg.packageId, msg.version, msg.framework, msg.acrossLines,
        );
        break;

      case 'SPLIT_PACKAGE_REFERENCE':
        await this._handleSplitReference(
          msg.projectPath, msg.packageId, msg.frameworks, msg.framework, msg.version,
        );
        break;

      case 'REMOVE_PACKAGE':
        await this._handleRemoveSingle(msg.projectPath, msg.packageId);
        break;

      case 'INSTALL_PACKAGE_MULTI':
        await this._handleInstallMulti(
          msg.projects, msg.packageId, msg.version, msg.frameworks, msg.acrossLines,
        );
        break;

      case 'REMOVE_PACKAGE_MULTI':
        await this._handleRemoveMulti(msg.projects, msg.packageId);
        break;

      case 'ROLLBACK_FAILED_UPDATE':
        await this._handleRollbackFailedUpdate();
        break;

      case 'UPDATE_PACKAGES_BATCH':
        await this._handleUpdateBatch(msg.kind, msg.items, msg.includePrerelease, msg.family);
        break;

      case 'CANCEL_BATCH_UPDATE':
        this._batchAbort?.abort();
        break;

      case 'REFRESH_PACKAGES':
        this._cancelEnrich();
        this._cancelVulnScan();
        await this._handleRefresh();
        break;

      case 'RESTORE_PACKAGES':
        await this._refreshWithRestore(false);
        break;

      case 'FORCE_REFRESH':
        this.httpCatalog?.invalidate();
        await this._refreshWithRestore(true);
        break;

      case 'SET_PRERELEASE_SETTING':
        this._cancelEnrich();
        this._cancelVulnScan();
        this._cancelImplicitWatches();
        await setIncludePrerelease(msg.prerelease);
        // Prerelease flag affects which versions are returned — invalidate cache
        this._cache.clear();
        await this._handleRefresh();
        break;

      case 'OPEN_CONFIG_FILE':
        await this._handleOpenConfigFile(msg.filePath, msg.sourceName);
        break;

      case 'OPEN_LICENSE_FILE':
        // Read-only: it is a file inside the package cache, and nothing good
        // comes of editing one there.
        try {
          const doc = await vscode.workspace.openTextDocument(msg.filePath);
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch (err) {
          this.logger.error(`Could not open the licence file at ${msg.filePath}`, err);
        }
        break;

      case 'COPY_TEXT':
        await vscode.env.clipboard.writeText(msg.text);
        break;

      case 'COPY_LOG_SANITIZED':
        await vscode.env.clipboard.writeText(sanitizeText(msg.text, await this._logSanitizeCtx()));
        break;

      case 'OPEN_LOG_OUTPUT':
        this.logger.show();
        break;

      case 'OPEN_URL':
        await this._handleOpenUrl(msg.url);
        break;

      case 'SET_SOURCE_ENABLED':
        await this._handleSetSourceEnabled(msg);
        break;

      case 'SET_SOURCE_CONNECTION_FLAGS':
        await this._handleSetSourceConnectionFlags(msg);
        break;

      case 'SET_SOURCE_MAPPING':
        await this._handleSetSourceMapping(msg);
        break;

      case 'ADD_PACKAGE_SOURCE':
        await this._handleAddPackageSource(msg);
        break;

      case 'REMOVE_PACKAGE_SOURCE':
        await this._handleRemovePackageSource(msg);
        break;

      case 'SET_SOURCE_SECRETS':
        await this._handleSetSourceSecrets(msg);
        break;

      case 'GET_LOG_ENTRIES':
        this.provider.postMessage({ type: 'LOG_ENTRIES', entries: this.logger.getEntries() });
        break;

      case 'START_TRACE':
        await this.trace?.startFromUi();
        break;

      case 'STOP_TRACE':
        await this.trace?.stopAndPack();
        break;

      case 'CLEAR_LOG':
        this.logger.clear();
        this.provider.postMessage({ type: 'LOG_CLEARED' });
        break;

      case 'SELECT_SCOPE':
        await this._handleGetScopeChoices();
        break;

      case 'PICK_SCOPE':
        await this._handlePickScope(msg.path);
        break;

      case 'PICK_SCOPE_FOLDER':
        await this._handlePickScopeFolder(msg.folderPath);
        break;

      case 'SET_PACKAGE_BLOCKED':
        await this._handleSetPackageBlocked(msg.packageId, msg.blocked);
        break;

      case 'SHOW_TOAST':
        void vscode.window.showInformationMessage(msg.message);
        break;

      case 'INSTALL_AGENT_SKILL':
        await this.skill?.install({ updateExisting: !!msg.updateExisting });
        await this.postSkillStatus();
        break;

      case 'WEBVIEW_ACTION': {
        const detail: string[] = [];
        if (msg.query !== undefined) detail.push(`query "${msg.query}"`);
        if (msg.packageId) detail.push(msg.version ? `${msg.packageId} ${msg.version}` : msg.packageId);
        if (msg.counts) {
          const { installed, implicit, available } = msg.counts;
          detail.push(
            `installed ${installed[0]}/${installed[1]}`,
            `implicit ${implicit[0]}/${implicit[1]}`,
            `available ${available}`,
          );
        }
        if (msg.detail?.length) detail.push(...msg.detail);
        const wording = {
          search: 'search box',
          select: 'package selected',
          confirm: 'confirmation',
          apply: 'apply',
        } as const;
        this._logDecision(wording[msg.action], detail);
        break;
      }

      case 'WEBVIEW_ERROR':
        this.logger.error(
          `webview ${msg.source}: ${msg.message}`,
          msg.stack ?? msg.message,
        );
        this.logger.show();
        break;

      default:
        break;
    }
  }

  // ─── Handlers ─────────────────────────────────────────────────────────────

  private _firstReady = false;

  private async _handleWebviewReady(): Promise<void> {
    const isFirstReady = !this._firstReady;
    this._firstReady = true;

    this.provider.markClientReady();

    const scope = this.provider.getCurrentScope();

    if (!scope) {
      // Independent I/O run together instead of one after another (#113):
      // the ambiguous-folder chooser used to wait out a `dotnet --version`
      // check and a Roslyn probe in series before it could even ask its
      // question, which the plain fixed "no scope" state that used to follow
      // never made visible — the chooser replacing it made the wait obvious.
      const [, , auto] = await Promise.all([
        isFirstReady ? (this.onFirstWebviewReady?.() ?? Promise.resolve()) : Promise.resolve(),
        this._refreshRoslynCap(false),
        this._detectWorkspaceScope(),
      ]);
      if (auto.scope) {
        this.provider.setScope(auto.scope);
        await this._initForScope(auto.scope);
      } else {
        this.provider.postMessage({
          type: 'INIT_STATE',
          scope: null,
          scopeChoices: auto.choices,
          sources: [],
          configChain: [],
          snapshot: EMPTY_SOURCES_SNAPSHOT,
          includePrerelease: getConfig().includePrerelease,
          blockedPackages: getBlockedPackages(),
          traceRecording: this.trace?.isRecording() ?? false,
          roslynCap: this._roslynCap ?? null,
          isWindows: process.platform === 'win32',
          ...(await this._skillFields()),
        });
      }
      return;
    }

    if (isFirstReady) await this.onFirstWebviewReady?.();
    await this._initForScope(scope);
  }

  /**
   * Opens/reopens the in-panel folder-scope chooser (#113) — the corner
   * control's click, whether nothing has been picked yet or an existing scope
   * is being changed. Always scoped to `workspaceFolders[0]`, matching
   * auto-detect, rather than the whole (possibly multi-root) workspace the
   * old native QuickPick used to scan.
   */
  private async _handleGetScopeChoices(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      await vscode.window.showErrorMessage('Averenium NuGet Manager: No workspace folder is open.');
      return;
    }

    const choices = await buildScopeChoices(folders[0].uri.fsPath, this.solutionParser);
    if (!choices) {
      await vscode.window.showWarningMessage(
        'AVE NuGet Manager: No .sln, .slnx, .csproj, or .fsproj found in the workspace.',
      );
      return;
    }

    this.provider.postMessage({
      type: 'SCOPE_CHOICES',
      choices,
      currentPath: this._currentScopePath() || null,
    });
  }

  private async _handlePickScope(filePath: string): Promise<void> {
    const currentPath = this._currentScopePath();
    if (currentPath && pathsEqual(filePath, currentPath)) return;

    const scope = await scopeFromDotnetFile(filePath, this.solutionParser);
    await this._rememberScope(scope);
    await this.activateScope(scope);
  }

  private async _handlePickScopeFolder(folderPath: string): Promise<void> {
    const currentPath = this._currentScopePath();
    if (currentPath && pathsEqual(folderPath, currentPath)) return;

    const scope = await scopeFromFolder(folderPath);
    await this._rememberScope(scope);
    await this.activateScope(scope);
  }

  /** Remembers the chooser's pick for its folder (#113 item 4) — always `workspaceFolders[0]`, the folder the chooser was for. */
  private async _rememberScope(scope: WorkspaceScope): Promise<void> {
    if (!this.scopeMemory) return;
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;

    const choice: RememberedScopeChoice = scope.kind === 'folder'
      ? { kind: 'folder' }
      : { kind: 'file', path: scopeIdentityPath(scope) };
    await this.scopeMemory.set(folders[0].uri.fsPath, choice);
  }

  private _currentScopePath(): string {
    const scope = this.provider.getCurrentScope();
    return scope ? scopeIdentityPath(scope) : '';
  }

  /**
   * Scan the workspace root for every `.sln`/`.slnx` and every project, both
   * recursively (#113) — {@link findDotnetTargetsInFolder}'s direct-children-
   * first shortcut answers "is there *a* target here?" well, but stops the
   * moment it finds one, which would silently hide a second solution nested a
   * level below a root one. Counting solutions correctly is exactly the
   * question this method exists to answer, so it cannot reuse that shortcut.
   *
   * That full list answers two different questions, and only one of them
   * wants every solution counted equally: whether the folder is genuinely
   * ambiguous asks where each solution sits, not just how many there are (#126).
   * A remembered choice (#113 item 4) is consulted first and, when it still
   * applies, resolved silently — including in a folder that was never
   * ambiguous, so a deliberate switch away from an obvious solution sticks.
   * That check is answered from `solutionFiles`/`projects` alone — a solution
   * with dozens of projects would otherwise pay {@link buildScopeChoices}'s
   * full cost (parsing every solution, `fs.stat` for its recency sort) on
   * every open just to confirm a remembered pick still exists, when only the
   * paths already scanned here are needed for that. Failing that: a single
   * solution at the folder root decides it however many solutions sit nested
   * below; a single solution anywhere decides it when none is in the root;
   * otherwise it falls through to the project/folder rules and finally the
   * chooser, which is the one case actually needing the built choices.
   */
  private async _detectWorkspaceScope(): Promise<{ scope: WorkspaceScope | null; choices: ScopeChoices | null }> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return { scope: null, choices: null };

    const rootPath = folders[0].uri.fsPath;
    const [solutionFiles, projects] = await Promise.all([
      findSolutionsInFolder(rootPath),
      findProjectsInFolder(rootPath),
    ]);
    if (solutionFiles.length === 0 && projects.length === 0) return { scope: null, choices: null };

    const remembered = this.scopeMemory?.get(rootPath);
    if (remembered && resolveRememberedChoice(remembered, {
      offerAllProjects: projects.length > 1,
      solutions: solutionFiles.map((p) => ({ path: p })),
      projects: projects.map((p) => ({ path: p.absolutePath })),
    })) {
      const scope = remembered.kind === 'folder'
        ? await scopeFromFolder(rootPath, projects)
        : await scopeFromDotnetFile(remembered.path, this.solutionParser);
      return { scope, choices: null };
    }

    const rootSolutions = solutionFiles.filter((s) => pathsEqual(path.dirname(s), rootPath));
    if (rootSolutions.length === 1) {
      const projectList = await this.solutionParser.getProjects(rootSolutions[0]);
      return { scope: { kind: 'solution', solutionPath: rootSolutions[0], projects: projectList }, choices: null };
    }

    if (solutionFiles.length === 1) {
      const projectList = await this.solutionParser.getProjects(solutionFiles[0]);
      return { scope: { kind: 'solution', solutionPath: solutionFiles[0], projects: projectList }, choices: null };
    }

    if (solutionFiles.length === 0) {
      if (projects.length === 1) return { scope: { kind: 'project', projectPath: projects[0].absolutePath }, choices: null };
      return { scope: await scopeFromFolder(rootPath, projects), choices: null };
    }

    // More than one solution, none singularly in the root — ambiguous.
    const choices = await buildScopeChoices(rootPath, this.solutionParser);
    return { scope: null, choices: choices ?? null };
  }

  private async _initForScope(scope: WorkspaceScope): Promise<void> {
    this._cancelEnrich();
    this._cancelVulnScan();
    this._restoreGeneration++;

    // Moving the view (panel ↔ sidebar ↔ secondary sidebar ↔ new window)
    // always tears down and recreates the WebviewView, which re-sends
    // WEBVIEW_READY → here even though the scope hasn't changed at all.
    // Nothing about the scope or its packages can have changed just from
    // moving the view, so replay the last known state instead of hitting
    // `dotnet restore`/`dotnet list`/enrich/vuln-scan all over again for a
    // genuinely new webview client with nothing rendered yet (#71). Only a
    // real first-open or an actual scope change goes through the full path.
    const scopePath = scopeIdentityPath(scope);
    const isSameScopeReinit = !!scopePath
      && scopePath === this._lastInitScopePath
      && this._lastListed !== undefined
      && this._lastInitPayload !== undefined;
    this._lastInitScopePath = scopePath;

    this.trace?.recordBroker('init-scope', {
      kind: scope.kind,
      path: path.basename(scopeIdentityPath(scope)),
      projects: scope.kind === 'solution' || scope.kind === 'folder' ? scope.projects.length : 1,
      replayed: isSameScopeReinit,
    });

    if (isSameScopeReinit) {
      await this._replayLastState(scope);
      return;
    }

    this._lastRestoreText = '';
    this._lastListed = undefined;
    this._lastVulnPost = undefined;

    const startDir = this._scopeStartDir(scope) ?? '';

    // Log the resolution attempt so it appears in the Log tab
    const chainStart = Date.now();
    this.logger.logCliOperation({
      timestamp: new Date(),
      kind: 'info',
      command: `NuGet config chain resolution`,
      args: ['startDir:', startDir],
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      durationMs: 0,
    });

    const [payload] = await Promise.all([
      this._buildSourcesPayload(scope),
      this._refreshRoslynCap(false),
    ]);
    this._lastInitPayload = payload;
    const { configChain, sources, snapshot } = payload;
    this._lastSnapshotJson = JSON.stringify(snapshot);

    // Log what we found
    this.logger.logCliOperation({
      timestamp: new Date(),
      kind: 'info',
      command: `NuGet config chain resolved`,
      args: [`found ${configChain.length} config file(s)`, ...configChain.map((c) => c.filePath)],
      stdout: configChain.map((c) => `${c.filePath}: ${c.sources.length} source(s)${c.parseError ? ' [ERROR: ' + c.parseError + ']' : ''}`).join('\n'),
      stderr: '',
      exitCode: 0,
      timedOut: false,
      durationMs: Date.now() - chainStart,
    });

    this.provider.postMessage({
      type: 'INIT_STATE',
      scope,
      sources,
      configChain,
      snapshot,
      includePrerelease: getConfig().includePrerelease,
      blockedPackages: getBlockedPackages(),
      traceRecording: this.trace?.isRecording() ?? false,
      roslynCap: this._roslynCap ?? null,
      isWindows: process.platform === 'win32',
      ...(await this._skillFields()),
    });

    // List with --no-restore so the UI fills even if restore is broken;
    // restore runs in parallel and reports NU1605 etc. in the banner. This
    // branch only runs for a genuine first-open or an actual scope change —
    // a same-scope re-init took the `_replayLastState` return above instead.
    await this._handleRefresh({ restore: true });
  }

  /**
   * Same-scope re-init (the view was moved/recreated, not an actual scope
   * change): replay the last known state instead of hitting the CLI/network
   * again. `dotnet restore`, `dotnet list`, enrich, and a vulnerability scan
   * are all genuinely slow/network-hitting, and none of them can have
   * anything new to report — nothing about the scope or its packages
   * changed just because the view moved (#71).
   */
  private async _replayLastState(scope: WorkspaceScope): Promise<void> {
    const payload = this._lastInitPayload!;
    const listed = this._lastListed!;

    this.provider.postMessage({
      type: 'INIT_STATE',
      scope,
      sources: payload.sources,
      configChain: payload.configChain,
      snapshot: payload.snapshot,
      includePrerelease: getConfig().includePrerelease,
      blockedPackages: getBlockedPackages(),
      traceRecording: this.trace?.isRecording() ?? false,
      roslynCap: this._roslynCap ?? null,
      isWindows: process.platform === 'win32',
      ...(await this._skillFields()),
    });

    const installed = this._stampCachedLatest(listed.installed, listed.projectFrameworks);
    this._installedIds = new Set(installed.map((pkg) => pkg.id.toLowerCase()));
    this.provider.postMessage({
      type: 'INSTALLED_PACKAGES',
      packages: installed,
      projectFrameworks: listed.projectFrameworks,
    });
    this.provider.postMessage({ type: 'IMPLICIT_PACKAGES', packages: listed.implicit });

    // Replay each package's cached enrich data (latest version, source,
    // full version list) instead of re-fetching it — same source
    // `_enrichInstalledPackages` itself reads from on a cache hit.
    const uniqueIds = [...new Set(installed.map((p) => p.id))];
    for (const id of uniqueIds) {
      const cached = this._cache.get(id.toLowerCase());
      if (!cached) continue;
      this.provider.postMessage({
        type: 'PACKAGE_INFO_UPDATE',
        packageId: id,
        latestVersion: cached.latestVersion,
        latestVersionByProject: this._latestVersionByProject(id, cached),
        sourceName: cached.sourceName,
        versions: cached.versions,
        versionFlags: this._versionFlagsFor(cached),
      });
    }
    this.provider.postMessage({ type: 'ENRICH_PROGRESS', done: uniqueIds.length, total: uniqueIds.length });

    if (this._lastVulnPost) {
      this.provider.postMessage({ type: 'VULNERABILITIES', findings: this._lastVulnPost.findings });
      this.provider.postMessage({ type: 'VULN_SCAN_HINT', ...this._lastVulnPost.hint });
    }
  }

  private async _handleSearch(
    query: string,
    enabledSourceNames: string[],
    prerelease: boolean,
  ): Promise<void> {
    // A keystroke-driven search supersedes the one before it; the previous
    // request stops instead of running to completion for an answer nobody
    // reads (#116) — the reducer already drops a stale one on arrival (#121),
    // but until now nothing stopped it from still costing the feed.
    this._cancelSearch();
    const signal = this._searchAbort.signal;

    // Resolve config files from current scope — not from webview payload
    const scope = this.provider.getCurrentScope();
    if (!scope) {
      // No scope to search yet (mid switch, most likely) — still answer, or
      // the webview's spinner has nothing left to clear it (#121). A stale
      // reply is harmless: the reducer already drops an answer to a query
      // the box has since moved on from.
      this.provider.postMessage({ type: 'SEARCH_RESULTS', query, packages: [] });
      return;
    }

    const startDir = this._scopeStartDir(scope) ?? '';

    const configChain = await this.configResolver.resolve(startDir);
    const configFiles = searchableConfigFiles(configChain);

    // Trimmed once, here, above both backends (#120) — the webview keeps
    // whatever the reader typed in the box, and without this a leading space
    // reached `dotnet package search` as part of the id being looked for.
    const trimmedQuery = query.trim();

    try {
      const packages = await this.backend.searchPackages(
        trimmedQuery, configFiles, enabledSourceNames, prerelease, signal,
      );
      if (signal.aborted) return;
      this.provider.postMessage({ type: 'SEARCH_RESULTS', query, packages });
    } catch (err) {
      // A search this method itself superseded, not a failure — the newer
      // one already answered or is still running.
      if (signal.aborted) return;
      this.provider.postMessage({
        type: 'ERROR',
        message: 'Search failed',
        details: String(err),
      });
    }
  }

  /**
   * Installed, at exactly `version` → the local `.nuspec` (offline,
   * complete: authors, license, tags, per-framework dependencies — none of
   * which `dotnet package search` can produce). Anything else (not
   * installed, or a different version picked in the dropdown) falls back to
   * the search response, preferring an already-cached detailed-search
   * result over paying for a fresh CLI call (#86).
   */
  private async _handleGetMetadata(
    packageId: string,
    version: string | undefined,
    configFiles: string[],
    projectPath: string | undefined,
  ): Promise<void> {
    // Superseded the moment the reader picks another package or version
    // before this one answers (#116) — the same shape `_licenseAbort` already
    // covers for the licence half of the same selection.
    this._cancelMetadataLookup();
    const signal = this._metadataAbort.signal;
    try {
      const nuspecMetadata = projectPath && version
        ? await this._tryReadNuspecMetadata(projectPath, packageId, version)
        : undefined;
      const metadata = nuspecMetadata ?? await this._getSearchMetadata(packageId, version, configFiles, signal);
      if (signal.aborted) return;
      this.provider.postMessage({ type: 'PACKAGE_METADATA', metadata });
    } catch (err) {
      if (signal.aborted) return;
      this.provider.postMessage({
        type: 'ERROR',
        message: `Failed to load metadata for ${packageId}`,
        details: String(err),
      });
    }
  }


  /**
   * Whether taking the selected version would change the package's licence (#89).
   *
   * A bump can move a package from one licence to another and nothing in the
   * toolchain says so: restore succeeds, `--outdated` is silent, the manifest
   * diff shows a version number. So the two are compared here, where the
   * installed package's own `.nuspec` and the feed are both reachable.
   *
   * Nothing is said unless there is something to say. Not installed, or showing
   * the version already installed, and there is no comparison to make at all;
   * and the comparison itself stays quiet whenever either side declares no
   * licence, since `<license>` only arrived in 2019 and a package old enough
   * predates it — reading that as a change would fire on almost every
   * long-lived package.
   */
  /**
   * The same comparison, for every package a batch would move (#89).
   *
   * The checks run together rather than in turn: a batch is tens of packages,
   * and run one after another even a cheap check would keep the user waiting on
   * a click they have already made. The budget covers the whole set — if it runs
   * out, the answer is "nothing found" and the batch goes ahead, with the skip
   * recorded in the log so the silence is at least accounted for. Nothing here
   * fails the batch: an unknown licence is not a reason to refuse an update the
   * user asked for.
   */
  private async _batchLicenseChanges(
    items: ReadonlyArray<{ packageId: string; fromVersion: string; toVersion: string }>,
    configFiles: string[],
  ): Promise<import('./packageLicense').BatchLicenseFinding[]> {
    if (items.length === 0) return [];
    const budget = new AbortController();
    const expiry = setTimeout(() => budget.abort(), this._licenseBudgetMs);
    try {
      const checked = await Promise.race([
        // Capped, not merely bounded in time. The budget limits how long this
        // may take and says nothing about how many connections it opens at once:
        // an "All" of forty packages would otherwise put forty requests to the
        // feed in the same instant, and a feed that answers 429 to the fortieth
        // does so well inside eight seconds. The same cap the rest of the broker
        // uses, and the natural place for the HTTP gateway of #116 to take over.
        runWithConcurrency(items.map((item) => async () => {
          const change = await this
            ._licenseChangeFor(item.packageId, item.toVersion, configFiles, budget.signal)
            .catch(() => undefined);
          return change ? { ...item, change } : undefined;
        }), getConfig().dotnetConcurrency),
        new Promise<undefined>((resolve) => {
          budget.signal.addEventListener('abort', () => resolve(undefined), { once: true });
        }),
      ]);
      if (!checked) {
        this.logger.info(
          `Licence check skipped: ${items.length} package(s) did not answer within ${this._licenseBudgetMs}ms — the update proceeds`,
        );
        return [];
      }
      return checked.filter((f): f is import('./packageLicense').BatchLicenseFinding => !!f);
    } finally {
      clearTimeout(expiry);
    }
  }

  /**
   * What taking the selected version would change about the dependencies (#114).
   *
   * Both versions' groups come out of the same registration pages the version
   * walk already made, so this asks the cache and never the feed — which is why
   * it can ride along with the licence question instead of being a request of
   * its own.
   */
  /**
   * The installed entry the panel says it is describing.
   *
   * A solution resolves a package per project and those versions differ, so
   * taking whichever entry the CLI listed first would compare against a version
   * that is not on screen — the case `resolveVersionSpread` exists for
   * (#90, #115).
   */
  private _installedEntryFor(
    packageId: string,
  ): { resolvedVersion: string; projectPath: string } | undefined {
    const direct = this._lastListed?.installed.filter((p) => packageIdsEqual(p.id, packageId)) ?? [];
    const transitive = this._lastListed?.implicit.filter((p) => packageIdsEqual(p.id, packageId)) ?? [];
    const spread = resolveVersionSpread(direct, transitive);
    return [...direct, ...transitive].find((p) => p.resolvedVersion === spread?.primary);
  }

  private async _dependencyDiffFor(
    packageId: string,
    selectedVersion: string,
    configFiles: string[],
    signal?: AbortSignal,
  ): Promise<import('./packageVersionDiff').VersionDependencyDiff | undefined> {
    const installedEntry = this._installedEntryFor(packageId);
    if (!installedEntry) return undefined;
    if (versionsEqual(installedEntry.resolvedVersion, selectedVersion)) return undefined;

    const [before, after] = await Promise.all([
      this._getSearchMetadata(packageId, installedEntry.resolvedVersion, configFiles, signal)
        .then((m) => m.declaredDependencies).catch(() => undefined),
      this._getSearchMetadata(packageId, selectedVersion, configFiles, signal)
        .then((m) => m.declaredDependencies).catch(() => undefined),
    ]);

    const frameworks = [...new Set(
      Object.values(this._lastListed?.projectFrameworks ?? {}).flat(),
    )];
    const diff = versionDependencyDiff(before, after, frameworks);
    return isEmptyDiff(diff) ? undefined : diff;
  }

  private async _licenseChangeFor(
    packageId: string,
    selectedVersion: string,
    configFiles: string[],
    signal?: AbortSignal,
  ): Promise<import('./packageLicense').LicenseChange | undefined> {
    if (!selectedVersion) return undefined;

    const installedEntry = this._installedEntryFor(packageId);
    if (!installedEntry) return undefined;
    if (versionsEqual(installedEntry.resolvedVersion, selectedVersion)) return undefined;

    const installedMetadata = await this._tryReadNuspecMetadata(
      installedEntry.projectPath, packageId, installedEntry.resolvedVersion,
    );
    const installed = installedMetadata?.license;
    if (!installed) return undefined;

    // The catalog states an SPDX expression per version and costs nothing extra
    // here. It cannot state a file licence at all — measured, the registration
    // leaf has no such key — so only then is the package's own nuspec worth a
    // request of its own.
    const catalogMetadata = await this._getSearchMetadata(packageId, selectedVersion, configFiles, signal)
      .catch(() => undefined);
    if (signal?.aborted) return undefined;
    const selected = catalogMetadata?.license
      ?? await this.licenseLookup?.forVersion(packageId, selectedVersion, configFiles, signal)
        .catch(() => undefined);

    // Only ever to give a file licence somewhere to be read — a file licence is
    // bundled in the package and has no address of its own, and this is the one
    // field that points at it. Never compared: see `licenseChange`.
    return licenseChange(
      installed,
      selected,
      { installed: installedMetadata?.licenseUrl, selected: catalogMetadata?.licenseUrl },
      installed.type === 'file'
        ? await this._installedLicenseFile(
          installedEntry.projectPath, packageId, installedEntry.resolvedVersion, installed.value,
        )
        : undefined,
    );
  }

  /**
   * The installed version's licence file, inside the extracted package (#89).
   *
   * The installed side is the one that is on disk, so its file licence — the
   * kind nothing on the web can name — can be opened and read. Undefined on any
   * miss: a pruned cache, or a package that never shipped the file it names.
   */
  private async _installedLicenseFile(
    projectPath: string,
    packageId: string,
    version: string,
    relativePath: string,
  ): Promise<string | undefined> {
    try {
      const packageFolders = await readPackageFolders(projectPath);
      const nuspecPath = await findNuspecFile(packageFolders, packageId, version);
      return nuspecPath ? await findLicenseFile(nuspecPath, relativePath) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Undefined on any failure (missing packageFolders, pruned cache, unparsable nuspec) — caller falls back to search. */
  private async _tryReadNuspecMetadata(
    projectPath: string,
    packageId: string,
    version: string,
  ): Promise<import('./types').PackageMetadata | undefined> {
    try {
      const packageFolders = await readPackageFolders(projectPath);
      if (packageFolders.length === 0) return undefined;
      const nuspecPath = await findNuspecFile(packageFolders, packageId, version);
      if (!nuspecPath) return undefined;
      const xml = await fs.readFile(nuspecPath, 'utf8');
      const parsed = parseNuspec(xml);
      if (!parsed) return undefined;

      // Everything below is derived from the restore graph (project.assets.json),
      // not the nuspec — declared-vs-resolved dependency ranges, the full
      // supported-framework list, and which asset was selected all live
      // there instead (#86 design pass). Best-effort: if assets.json is
      // missing or the package isn't in it under this exact version (a
      // stale/pruned obj folder), these fields are simply absent.
      const assetsJson = await readAssetsJson(projectPath);
      const framework = assetsJson ? findFrameworkForPackage(assetsJson, packageId, version) : undefined;
      const dependencyTree = assetsJson && framework
        ? resolvePackageDependencyTree(assetsJson, packageId, version, framework)
        : undefined;
      const supportedFrameworks = assetsJson ? packageSupportedFrameworks(assetsJson, packageId, version) : undefined;
      const runtimeIdentifiers = await listRuntimeIdentifiers(nuspecPath);

      return {
        id: parsed.id,
        version: parsed.version,
        authors: parsed.authors,
        owners: parsed.owners,
        projectUrl: parsed.projectUrl,
        licenseUrl: parsed.licenseUrl,
        license: parsed.license,
        copyright: parsed.copyright,
        repository: parsed.repository,
        description: parsed.description,
        tags: parsed.tags,
        supportedFrameworks: supportedFrameworks?.length ? supportedFrameworks : undefined,
        runtimeIdentifiers: runtimeIdentifiers.length > 0 ? runtimeIdentifiers : undefined,
        dependencyTree,
        // `published` is a feed property, never derived from a local file (#86).
      };
    } catch {
      return undefined;
    }
  }

  /** A fresh enrich-detailed-search cache hit for `version`, else a new CLI call. */
  private async _getSearchMetadata(
    packageId: string,
    version: string | undefined,
    configFiles: string[],
    signal?: AbortSignal,
  ): Promise<import('./types').PackageMetadata> {
    const cached = this._cache.get(packageId.toLowerCase());
    const ttl = getConfig().cacheTtlMs;
    const cacheFresh = !!(cached && Date.now() - cached.fetchedAt < ttl);
    const wantVersion = version || cached?.latestVersion;
    const cachedEntry = cacheFresh && wantVersion ? cached?.metadataByVersion?.[wantVersion] : undefined;

    if (cachedEntry && wantVersion) {
      this._logCacheAnswer('Metadata', packageId, [
        wantVersion,
        cachedEntry.published ? `published ${cachedEntry.published}` : 'no publication date',
        cachedEntry.license ? `licence ${cachedEntry.license.type}` : 'no licence',
      ], Date.now() - (cached?.fetchedAt ?? 0));
      return searchedMetadataToPackageMetadata(packageId, wantVersion, cachedEntry);
    }
    return this.backend.getMetadata(packageId, version ?? '', configFiles, signal);
  }

  /**
   * An answer served from this broker's own cache (#114 diagnosis).
   *
   * This cache sits above the HTTP cache and the backend both, so when it
   * answers, neither of them has anything to record and the log shows the
   * request arriving and nothing after it — which reads as "the HTTP path is
   * not being logged" rather than "no request was made". The row says what was
   * served, not merely that something was: the question these rows exist to
   * answer is why a field is empty, and "37 versions, 0 dated" answers it where
   * "answered from cache" does not.
   */
  private _logCacheAnswer(what: string, packageId: string, details: string[], ageMs: number): void {
    this.logger.logCliOperation({
      timestamp: new Date(),
      kind: 'info',
      command: `${what} answered from cache: ${packageId}`,
      args: [...details, `age: ${Math.round(ageMs / 1000)}s`, `ttl: ${Math.round(getConfig().cacheTtlMs / 1000)}s`],
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      durationMs: 0,
    });
  }

  /**
   * What the feed said about each version (#86, #114) — undefined when it said
   * nothing about any of them, so the message stays lean in the common case.
   *
   * Marks for the dropdown, and the publication date for the panel: the panel
   * dates whatever version is picked, which is usually not the version metadata
   * was fetched for, so the dates have to travel with the list.
   */
  private _versionFlagsFor(
    entry: CacheEntry | undefined,
  ): Record<string, VersionFlag> | undefined {
    if (!entry) return undefined;
    // Both halves are the same answer from the same feed, held apart only
    // because one of them may not be written into `metadataByVersion`. An entry
    // that has only ever been through `getAllVersions` carries the second half
    // alone, and reporting "nothing is marked" for it blanks the dropdown.
    const out: Record<string, VersionFlag> = { ...entry.versionFlags };
    for (const [v, m] of Object.entries(entry.metadataByVersion ?? {})) {
      if (m.vulnerable || m.deprecation || m.published || m.declaredDependencies?.length) {
        out[v] = {
          ...out[v],
          vulnerable: m.vulnerable,
          deprecation: m.deprecation,
          advisories: m.advisories,
          published: m.published ?? out[v]?.published,
          declaredDependencies: m.declaredDependencies ?? out[v]?.declaredDependencies,
        };
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  private async _handleGetAllVersions(
    packageId: string,
    configFiles: string[],
    prerelease: boolean,
  ): Promise<void> {
    // Superseded the moment the reader picks another package before this one
    // answers (#116) — a cache hit above still answers synchronously either
    // way, so cancelling here only ever stops a request actually in flight.
    this._cancelVersionsLookup();
    const signal = this._versionsAbort.signal;

    const key = packageId.toLowerCase();
    const cached = this._cache.get(key);
    const ttl = getConfig().cacheTtlMs;
    const cacheIsFresh = !!(cached?.versions?.length && (Date.now() - cached.fetchedAt < ttl));

    if (cached?.versions?.length) {
      this.provider.postMessage({
        type: 'ALL_VERSIONS',
        packageId,
        versions: cached.versions,
        versionFlags: this._versionFlagsFor(cached),
      });
    }
    if (cacheIsFresh) {
      const served = this._versionFlagsFor(cached) ?? {};
      const values = Object.values(served);
      this._logCacheAnswer('Versions', packageId, [
        `${cached?.versions?.length ?? 0} versions`,
        `${values.filter((f) => f.published).length} dated`,
        `${values.filter((f) => f.vulnerable || f.deprecation).length} marked`,
      ], Date.now() - (cached?.fetchedAt ?? 0));
      return;
    }
    try {
      const prev = cached?.versions ?? [];
      const { versions, versionFlags } = await this.backend.getAllVersions(packageId, configFiles, prerelease, signal);
      if (signal.aborted) return;

      if (cached) {
        cached.versions = versions;
        cached.fetchedAt = Date.now();
        // Only enrich a version's metadata this call already has a richer
        // entry for (from `enrichPackage`) — never fabricate a flags-only
        // `{ vulnerable, deprecation }` entry here. `_getSearchMetadata`'s
        // cache-hit check treats any `metadataByVersion[v]` entry as a
        // complete search result and skips a real detailed lookup; a
        // flags-only entry created here would silently lose that version's
        // description/projectUrl the next time metadata is requested (#86).
        const metadataByVersion: Record<string, import('./types').SearchedVersionMetadata> = { ...cached.metadataByVersion };
        for (const [v, flags] of Object.entries(versionFlags)) {
          metadataByVersion[v] = { ...metadataByVersion[v], ...flags };
        }
        cached.metadataByVersion = metadataByVersion;
        cached.versionFlags = versionFlags;
      } else {
        // The marks travel on their own field rather than inside
        // `metadataByVersion`, which must keep meaning "a full search result
        // for this version". Without them here, the next selection read this
        // entry, found nothing marked, and said so — blanking the dropdown.
        this._cache.set(key, {
          latestVersion: versions[0] ?? '',
          sourceName: '',
          versions,
          versionFlags,
          fetchedAt: Date.now(),
        });
      }

      const changed = versions.length !== prev.length || versions.some((v, i) => v !== prev[i]);
      if (changed || prev.length === 0) {
        // The outgoing message's marks combine any richer cached flags with
        // this call's own fresh ones — but that merge is never written back
        // into `metadataByVersion` (see above), only sent on the wire.
        const mergedFlags: Record<string, VersionFlag> = {
          ...this._versionFlagsFor(this._cache.get(key)),
        };
        for (const [v, flags] of Object.entries(versionFlags)) {
          if (flags.vulnerable || flags.deprecation || flags.published || flags.listed === false
            || flags.declaredDependencies?.length) {
            mergedFlags[v] = {
              vulnerable: flags.vulnerable,
              deprecation: flags.deprecation,
              advisories: flags.advisories,
              published: flags.published,
              listed: flags.listed,
              declaredDependencies: flags.declaredDependencies,
            };
          }
        }
        this.provider.postMessage({
          type: 'ALL_VERSIONS',
          packageId,
          versions,
          versionFlags: Object.keys(mergedFlags).length > 0 ? mergedFlags : undefined,
        });
      }
    } catch {
      // Superseded, not failed — the newer request already answered or is
      // still running (#116).
      if (signal.aborted) return;
      // If fetch fails and we already sent cached — that's fine, no error needed
      if (!cached?.versions?.length) {
        this.provider.postMessage({
          type: 'ERROR',
          message: `Failed to load versions for ${packageId}`,
        });
      }
    }
  }

  private async _handleInstallSingle(
    projectPath: string,
    packageId: string,
    version: string,
    framework?: string,
    acrossLines?: boolean,
  ): Promise<void> {
    if (this._rejectBlockedVersionChange(packageId)) return;
    const attempts = await this._installOnProjects(
      packageId, version, [projectPath], undefined, undefined, false, framework, undefined, acrossLines,
    );
    await this._finishInstallAttempts(packageId, version, attempts);
  }

  /**
   * Replace one unconditional `PackageReference` with one per target framework
   * (#82). `dotnet add --framework` cannot narrow a shared reference — it edits
   * that one line and moves every framework with it — so the shape is rebuilt
   * instead: remove the shared reference, then add it back once per framework,
   * the named one at the new version and the rest at the version they already
   * had. Nothing changes for a framework the user did not pick.
   *
   * Each add carries its own restore, and deliberately so: `--framework` is
   * only honoured when the compatibility check runs, and `--no-restore` makes
   * the CLI write the version into *every* conditional group instead — measured
   * on `demo/multi-tfm`, and the reason this cannot borrow the batched
   * `--no-restore` shape the entangled-cluster path uses (#38).
   *
   * The project file decides whether this may run at all. `dotnet list` cannot
   * tell one unconditional reference from two conditional groups that happen to
   * agree on a version, and rebuilding the second kind would replace whatever
   * conditions it had with plain TFM equalities — losing a `!=` or a
   * `Contains(...)` this code cannot write back. So the reference has to be
   * genuinely shared, read from the file, before anything is removed.
   *
   * A failure restores the snapshot outright rather than going through the
   * `onFailedUpdate` setting: `keep` exists to leave a *version bump* in place
   * for the user to inspect, and there is no version to keep here — a half-done
   * split is a project that lost its reference.
   */
  private async _handleSplitReference(
    projectPath: string,
    packageId: string,
    frameworks: string[],
    framework: string,
    version: string,
  ): Promise<void> {
    if (this._rejectBlockedVersionChange(packageId)) return;
    if (frameworks.length === 0) return;

    const snapshots = await snapshotProjectFiles(projectPath);
    this.trace?.noteTouchedProject(projectPath);
    const xml = snapshots.find((f) => pathsEqual(f.path, projectPath))?.content ?? '';
    if (!hasSharedReference(xml, packageId)) {
      // `dotnet list` reports one entry per framework either way, so the webview
      // cannot tell a shared reference from conditional groups that happen to
      // agree on a version. The file can. When they are already conditional,
      // the ask needs no split at all — the group for this framework is right
      // there to be written, and rebuilding the file would only risk losing a
      // condition this code cannot write back.
      const conditional = frameworksToUpdate(xml, packageId);
      if (conditional.includes(framework)) {
        await this._handleInstallSingle(projectPath, packageId, version, framework);
        return;
      }
      this.provider.postMessage({
        type: 'OPERATION_ERROR',
        operation: 'install',
        packageId,
        failures: [{
          projectPath,
          stderr: `${packageId} is not referenced by a single unconditional PackageReference in `
            + `this project, and no conditional group targets ${framework}, so there is nothing `
            + 'to split. Change the version on the framework row instead.',
          exitCode: null,
        }],
        succeededProjects: [],
      });
      return;
    }
    const previousVersion = readPackageVersionFromSnapshots(snapshots, packageId);
    const results = await this._rebuildAsFrameworkGroups(
      projectPath, packageId, frameworks, [framework], version, previousVersion,
    );

    const ok = results.every(isCliOperationSuccess);
    this.trace?.recordBroker('split-reference', {
      project: path.basename(projectPath),
      packageId,
      version,
      framework,
      ok,
    });

    const attempt: InstallAttempt = {
      projectPath,
      snapshots,
      previousVersion,
      result: mergeCliResults(results),
    };
    // Restores the file and re-restores the project, the same way a rolled-back
    // update does. Reported as `mutated: false` afterwards so the shared
    // bookkeeping does not roll back a file that is already back where it
    // started — or, under `keep`, offer a Rollback button for it.
    if (!ok) await this._restoreAttempts([attempt]);
    await this._finishInstallAttempts(packageId, version, [
      ok ? attempt : { ...attempt, mutated: false },
    ]);
  }

  /**
   * Remove a shared reference and add it back once per framework: the ones in
   * `updated` at `version`, every other one at the version it already had.
   *
   * Each add restores, for the reason `_handleSplitReference` documents —
   * `--framework` is only honoured when the compatibility check runs. Stops at
   * the first failure; the caller puts the file back.
   */
  private async _rebuildAsFrameworkGroups(
    projectPath: string,
    packageId: string,
    frameworks: string[],
    updated: readonly string[],
    version: string,
    previousVersion: string | null,
    signal?: AbortSignal,
  ): Promise<CliResult[]> {
    const results: CliResult[] = [];
    const removed = await this.backend.removePackage(projectPath, packageId);
    results.push(removed);
    if (!isCliOperationSuccess(removed)) return results;
    for (const tfm of frameworks) {
      const target = updated.includes(tfm) ? version : (previousVersion ?? version);
      const added = await this.backend.installPackage(projectPath, packageId, target, signal, tfm);
      results.push(added);
      if (!isCliOperationSuccess(added) || signal?.aborted) break;
    }
    return results;
  }

  /**
   * A write aimed at named frameworks of a reference the project states once,
   * unconditionally, for all of them (#82).
   *
   * `dotnet add --framework` cannot narrow that: measured on a two-framework
   * project, asking for `net9.0` alone rewrites the one shared line and
   * `net10.0` moves with it, the CLI saying only that the package is
   * "compatible with a subset of the specified frameworks". The frameworks the
   * user switched off in the project popup would change anyway — the opposite
   * of what switching them off asked for. So the reference is rebuilt into one
   * group per framework, exactly as the single-row split does, and only the
   * named ones take the new version.
   *
   * Returns `undefined` when none of this applies, leaving the caller to write
   * the way it always did: `--framework` lands correctly both on a reference
   * that is already conditional and on a package the project does not reference
   * yet, where it creates the conditional group itself.
   */
  private async _narrowSharedReference(
    projectPath: string,
    snapshots: FileSnapshot[],
    previousVersion: string | null,
    packageId: string,
    version: string,
    targets: string[],
    signal?: AbortSignal,
  ): Promise<{ result: CliResult; skipped?: boolean; mutated?: boolean; frameworks?: string[] } | undefined> {
    const xml = snapshots.find((f) => pathsEqual(f.path, projectPath))?.content ?? '';
    // A legacy project is written by editing its XML, not by `dotnet add`, and
    // targets one framework anyway — nothing here applies to it.
    if (!isSdkStyleProject(xml)) return undefined;
    if (!hasSharedReference(xml, packageId)) return undefined;
    if (previousVersion !== null && compareSemVer(previousVersion, version) === 0) {
      // The one line already reads the target, so every framework is on it
      // and there is nothing a rebuild would change.
      this._logDecision('update skipped', [
        `${packageId} ${version}`,
        'the shared reference already states this version',
        path.basename(projectPath),
      ]);
      return { result: skippedInstallResult(), skipped: true };
    }

    // The whole set, or the groups for the frameworks left alone would not be
    // written back and the package would leave them. The file answers when it
    // states the frameworks literally; `dotnet list` reports what MSBuild
    // evaluated, which is the answer when they come from a property.
    const evaluated = Object.entries(this._lastListed?.projectFrameworks ?? {})
      .find(([p]) => pathsEqual(p, projectPath))?.[1] ?? [];
    const stated = declaredFrameworks(xml);
    const declared = stated.length > 0 ? stated : evaluated;
    if (declared.length === 0 || targets.some((t) => !declared.includes(t))) {
      return {
        result: {
          exitCode: null,
          stdout: '',
          stderr: `${packageId} is referenced once for every framework of this project, so `
            + `installing it into ${targets.join(', ')} alone means splitting that reference — `
            + 'and the frameworks this project targets could not be read, so the rest of them '
            + 'would lose the package. Install it into every framework instead, or split the '
            + 'reference from the project row.',
          timedOut: false,
        },
        mutated: false,
      };
    }

    const results = await this._rebuildAsFrameworkGroups(
      projectPath, packageId, declared, targets, version, previousVersion, signal,
    );
    const ok = results.every(isCliOperationSuccess);
    this.trace?.recordBroker('narrow-shared-reference', {
      project: path.basename(projectPath),
      packageId,
      version,
      frameworks: targets.join(','),
      ok,
    });
    // A half-done rebuild is a project that lost its reference, not a version
    // bump worth keeping, so it goes back immediately and is reported as
    // `mutated: false` — the same choice the single-row split makes, and what
    // keeps it away from `onFailedUpdate: keep` and its Rollback button.
    if (!ok) {
      await this._restoreAttempts([{
        projectPath, snapshots, previousVersion, result: mergeCliResults(results),
      }]);
    }
    return {
      result: mergeCliResults(results),
      frameworks: ok ? targets : undefined,
      mutated: ok,
    };
  }

  private async _handleInstallMulti(
    projects: string[],
    packageId: string,
    version: string,
    frameworks?: Record<string, string[]>,
    acrossLines?: boolean,
  ): Promise<void> {
    if (this._rejectBlockedVersionChange(packageId)) return;
    // `_installOnProjects` already reports each project as it lands — the batch
    // flow has used this hook since #58. Without it every selected row sat at
    // "…" until the whole operation finished (#104).
    const attempts = await this._installOnProjects(
      packageId,
      version,
      projects,
      (projectPath, ok) => this.provider.postMessage({
        type: 'PROJECT_OPERATION_DONE', operation: 'install', packageId, projectPath, ok,
      }),
      undefined,
      false,
      undefined,
      frameworks,
      acrossLines,
    );
    await this._finishInstallAttempts(packageId, version, attempts);
  }

  private async _installOnProjects(
    packageId: string,
    version: string,
    projects: string[],
    onProjectDone?: (projectPath: string, ok: boolean) => void,
    signal?: AbortSignal,
    retryTransient = false,
    /** One target framework to confine every write to (#82). */
    framework?: string,
    /** Frameworks to write per project, for the ones narrowed to a subset (#82). */
    frameworksByProject?: Record<string, string[]>,
    /** Confirmed: write conditional groups outside this version's line too (#82). */
    acrossLines?: boolean,
  ): Promise<InstallAttempt[]> {
    const generation = this._restoreGeneration;
    const prepared = await Promise.all(
      projects.map(async (projectPath) => {
        const snapshots = await snapshotProjectFiles(projectPath);
        this.trace?.noteTouchedProject(projectPath);
        this.trace?.recordBroker('snapshot', { project: path.basename(projectPath) });
        return {
          projectPath,
          snapshots,
          previousVersion: readPackageVersionFromSnapshots(snapshots, packageId),
        };
      }),
    );
    const attempts = await runWithConcurrency(
      prepared.map((p) => async () => {
        if (signal?.aborted) {
          const result: CliResult = {
            exitCode: null, stdout: '', stderr: 'Cancelled', timedOut: false, cancelled: true,
          };
          onProjectDone?.(p.projectPath, false);
          return { ...p, result };
        }
        // A project narrowed to some of its frameworks is written once per
        // framework; every other project keeps the single plain write it always
        // had, `undefined` and all (#82).
        const targets: Array<string | undefined> = frameworksByProject?.[p.projectPath]?.length
          ? frameworksByProject[p.projectPath]
          : [framework];
        const { result: first, skipped, mutated, skippedUnsupported, frameworks } = await this._addOrUpdateFrameworks(
          p.projectPath,
          p.snapshots,
          p.previousVersion,
          packageId,
          version,
          targets,
          signal,
          acrossLines,
        );
        let result = first;
        this.trace?.recordBroker('add', {
          project: path.basename(p.projectPath),
          packageId,
          version,
          ok: isCliOperationSuccess(result),
        });
        for (
          let extra = 0;
          extra < INSTALL_RETRY_EXTRA_ATTEMPTS
            && retryTransient
            && !skipped
            && !skippedUnsupported
            && isRetryableCliFailure(result)
            && !signal?.aborted;
          extra++
        ) {
          await delayInstallRetry(signal);
          if (signal?.aborted) break;
          result = mutated
            ? await this.backend.restoreProject(p.projectPath, signal)
            : await this.backend.installPackage(
              p.projectPath, packageId, version, signal, targets[0],
            );
          this.trace?.recordBroker('add-retry', {
            project: path.basename(p.projectPath),
            packageId,
            version,
            ok: isCliOperationSuccess(result),
          });
        }
        onProjectDone?.(p.projectPath, isCliOperationSuccess(result));
        return { ...p, result, skipped, mutated, skippedUnsupported, frameworks };
      }),
      getConfig().dotnetConcurrency,
    );
    if (generation === this._restoreGeneration) {
      // `dotnet add`/the legacy-packageref restore it triggers can itself carry
      // NU190x audit warnings — feed that text into `_lastRestoreText` too, not
      // only explicit Restore/Force refresh, so `_scanVulnerabilities`'s
      // restore-text fallback (#53) doesn't stay pinned to the last *explicit*
      // restore after a plain install/update.
      const merged = mergeCliResults(attempts.map((a) => a.result));
      this._lastRestoreText = `${merged.stdout}\n${merged.stderr}`;
    }
    return attempts;
  }

  /**
   * One project's write, once per target framework it was narrowed to (#82).
   * `targets` is `[undefined]` for the ordinary case, which is the single plain
   * call this always made. The first failure stops the rest: the restore that
   * each one runs would fail again anyway, and one error reads better than
   * several saying the same thing.
   */
  private async _addOrUpdateFrameworks(
    projectPath: string,
    snapshots: FileSnapshot[],
    previousVersion: string | null,
    packageId: string,
    version: string,
    targets: Array<string | undefined>,
    signal?: AbortSignal,
    acrossLines?: boolean,
  ): Promise<{
    result: CliResult;
    skipped?: boolean;
    mutated?: boolean;
    skippedUnsupported?: boolean;
    frameworks?: string[];
  }> {
    // Every target named, and the project stating one shared reference for all
    // of them, is the one shape `--framework` cannot write: it would move the
    // frameworks the caller left out (#82).
    const named = targets.filter((t): t is string => !!t);
    if (named.length > 0 && named.length === targets.length) {
      const narrowed = await this._narrowSharedReference(
        projectPath, snapshots, previousVersion, packageId, version, named, signal,
      );
      if (narrowed) return narrowed;
    }

    const outcomes = [];
    for (const framework of targets.length > 0 ? targets : [undefined]) {
      const outcome = await this._addOrUpdatePackage(
        projectPath, snapshots, previousVersion, packageId, version, signal, framework, acrossLines,
      );
      outcomes.push(outcome);
      if (!isCliOperationSuccess(outcome.result) || signal?.aborted) break;
    }
    const frameworks = [...new Set(outcomes.flatMap((o) => o.frameworks ?? []))];
    return {
      result: mergeCliResults(outcomes.map((o) => o.result)),
      frameworks: frameworks.length > 0 ? frameworks : undefined,
      // Skipped only when nothing was written anywhere, and mutated as soon as
      // any one framework changed the file.
      skipped: outcomes.every((o) => o.skipped),
      mutated: outcomes.some((o) => o.mutated === true)
        ? true
        : (outcomes.every((o) => o.mutated === false) ? false : undefined),
      skippedUnsupported: outcomes.some((o) => o.skippedUnsupported),
    };
  }

  /**
   * Whether the last `dotnet list` for this project resolved `packageId` at
   * all — the only way to tell a fresh install from an update to a reference
   * an import declares, when the project file itself states neither
   * `Include=` nor `Update=` for it (#124).
   */
  private _isPackageInstalledInProject(projectPath: string, packageId: string): boolean {
    return (this._lastListed?.installed ?? []).some(
      (p) => packageIdsEqual(p.id, packageId) && pathsEqual(p.projectPath, projectPath),
    );
  }

  private async _addOrUpdatePackage(
    projectPath: string,
    snapshots: FileSnapshot[],
    previousVersion: string | null,
    packageId: string,
    version: string,
    signal?: AbortSignal,
    framework?: string,
    acrossLines?: boolean,
  ): Promise<{
    result: CliResult;
    skipped?: boolean;
    mutated?: boolean;
    skippedUnsupported?: boolean;
    frameworks?: string[];
  }> {
    const xml = snapshots.find((s) => pathsEqual(s.path, projectPath))?.content ?? '';
    const style = detectProjectPackageStyle(xml, await packagesConfigExists(projectPath));

    if (style === 'packages-config') {
      return {
        result: {
          exitCode: 1, stdout: '', stderr: PACKAGES_CONFIG_SKIP, timedOut: false,
        },
        mutated: false,
        skippedUnsupported: true,
      };
    }

    // "Already at this version" has to be asked of the reference this write is
    // about. A package referenced per framework has several, and
    // `readPackageVersionFromSnapshots` answers with whichever comes first in
    // the file — so a write another framework needed was skipped, the operation
    // ended having done nothing, and the progress strip waited on a refresh
    // that never came (#82).
    //
    // `isFrameworkScopedReference`/`frameworksToUpdate` only read `Include=`
    // conditions, so a project that splits an `Update=` override into one
    // conditional group per framework looks unconditional to them — the same
    // hazard the comment above describes, just for a shape those two cannot
    // see at all (#124). `updateSpanCount` catches it directly: more than one
    // `Update=` line for this id means the naive single-version comparison
    // cannot be trusted either, so this never silently reports "already at
    // this version" for it — better an attempted write that the CLI then
    // explains than one skipped without a trace.
    const updateSpanCount = findPackageReferenceSpans(xml, packageId, { attribute: 'Update' }).length;
    const sameVersion = framework
      ? versionForFramework(xml, packageId, framework) === version
      : isFrameworkScopedReference(xml, packageId)
        ? frameworksToUpdate(xml, packageId, version, { acrossLines }).length === 0
        : updateSpanCount > 1
          ? false
          : previousVersion !== null && compareSemVer(previousVersion, version) === 0;
    const duplicateLegacy = style === 'legacy-packageref'
      && countPackageReferences(xml, packageId) > 1;
    if (sameVersion && !duplicateLegacy) {
      this._logDecision('update skipped', [
        `${packageId} ${version}`,
        'the project already states this version',
        path.basename(projectPath),
      ]);
      return { result: skippedInstallResult(), skipped: true };
    }

    if (style === 'legacy-packageref') {
      const next = upsertPackageReference(xml, packageId, version);
      await writeProjectXml(projectPath, next);
      this.logger.logCliOperation({
        timestamp: new Date(),
        kind: 'edit',
        command: 'edit PackageReference',
        args: [projectPath, packageId, version],
        stdout: `Set ${packageId} to ${version} (legacy csproj)`,
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 0,
      });
      this.trace?.recordBroker('legacy-packageref', { project: path.basename(projectPath), packageId, version });
      return {
        result: await this.backend.restoreProject(projectPath, signal),
        mutated: true,
      };
    }

    // An SDK-style project can still declare the reference itself, with
    // `Update=` rather than `Include=` — the F# SDK's own
    // `Microsoft.FSharp.NetSdk.props` does this for `FSharp.Core`, and so
    // does a `PackageReference Include=` sitting in `Directory.Build.props`
    // with a project-local `Update=` meant to override it — or not declare
    // it at all, when nothing local overrides the SDK's implicit reference
    // yet. `dotnet add`/`dotnet remove` refuse to edit an item that lives in
    // an imported file, so this has to be a direct XML write instead (#124).
    // Central package management keeps its own path regardless: a `Version`
    // on a `PackageReference` is an error under CPM (NU1008), and the CLI
    // was measured to handle CPM correctly even when the `Include=` itself
    // sits in an imported file.
    //
    // Left to the `framework` branch below when one was named, or when the
    // file already splits the reference into more than one conditional
    // `Update=` group on its own (`updateSpanCount > 1`, `!framework`
    // notwithstanding): the write this does has no `Condition`, so it would
    // land on every framework of a multi-target project at once — #82's
    // whole reason for narrowing to one `--framework`, or one conditional
    // group, in the first place. Worse than the unconditional case, here
    // `upsertPackageReference` would keep one existing conditional group as
    // the "real" one and delete the rest as duplicates, silently dropping
    // whatever versions the other frameworks were pinned to. #124's own
    // proposal never named this combination, so it stays on the CLI here
    // rather than risk either; teaching this write path to produce a
    // conditional `Update=` group is its own piece of work.
    if (
      !framework
      && updateSpanCount <= 1
      && isSdkStyleProject(xml)
      && !hasCentralPackageManagement(snapshots)
      && !findPackageReferenceSpans(xml, packageId, { attribute: 'Include' }).length
    ) {
      const hasUpdate = updateSpanCount > 0;
      // Writing `Update=` for a package nothing declares is silently inert —
      // it never matches an item to override — so this may only fire for a
      // package the project already has, which is the difference between an
      // update and a fresh install; the caller already knows which this is,
      // via what `dotnet list` reported.
      if (hasUpdate || this._isPackageInstalledInProject(projectPath, packageId)) {
        const next = upsertPackageReference(xml, packageId, version, { attribute: 'Update' });
        await writeProjectXml(projectPath, next);
        this.logger.logCliOperation({
          timestamp: new Date(),
          kind: 'edit',
          command: 'edit PackageReference',
          args: [projectPath, packageId, version],
          stdout: `Set ${packageId} to ${version} (SDK-declared reference, ${
            hasUpdate ? 'overriding the existing Update=' : 'adding an Update= override'
          })`,
          stderr: '',
          exitCode: 0,
          timedOut: false,
          durationMs: 0,
        });
        this.trace?.recordBroker('sdk-update-override', { project: path.basename(projectPath), packageId, version });
        return {
          result: await this.backend.restoreProject(projectPath, signal),
          mutated: true,
        };
      }
    }

    if (framework) {
      return {
        result: await this.backend.installPackage(projectPath, packageId, version, signal, framework),
        frameworks: [framework],
      };
    }

    // Nobody named a framework, so the project file decides. A package pinned
    // in conditional groups is written one group at a time: a single call with
    // no `--framework` rewrites every one of them to this version, which is
    // how a `net8.0` pin used to end up on a `net10.0` target (#82). Writing
    // each group separately lands the same version everywhere the caller meant
    // it to land, and leaves the conditional structure intact.
    const frameworks = frameworksToUpdate(xml, packageId, version, { acrossLines });
    if (frameworks.length === 0) {
      return { result: await this.backend.installPackage(projectPath, packageId, version, signal) };
    }
    const results: CliResult[] = [];
    const written: string[] = [];
    for (const tfm of frameworks) {
      const result = await this.backend.installPackage(projectPath, packageId, version, signal, tfm);
      results.push(result);
      written.push(tfm);
      if (!isCliOperationSuccess(result) || signal?.aborted) break;
    }
    return { result: mergeCliResults(results), frameworks: written };
  }

  private async _removeFromProject(
    projectPath: string,
    packageId: string,
  ): Promise<CliResult> {
    const snapshots = await snapshotProjectFiles(projectPath);
    const xml = snapshots.find((s) => pathsEqual(s.path, projectPath))?.content ?? '';
    const style = detectProjectPackageStyle(xml, await packagesConfigExists(projectPath));

    if (style === 'packages-config') {
      return { exitCode: 1, stdout: '', stderr: PACKAGES_CONFIG_SKIP, timedOut: false };
    }

    if (style === 'legacy-packageref') {
      await writeProjectXml(projectPath, removePackageReferences(xml, packageId));
      this.logger.logCliOperation({
        timestamp: new Date(),
        kind: 'edit',
        command: 'edit PackageReference',
        args: [projectPath, packageId],
        stdout: `Removed ${packageId} (legacy csproj)`,
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 0,
      });
      return this.backend.restoreProject(projectPath);
    }

    // Same reasoning as the write side (#124): `dotnet remove` cannot touch a
    // reference declared with `Update=` in an imported file either, and it
    // fails identically for one declared with no local line at all — worse,
    // only after downloading the package first. CPM stays on the CLI, which
    // handles it correctly.
    if (
      isSdkStyleProject(xml)
      && !hasCentralPackageManagement(snapshots)
      && !findPackageReferenceSpans(xml, packageId, { attribute: 'Include' }).length
    ) {
      const hasUpdate = findPackageReferenceSpans(xml, packageId, { attribute: 'Update' }).length > 0;
      if (!hasUpdate) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: `${packageId} is not declared in ${path.basename(projectPath)} — it comes from `
            + 'the SDK or an imported file, so there is no local reference here to remove.',
          timedOut: false,
        };
      }
      await writeProjectXml(projectPath, removePackageReferences(xml, packageId));
      this.logger.logCliOperation({
        timestamp: new Date(),
        kind: 'edit',
        command: 'edit PackageReference',
        args: [projectPath, packageId],
        stdout: `Removed the ${packageId} override; the version the import declares now applies.`,
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 0,
      });
      return this.backend.restoreProject(projectPath);
    }

    return this.backend.removePackage(projectPath, packageId);
  }

  private async _handleUpdateBatch(
    kind: 'all' | 'family' | 'other',
    items: BatchUpdateItem[],
    includePrerelease: boolean,
    family?: string,
  ): Promise<void> {
    if (this._batchRunning) {
      this.provider.postMessage({
        type: 'ERROR',
        message: 'A batch update is already running',
      });
      return;
    }

    const unblocked = withoutBlocked(
      items.filter((i) => i.packageId && i.toVersion && i.projects.length > 0),
      getBlockedPackages(),
    );
    if (unblocked.length === 0) {
      void vscode.window.showInformationMessage(
        items.length > 0 ? BLOCKED_UPDATES_TOOLTIP : 'No packages to update',
      );
      return;
    }

    const queued = withoutOverRoslynCap(unblocked, this._roslynCap);
    if (queued.length === 0) {
      void vscode.window.showInformationMessage(
        roslynCapRejectMessage(unblocked, this._roslynCap),
      );
      return;
    }

    this._batchRunning = true;
    const abort = new AbortController();
    this._batchAbort = abort;
    const jobId = `batch-${Date.now()}`;
    const job: BatchUpdateJob = {
      id: jobId,
      kind,
      family,
      includePrerelease,
      startedAt: Date.now(),
      items: queued.map((item) => ({
        ...item,
        status: 'pending' as const,
        succeededProjects: [],
        completedProjects: [],
      })),
    };
    this.provider.postMessage({ type: 'BATCH_UPDATE_STARTED', job });

    const keepFailures: InstallAttempt[] = [];

    try {
      // #38: some (project, package) pairs in this batch may be entangled by a
      // ProjectReference version floor — applying them one at a time, each with
      // its own implicit restore, fails every single item even though the full
      // batch would resolve cleanly. Pre-resolve those pairs together (no
      // restore until the whole cluster has landed); everything else keeps the
      // existing one-item-at-a-time flow below untouched.
      const clusterOutcomes = abort.signal.aborted
        ? new Map<string, BatchItemOutcome>()
        : await this._computeClusterOutcomes(queued, abort.signal, keepFailures);

      for (let i = 0; i < queued.length; i++) {
        const item = queued[i];
        if (abort.signal.aborted) {
          for (const rest of queued.slice(i)) {
            this._postBatchItem(jobId, rest.packageId, 'cancelled', [], 'Stopped', []);
          }
          break;
        }

        const clusterKey = (p: string) => `${p} ${item.packageId.toLowerCase()}`;
        const clusteredProjects = item.projects.filter((p) => clusterOutcomes.has(clusterKey(p)));
        const remainingProjects = item.projects.filter((p) => !clusteredProjects.includes(p));
        const clusteredResults = clusteredProjects.map((p) => clusterOutcomes.get(clusterKey(p))!);

        this._postBatchItem(
          jobId,
          item.packageId,
          'running',
          clusteredResults.flatMap((o) => o.succeeded),
          undefined,
          [...clusteredProjects],
        );

        let outcome: BatchItemOutcome;
        if (remainingProjects.length > 0) {
          const succeededSoFar: string[] = [...clusteredResults.flatMap((o) => o.succeeded)];
          const completedSoFar: string[] = [...clusteredProjects];
          const attempts = await this._installOnProjects(
            item.packageId,
            item.toVersion,
            remainingProjects,
            (projectPath, ok) => {
              completedSoFar.push(projectPath);
              if (ok) succeededSoFar.push(projectPath);
              this._postBatchItem(
                jobId,
                item.packageId,
                'running',
                [...succeededSoFar],
                undefined,
                [...completedSoFar],
              );
            },
            abort.signal,
            true,
            item.framework,
          );
          const remainingOutcome = await this._finishInstallAttempts(item.packageId, item.toVersion, attempts, {
            notify: false,
            refresh: false,
          });
          if (remainingOutcome.keepAttempts.length > 0) {
            keepFailures.push(...remainingOutcome.keepAttempts);
          }
          outcome = mergeOutcomes([...clusteredResults, remainingOutcome]);
        } else {
          outcome = mergeOutcomes(clusteredResults);
        }

        const stopped = abort.signal.aborted && outcome.status !== 'ok';
        this._postBatchItem(
          jobId,
          item.packageId,
          stopped ? 'cancelled' : outcome.status,
          outcome.succeeded,
          stopped ? (outcome.error ?? 'Stopped') : outcome.error,
          item.projects,
        );
        if (abort.signal.aborted) {
          for (const rest of queued.slice(i + 1)) {
            this._postBatchItem(jobId, rest.packageId, 'cancelled', [], 'Stopped', []);
          }
          break;
        }
      }

      if (keepFailures.length > 0) {
        this._pendingRollback = { packageId: queued[queued.length - 1].packageId, attempts: keepFailures };
      } else if (abort.signal.aborted) {
        this._pendingRollback = null;
      }

      this.provider.postMessage({
        type: 'BATCH_UPDATE_FINISHED',
        jobId,
        canRollback: keepFailures.length > 0,
        cancelled: abort.signal.aborted,
      });
      await this._refreshAfterMutation({ notifyListError: false });
    } finally {
      this._batchRunning = false;
      this._batchAbort = null;
    }
  }

  /**
   * #38: for every project touched by this batch, checks whether any of its
   * batch packages sits below a `ProjectReference` version floor and, if so,
   * resolves the whole entangled cluster on that project as one no-restore-adds
   * + one-restore unit (via `_runClusterForProject`), reusing the existing
   * `_finishInstallAttempts` for rollback/keep bookkeeping per package.
   * Returns per-(project, packageId) outcomes keyed by `${projectPath} ${packageIdLower}`
   * — empty (and no-op) when nothing in the batch has a floor conflict.
   */
  private async _computeClusterOutcomes(
    queued: BatchUpdateItem[],
    signal: AbortSignal,
    keepFailures: InstallAttempt[],
  ): Promise<Map<string, BatchItemOutcome>> {
    const outcomes = new Map<string, BatchItemOutcome>();
    const projectPaths = [...new Set(queued.flatMap((item) => item.projects))];

    // One project's cluster work (reading its assets file, snapshotting, the
    // no-restore adds, the shared restore) is independent of every other
    // project's — fan out the same way every other multi-project pass in this
    // file does (_restoreProjects, _listProjectsThenApply, _installOnProjects),
    // instead of scanning the whole batch's projects one at a time.
    await runWithConcurrency(
      projectPaths.map((projectPath) => async () => {
        if (signal.aborted) return;

        const membersForProject = queued
          .filter((item) => item.projects.includes(projectPath))
          .map((item) => ({ packageId: item.packageId, toVersion: item.toVersion, framework: item.framework }));
        const batchPackageIds = new Set(membersForProject.map((m) => m.packageId.toLowerCase()));

        const [{ dependencies: depsGraph, floors }, snapshot] = await Promise.all([
          readProjectAssets(projectPath),
          snapshotProjectFiles(projectPath),
        ]);
        const currentVersions = new Map<string, string>();
        for (const { packageId } of membersForProject) {
          const version = readPackageVersionFromSnapshots(snapshot, packageId);
          if (version) currentVersions.set(packageId.toLowerCase(), version);
        }

        const cluster = computeEntangledCluster({ currentVersions, floors, depsGraph, batchPackageIds });
        if (cluster.size === 0) return;

        const members = membersForProject.filter((m) => cluster.has(m.packageId.toLowerCase()));
        this.trace?.recordBroker('cluster-detected', {
          project: path.basename(projectPath),
          packages: members.map((m) => m.packageId).join(', '),
        });

        const results = await this._runClusterForProject(projectPath, members, snapshot, currentVersions, signal);
        for (const { packageId, toVersion, attempt } of results) {
          const outcome = await this._finishInstallAttempts(packageId, toVersion, [attempt], {
            notify: false,
            refresh: false,
          });
          outcomes.set(`${projectPath} ${packageId.toLowerCase()}`, {
            status: outcome.status,
            succeeded: outcome.succeeded,
            error: outcome.error,
          });
          keepFailures.push(...outcome.keepAttempts);
        }
      }),
      getConfig().dotnetConcurrency,
    );

    return outcomes;
  }

  /**
   * Applies every cluster member to one project with `--no-restore`, then runs
   * a single `restoreProject` for the whole set — the fix for #38 (a floor
   * violation fails *every* restore until every entangled package lands, not
   * just the one that violates it). Transient failures retry the same way a
   * normal single-package install does; a real (non-transient) failure on one
   * package's add does not block the others from also being applied — the
   * shared restore afterwards is what ultimately decides success or failure.
   */
  /**
   * One cluster member's add. `targets` is empty for an ordinary reference —
   * the plain `--no-restore` call this path has always made — and otherwise
   * names the conditional groups to write, each on its own so none of the
   * others is collapsed onto this version (#82).
   *
   * A named framework forces the restoring form: `dotnet add --framework
   * --no-restore` ignores the framework and writes every conditional group,
   * measured on `demo/multi-tfm`. Framework-pinned members therefore give up
   * the single shared restore this path exists for (#38) — being written to the
   * right group matters more than being written in one pass. The first failure
   * stops the rest, since the restore afterwards would fail anyway.
   */
  private async _clusterAdd(
    projectPath: string,
    packageId: string,
    version: string,
    targets: Array<string | undefined>,
    signal: AbortSignal,
  ): Promise<CliResult> {
    const list = targets.length > 0 ? targets : [undefined];
    const results: CliResult[] = [];
    for (const framework of list) {
      const result = framework
        ? await this.backend.installPackage(projectPath, packageId, version, signal, framework)
        : await this.backend.installPackageNoRestore(projectPath, packageId, version, signal);
      results.push(result);
      if (!isCliOperationSuccess(result) || signal.aborted) break;
    }
    return mergeCliResults(results);
  }

  private async _runClusterForProject(
    projectPath: string,
    members: Array<{ packageId: string; toVersion: string; framework?: string }>,
    snapshot: FileSnapshot[],
    currentVersions: ReadonlyMap<string, string>,
    signal: AbortSignal,
  ): Promise<Array<{ packageId: string; toVersion: string; attempt: InstallAttempt }>> {
    const addResults = new Map<string, CliResult>();

    for (const { packageId, toVersion, framework } of members) {
      if (signal.aborted) {
        addResults.set(packageId.toLowerCase(), {
          exitCode: null, stdout: '', stderr: 'Cancelled', timedOut: false, cancelled: true,
        });
        continue;
      }
      // Same rule as the ordinary write: an unnamed framework lets the project
      // file decide, so a conditional group outside this target's line is left
      // alone instead of being collapsed onto it (#82).
      const xml = snapshot.find((f) => pathsEqual(f.path, projectPath))?.content ?? '';
      const targets = framework
        ? [framework]
        : (frameworksToUpdate(xml, packageId, toVersion) as Array<string | undefined>);
      let result = await this._clusterAdd(projectPath, packageId, toVersion, targets, signal);
      this.trace?.recordBroker('cluster-add', {
        project: path.basename(projectPath), packageId, version: toVersion, ok: isCliOperationSuccess(result),
      });
      for (
        let extra = 0;
        extra < INSTALL_RETRY_EXTRA_ATTEMPTS && isRetryableCliFailure(result) && !signal.aborted;
        extra++
      ) {
        await delayInstallRetry(signal);
        if (signal.aborted) break;
        result = await this._clusterAdd(projectPath, packageId, toVersion, targets, signal);
        this.trace?.recordBroker('cluster-add-retry', {
          project: path.basename(projectPath), packageId, version: toVersion, ok: isCliOperationSuccess(result),
        });
      }
      addResults.set(packageId.toLowerCase(), result);
    }

    const buildAttempts = (result: (packageId: string) => CliResult) => members.map(({ packageId, toVersion }) => ({
      packageId,
      toVersion,
      attempt: {
        projectPath,
        snapshots: snapshot,
        previousVersion: currentVersions.get(packageId.toLowerCase()) ?? null,
        result: result(packageId),
      } satisfies InstallAttempt,
    }));

    // Aborted between the adds and the restore — nothing here was actually
    // validated; report every member as cancelled rather than "succeeded".
    if (signal.aborted) {
      return buildAttempts(() => ({
        exitCode: null, stdout: '', stderr: 'Cancelled', timedOut: false, cancelled: true,
      }));
    }

    const anyApplied = [...addResults.values()].some((r) => !r.cancelled);
    let restoreResult: CliResult | undefined;
    if (anyApplied) {
      restoreResult = await this.backend.restoreProject(projectPath, signal);
      this.trace?.recordBroker('cluster-restore', {
        project: path.basename(projectPath), ok: isCliOperationSuccess(restoreResult),
      });
      for (
        let extra = 0;
        extra < INSTALL_RETRY_EXTRA_ATTEMPTS && isRetryableCliFailure(restoreResult) && !signal.aborted;
        extra++
      ) {
        await delayInstallRetry(signal);
        if (signal.aborted) break;
        restoreResult = await this.backend.restoreProject(projectPath, signal);
        this.trace?.recordBroker('cluster-restore-retry', {
          project: path.basename(projectPath), ok: isCliOperationSuccess(restoreResult),
        });
      }
    }
    const finalRestoreResult = restoreResult;

    return buildAttempts((packageId) => {
      const addResult = addResults.get(packageId.toLowerCase())!;
      // A package whose own add failed (or was cancelled) reports that failure
      // directly; one that landed cleanly reports the shared restore's outcome.
      return isCliOperationSuccess(addResult) ? (finalRestoreResult ?? addResult) : addResult;
    });
  }

  private _postBatchItem(
    jobId: string,
    packageId: string,
    status: BatchItemStatus,
    succeededProjects: string[],
    error?: string,
    completedProjects?: string[],
  ): void {
    this.trace?.recordBroker('batch-item', { packageId, status });
    this.provider.postMessage({
      type: 'BATCH_UPDATE_ITEM',
      jobId,
      packageId,
      status,
      succeededProjects,
      completedProjects: completedProjects ?? succeededProjects,
      error,
    });
  }

  private async _finishInstallAttempts(
    packageId: string,
    version: string,
    attempts: InstallAttempt[],
    opts: { notify?: boolean; refresh?: boolean } = {},
  ): Promise<{
    status: BatchItemStatus;
    succeeded: string[];
    error?: string;
    keepAttempts: InstallAttempt[];
  }> {
    const notify = opts.notify !== false;
    const refresh = opts.refresh !== false;

    const timedOut = attempts.find((a) => a.result.timedOut);
    if (timedOut && attempts.length === 1) {
      const mutatedTimedOut = attempts.filter((a) => a.result.timedOut && a.mutated === true);
      let keepAttempts: InstallAttempt[] = [];
      if (mutatedTimedOut.length > 0) {
        const mode = getConfig().onFailedUpdate;
        if (mode === 'rollback') {
          await this._restoreAttempts(mutatedTimedOut);
          if (notify) this._pendingRollback = null;
        } else {
          keepAttempts = mutatedTimedOut;
          if (notify) this._pendingRollback = { packageId, attempts: mutatedTimedOut };
          this._patchInstalledVersions(packageId, version, mutatedTimedOut);
        }
      }
      if (notify) {
        this.provider.postMessage({
          type: 'OPERATION_TIMEOUT',
          command: mutatedTimedOut.length > 0
            ? `dotnet restore ${timedOut.projectPath}`
            : `dotnet add ${timedOut.projectPath} package ${packageId} --version ${version}`,
        });
      }
      if (refresh && mutatedTimedOut.length > 0) {
        await this._refreshAfterMutation({ notifyListError: false });
      }
      return { status: 'timeout', succeeded: [], error: 'Operation timed out', keepAttempts };
    }

    const succeededAttempts = attempts.filter((a) => isCliOperationSuccess(a.result));
    const mutatedAttempts = succeededAttempts.filter((a) => !a.skipped);
    const failed = attempts.filter((a) =>
      !isCliOperationSuccess(a.result) && !a.skippedUnsupported,
    );
    const cancelledAttempts = failed.filter((a) => a.result.cancelled);
    const realFailed = failed.filter((a) => !a.result.cancelled);
    const skippedUnsupported = attempts.filter((a) => a.skippedUnsupported);
    const succeeded = succeededAttempts.map((a) => a.projectPath);

    if (failed.length === 0) {
      if (skippedUnsupported.length > 0 && succeededAttempts.length === 0) {
        if (notify) {
          this.provider.postMessage({
            type: 'OPERATION_ERROR',
            operation: 'install',
            packageId,
            failures: skippedUnsupported.map((a) => cliFailure(a.projectPath, a.result, {
              previousVersion: a.previousVersion,
              attemptedVersion: version,
            })),
            succeededProjects: [],
            rollbackApplied: false,
            canRollback: false,
          });
        }
        return {
          status: notify ? 'error' : 'ok',
          succeeded: [],
          error: notify ? PACKAGES_CONFIG_SKIP : undefined,
          keepAttempts: [],
        };
      }
      if (notify) {
        this._pendingRollback = null;
        this.provider.postMessage({
          type: 'OPERATION_SUCCESS',
          operation: 'install',
          packageId,
          affectedProjects: succeeded,
          refreshing: refresh && mutatedAttempts.length > 0,
        });
      } else if (mutatedAttempts.length > 0) {
        this._patchInstalledVersions(packageId, version, mutatedAttempts);
      }
      if (refresh && mutatedAttempts.length > 0) await this._refreshAfterMutation();
      return { status: 'ok', succeeded, keepAttempts: [] };
    }

    // Stop is not a failed update: always restore in-flight adds, never keep/patch.
    if (cancelledAttempts.length > 0) {
      await this._restoreAttempts(cancelledAttempts);
    }

    if (realFailed.length === 0) {
      if (notify) this._pendingRollback = null;
      if (succeededAttempts.length > 0) {
        this._patchInstalledVersions(packageId, version, succeededAttempts);
      }
      if (refresh) await this._refreshAfterMutation({ notifyListError: false });
      return { status: 'cancelled', succeeded, error: 'Stopped', keepAttempts: [] };
    }

    const mutatedFailed = realFailed.filter((a) => a.mutated !== false);
    const mode = getConfig().onFailedUpdate;
    let rollbackApplied = false;
    let keepAttempts: InstallAttempt[] = [];
    if (mode === 'rollback') {
      if (mutatedFailed.length > 0) {
        await this._restoreAttempts(mutatedFailed);
        rollbackApplied = true;
      }
      if (notify) this._pendingRollback = null;
      if (succeededAttempts.length > 0) {
        this._patchInstalledVersions(packageId, version, succeededAttempts);
      }
    } else {
      keepAttempts = mutatedFailed;
      if (notify) this._pendingRollback = mutatedFailed.length > 0
        ? { packageId, attempts: mutatedFailed }
        : null;
      this._patchInstalledVersions(packageId, version, [...succeededAttempts, ...mutatedFailed]);
    }

    const failures = realFailed.map((a) => cliFailure(a.projectPath, a.result, {
      previousVersion: a.previousVersion,
      attemptedVersion: version,
    }));

    if (notify) {
      this.provider.postMessage({
        type: 'OPERATION_ERROR',
        operation: 'install',
        packageId,
        failures,
        succeededProjects: succeeded,
        rollbackMode: mode,
        rollbackApplied,
        canRollback: mode === 'keep' && mutatedFailed.length > 0,
      });
    }

    if (refresh) {
      await this._refreshAfterMutation({ notifyListError: false });
    }

    return {
      status: 'error',
      succeeded,
      error: failures.map((f) =>
        `${path.basename(f.projectPath, path.extname(f.projectPath))}:\n${f.stderr}`
      ).join('\n\n'),
      keepAttempts,
    };
  }

  private async _restoreAttempts(attempts: InstallAttempt[]): Promise<void> {
    for (const attempt of attempts) {
      await restoreFileSnapshots(attempt.snapshots);
      await this.backend.restoreProject(attempt.projectPath);
      this.logger.logCliOperation({
        timestamp: new Date(),
        kind: 'edit',
        command: 'rollback project files',
        args: attempt.snapshots.map((s) => s.path),
        stdout: attempt.previousVersion
          ? `Restored PackageReference to ${attempt.previousVersion}`
          : 'Removed newly added PackageReference',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 0,
      });
    }
  }

  private _patchInstalledVersions(
    packageId: string,
    version: string,
    attempts: InstallAttempt[],
  ): void {
    this.provider.postMessage({
      type: 'INSTALLED_PACKAGES_PATCH',
      // One patch per conditional group actually written (#82). Without the
      // framework the webview matched on the project alone and moved every
      // framework of a multi-targeted project to this version — the rows then
      // agreed with each other until the real refresh disagreed again.
      packages: attempts.flatMap((a) => (a.frameworks?.length ? a.frameworks : [undefined])
        .map((framework) => ({
          id: packageId,
          requestedVersion: version,
          resolvedVersion: version,
          projectPath: a.projectPath,
          framework,
        }))),
    });
  }

  private async _handleRollbackFailedUpdate(): Promise<void> {
    const pending = this._pendingRollback;
    if (!pending) return;
    this._pendingRollback = null;
    await this._restoreAttempts(pending.attempts);
    this.provider.postMessage({ type: 'ROLLBACK_COMPLETE', packageId: pending.packageId });
    await this._refreshAfterMutation();
  }

  private async _handleRemoveSingle(
    projectPath: string,
    packageId: string,
  ): Promise<void> {
    const result = await this._removeFromProject(projectPath, packageId);
    this.trace?.noteTouchedProject(projectPath);
    this.trace?.recordBroker('remove', {
      project: path.basename(projectPath),
      packageId,
      ok: isCliOperationSuccess(result),
    });
    if (result.timedOut) {
      this.provider.postMessage({
        type: 'OPERATION_TIMEOUT',
        command: `dotnet remove ${projectPath} package ${packageId}`,
      });
      return;
    }
    if (!isCliOperationSuccess(result)) {
      this.provider.postMessage({
        type: 'OPERATION_ERROR',
        operation: 'remove',
        packageId,
        failures: [cliFailure(projectPath, result)],
        succeededProjects: [],
      });
      await this._refreshAfterMutation({ notifyListError: false });
      return;
    }
    this.provider.postMessage({
      type: 'OPERATION_SUCCESS',
      operation: 'remove',
      packageId,
      affectedProjects: [projectPath],
    });
    await this._refreshAfterMutation();
  }

  private async _handleRemoveMulti(
    projects: string[],
    packageId: string,
  ): Promise<void> {
    const results = await runWithConcurrency(
      projects.map((p) => async () => {
        this.trace?.noteTouchedProject(p);
        this.trace?.recordBroker('remove', { project: path.basename(p), packageId });
        const result = await this._removeFromProject(p, packageId);
        // Same incremental signal the install path gets (#104); remove had no
        // per-project hook at all, so its rows only ever moved once, at the end.
        this.provider.postMessage({
          type: 'PROJECT_OPERATION_DONE',
          operation: 'remove',
          packageId,
          projectPath: p,
          ok: isCliOperationSuccess(result),
        });
        return { projectPath: p, result };
      }),
      getConfig().dotnetConcurrency,
    );

    const failures = results
      .filter((r) => !isCliOperationSuccess(r.result))
      .map((r) => cliFailure(r.projectPath, r.result));
    const succeeded = results
      .filter((r) => isCliOperationSuccess(r.result))
      .map((r) => r.projectPath);

    if (failures.length > 0) {
      this.provider.postMessage({ type: 'OPERATION_ERROR', operation: 'remove', packageId, failures, succeededProjects: succeeded });
    } else {
      this.provider.postMessage({ type: 'OPERATION_SUCCESS', operation: 'remove', packageId, affectedProjects: succeeded });
    }
    await this._refreshAfterMutation({ notifyListError: failures.length === 0 });
  }

  private async _refreshAfterMutation(opts?: { notifyListError?: boolean }): Promise<void> {
    await this._handleRefresh(opts);
  }

  /** List + `dotnet restore`. `clearCache` drops latest-version enrich so Force refresh re-fetches. */
  private async _refreshWithRestore(clearCache: boolean): Promise<void> {
    this._cancelEnrich();
    this._cancelVulnScan();
    this._cancelImplicitWatches();
    if (clearCache) this._cache.clear();
    this.provider.postMessage({
      type: 'REFRESH_STARTED',
      kind: clearCache ? 'refresh' : 'restore',
    });
    try {
      await Promise.all([
        this._refreshRoslynCap(true),
        this._pushConfigChainUpdate(true),
        this._handleRefresh({
          restore: true,
          listAfterRestore: true,
          awaitVuln: true,
          quietEnrich: !clearCache,
        }),
      ]);
    } finally {
      this.provider.postMessage({ type: 'REFRESH_FINISHED' });
    }
  }

  private async _handleRefresh(opts?: RefreshOpts): Promise<void> {
    const scope = this.provider.getCurrentScope();
    if (!scope) return;

    if (scope.kind === 'solution') {
      await this._refreshForSolution(scope.solutionPath, scope.projects.length, opts);
    } else if (scope.kind === 'folder') {
      await this._refreshForFolder(scope.folderPath, scopeProjectPaths(scope), opts);
    } else if (scope.projectPath) {
      await this._refreshPackagesForProjects([scope.projectPath], opts);
    }
  }

  /**
   * Push new lists only when we actually parsed packages. A failed restore makes
   * `dotnet list` return `{ problems: [...] }` with no projects — posting that
   * as INSTALLED_PACKAGES: [] wipes the UI.
   */
  private async _applyListedPackages(
    listed: PackageListResult,
    opts?: RefreshOpts,
  ): Promise<void> {
    const notifyListError = opts?.notifyListError !== false;
    const empty = listed.installed.length === 0 && listed.implicit.length === 0;

    // Failed restore → list JSON is only `problems`, no projects. Never replace
    // the UI with []. After a failed add we also skip posting an empty list
    // even if the backend omitted `error` (csproj may already have changed).
    if (empty && (listed.error || !notifyListError)) {
      if (listed.error && notifyListError) {
        this.provider.postMessage({
          type: 'ERROR',
          message: 'Failed to refresh package list',
          details: listed.error,
        });
      }
      return;
    }

    const installed = this._stampCachedLatest(listed.installed, listed.projectFrameworks);
    this._installedIds = new Set(installed.map((pkg) => pkg.id.toLowerCase()));
    this.provider.postMessage({
      type: 'INSTALLED_PACKAGES',
      packages: installed,
      projectFrameworks: listed.projectFrameworks,
    });
    this.provider.postMessage({ type: 'IMPLICIT_PACKAGES', packages: listed.implicit });

    this._lastListed = listed;
    void this._updateMissingCompileAssetDiagnostics(listed.installed);
    this._cancelVulnScan();
    const vulnSignal = this._vulnAbort.signal;
    const vuln = this._scanVulnerabilities(listed, vulnSignal);

    const skipEnrich = opts?.quietEnrich && installed.length > 0 && this._allLatestCached(installed);
    if (installed.length > 0 && !skipEnrich) {
      this._cancelEnrich();
      const signal = this._enrichAbort.signal;
      void this._enrichInstalledPackages(installed, signal, { quietCacheHits: !!opts?.quietEnrich });
    }

    if (opts?.awaitVuln) await vuln;
    else void vuln;
  }

  private _stampCachedLatest(
    installed: InstalledPackage[],
    projectFrameworks?: Record<string, string[]>,
  ): InstalledPackage[] {
    const now = Date.now();
    const ttl = getConfig().cacheTtlMs;
    return installed.map((pkg) => {
      const cached = this._cache.get(pkg.id.toLowerCase());
      if (!cached || now - cached.fetchedAt >= ttl) return pkg;
      return {
        ...pkg,
        latestVersion: pkg.latestVersion || this._compatibleLatest(cached, pkg, projectFrameworks),
        sourceName: pkg.sourceName || cached.sourceName,
        versions: pkg.versions?.length ? pkg.versions : cached.versions,
      };
    });
  }

  /**
   * The version an update proposes for one row — the highest one this
   * package's own project framework(s) can actually use (#107), not the
   * feed's raw latest. Falls back to the row's own resolved version (no ↑)
   * rather than the raw latest when a framework is known but nothing
   * compatible was found, and to the raw latest itself when the framework
   * isn't known at all — the same "nothing to judge against, nothing ruled
   * out" rule `isVersionCompatible` applies everywhere else.
   */
  private _compatibleLatest(
    cached: CacheEntry,
    pkg: InstalledPackage,
    projectFrameworks: Record<string, string[]> | undefined,
  ): string {
    // A per-framework pinned entry (#82) already names its one framework;
    // otherwise every framework the project declares is in play, since one
    // unconditional reference is read from all of them.
    const tfms = pkg.framework ? [pkg.framework] : this._frameworksForProject(projectFrameworks, pkg.projectPath);
    if (tfms.length === 0) return cached.latestVersion;
    const compatible = highestCompatibleVersion(
      cached.versions, (v) => cached.metadataByVersion?.[v]?.declaredDependencies, tfms,
    );
    return compatible ?? pkg.resolvedVersion;
  }

  /**
   * `projectFrameworks[projectPath]`, tolerant of a differently-written key —
   * the same fallback `PackageDetailPanel`, `ProjectListSection` and
   * `memberProjectTfms` already carry for exactly this reason (#107). Without
   * it, a key that merely disagrees on spelling silently reads as "no
   * framework known" and both `_compatibleLatest` and the id-level answer
   * below fall back to the raw feed latest with nothing to say why.
   */
  private _frameworksForProject(
    projectFrameworks: Record<string, string[]> | undefined,
    projectPath: string,
  ): string[] {
    if (!projectFrameworks) return [];
    return projectFrameworks[projectPath]
      ?? Object.entries(projectFrameworks).find(([key]) => pathsEqual(key, projectPath))?.[1]
      ?? [];
  }

  /**
   * The same question as `_compatibleLatest`, asked at the id level rather
   * than one row's — used where the enrich wave answers once for every
   * project that references an id at once, and no single resolved version
   * exists to fall back to. `tfms` is the union of every framework any of
   * those projects declares (#107); requiring compatibility with the whole
   * union is the conservative reading, since one broadcast value has to serve
   * every row that shares this id until the next full list corrects it with
   * `_compatibleLatest`'s per-row answer.
   *
   * When nothing at all is compatible — Part 1's own territory, an installed
   * version already missing its compile assets — this must not fall back to
   * the raw feed latest: that is exactly the incompatible version #107 opens
   * with, and it would sit in webview state proposing an ↑ to it until the
   * next full list corrected it. The lowest resolved version among the rows
   * that share this id is never newer than any of them, so it proposes no ↑
   * for any row instead of guessing.
   */
  private _compatibleLatestForTfms(
    cached: CacheEntry,
    tfms: readonly string[],
    resolvedVersions: readonly string[],
  ): string {
    if (tfms.length === 0) return cached.latestVersion;
    const compatible = highestCompatibleVersion(
      cached.versions, (v) => cached.metadataByVersion?.[v]?.declaredDependencies, tfms,
    );
    if (compatible) return compatible;
    const lowest = [...resolvedVersions].sort(compareSemVer)[0];
    return lowest ?? cached.latestVersion;
  }

  /**
   * `_compatibleLatest`, answered separately for every project this id is
   * referenced from (#107) — for a `PACKAGE_INFO_UPDATE` broadcast to carry
   * instead of a single value the reducer would otherwise apply to every row
   * that shares the id. Computed even for a single project, so the reducer
   * never has to fall back to the conservative id-wide `latestVersion` for a
   * row this broker can answer precisely for; `undefined` only when the id
   * matches nothing in the last list at all (a stale/cancelled request).
   *
   * Keyed by project path *and* framework where a framework is pinned (#82):
   * `dotnet list` reports a framework-scoped pin as two entries that share
   * the same project path and differ only in `framework`, so a plain
   * project-path key would have let the second overwrite the first in this
   * map — collapsing two independently-pinned ceilings into whichever one
   * happened to be read last, and applying it to both once the reducer
   * looked the shared path back up.
   */
  private _latestVersionByProject(id: string, cached: CacheEntry): Record<string, string> | undefined {
    const rows = (this._lastListed?.installed ?? []).filter((p) => packageIdsEqual(p.id, id));
    if (rows.length === 0) return undefined;
    const projectFrameworks = this._lastListed?.projectFrameworks;
    const map: Record<string, string> = {};
    for (const row of rows) {
      map[projectFrameworkKey(row)] = this._compatibleLatest(cached, row, projectFrameworks);
    }
    return map;
  }

  /** Every framework, and every resolved version, any project in `installed` references this id from — unioned per id (#107). */
  private _perIdContext(
    installed: readonly InstalledPackage[],
  ): Map<string, { tfms: string[]; resolvedVersions: string[] }> {
    const projectFrameworks = this._lastListed?.projectFrameworks;
    const perId = new Map<string, { tfms: Set<string>; resolvedVersions: string[] }>();
    for (const pkg of installed) {
      const key = pkg.id.toLowerCase();
      const tfms = pkg.framework ? [pkg.framework] : this._frameworksForProject(projectFrameworks, pkg.projectPath);
      const entry = perId.get(key) ?? { tfms: new Set<string>(), resolvedVersions: [] };
      for (const tfm of tfms) entry.tfms.add(tfm);
      entry.resolvedVersions.push(pkg.resolvedVersion);
      perId.set(key, entry);
    }
    return new Map([...perId].map(([id, v]) => [id, { tfms: [...v.tfms], resolvedVersions: v.resolvedVersions }]));
  }

  /**
   * Reports the silent case #107 opens with: a package restored with no
   * compile asset for a project's target framework, which `dotnet restore`
   * accepts and only a later compile error (never naming the package) reveals.
   * Read straight from `project.assets.json` — no network call, no waiting on
   * a fresh one since the list this runs from already implies a restore.
   *
   * The whole collection is rebuilt every call rather than patched, so a
   * package that stops being a problem (removed, or a version that now ships
   * the right assets) drops out on the very next list instead of lingering.
   */
  private async _updateMissingCompileAssetDiagnostics(installed: InstalledPackage[]): Promise<void> {
    if (!this.diagnostics) return;
    const generation = ++this._compileAssetDiagnosticsGeneration;
    const projectPaths = [...new Set(installed.map((pkg) => pkg.projectPath))];
    const perProject = await Promise.all(projectPaths.map(async (projectPath) => {
      const assetsJson = await readAssetsJson(projectPath);
      return { projectPath, missing: assetsJson ? findMissingCompileAssets(assetsJson) : [] };
    }));
    // A newer call already started (and will finish and clear/rebuild on its
    // own) while this one was reading from disk — writing this call's
    // now-stale answer would overwrite that newer one's.
    if (generation !== this._compileAssetDiagnosticsGeneration) return;

    this.diagnostics.clear();
    for (const { projectPath, missing } of perProject) {
      if (missing.length === 0) continue;
      const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
      const rowDiagnostics = missing.map((m) => {
        const shipped = m.shipsOnly.length > 0 ? ` (ships ${m.shipsOnly.join(', ')} only)` : '';
        const diagnostic = new vscode.Diagnostic(
          range,
          `${m.id} ${m.version} has no compile assets for ${m.framework}${shipped}`,
          vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.source = 'AVE NuGet Manager';
        return diagnostic;
      });
      this.diagnostics.set(vscode.Uri.file(projectPath), rowDiagnostics);
    }
  }

  private _allLatestCached(installed: InstalledPackage[]): boolean {
    const now = Date.now();
    const ttl = getConfig().cacheTtlMs;
    for (const id of new Set(installed.map((p) => p.id.toLowerCase()))) {
      const cached = this._cache.get(id);
      if (!cached || now - cached.fetchedAt >= ttl) return false;
    }
    return true;
  }

  private async _refreshForSolution(
    solutionPath: string,
    projectCount: number,
    opts?: RefreshOpts,
  ): Promise<void> {
    if (opts?.restore && opts.listAfterRestore) {
      const restoreResult = await this._beginRestore(this.backend.restoreProject(solutionPath));
      const listed = await this.backend.listAllForSolution(solutionPath, projectCount);
      await this._applyListedPackages(listed, opts);
      this._reportRestoreIfCurrent(solutionPath, restoreResult);
      return;
    }

    const restoreP = opts?.restore
      ? this._beginRestore(this.backend.restoreProject(solutionPath))
      : undefined;
    const listed = await this.backend.listAllForSolution(solutionPath, projectCount);
    await this._applyListedPackages(listed, opts);
    if (restoreP) this._reportRestoreIfCurrent(solutionPath, await restoreP);
  }

  private async _refreshPackagesForProjects(
    projectPaths: string[],
    opts?: RefreshOpts,
  ): Promise<void> {
    if (projectPaths.length === 0) return;

    if (opts?.restore && opts.listAfterRestore) {
      const restoreResult = await this._beginRestore(this.backend.restoreProject(projectPaths[0]));
      await this._listProjectsThenApply(projectPaths, opts);
      this._reportRestoreIfCurrent(projectPaths[0], restoreResult);
      return;
    }

    const restoreP = opts?.restore
      ? this._beginRestore(this.backend.restoreProject(projectPaths[0]))
      : undefined;
    await this._listProjectsThenApply(projectPaths, opts);
    if (restoreP) this._reportRestoreIfCurrent(projectPaths[0], await restoreP);
  }

  private async _listProjectsThenApply(
    projectPaths: string[],
    opts?: RefreshOpts,
  ): Promise<void> {
    const concurrency = getConfig().dotnetConcurrency;
    const results: PackageListResult[] = new Array(projectPaths.length);

    await runWithConcurrency(
      projectPaths.map((p, i) => async () => {
        results[i] = await this.backend.listAllForProject(p);
      }),
      concurrency,
    );

    const listed: PackageListResult = {
      installed: results.flatMap((r) => r.installed),
      implicit: results.flatMap((r) => r.implicit),
      error: results.find((r) => r.error)?.error,
      // Merged rather than dropped (#107): a single-project scope is exactly
      // where a project's own target framework is known with no ambiguity at
      // all, and the compatibility filtering downstream needs it by project
      // path the same way the solution-scope answer already carries it.
      projectFrameworks: results.reduce<Record<string, string[]>>(
        (acc, r) => (r.projectFrameworks ? { ...acc, ...r.projectFrameworks } : acc), {},
      ),
    };
    await this._applyListedPackages(listed, opts);
  }

  /**
   * A folder scope has no `.sln` to hand `dotnet restore`/`dotnet list` in one
   * call, so each discovered project is restored/listed independently (capped
   * concurrency) and the results are merged as if they came from one solution.
   */
  private async _refreshForFolder(
    folderPath: string,
    projectPaths: string[],
    opts?: RefreshOpts,
  ): Promise<void> {
    if (projectPaths.length === 0) {
      await this._applyListedPackages({ installed: [], implicit: [] }, opts);
      return;
    }

    if (opts?.restore && opts.listAfterRestore) {
      const restoreResult = await this._beginRestore(this._restoreProjects(projectPaths));
      await this._listProjectsThenApply(projectPaths, opts);
      this._reportRestoreIfCurrent(folderPath, restoreResult);
      return;
    }

    const restoreP = opts?.restore
      ? this._beginRestore(this._restoreProjects(projectPaths))
      : undefined;
    await this._listProjectsThenApply(projectPaths, opts);
    if (restoreP) this._reportRestoreIfCurrent(folderPath, await restoreP);
  }

  private async _restoreProjects(projectPaths: string[], signal?: AbortSignal): Promise<CliResult> {
    const concurrency = getConfig().dotnetConcurrency;
    const results: CliResult[] = new Array(projectPaths.length);

    await runWithConcurrency(
      projectPaths.map((p, i) => async () => {
        results[i] = await this.backend.restoreProject(p, signal);
      }),
      concurrency,
    );

    return mergeCliResults(results);
  }

  /**
   * Real restore + list for the whole scope, bypassing whatever `--no-restore`
   * package list the caller already has. Used only by the vulnerability
   * fallback (no working `<auditSources>`): a plain single-project install
   * only restores *that* project, so `dotnet list --no-restore` for the rest
   * of a solution/folder can still report a stale floor for any OTHER project
   * that reaches the updated one only via `<ProjectReference>` — e.g. p01
   * referencing p02, whose SSH.NET was just bumped, still shows p01's old
   * transitive SSH.NET version until something restores p01 too (#53). A
   * single-project scope has nothing else that could go stale this way, so
   * callers skip this for that case rather than pay for a needless restore.
   */
  private async _freshListedForScope(
    scope: WorkspaceScope,
  ): Promise<{ listed: PackageListResult; restoreText: string }> {
    if (scope.kind === 'solution') {
      const restoreResult = await this.backend.restoreProject(scope.solutionPath);
      const listed = await this.backend.listAllForSolution(scope.solutionPath, scope.projects.length);
      return { listed, restoreText: `${restoreResult.stdout}\n${restoreResult.stderr}` };
    }
    const projectPaths = scopeProjectPaths(scope);
    const restoreResult = await this._restoreProjects(projectPaths);
    const results = await Promise.all(projectPaths.map((p) => this.backend.listAllForProject(p)));
    const listed: PackageListResult = {
      installed: results.flatMap((r) => r.installed),
      implicit: results.flatMap((r) => r.implicit),
      error: results.find((r) => r.error)?.error,
    };
    return { listed, restoreText: `${restoreResult.stdout}\n${restoreResult.stderr}` };
  }

  private _beginRestore(p: Promise<CliResult>): Promise<CliResult> {
    const generation = this._restoreGeneration;
    const tracked = p.then((result) => {
      if (generation === this._restoreGeneration) {
        this._lastRestoreText = `${result.stdout}\n${result.stderr}`;
      }
      return result;
    });
    this._restoreInFlight = tracked;
    void tracked.finally(() => {
      if (this._restoreInFlight === tracked) this._restoreInFlight = undefined;
    });
    return tracked;
  }

  private _reportRestoreIfCurrent(targetPath: string, result: CliResult): void {
    const scope = this.provider.getCurrentScope();
    if (!scope) return;
    const current = scopeIdentityPath(scope);
    if (!current || !pathsEqual(current, targetPath)) return;
    if (isCliOperationSuccess(result)) return;

    const dump = cliOutputText(result);
    const details = result.timedOut
      ? ['dotnet restore timed out', dump].filter((s) => s.trim().length > 0).join('\n')
      : dump;

    this.provider.postMessage({
      type: 'ERROR',
      message: 'Restore failed',
      details: details || 'dotnet restore failed',
    });
  }

  private async _scanVulnerabilities(
    listed: PackageListResult,
    signal: AbortSignal,
  ): Promise<void> {
    const generation = this._vulnScanGeneration;
    const lastRestoreTextAtStart = this._lastRestoreText;
    const scope = this.provider.getCurrentScope();
    const targetPath = scope ? scopeIdentityPath(scope) : undefined;
    if (!scope || !targetPath) return;

    const startDir = this._scopeStartDir(scope) ?? '';
    const chain = await this.configResolver.resolve(startDir);
    const packageSources = uniqueEnabledPackageSources(chain);
    const auditSources = uniqueEnabledAuditSources(chain);
    const runCli = shouldRunDotnetListVulnerable(packageSources, auditSources);
    const fingerprint = [
      ...chain.map((c) => c.filePath),
      ...auditSources.map((s) => s.url),
    ].join('\n');
    const nearestConfig = chain[0]?.filePath;

    this.trace?.recordBroker('vuln-scan', {
      target: path.basename(targetPath),
      runCli,
    });

    const providers: import('./vulnerabilityProvider').IVulnerabilityProvider[] = [];

    // The database first, when it can be read (#27). It answers for the whole
    // solution with a couple of small requests against one document, while
    // `dotnet list --vulnerable` on a feed with no audit source reads that
    // feed's registration once per package. Both end up reading the same
    // advisories, and the match here runs over the implicit set too, so the
    // transitive packages the CLI catches are not lost.
    const fromDatabase = this.vulnScan?.fromDatabase
      ? await this.vulnScan.fromDatabase(
          { packageSources, auditSources }, listed.installed, listed.implicit, signal,
        ).catch(() => undefined)
      : undefined;

    // An empty answer only settles the question when the CLI would have asked
    // the same database. Without an audit source it reads package registration
    // instead, which carries advisories the database need not have — so
    // "nothing matched" there is not "nothing is wrong", and the CLI still runs.
    const databaseSettlesIt = fromDatabase
      && (fromDatabase.length > 0 || databaseSpeaksForTheCli(auditSources));

    if (databaseSettlesIt) {
      this.logger.logCliOperation({
        timestamp: new Date(),
        kind: 'scan',
        command: 'vulnerability scan via HTTP database',
        args: [`${fromDatabase.length} finding(s)`, 'dotnet list --vulnerable not started'],
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 0,
      });
      providers.push({ id: 'vulnerability-database', scan: async () => fromDatabase });
    } else if (runCli) {
      if (fromDatabase) {
        // Worth a row of its own: the database was reachable and matched
        // nothing, and the reason the CLI still ran is not otherwise visible.
        this.logger.logCliOperation({
          timestamp: new Date(),
          kind: 'scan',
          command: 'vulnerability database matched nothing',
          args: ['no audit source, so the CLI reads package registration instead'],
          stdout: '',
          stderr: '',
          exitCode: 0,
          timedOut: false,
          durationMs: 0,
        });
      }
      providers.push(new DotnetVulnerableProvider(this.backend));
    } else {
      this.logger.logCliOperation({
        timestamp: new Date(),
        kind: 'scan',
        command: 'vulnerability scan skipped',
        args: ['dotnet list --vulnerable not started: a package source has no VulnerabilityInfo'],
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 0,
      });
      if (this._restoreInFlight) await this._restoreInFlight;
      // A single-project install only restores that project — for a
      // solution/folder scope, re-restore + re-list here rather than trust
      // the (possibly `--no-restore`-listed) `listed` already in hand, so a
      // sibling project that only sees the change via <ProjectReference>
      // isn't scored against its own stale floor (#53).
      let restoreTextForFallback = lastRestoreTextAtStart;
      if (scope.kind !== 'project') {
        try {
          const fresh = await this._freshListedForScope(scope);
          listed = fresh.listed;
          restoreTextForFallback = fresh.restoreText;
        } catch {
          // Keep the already-listed (possibly stale) data rather than fail the scan.
        }
      }
      const cacheDir = this.vulnScan?.httpCacheDir
        ? [this.vulnScan.httpCacheDir()]
        : nugetHttpCacheDirs();
      const cached = await findingsFromNuGetHttpCache(
        cacheDir, listed.installed, listed.implicit,
      );
      const fromRestore = parseRestoreAuditWarnings(restoreTextForFallback, {
        installed: listed.installed,
        implicit: listed.implicit,
      });
      providers.push({
        id: 'nuget-cache',
        scan: async () => mergeFindings([cached, fromRestore]),
      });
    }
    providers.push(new UserScriptVulnerabilityProvider(this.logger));

    const findings = await collectVulnerabilityFindings(providers, {
      targetPath,
      cwd: startDir,
      scope,
      installed: listed.installed,
      implicit: listed.implicit,
      signal,
    });
    if (signal.aborted || generation !== this._vulnScanGeneration) return;
    const hint = { show: !runCli, fingerprint, message: AUDIT_SOURCES_HINT, configFilePath: nearestConfig };
    this._lastVulnPost = { findings, hint };
    this.provider.postMessage({ type: 'VULNERABILITIES', findings });
    this.provider.postMessage({ type: 'VULN_SCAN_HINT', ...hint });
  }

  /** Fetches latestVersion + sourceName for each unique package id and pushes
   *  individual PACKAGE_INFO_UPDATE messages as results arrive.
   *  Uses an in-memory cache (TTL: config.cacheTtlMs) and limits concurrency
   *  to config.dotnetConcurrency parallel dotnet processes (same cap as install/remove).
   *  Search errors / empty results retry once after the rest of the wave finishes. */
  private async _enrichInstalledPackages(
    installed: import('./types').InstalledPackage[],
    signal: AbortSignal,
    opts?: { quietCacheHits?: boolean },
  ): Promise<void> {
    const scope = this.provider.getCurrentScope();
    if (!scope || signal.aborted) return;

    const startDir = this._scopeStartDir(scope) ?? '';
    const configChain = await this.configResolver.resolve(startDir);
    const configFiles = searchableConfigFiles(configChain);
    if (configFiles.length === 0 || signal.aborted) return;

    const uniqueIds = [...new Set(installed.map((p) => p.id))];
    const now = Date.now();
    const perId = this._perIdContext(installed);
    const emptyContext = { tfms: [] as string[], resolvedVersions: [] as string[] };

    const needsFetch: string[] = [];
    for (const id of uniqueIds) {
      const cached = this._cache.get(id.toLowerCase());
      if (cached && now - cached.fetchedAt < getConfig().cacheTtlMs) {
        if (!opts?.quietCacheHits) {
          const ctx = perId.get(id.toLowerCase()) ?? emptyContext;
          this.provider.postMessage({
            type: 'PACKAGE_INFO_UPDATE',
            packageId: id,
            latestVersion: this._compatibleLatestForTfms(cached, ctx.tfms, ctx.resolvedVersions),
            latestVersionByProject: this._latestVersionByProject(id, cached),
            sourceName: cached.sourceName,
            versions: cached.versions,
            versionFlags: this._versionFlagsFor(cached),
          });
        }
      } else {
        needsFetch.push(id);
      }
    }

    if (needsFetch.length === 0) {
      this.provider.postMessage({ type: 'ENRICH_PROGRESS', done: uniqueIds.length, total: uniqueIds.length });
      return;
    }

    const total = uniqueIds.length;
    let done = uniqueIds.length - needsFetch.length;

    if (signal.aborted) return;

    // Announce start
    this.provider.postMessage({ type: 'ENRICH_PROGRESS', done, total });

    // Fetch missing/stale entries with concurrency limit. Failures (throw or
    // empty search) wait until the rest of this wave finishes, then retry once.
    const failedIds: string[] = [];
    const tasks = needsFetch.map((id) => async () => {
      if (signal.aborted) return;
      const ctx = perId.get(id.toLowerCase()) ?? emptyContext;
      const ok = await this._tryEnrichPackage(id, configFiles, signal, ctx.tfms, ctx.resolvedVersions);
      if (signal.aborted) return;
      if (ok) {
        done++;
        this.provider.postMessage({ type: 'ENRICH_PROGRESS', done, total });
      } else {
        failedIds.push(id);
      }
    });

    await runWithConcurrency(tasks, getConfig().dotnetConcurrency);
    if (signal.aborted) {
      this._finishEnrichProgress(done, total);
      return;
    }

    if (failedIds.length > 0) {
      this.trace?.recordBroker('enrich-retry', { count: failedIds.length });
      const retries = failedIds.map((id) => async () => {
        if (signal.aborted) return;
        const ctx = perId.get(id.toLowerCase()) ?? emptyContext;
        await this._tryEnrichPackage(id, configFiles, signal, ctx.tfms, ctx.resolvedVersions);
        if (signal.aborted) return;
        done++;
        this.provider.postMessage({ type: 'ENRICH_PROGRESS', done, total });
      });
      await runWithConcurrency(retries, getConfig().dotnetConcurrency);
      if (signal.aborted) {
        this._finishEnrichProgress(done, total);
      }
    }
  }

  private _finishEnrichProgress(done: number, total: number): void {
    if (done < total) {
      this.provider.postMessage({ type: 'ENRICH_PROGRESS', done: total, total });
    }
  }

  /** Returns true when latest/source was stored and posted. Empty search or throw → false. */
  private async _tryEnrichPackage(
    id: string,
    configFiles: string[],
    signal: AbortSignal,
    tfms: readonly string[],
    resolvedVersions: readonly string[],
  ): Promise<boolean> {
    try {
      const { latestVersion, sourceName, versions, metadataByVersion } = await this.backend.enrichPackage(
        id, configFiles, getConfig().includePrerelease, signal,
      );
      if (signal.aborted) return false;
      if (!latestVersion && !sourceName) return false;

      const cached: CacheEntry = { latestVersion, sourceName, versions, metadataByVersion, fetchedAt: Date.now() };
      this._cache.set(id.toLowerCase(), cached);
      this.provider.postMessage({
        type: 'PACKAGE_INFO_UPDATE',
        packageId: id,
        latestVersion: this._compatibleLatestForTfms(cached, tfms, resolvedVersions),
        latestVersionByProject: this._latestVersionByProject(id, cached),
        sourceName,
        versions,
        versionFlags: feedFlags(metadataByVersion),
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Asks the feed about one transitive id, the moment its row is actually on
   * screen (#118). The enrich wave never reaches an implicit package — it
   * walks `installed` alone — so without this a deprecation notice for a
   * transitive id stayed invisible in the list even though the feed would
   * have answered it, same as any other id, if only something had asked.
   * Goes through the same `_tryEnrichPackage` the wave uses, so the answer
   * lands in `_cache` under the same TTL and a package that later becomes
   * directly installed does not get asked twice.
   */
  private async _handleWatchImplicitPackage(packageId: string): Promise<void> {
    const key = packageId.toLowerCase();
    // The webview's own filter never asks about a directly installed id —
    // the enrich wave already covers it — but that rule lives in `ImplicitList`,
    // not here, so a request that reaches the host answering for it anyway is
    // enforced again at the one place this broker can actually guarantee it.
    if (this._installedIds.has(key)) return;
    if (this._implicitWatches.has(key)) return;

    const cached = this._cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < getConfig().cacheTtlMs) {
      this.provider.postMessage({
        type: 'PACKAGE_INFO_UPDATE',
        packageId,
        latestVersion: this._compatibleLatestForTfms(cached, [], []),
        latestVersionByProject: this._latestVersionByProject(packageId, cached),
        sourceName: cached.sourceName,
        versions: cached.versions,
        versionFlags: this._versionFlagsFor(cached),
      });
      return;
    }

    const scope = this.provider.getCurrentScope();
    if (!scope) return;
    const configFiles = await this._configFilesForImplicitWatch(scope);
    if (configFiles.length === 0) return;

    const controller = new AbortController();
    this._implicitWatches.set(key, controller);
    try {
      await this._implicitWatchGate.run(async () => {
        // Queued behind other watches long enough for its own row to have
        // left in the meantime — the gate has no idea, so this is the one
        // place left to ask before spending a `dotnet` process on an answer
        // nobody is waiting for any more.
        if (controller.signal.aborted) return;
        await this._tryEnrichPackage(packageId, configFiles, controller.signal, [], []);
      });
    } finally {
      // Only drop this row's own slot — a newer watch for the same id, taken
      // out and re-inserted while this one was still resolving, must survive.
      if (this._implicitWatches.get(key) === controller) this._implicitWatches.delete(key);
    }
  }

  /**
   * The config chain for an implicit-row watch, resolved once per `startDir`
   * and reused until the chain might actually differ (#118) — scrolling
   * through forty implicit rows must not mean forty directory walks and
   * forty re-parses of the same files the first row's watch already read.
   */
  private async _configFilesForImplicitWatch(scope: WorkspaceScope): Promise<string[]> {
    const startDir = this._scopeStartDir(scope) ?? '';
    if (this._implicitConfigFiles?.startDir === startDir) return this._implicitConfigFiles.files;
    const configChain = await this.configResolver.resolve(startDir);
    const files = searchableConfigFiles(configChain);
    this._implicitConfigFiles = { startDir, files };
    return files;
  }

  /** The row `_handleWatchImplicitPackage` was asking about scrolled back out before it answered (#118). */
  private _handleUnwatchImplicitPackage(packageId: string): void {
    const key = packageId.toLowerCase();
    this._implicitWatches.get(key)?.abort();
    this._implicitWatches.delete(key);
  }

  /**
   * `sanitizeCtx()` alone has no `aliases`, so it can only redact the
   * workspace root / home / hostname — project file names inside a relative
   * path (`<workspace>/Foo.Data/Foo.Data.csproj`) pass through unchanged.
   * "Copy sanitised" in the Log tab isn't a full trace-zip pack, but it must
   * still mask project names the same way, so build the same kind of
   * `pNN.csproj` aliases from the current scope's project files.
   */
  private async _logSanitizeCtx(): Promise<SanitizeContext> {
    const scope = this.provider.getCurrentScope() ?? undefined;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const snapshot = await collectScopeSnapshotFiles(scope, [], workspaceRoot);
    const aliases: FileAlias[] = snapshot.files.map((f) => ({ absPath: f.absPath, dest: f.destName }));
    return { ...sanitizeCtx(), aliases };
  }

  private _scopeStartDir(scope: WorkspaceScope | null | undefined): string | undefined {
    if (!scope) return undefined;
    if (scope.kind === 'solution') return path.dirname(scope.solutionPath);
    if (scope.kind === 'folder') return scope.folderPath;
    if (scope.projectPath) return path.dirname(scope.projectPath);
    return undefined;
  }

  private _projectEntries(scope: WorkspaceScope): { name: string; dir: string }[] {
    if (scope.kind === 'solution' || scope.kind === 'folder') {
      return scope.projects.map((p) => ({
        name: p.name,
        dir: path.dirname(p.absolutePath),
      }));
    }
    if (!scope.projectPath) return [];
    return [{
      name: path.basename(scope.projectPath, path.extname(scope.projectPath)),
      dir: path.dirname(scope.projectPath),
    }];
  }

  private async _buildSourcesPayload(scope: WorkspaceScope): Promise<{
    configChain: NuGetConfigFile[];
    sources: ReturnType<typeof uniquePackageSources>;
    snapshot: ReturnType<typeof buildSourcesSnapshot>;
  }> {
    const startDir = this._scopeStartDir(scope);
    const configChain = startDir ? await this.configResolver.resolve(startDir) : [];

    const resolveCache = new Map<string, Promise<NuGetConfigFile[]>>();
    const resolveDir = (dir: string): Promise<NuGetConfigFile[]> => {
      const key = normalizeFsPath(dir);
      let pending = resolveCache.get(key);
      if (!pending) {
        pending = this.configResolver.resolve(dir);
        resolveCache.set(key, pending);
      }
      return pending;
    };

    const projectChains: { projectName: string; chain: NuGetConfigFile[] }[] = [];
    for (const proj of this._projectEntries(scope)) {
      projectChains.push({ projectName: proj.name, chain: await resolveDir(proj.dir) });
    }

    const parsedByPath = new Map<string, NuGetConfigFile>();
    const remember = (file: NuGetConfigFile): void => {
      parsedByPath.set(normalizeFsPath(file.filePath), file);
    };
    configChain.forEach(remember);
    for (const project of projectChains) project.chain.forEach(remember);

    const extraScan = await listWorkspaceNuGetConfigFiles();
    const extraPaths = extraScan.uris
      .map((u) => u.fsPath)
      .filter((p) => path.basename(p).toLowerCase() === 'nuget.config');

    const workspaceConfigs: NuGetConfigFile[] = [];
    for (const fp of extraPaths) {
      const existing = parsedByPath.get(normalizeFsPath(fp));
      if (existing) {
        workspaceConfigs.push(existing);
        continue;
      }
      const parsed = await parseNuGetConfig(fp);
      parsedByPath.set(normalizeFsPath(fp), parsed);
      workspaceConfigs.push(parsed);
    }

    for (const [key, file] of [...parsedByPath.entries()]) {
      parsedByPath.set(key, this._parseLiveNuGetConfig(file));
    }
    const overlay = (files: NuGetConfigFile[]): NuGetConfigFile[] =>
      files.map((f) => parsedByPath.get(normalizeFsPath(f.filePath)) ?? f);
    const liveChain = overlay(configChain);
    const liveProjects = projectChains.map((p) => ({ ...p, chain: overlay(p.chain) }));
    const liveWorkspace = overlay(workspaceConfigs);
    const liveSources = uniquePackageSources(liveChain);

    const snapshot = buildSourcesSnapshot({
      scopeChain: liveChain,
      projectChains: liveProjects,
      workspaceConfigs: liveWorkspace,
      relativePath: (abs) => vscode.workspace.asRelativePath(abs, true),
      isGlobalPath: isGlobalNuGetConfigPath,
      compareAuditToProjects: scope.kind === 'solution' || scope.kind === 'folder',
      extraConfigsTruncated: extraScan.truncated,
    });

    return { configChain: liveChain, sources: liveSources, snapshot };
  }

  private _editorNuGetConfigXml(filePath: string): string | undefined {
    const want = normalizeFsPath(filePath);
    const doc = vscode.workspace.textDocuments.find(
      (d) => !d.isClosed && path.basename(d.fileName).toLowerCase() === 'nuget.config'
        && normalizeFsPath(d.fileName) === want,
    );
    return doc?.getText();
  }

  private _parseLiveNuGetConfig(file: NuGetConfigFile): NuGetConfigFile {
    const xml = this._editorNuGetConfigXml(file.filePath);
    if (xml === undefined) return file;
    const parsed = parseNuGetConfigXml(file.filePath, xml);
    parsed.isMachineWide = file.isMachineWide;
    return parsed;
  }

  private _ensureNuGetConfigWatcher(): void {
    if (this._nugetConfigWatcher) return;
    const watcher = vscode.workspace.createFileSystemWatcher(NUGET_CONFIG_GLOB);
    this._nugetConfigWatcher = watcher;
    const bump = (): void => this._scheduleConfigChainRefresh();
    this._nugetConfigWatchSubs = [
      watcher.onDidCreate(bump),
      watcher.onDidChange(bump),
      watcher.onDidDelete(bump),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (path.basename(e.document.fileName).toLowerCase() === 'nuget.config') bump();
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (path.basename(doc.fileName).toLowerCase() !== 'nuget.config') return;
        // A saved file is a decision; a keystroke is not. The chain preview
        // follows every edit, but what the catalog holds — probe verdicts,
        // cached responses, credentials — is dropped only here and on an
        // explicit refresh (#27).
        this.httpCatalog?.invalidate();
        bump();
      }),
    ];
  }

  private _disposeNuGetConfigWatcher(): void {
    if (this._configChainTimer) {
      clearTimeout(this._configChainTimer);
      this._configChainTimer = undefined;
    }
    this._nugetConfigWatchSubs.forEach((d) => d.dispose());
    this._nugetConfigWatchSubs = [];
    this._nugetConfigWatcher?.dispose();
    this._nugetConfigWatcher = undefined;
  }

  private _scheduleConfigChainRefresh(): void {
    if (this._configChainTimer) clearTimeout(this._configChainTimer);
    this._configChainTimer = setTimeout(() => {
      this._configChainTimer = undefined;
      void this._pushConfigChainUpdate(false);
    }, 200);
  }

  /**
   * After this extension itself writes a `nuget.config` — a source added,
   * disabled, re-credentialled, remapped. What the HTTP catalog holds is
   * derived from that file, so it is dropped here rather than on a watcher:
   * the write is the decision, and there is exactly one moment for it (#27).
   */
  private async _afterConfigWrite(): Promise<void> {
    this.httpCatalog?.invalidate();
    await this._pushConfigChainUpdate(true);
  }

  private async _pushConfigChainUpdate(force: boolean): Promise<void> {
    // Whatever changed on disk to bring this call about, the config chain an
    // implicit-row watch would reuse might no longer be it (#118).
    this._implicitConfigFiles = undefined;
    const scope = this.provider.getCurrentScope();
    const startDir = this._scopeStartDir(scope);
    if (!scope || !startDir) return;
    const payload = await this._buildSourcesPayload(scope);
    const json = JSON.stringify({
      snapshot: payload.snapshot,
      urls: payload.sources.map((s) => `${s.name}\0${s.url}`),
    });
    if (!force && json === this._lastSnapshotJson) return;
    this._lastSnapshotJson = json;
    this.provider.postMessage({
      type: 'CONFIG_CHAIN_UPDATE',
      configChain: payload.configChain,
      sources: payload.sources,
      snapshot: payload.snapshot,
    });
    const packageSources = uniqueEnabledPackageSources(payload.configChain);
    const auditSources = uniqueEnabledAuditSources(payload.configChain);
    if (shouldRunDotnetListVulnerable(packageSources, auditSources)) {
      this.provider.postMessage({
        type: 'VULN_SCAN_HINT',
        show: false,
        fingerprint: [
          ...payload.configChain.map((c) => c.filePath),
          ...auditSources.map((s) => s.url),
        ].join('\n'),
        message: AUDIT_SOURCES_HINT,
        configFilePath: payload.configChain[0]?.filePath,
      });
    }
  }

  /** Re-run the vuln scan against the last listed packages, without a fresh
   *  `dotnet list` — used after an audit-source change, since that flips
   *  which scan path (`DotnetVulnerableProvider` vs. the cache/restore-text
   *  fallback) applies, and the panel would otherwise keep showing findings
   *  from before the change until the next full refresh (#53). */
  private _rescanVulnerabilities(): void {
    if (!this._lastListed) return;
    const listed = this._lastListed;
    this._cancelVulnScan();
    void this._scanVulnerabilities(listed, this._vulnAbort.signal);
  }

  private async _handleSetSourceEnabled(
    msg: Extract<WebviewMessage, { type: 'SET_SOURCE_ENABLED' }>,
  ): Promise<void> {
    try {
      if (msg.kind === 'audit') {
        const wrote = await this._setAuditSourceEnabled(msg);
        if (!wrote) return;
      } else {
        if (!this._isWritableNuGetConfig(msg.configFilePath)) {
          await this._warnNuGetConfigNotWritable(msg.configFilePath);
          return;
        }
        await patchNuGetConfigFile(msg.configFilePath, (xml) => setPackageSourceDisabled(xml, msg.name, !msg.enabled));
      }
      this.logger.logCliOperation({
        timestamp: new Date(),
        kind: 'edit',
        command: msg.kind === 'audit' ? 'nuget.config auditSources' : 'nuget.config source',
        args: [msg.enabled ? 'enable' : 'disable', msg.name, msg.configFilePath],
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 0,
      });
      await this._afterConfigWrite();
      if (msg.kind === 'audit') this._rescanVulnerabilities();
    } catch (err) {
      await vscode.window.showErrorMessage(`Could not update source ${msg.name}: ${String(err)}`);
    }
  }

  /**
   * Audit on/off must not use `<disabledPackageSources>` — that key is shared with
   * package sources, so toggling audit nuget.org would also disable package nuget.org.
   * Effective view never copies the whole declared audit list into the nearest
   * workspace file; inherited feeds go to user NuGet.Config.
   */
  private async _setAuditSourceEnabled(
    msg: Extract<WebviewMessage, { type: 'SET_SOURCE_ENABLED' }>,
  ): Promise<boolean> {
    const scope = this.provider.getCurrentScope();
    const startDir = this._scopeStartDir(scope);
    const chain = startDir ? await this.configResolver.resolve(startDir) : [];
    const nearest = chain[0]?.filePath;
    const targetingNearest = !!nearest && pathsEqual(msg.configFilePath, nearest);

    if (!targetingNearest) {
      if (!this._isWritableNuGetConfig(msg.configFilePath)) {
        await this._warnNuGetConfigNotWritable(msg.configFilePath);
        return false;
      }
      if (msg.enabled) {
        if (!msg.url) {
          await vscode.window.showWarningMessage(`Could not enable audit source ${msg.name}: missing URL.`);
          return false;
        }
        await patchNuGetConfigFile(msg.configFilePath, (xml) => upsertAuditSource(xml, msg.name, msg.url!));
        return true;
      }
      await patchNuGetConfigFile(msg.configFilePath, (xml) => removeAuditSource(xml, msg.name));
      return true;
    }

    const userConfigPath = await resolveUserNuGetConfigPath();
    const edits = planEffectiveAuditToggle({
      chain,
      name: msg.name,
      enabled: msg.enabled,
      url: msg.url,
      userConfigPath,
    });
    if (edits.length === 0) {
      if (msg.enabled) {
        await vscode.window.showWarningMessage(`Could not enable audit source ${msg.name}: missing URL.`);
      }
      return false;
    }

    const written: string[] = [];
    for (const edit of edits) {
      if (!this._isWritableNuGetConfig(edit.filePath)) {
        await this._warnNuGetConfigNotWritable(edit.filePath);
        continue;
      }
      if (isGlobalNuGetConfigPath(edit.filePath) || pathsEqual(edit.filePath, userConfigPath)) {
        await ensureNuGetConfigFile(edit.filePath);
      }
      if (edit.op === 'replace') {
        await patchNuGetConfigFile(edit.filePath, (xml) => replaceAuditSources(xml, edit.sources, true));
      } else if (edit.op === 'upsert') {
        await patchNuGetConfigFile(edit.filePath, (xml) => upsertAuditSource(xml, edit.name, edit.url));
      } else {
        await patchNuGetConfigFile(edit.filePath, (xml) => removeAuditSource(xml, edit.name));
      }
      written.push(edit.filePath);
    }
    return written.length > 0;
  }

  private async _handleSetSourceConnectionFlags(
    msg: Extract<WebviewMessage, { type: 'SET_SOURCE_CONNECTION_FLAGS' }>,
  ): Promise<void> {
    if (!this._isWritableNuGetConfig(msg.configFilePath)) {
      await this._warnNuGetConfigNotWritable(msg.configFilePath);
      return;
    }
    try {
      await patchNuGetConfigFile(msg.configFilePath, (xml) => setPackageSourceConnectionFlags(xml, msg.name, {
        allowInsecureConnections: msg.allowInsecureConnections,
        disableTlsCertificateValidation: msg.disableTlsCertificateValidation,
      }));
      this.logger.logCliOperation({
        timestamp: new Date(),
        kind: 'edit',
        command: 'nuget.config source flags',
        args: [
          msg.name,
          `allowInsecureConnections=${msg.allowInsecureConnections}`,
          `disableTLSCertificateValidation=${msg.disableTlsCertificateValidation}`,
          msg.configFilePath,
        ],
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 0,
      });
      await this._afterConfigWrite();
    } catch (err) {
      await vscode.window.showErrorMessage(`Could not update source ${msg.name}: ${String(err)}`);
    }
  }

  private async _handleSetSourceMapping(
    msg: Extract<WebviewMessage, { type: 'SET_SOURCE_MAPPING' }>,
  ): Promise<void> {
    if (!this._isWritableNuGetConfig(msg.configFilePath)) {
      await this._warnNuGetConfigNotWritable(msg.configFilePath);
      return;
    }
    try {
      await patchNuGetConfigFile(msg.configFilePath, (xml) =>
        setPackageSourceMappingPatterns(xml, msg.name, msg.patterns));
      this.logger.logCliOperation({
        timestamp: new Date(),
        kind: 'edit',
        command: 'nuget.config source mapping',
        args: [msg.name, `patterns=${msg.patterns.join(', ') || '(none)'}`, msg.configFilePath],
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 0,
      });
      await this._afterConfigWrite();
    } catch (err) {
      await vscode.window.showErrorMessage(`Could not update source mapping for ${msg.name}: ${String(err)}`);
    }
  }

  private async _handleAddPackageSource(
    msg: Extract<WebviewMessage, { type: 'ADD_PACKAGE_SOURCE' }>,
  ): Promise<void> {
    if (!this._isWritableNuGetConfig(msg.configFilePath)) {
      await this._warnNuGetConfigNotWritable(msg.configFilePath);
      return;
    }
    try {
      await patchNuGetConfigFile(msg.configFilePath, (xml) =>
        addPackageSource(xml, msg.name, msg.url, { protocolVersion: msg.protocolVersion }));
      this.logger.logCliOperation({
        timestamp: new Date(),
        kind: 'edit',
        command: 'nuget.config add source',
        args: [msg.name, msg.url, msg.configFilePath],
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 0,
      });
      await this._afterConfigWrite();
    } catch (err) {
      await vscode.window.showErrorMessage(`Could not add source ${msg.name}: ${String(err)}`);
    }
  }

  private async _handleRemovePackageSource(
    msg: Extract<WebviewMessage, { type: 'REMOVE_PACKAGE_SOURCE' }>,
  ): Promise<void> {
    if (!this._isWritableNuGetConfig(msg.configFilePath)) {
      await this._warnNuGetConfigNotWritable(msg.configFilePath);
      return;
    }
    try {
      await patchNuGetConfigFile(msg.configFilePath, (xml) => removePackageSourceEntry(xml, msg.name));
      this.logger.logCliOperation({
        timestamp: new Date(),
        kind: 'edit',
        command: 'nuget.config remove source',
        args: [msg.name, msg.configFilePath],
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 0,
      });
      await this._afterConfigWrite();
    } catch (err) {
      await vscode.window.showErrorMessage(`Could not remove source ${msg.name}: ${String(err)}`);
    }
  }

  private async _handleSetSourceSecrets(msg: Extract<WebviewMessage, { type: 'SET_SOURCE_SECRETS' }>): Promise<void> {
    const machine = isMachineWideNuGetConfigPath(msg.configFilePath);
    if (!machine && !this._isWritableNuGetConfig(msg.configFilePath)) {
      await this._warnNuGetConfigNotWritable(msg.configFilePath);
      return;
    }
    try {
      let password = msg.password;
      let passwordEncrypted = false;
      if (password && supportsEncryptedNuGetPasswords()) {
        password = await encryptNuGetConfigPassword(password);
        passwordEncrypted = true;
      }
      const userConfigPath = await ensureUserNuGetConfigFile();
      const result = await writeSourceSecrets({
        declaredFilePath: msg.configFilePath,
        userConfigPath,
        sourceName: msg.name,
        sourceUrl: msg.url,
        username: msg.username,
        password,
        passwordEncrypted,
        clearCredentials: msg.clearCredentials,
        apiKey: msg.clearApiKey ? null : (msg.apiKey !== undefined && msg.apiKey !== '' ? msg.apiKey : undefined),
      });
      this.logger.logCliOperation({
        timestamp: new Date(),
        kind: 'edit',
        command: 'nuget.config secrets',
        args: [
          msg.clearCredentials || msg.clearApiKey ? 'clear' : 'update',
          msg.name,
          result.targetPath,
          ...(result.strippedDeclared ? ['stripped', msg.configFilePath] : []),
        ],
        stdout: 'secrets omitted',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 0,
      });
      await this._afterConfigWrite();
    } catch (err) {
      await vscode.window.showErrorMessage(`Could not update credentials for ${msg.name}: ${String(err)}`);
    }
  }

  private _isWritableNuGetConfig(filePath: string): boolean {
    if (isMachineWideNuGetConfigPath(filePath)) return false;
    return path.basename(filePath).toLowerCase() === 'nuget.config';
  }

  private async _warnNuGetConfigNotWritable(filePath: string): Promise<void> {
    const reason = isMachineWideNuGetConfigPath(filePath)
      ? 'Machine-wide NuGet config is read-only.'
      : 'This file is not a writable nuget.config.';
    await vscode.window.showWarningMessage(`${reason} (${filePath})`);
  }

  private async _handleOpenConfigFile(filePath: string, sourceName?: string): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(filePath);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      if (!sourceName) return;
      const line = findPackageSourceLine(doc.getText(), sourceName);
      if (line === undefined) return;
      const start = new vscode.Position(line, 0);
      const end = doc.lineAt(line).range.end;
      editor.selection = new vscode.Selection(start, end);
      editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
    } catch (err) {
      this.provider.postMessage({
        type: 'ERROR',
        message: `Cannot open ${filePath}`,
        details: String(err),
      });
    }
  }

  private async _handleOpenUrl(url: string): Promise<void> {
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) return;
    try {
      await vscode.env.openExternal(vscode.Uri.parse(trimmed));
    } catch (err) {
      this.provider.postMessage({
        type: 'ERROR',
        message: `Cannot open ${trimmed}`,
        details: String(err),
      });
    }
  }
}
