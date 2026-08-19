import * as vscode from 'vscode';
import * as path from 'path';
import { runWithConcurrency } from './concurrency';
import { getConfig, setIncludePrerelease } from './config';
import type { NugetManagerViewProvider } from './nugetManagerViewProvider';
import type { INuGetBackend } from './backend/INuGetBackend';
import type { SolutionParser } from './solutionParser';
import type { NuGetConfigChainResolver } from './nugetConfigChainResolver';
import type { Logger } from './logger';
import type { WebviewMessage } from './messages';
import type { WorkspaceScope, CliResult, OperationFailure, PackageListResult, InstalledPackage, BatchUpdateItem, BatchUpdateJob, BatchItemStatus } from './types';
import { isCliOperationSuccess, summarizeDotnetFailure, cliOutputText } from './dotnetOutput';
import { pathsEqual } from './pathCompare';
import {
  snapshotProjectFiles,
  restoreFileSnapshots,
  readPackageVersionFromSnapshots,
  type FileSnapshot,
} from './projectFileSnapshot';
import {
  collectVulnerabilityFindings,
  DotnetVulnerableProvider,
} from './vulnerabilityProvider';
import { UserScriptVulnerabilityProvider } from './userScriptVulnerabilities';

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
}

interface CacheEntry {
  latestVersion: string;
  sourceName: string;
  fetchedAt: number;
  /** Full sorted version list — cached for instant detail panel population */
  versions: string[];
}

export class WebviewMessageBroker {
  private _messageDisposable?: vscode.Disposable;
  private _logDisposable?: vscode.Disposable;

  /** packageId (lowercase) → cached enrichment data */
  private readonly _cache = new Map<string, CacheEntry>();

  /** Cancellation token for the current enrich job — replaced on each new job */
  private _enrichAbort: AbortController = new AbortController();
  private _vulnAbort: AbortController = new AbortController();

  /** Snapshots from the last failed add, used by the Rollback button (`onFailedUpdate: keep`). */
  private _pendingRollback: { packageId: string; attempts: InstallAttempt[] } | null = null;

  private _batchRunning = false;

  constructor(
    private readonly provider: NugetManagerViewProvider,
    private readonly backend: INuGetBackend,
    private readonly solutionParser: SolutionParser,
    private readonly configResolver: NuGetConfigChainResolver,
    private readonly logger: Logger,
  ) {}

  attach(): void {
    // Subscribe to webview messages (safe before view is resolved)
    this._messageDisposable = this.provider.onDidReceiveMessage(
      (raw) => void this._handle(raw as WebviewMessage),
    );

    // Subscribe to new log entries → push LOG_ENTRY_ADDED to webview
    this._logDisposable = this.logger.subscribe((entry) => {
      this.provider.postMessage({ type: 'LOG_ENTRY_ADDED', entry });
    });

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
    this._messageDisposable?.dispose();
    this._messageDisposable = undefined;
    this._logDisposable?.dispose();
    this._logDisposable = undefined;
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

  // ─── Message router ────────────────────────────────────────────────────────

  private async _handle(msg: WebviewMessage): Promise<void> {
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

      case 'REFRESH_PACKAGES':
        this._cancelEnrich();
        this._cancelVulnScan();
        await this._handleRefresh();
        break;

      case 'FORCE_REFRESH':
        this._cancelEnrich();
        this._cancelVulnScan();
        this._cache.clear();
        this.provider.postMessage({ type: 'REFRESH_STARTED' });
        await this._handleRefresh({ restore: true });
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
        await this._handleOpenConfigFile(msg.filePath);
        break;

      case 'GET_LOG_ENTRIES':
        this.provider.postMessage({ type: 'LOG_ENTRIES', entries: this.logger.getEntries() });
        break;

      default:
        break;
    }
  }

  // ─── Handlers ─────────────────────────────────────────────────────────────

  private async _handleWebviewReady(): Promise<void> {
    this.provider.markClientReady();

    const scope = this.provider.getCurrentScope();

    if (!scope) {
      // Try to auto-detect a solution/project in the workspace root
      const autoScope = await this._detectWorkspaceScope();
      if (autoScope) {
        this.provider.setScope(autoScope);
        await this._initForScope(autoScope);
      } else {
        this.provider.postMessage({
          type: 'INIT_STATE',
          scope: { kind: 'project', projectPath: '' },
          sources: [],
          configChain: [],
          includePrerelease: getConfig().includePrerelease,
        });
      }
      return;
    }

    await this._initForScope(scope);
  }

  /** Scan workspace root for a .sln/.slnx/.csproj/.fsproj file. */
  private async _detectWorkspaceScope(): Promise<import('./types').WorkspaceScope | null> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;

