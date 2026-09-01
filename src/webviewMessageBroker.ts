import * as vscode from 'vscode';
import * as path from 'path';
import { runWithConcurrency } from './concurrency';
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
import type { WebviewMessage } from './messages';
import { EMPTY_SKILL_STATUS, type SkillStatus } from './agentSkillInstall';
import type { WorkspaceScope, CliResult, OperationFailure, PackageListResult, InstalledPackage, BatchUpdateItem, BatchUpdateJob, BatchItemStatus, NuGetConfigFile } from './types';
import { isCliOperationSuccess, summarizeDotnetFailure, cliOutputText, mergeCliResults } from './dotnetOutput';
import { mergeFindings } from './vulnerabilities';
import { delayInstallRetry, INSTALL_RETRY_EXTRA_ATTEMPTS, isRetryableCliFailure } from './cliRetry';
import { BLOCKED_UPDATES_TOOLTIP, isPackageBlocked, withoutBlocked } from './blockedPackages';
import { pathsEqual, normalizeFsPath } from './pathCompare';
import { compareSemVer } from './semver';
import {
  listWorkspaceDotnetFiles,
  listWorkspaceNuGetConfigFiles,
  scopeFromDotnetFile,
  scopeFromFolder,
  findDotnetTargetsInFolder,
  toProjectInfo,
  sortDotnetTargetPaths,
  isSolutionFile,
  NUGET_CONFIG_GLOB,
} from './dotnetWorkspace';
import { readProjectAssets } from './projectAssets';
import { computeEntangledCluster } from './batchUpdates';

/** Absolute path uniquely identifying a scope — solution/folder path, or the single project. */
function scopeIdentityPath(scope: WorkspaceScope): string {
  if (scope.kind === 'solution') return scope.solutionPath;
  if (scope.kind === 'folder') return scope.folderPath;
  return scope.projectPath;
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
  type FileSnapshot,
} from './projectFileSnapshot';
import {
  detectProjectPackageStyle,
  packagesConfigExists,
  PACKAGES_CONFIG_SKIP,
} from './projectPackageStyle';
import {
  countPackageReferences,
  removePackageReferences,
  upsertPackageReference,
  writeProjectXml,
} from './legacyPackageReference';
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
  findPackageSourceLine,
} from './nugetConfigEdit';
import { encryptNuGetConfigPassword, supportsEncryptedNuGetPasswords } from './nugetConfigDpapi';
import { ensureNuGetConfigFile, ensureUserNuGetConfigFile, resolveUserNuGetConfigPath, writeSourceSecrets } from './nugetConfigSecretTarget';
import { planEffectiveAuditToggle } from './auditSourceToggle';

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
}

function skippedInstallResult(): CliResult {
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
}

interface BatchItemOutcome {
  status: BatchItemStatus;
  succeeded: string[];
  error?: string;
}

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

  /** Snapshots from the last failed add, used by the Rollback button (`onFailedUpdate: keep`). */
  private _pendingRollback: { packageId: string; attempts: InstallAttempt[] } | null = null;

  private _batchRunning = false;
  private _batchAbort: AbortController | null = null;

  /** Probe result for Groups. `undefined` = not probed (tests without a probe). */
  private _roslynCap: RoslynCap | null | undefined = undefined;
  private _restoreInFlight?: Promise<CliResult>;
  private _restoreGeneration = 0;
  private _lastRestoreText = '';

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
    },
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
  }

  private _postBlockedPackages(): void {
    this.provider.postMessage({ type: 'BLOCKED_PACKAGES', packageIds: getBlockedPackages() });
  }

  private async _handleSetPackageBlocked(packageId: string, blocked: boolean): Promise<void> {
    const packageIds = await setPackageBlocked(packageId, blocked);
    this.provider.postMessage({ type: 'BLOCKED_PACKAGES', packageIds });
  }

  /** True when this id is blocked and already installed — first-time install stays allowed. */
  private _rejectBlockedVersionChange(packageId: string): boolean {
    if (!isPackageBlocked(packageId, getBlockedPackages())) return false;
    if (!this._installedIds.has(packageId.toLowerCase())) return false;
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
        await this._handleGetMetadata(msg.packageId, msg.version, msg.configFiles);
        break;

      case 'GET_ALL_VERSIONS':
        await this._handleGetAllVersions(msg.packageId, msg.configFiles, msg.prerelease);
        break;

      case 'INSTALL_PACKAGE':
        await this._handleInstallSingle(msg.projectPath, msg.packageId, msg.version);
        break;

      case 'REMOVE_PACKAGE':
        await this._handleRemoveSingle(msg.projectPath, msg.packageId);
        break;

      case 'INSTALL_PACKAGE_MULTI':
        await this._handleInstallMulti(msg.projects, msg.packageId, msg.version);
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
        await this._refreshWithRestore(true);
        break;

      case 'SET_PRERELEASE_SETTING':
        this._cancelEnrich();
        this._cancelVulnScan();
        await setIncludePrerelease(msg.prerelease);
        // Prerelease flag affects which versions are returned — invalidate cache
        this._cache.clear();
        await this._handleRefresh();
        break;

      case 'OPEN_CONFIG_FILE':
        await this._handleOpenConfigFile(msg.filePath, msg.sourceName);
        break;

      case 'COPY_TEXT':
        await vscode.env.clipboard.writeText(msg.text);
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
        await this._handleSelectScope();
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
    if (!this._firstReady) {
      this._firstReady = true;
      await this.onFirstWebviewReady?.();
    }

    this.provider.markClientReady();

    const scope = this.provider.getCurrentScope();

    if (!scope) {
      // Try to auto-detect a solution/project in the workspace root
      const autoScope = await this._detectWorkspaceScope();
      if (autoScope) {
        this.provider.setScope(autoScope);
        await this._initForScope(autoScope);
      } else {
        await this._refreshRoslynCap(false);
        this.provider.postMessage({
          type: 'INIT_STATE',
          scope: { kind: 'project', projectPath: '' },
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

    await this._initForScope(scope);
  }

  private async _handleSelectScope(): Promise<void> {
    const uris = await listWorkspaceDotnetFiles();
    if (uris.length === 0) {
      await vscode.window.showWarningMessage(
        'AVE NuGet Manager: No .sln, .slnx, .csproj, or .fsproj found in the workspace.',
      );
      return;
    }

    const currentPath = this._currentScopePath();
    const sorted = sortDotnetTargetPaths(uris.map((u) => u.fsPath));
    const items = sorted.map((fsPath) => {
      const rel = vscode.workspace.asRelativePath(fsPath, false);
      const current = currentPath.length > 0 && pathsEqual(fsPath, currentPath);
      return {
        label: path.basename(fsPath),
        description: current ? `${rel}  (current)` : rel,
        detail: isSolutionFile(fsPath) ? 'Solution' : 'Project',
        fsPath,
      };
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a solution or project',
      matchOnDescription: true,
    });
    if (!selected) return;
    if (currentPath && pathsEqual(selected.fsPath, currentPath)) return;

    const scope = await scopeFromDotnetFile(selected.fsPath, this.solutionParser);
    await this.activateScope(scope);
  }

  private _currentScopePath(): string {
    const scope = this.provider.getCurrentScope();
    return scope ? scopeIdentityPath(scope) : '';
  }

  /**
   * Scan the workspace root for a .sln/.slnx/.csproj/.fsproj file — direct
   * children first, falling back recursively (see {@link findDotnetTargetsInFolder}).
   * Multiple solutions are ambiguous and left to the manual "Select scope" picker.
   */
  private async _detectWorkspaceScope(): Promise<import('./types').WorkspaceScope | null> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;

    const rootPath = folders[0].uri.fsPath;
    const matches = await findDotnetTargetsInFolder(rootPath);
    if (matches.length === 0) return null;

    const solutionFiles = matches.filter(isSolutionFile);
    if (solutionFiles.length === 1) {
      const projectList = await this.solutionParser.getProjects(solutionFiles[0]);
      return { kind: 'solution', solutionPath: solutionFiles[0], projects: projectList };
    }
    if (solutionFiles.length > 1) return null;

    const projectFiles = matches.filter((p) => !isSolutionFile(p));
    if (projectFiles.length === 1) return { kind: 'project', projectPath: projectFiles[0] };
    if (projectFiles.length > 1) {
      const projects = projectFiles
        .map((p) => toProjectInfo(rootPath, p))
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      return scopeFromFolder(rootPath, projects);
    }

    return null;
  }

  private async _initForScope(scope: WorkspaceScope): Promise<void> {
    this._cancelEnrich();
    this._cancelVulnScan();
    this._restoreGeneration++;
    this._lastRestoreText = '';
    this.trace?.recordBroker('init-scope', {
      kind: scope.kind,
      path: path.basename(scopeIdentityPath(scope)),
      projects: scope.kind === 'solution' || scope.kind === 'folder' ? scope.projects.length : 1,
    });
    const startDir = this._scopeStartDir(scope) ?? '';

    // Log the resolution attempt so it appears in the Log tab
    const chainStart = Date.now();
    this.logger.logCliOperation({
      timestamp: new Date(),
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
    const { configChain, sources, snapshot } = payload;
    this._lastSnapshotJson = JSON.stringify(snapshot);

    // Log what we found
    this.logger.logCliOperation({
      timestamp: new Date(),
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
    // restore runs in parallel and reports NU1605 etc. in the banner.
    await this._handleRefresh({ restore: true });
  }

  private async _handleSearch(
    query: string,
    enabledSourceNames: string[],
    prerelease: boolean,
  ): Promise<void> {
    // Resolve config files from current scope — not from webview payload
    const scope = this.provider.getCurrentScope();
    if (!scope) return;

    const startDir = this._scopeStartDir(scope) ?? '';

    const configChain = await this.configResolver.resolve(startDir);
    const configFiles = configChain.map((c) => c.filePath);

    try {
      const packages = await this.backend.searchPackages(
        query, configFiles, enabledSourceNames, prerelease,
      );
      this.provider.postMessage({ type: 'SEARCH_RESULTS', query, packages });
    } catch (err) {
      this.provider.postMessage({
        type: 'ERROR',
        message: 'Search failed',
        details: String(err),
      });
    }
  }

  private async _handleGetMetadata(
    packageId: string,
    version: string | undefined,
    configFiles: string[],
  ): Promise<void> {
    try {
      const metadata = await this.backend.getMetadata(packageId, version ?? '', configFiles);
      this.provider.postMessage({ type: 'PACKAGE_METADATA', metadata });
    } catch (err) {
      this.provider.postMessage({
        type: 'ERROR',
        message: `Failed to load metadata for ${packageId}`,
        details: String(err),
      });
    }
  }

  private async _handleGetAllVersions(
    packageId: string,
    configFiles: string[],
    prerelease: boolean,
  ): Promise<void> {
    const key = packageId.toLowerCase();
    const cached = this._cache.get(key);
    const ttl = getConfig().cacheTtlMs;
    const cacheIsFresh = !!(cached?.versions?.length && (Date.now() - cached.fetchedAt < ttl));

    if (cached?.versions?.length) {
      this.provider.postMessage({ type: 'ALL_VERSIONS', packageId, versions: cached.versions });
    }
    if (cacheIsFresh) return;
    try {
      const prev = cached?.versions ?? [];
      const versions = await this.backend.getAllVersions(packageId, configFiles, prerelease);

      if (cached) {
        cached.versions = versions;
        cached.fetchedAt = Date.now();
      } else {
        this._cache.set(key, {
          latestVersion: versions[0] ?? '',
          sourceName: '',
          versions,
          fetchedAt: Date.now(),
        });
      }

      const changed = versions.length !== prev.length || versions.some((v, i) => v !== prev[i]);
      if (changed || prev.length === 0) {
        this.provider.postMessage({ type: 'ALL_VERSIONS', packageId, versions });
      }
    } catch {
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
  ): Promise<void> {
    if (this._rejectBlockedVersionChange(packageId)) return;
    const attempts = await this._installOnProjects(packageId, version, [projectPath]);
    await this._finishInstallAttempts(packageId, version, attempts);
  }

  private async _handleInstallMulti(
    projects: string[],
    packageId: string,
    version: string,
  ): Promise<void> {
    if (this._rejectBlockedVersionChange(packageId)) return;
    const attempts = await this._installOnProjects(packageId, version, projects);
    await this._finishInstallAttempts(packageId, version, attempts);
  }

  private async _installOnProjects(
    packageId: string,
    version: string,
    projects: string[],
    onProjectDone?: (projectPath: string, ok: boolean) => void,
    signal?: AbortSignal,
    retryTransient = false,
  ): Promise<InstallAttempt[]> {
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
    return runWithConcurrency(
      prepared.map((p) => async () => {
        if (signal?.aborted) {
          const result: CliResult = {
            exitCode: null, stdout: '', stderr: 'Cancelled', timedOut: false, cancelled: true,
          };
          onProjectDone?.(p.projectPath, false);
          return { ...p, result };
        }
        const { result: first, skipped, mutated, skippedUnsupported } = await this._addOrUpdatePackage(
          p.projectPath,
          p.snapshots,
          p.previousVersion,
          packageId,
          version,
          signal,
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
            : await this.backend.installPackage(p.projectPath, packageId, version, signal);
          this.trace?.recordBroker('add-retry', {
            project: path.basename(p.projectPath),
            packageId,
            version,
            ok: isCliOperationSuccess(result),
          });
        }
        onProjectDone?.(p.projectPath, isCliOperationSuccess(result));
        return { ...p, result, skipped, mutated, skippedUnsupported };
      }),
      getConfig().dotnetConcurrency,
    );
  }

  private async _addOrUpdatePackage(
    projectPath: string,
    snapshots: FileSnapshot[],
    previousVersion: string | null,
    packageId: string,
    version: string,
    signal?: AbortSignal,
  ): Promise<{ result: CliResult; skipped?: boolean; mutated?: boolean; skippedUnsupported?: boolean }> {
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

    const sameVersion = previousVersion !== null && compareSemVer(previousVersion, version) === 0;
    const duplicateLegacy = style === 'legacy-packageref'
      && countPackageReferences(xml, packageId) > 1;
    if (sameVersion && !duplicateLegacy) {
      return { result: skippedInstallResult(), skipped: true };
    }

    if (style === 'legacy-packageref') {
      const next = upsertPackageReference(xml, packageId, version);
      await writeProjectXml(projectPath, next);
      this.logger.logCliOperation({
        timestamp: new Date(),
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

    return { result: await this.backend.installPackage(projectPath, packageId, version, signal) };
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
          .map((item) => ({ packageId: item.packageId, toVersion: item.toVersion }));
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
  private async _runClusterForProject(
    projectPath: string,
    members: Array<{ packageId: string; toVersion: string }>,
    snapshot: FileSnapshot[],
    currentVersions: ReadonlyMap<string, string>,
    signal: AbortSignal,
  ): Promise<Array<{ packageId: string; toVersion: string; attempt: InstallAttempt }>> {
    const addResults = new Map<string, CliResult>();

    for (const { packageId, toVersion } of members) {
      if (signal.aborted) {
        addResults.set(packageId.toLowerCase(), {
          exitCode: null, stdout: '', stderr: 'Cancelled', timedOut: false, cancelled: true,
        });
        continue;
      }
      let result = await this.backend.installPackageNoRestore(projectPath, packageId, toVersion, signal);
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
        result = await this.backend.installPackageNoRestore(projectPath, packageId, toVersion, signal);
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
      packages: attempts.map((a) => ({
        id: packageId,
        requestedVersion: version,
        resolvedVersion: version,
        projectPath: a.projectPath,
      })),
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
        return {
          projectPath: p,
          result: await this._removeFromProject(p, packageId),
        };
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
      await this._refreshForSolution(scope.solutionPath, opts);
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

    const installed = this._stampCachedLatest(listed.installed);
    this._installedIds = new Set(installed.map((pkg) => pkg.id.toLowerCase()));
    this.provider.postMessage({ type: 'INSTALLED_PACKAGES', packages: installed });
    this.provider.postMessage({ type: 'IMPLICIT_PACKAGES', packages: listed.implicit });

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

  private _stampCachedLatest(installed: InstalledPackage[]): InstalledPackage[] {
    const now = Date.now();
    const ttl = getConfig().cacheTtlMs;
    return installed.map((pkg) => {
      const cached = this._cache.get(pkg.id.toLowerCase());
      if (!cached || now - cached.fetchedAt >= ttl) return pkg;
      return {
        ...pkg,
        latestVersion: pkg.latestVersion || cached.latestVersion,
        sourceName: pkg.sourceName || cached.sourceName,
        versions: pkg.versions?.length ? pkg.versions : cached.versions,
      };
    });
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
    opts?: RefreshOpts,
  ): Promise<void> {
    if (opts?.restore && opts.listAfterRestore) {
      const restoreResult = await this._beginRestore(this.backend.restoreProject(solutionPath));
      const listed = await this.backend.listAllForSolution(solutionPath);
      await this._applyListedPackages(listed, opts);
      this._reportRestoreIfCurrent(solutionPath, restoreResult);
      return;
    }

    const restoreP = opts?.restore
      ? this._beginRestore(this.backend.restoreProject(solutionPath))
      : undefined;
    const listed = await this.backend.listAllForSolution(solutionPath);
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
    if (runCli) {
      providers.push(new DotnetVulnerableProvider(this.backend));
    } else {
      this.logger.logCliOperation({
        timestamp: new Date(),
        command: 'vulnerability scan skipped',
        args: ['dotnet list --vulnerable not started: a package source has no VulnerabilityInfo'],
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 0,
      });
      if (this._restoreInFlight) await this._restoreInFlight;
      const cacheDir = this.vulnScan?.httpCacheDir
        ? [this.vulnScan.httpCacheDir()]
        : nugetHttpCacheDirs();
      const cached = await findingsFromNuGetHttpCache(
        cacheDir, listed.installed, listed.implicit,
      );
      const fromRestore = parseRestoreAuditWarnings(this._lastRestoreText, {
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
    if (signal.aborted) return;
    this.provider.postMessage({ type: 'VULNERABILITIES', findings });
    this.provider.postMessage({
      type: 'VULN_SCAN_HINT',
      show: !runCli,
      fingerprint,
      message: AUDIT_SOURCES_HINT,
      configFilePath: nearestConfig,
    });
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
    const configFiles = configChain.map((c) => c.filePath);
    if (configFiles.length === 0 || signal.aborted) return;

    const uniqueIds = [...new Set(installed.map((p) => p.id))];
    const now = Date.now();

    const needsFetch: string[] = [];
    for (const id of uniqueIds) {
      const cached = this._cache.get(id.toLowerCase());
      if (cached && now - cached.fetchedAt < getConfig().cacheTtlMs) {
        if (!opts?.quietCacheHits) {
          this.provider.postMessage({
            type: 'PACKAGE_INFO_UPDATE',
            packageId: id,
            latestVersion: cached.latestVersion,
            sourceName: cached.sourceName,
            versions: cached.versions,
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
      const ok = await this._tryEnrichPackage(id, configFiles, signal);
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
        await this._tryEnrichPackage(id, configFiles, signal);
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
  ): Promise<boolean> {
    try {
      const { latestVersion, sourceName, versions } = await this.backend.enrichPackage(
        id, configFiles, getConfig().includePrerelease,
      );
      if (signal.aborted) return false;
      if (!latestVersion && !sourceName) return false;

      this._cache.set(id.toLowerCase(), { latestVersion, sourceName, versions, fetchedAt: Date.now() });
      this.provider.postMessage({
        type: 'PACKAGE_INFO_UPDATE',
        packageId: id,
        latestVersion,
        sourceName,
        versions,
      });
      return true;
    } catch {
      return false;
    }
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
        if (path.basename(doc.fileName).toLowerCase() === 'nuget.config') bump();
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

  private async _pushConfigChainUpdate(force: boolean): Promise<void> {
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
        command: msg.kind === 'audit' ? 'nuget.config auditSources' : 'nuget.config source',
        args: [msg.enabled ? 'enable' : 'disable', msg.name, msg.configFilePath],
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 0,
      });
      await this._pushConfigChainUpdate(true);
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
      await this._pushConfigChainUpdate(true);
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
        command: 'nuget.config source mapping',
        args: [msg.name, `patterns=${msg.patterns.join(', ') || '(none)'}`, msg.configFilePath],
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 0,
      });
      await this._pushConfigChainUpdate(true);
    } catch (err) {
      await vscode.window.showErrorMessage(`Could not update source mapping for ${msg.name}: ${String(err)}`);
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
      await this._pushConfigChainUpdate(true);
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