    const rootPath = folders[0].uri.fsPath;
    let entries: string[];
    try {
      const fs = await import('fs/promises');
      const dirents = await fs.readdir(rootPath, { withFileTypes: true });
      entries = dirents.filter((d) => d.isFile()).map((d) => d.name);
    } catch {
      return null;
    }

    const SOLUTION_EXTS = new Set(['.sln', '.slnx']);
    const ALL_EXTS = new Set(['.sln', '.slnx', '.csproj', '.fsproj']);

    // Prefer solution files over project files
    const solutions = entries.filter((n) => SOLUTION_EXTS.has(path.extname(n).toLowerCase()));
    const projects  = entries.filter((n) => ALL_EXTS.has(path.extname(n).toLowerCase()) && !SOLUTION_EXTS.has(path.extname(n).toLowerCase()));

    const target = solutions[0] ?? projects[0];
    if (!target) return null;

    const targetPath = path.join(rootPath, target);
    const ext = path.extname(target).toLowerCase();

    if (SOLUTION_EXTS.has(ext)) {
      const projectList = await this.solutionParser.getProjects(targetPath);
      return { kind: 'solution', solutionPath: targetPath, projects: projectList };
    }

    return { kind: 'project', projectPath: targetPath };
  }

  private async _initForScope(scope: WorkspaceScope): Promise<void> {
    this._cancelEnrich();
    this._cancelVulnScan();
    const startDir =
      scope.kind === 'solution'
        ? path.dirname(scope.solutionPath)
        : path.dirname(scope.projectPath);

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

    const configChain = await this.configResolver.resolve(startDir);

    // Deduplicate sources by name (case-insensitive), nearest config wins
    const seenSourceNames = new Set<string>();
    const sources = configChain
      .flatMap((c) => c.sources)
      .filter((s) => {
        const key = s.name.toLowerCase();
        if (seenSourceNames.has(key)) return false;
        seenSourceNames.add(key);
        return true;
      });

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

    this.provider.postMessage({ type: 'INIT_STATE', scope, sources, configChain, includePrerelease: getConfig().includePrerelease });

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

    const startDir = scope.kind === 'solution'
      ? path.dirname(scope.solutionPath)
      : path.dirname(scope.projectPath);

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

    // Serve cached versions immediately — no waiting
    if (cached?.versions?.length) {
      this.provider.postMessage({ type: 'ALL_VERSIONS', packageId, versions: cached.versions });
    }

    // Background refresh — fetch fresh versions and send only if list changed
    try {
      const fresh = await this.backend.getAllVersions(packageId, configFiles, prerelease);

      // Update cache with fresh versions (keep other fields if present)
      if (cached) {
        cached.versions = fresh;
        cached.fetchedAt = Date.now();
      } else {
        this._cache.set(key, { latestVersion: fresh[0] ?? '', sourceName: '', versions: fresh, fetchedAt: Date.now() });
      }

      // Send only if different from what was already sent
      const prev = cached?.versions ?? [];
      const changed = fresh.length !== prev.length || fresh.some((v, i) => v !== prev[i]);
      if (changed || !cached?.versions?.length) {
        this.provider.postMessage({ type: 'ALL_VERSIONS', packageId, versions: fresh });
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
    const attempts = await this._installOnProjects(packageId, version, [projectPath]);
    await this._finishInstallAttempts(packageId, version, attempts);
  }

  private async _handleInstallMulti(
    projects: string[],
    packageId: string,
    version: string,
  ): Promise<void> {
    const attempts = await this._installOnProjects(packageId, version, projects);
    await this._finishInstallAttempts(packageId, version, attempts);
  }

  private async _installOnProjects(
    packageId: string,
    version: string,
    projects: string[],
    onProjectDone?: (projectPath: string, ok: boolean) => void,
  ): Promise<InstallAttempt[]> {
    const prepared = await Promise.all(
      projects.map(async (projectPath) => {
        const snapshots = await snapshotProjectFiles(projectPath);
        return {
          projectPath,
          snapshots,
          previousVersion: readPackageVersionFromSnapshots(snapshots, packageId),
        };
      }),
    );
    return Promise.all(
      prepared.map(async (p) => {
        const result = await this.backend.installPackage(p.projectPath, packageId, version);
        onProjectDone?.(p.projectPath, isCliOperationSuccess(result));
        return { ...p, result };
      }),
    );
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

    const queued = items.filter((i) => i.packageId && i.toVersion && i.projects.length > 0);
    if (queued.length === 0) {
      this.provider.postMessage({ type: 'ERROR', message: 'No packages to update' });
      return;
    }

    this._batchRunning = true;
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
      for (const item of queued) {
        this._postBatchItem(jobId, item.packageId, 'running', [], undefined, []);
        const succeededSoFar: string[] = [];
        const completedSoFar: string[] = [];
        const attempts = await this._installOnProjects(
          item.packageId,
          item.toVersion,
          item.projects,
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
        );
        const outcome = await this._finishInstallAttempts(item.packageId, item.toVersion, attempts, {
          notify: false,
          refresh: false,
        });
        if (outcome.keepAttempts.length > 0) {
          keepFailures.push(...outcome.keepAttempts);
        }
        this._postBatchItem(
          jobId,
          item.packageId,
          outcome.status,
          outcome.succeeded,
          outcome.error,
          item.projects,
        );
      }

      if (keepFailures.length > 0) {
        this._pendingRollback = { packageId: queued[queued.length - 1].packageId, attempts: keepFailures };
      }

      this.provider.postMessage({
        type: 'BATCH_UPDATE_FINISHED',
        jobId,
        canRollback: keepFailures.length > 0,
      });
      await this._refreshAfterMutation({ notifyListError: false });
    } finally {
      this._batchRunning = false;
    }
  }

  private _postBatchItem(
    jobId: string,
    packageId: string,
    status: BatchItemStatus,
    succeededProjects: string[],
    error?: string,
    completedProjects?: string[],
  ): void {
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
      if (notify) {
        this.provider.postMessage({
          type: 'OPERATION_TIMEOUT',
          command: `dotnet add ${timedOut.projectPath} package ${packageId} --version ${version}`,
        });
      }
      return { status: 'timeout', succeeded: [], error: 'Operation timed out', keepAttempts: [] };
    }

    const succeededAttempts = attempts.filter((a) => isCliOperationSuccess(a.result));
    const failed = attempts.filter((a) => !isCliOperationSuccess(a.result));
    const succeeded = succeededAttempts.map((a) => a.projectPath);

    if (failed.length === 0) {
      if (notify) {
        this._pendingRollback = null;
        this.provider.postMessage({
          type: 'OPERATION_SUCCESS',
          operation: 'install',
          packageId,
          affectedProjects: succeeded,
        });
      } else if (succeededAttempts.length > 0) {
        this._patchInstalledVersions(packageId, version, succeededAttempts);
      }
      if (refresh) await this._refreshAfterMutation();
      return { status: 'ok', succeeded, keepAttempts: [] };
    }

    const mode = getConfig().onFailedUpdate;
    let rollbackApplied = false;
    let keepAttempts: InstallAttempt[] = [];
    if (mode === 'rollback') {
      await this._restoreAttempts(failed);
      if (notify) this._pendingRollback = null;
      rollbackApplied = true;
      if (succeededAttempts.length > 0) {
        this._patchInstalledVersions(packageId, version, succeededAttempts);
      }
    } else {
      keepAttempts = failed;
      if (notify) this._pendingRollback = { packageId, attempts: failed };
      this._patchInstalledVersions(packageId, version, [...succeededAttempts, ...failed]);
    }

    const failures = failed.map((a) => cliFailure(a.projectPath, a.result, {
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
        canRollback: mode === 'keep',
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
    const result = await this.backend.removePackage(projectPath, packageId);
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
    const results = await Promise.all(
      projects.map(async (p) => ({
        projectPath: p,
        result: await this.backend.removePackage(p, packageId),
      })),
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

  private async _handleRefresh(opts?: { notifyListError?: boolean; restore?: boolean }): Promise<void> {
    const scope = this.provider.getCurrentScope();
    if (!scope) return;

    if (scope.kind === 'solution') {
      await this._refreshForSolution(scope.solutionPath, opts);
    } else if (scope.projectPath) {
      await this._refreshPackagesForProjects([scope.projectPath], opts);
    }
  }

  /**
   * Push new lists only when we actually parsed packages. A failed restore makes
   * `dotnet list` return `{ problems: [...] }` with no projects — posting that
   * as INSTALLED_PACKAGES: [] wipes the UI.
   */
  private _applyListedPackages(
    listed: PackageListResult,
    opts?: { notifyListError?: boolean },
  ): void {
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

    this.provider.postMessage({ type: 'INSTALLED_PACKAGES', packages: listed.installed });
    this.provider.postMessage({ type: 'IMPLICIT_PACKAGES', packages: listed.implicit });

    this._cancelVulnScan();
    const vulnSignal = this._vulnAbort.signal;
    void this._scanVulnerabilities(listed, vulnSignal);

    if (listed.installed.length > 0) {
      this._cancelEnrich();
      const signal = this._enrichAbort.signal;
      void this._enrichInstalledPackages(listed.installed, signal);
    }
  }

  private async _refreshForSolution(
    solutionPath: string,
    opts?: { notifyListError?: boolean; restore?: boolean },
  ): Promise<void> {
    const restoreP = opts?.restore ? this.backend.restoreProject(solutionPath) : undefined;
    const listed = await this.backend.listAllForSolution(solutionPath);
    this._applyListedPackages(listed, opts);
    if (restoreP) await this._reportRestoreIfCurrent(solutionPath, await restoreP);
  }

  private async _refreshPackagesForProjects(
    projectPaths: string[],
    opts?: { notifyListError?: boolean; restore?: boolean },
  ): Promise<void> {
    if (projectPaths.length === 0) return;

    const restoreP = opts?.restore ? this.backend.restoreProject(projectPaths[0]) : undefined;
    const concurrency = getConfig().enrichConcurrency;
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
    this._applyListedPackages(listed, opts);
    if (restoreP) await this._reportRestoreIfCurrent(projectPaths[0], await restoreP);
  }

  private _reportRestoreIfCurrent(targetPath: string, result: CliResult): void {
    const scope = this.provider.getCurrentScope();
    if (!scope) return;
    const current = scope.kind === 'solution' ? scope.solutionPath : scope.projectPath;
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
    if (!scope || signal.aborted) return;

    const targetPath = scope.kind === 'solution' ? scope.solutionPath : scope.projectPath;
    if (!targetPath) return;

    const findings = await collectVulnerabilityFindings(
      [
        new DotnetVulnerableProvider(this.backend),
        new UserScriptVulnerabilityProvider(this.logger),
      ],
      {
        targetPath,
        cwd: path.dirname(targetPath),
        scope,
        installed: listed.installed,
        implicit: listed.implicit,
        signal,
      },
    );
    if (signal.aborted) return;
    this.provider.postMessage({ type: 'VULNERABILITIES', findings });
  }

  /** Fetches latestVersion + sourceName for each unique package id and pushes
   *  individual PACKAGE_INFO_UPDATE messages as results arrive.
   *  Uses an in-memory cache (TTL: config.cacheTtlMs) and limits concurrency
   *  to config.enrichConcurrency parallel dotnet processes. */
  private async _enrichInstalledPackages(
    installed: import('./types').InstalledPackage[],
    signal: AbortSignal,
  ): Promise<void> {
    const scope = this.provider.getCurrentScope();
    if (!scope || signal.aborted) return;

    const startDir = scope.kind === 'solution'
      ? path.dirname(scope.solutionPath)
      : path.dirname(scope.projectPath);

    const configChain = await this.configResolver.resolve(startDir);
    const configFiles = configChain.map((c) => c.filePath);
    if (configFiles.length === 0 || signal.aborted) return;

    const uniqueIds = [...new Set(installed.map((p) => p.id))];
    const now = Date.now();

    // Push cached entries immediately (no network call needed)
    const needsFetch: string[] = [];
    for (const id of uniqueIds) {
      const cached = this._cache.get(id.toLowerCase());
      if (cached && now - cached.fetchedAt < getConfig().cacheTtlMs) {
        this.provider.postMessage({
          type: 'PACKAGE_INFO_UPDATE',
          packageId: id,
          latestVersion: cached.latestVersion,
          sourceName: cached.sourceName,
        });
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

    // Fetch missing/stale entries with concurrency limit
    const tasks = needsFetch.map((id) => async () => {
      if (signal.aborted) return;

      try {
        const { latestVersion, sourceName, versions } = await this.backend.enrichPackage(
          id, configFiles, getConfig().includePrerelease,
        );

        if (signal.aborted) return;

        this._cache.set(id.toLowerCase(), { latestVersion, sourceName, versions, fetchedAt: Date.now() });

        if (latestVersion || sourceName) {
          this.provider.postMessage({
            type: 'PACKAGE_INFO_UPDATE',
            packageId: id,
            latestVersion,
            sourceName,
          });
        }
      } catch {
        // best-effort
      }

      if (signal.aborted) return;

      done++;
      this.provider.postMessage({ type: 'ENRICH_PROGRESS', done, total });
    });

    await runWithConcurrency(tasks, getConfig().enrichConcurrency);
  }

  private async _handleOpenConfigFile(filePath: string): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc);
    } catch (err) {
      this.provider.postMessage({
        type: 'ERROR',
        message: `Cannot open ${filePath}`,
        details: String(err),
      });
    }
  }
}
