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
import type { WorkspaceScope } from './types';

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

  /** Set to true after activateScope pushes INIT_STATE so WEBVIEW_READY doesn't re-init */
  private _scopeInitialized = false;

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
    this._messageDisposable?.dispose();
    this._messageDisposable = undefined;
    this._logDisposable?.dispose();
    this._logDisposable = undefined;
  }

  /**
   * Called by CommandRegistrar after resolving the target file.
   * Sets the scope on the provider AND immediately pushes INIT_STATE + packages
   * so the webview updates without needing a WEBVIEW_READY round-trip.
   */
  async activateScope(scope: WorkspaceScope): Promise<void> {
    this._cancelEnrich();
    this._scopeInitialized = false; // reset so WEBVIEW_READY won't duplicate
    this.provider.setScope(scope);
    await this._initForScope(scope);
    this._scopeInitialized = true;
  }

  /** Abort any in-progress enrichment job and issue a fresh token. */
  private _cancelEnrich(): void {
    this._enrichAbort.abort();
    this._enrichAbort = new AbortController();
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

      case 'REFRESH_PACKAGES':
        this._cancelEnrich();
        await this._handleRefresh();
        break;

      case 'FORCE_REFRESH':
        this._cancelEnrich();
        this._cache.clear();
        await this._handleRefresh();
        break;

      case 'SET_PRERELEASE_SETTING':
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

    // If activateScope already ran and pushed INIT_STATE, skip re-init.
    // This prevents a double load when the user opens via context menu:
    //   activateScope() → _initForScope() → webview mounts → WEBVIEW_READY → here
    if (this._scopeInitialized) {
      this._scopeInitialized = false; // reset for next time
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

    // Send initial package lists
    await this._handleRefresh();
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
    const result = await this.backend.installPackage(projectPath, packageId, version);
    if (result.timedOut) {
      this.provider.postMessage({
        type: 'OPERATION_TIMEOUT',
        command: `dotnet add ${projectPath} package ${packageId} --version ${version}`,
      });
      return;
    }
    if (result.exitCode !== 0) {
      this.provider.postMessage({
        type: 'OPERATION_ERROR',
        operation: 'install',
        packageId,
        failures: [{ projectPath, stderr: result.stderr, exitCode: result.exitCode }],
        succeededProjects: [],
      });
      return;
    }
    this.provider.postMessage({
      type: 'OPERATION_SUCCESS',
      operation: 'install',
      packageId,
      affectedProjects: [projectPath],
    });
    await this._refreshPackagesForProjects([projectPath]);
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
    if (result.exitCode !== 0) {
      this.provider.postMessage({
        type: 'OPERATION_ERROR',
        operation: 'remove',
        packageId,
        failures: [{ projectPath, stderr: result.stderr, exitCode: result.exitCode }],
        succeededProjects: [],
      });
      return;
    }
    this.provider.postMessage({
      type: 'OPERATION_SUCCESS',
      operation: 'remove',
      packageId,
      affectedProjects: [projectPath],
    });
    await this._refreshPackagesForProjects([projectPath]);
  }

  private async _handleInstallMulti(
    projects: string[],
    packageId: string,
    version: string,
  ): Promise<void> {
    const results = await Promise.all(
      projects.map(async (p) => ({
        projectPath: p,
        result: await this.backend.installPackage(p, packageId, version),
      })),
    );

    const failures = results
      .filter((r) => r.result.exitCode !== 0 && !r.result.timedOut)
      .map((r) => ({ projectPath: r.projectPath, stderr: r.result.stderr, exitCode: r.result.exitCode }));
    const succeeded = results
      .filter((r) => r.result.exitCode === 0)
      .map((r) => r.projectPath);

    if (failures.length > 0) {
      this.provider.postMessage({ type: 'OPERATION_ERROR', operation: 'install', packageId, failures, succeededProjects: succeeded });
    } else {
      this.provider.postMessage({ type: 'OPERATION_SUCCESS', operation: 'install', packageId, affectedProjects: succeeded });
    }
    await this._refreshPackagesForProjects(succeeded);
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
      .filter((r) => r.result.exitCode !== 0 && !r.result.timedOut)
      .map((r) => ({ projectPath: r.projectPath, stderr: r.result.stderr, exitCode: r.result.exitCode }));
    const succeeded = results
      .filter((r) => r.result.exitCode === 0)
      .map((r) => r.projectPath);

    if (failures.length > 0) {
      this.provider.postMessage({ type: 'OPERATION_ERROR', operation: 'remove', packageId, failures, succeededProjects: succeeded });
    } else {
      this.provider.postMessage({ type: 'OPERATION_SUCCESS', operation: 'remove', packageId, affectedProjects: succeeded });
    }
    await this._refreshPackagesForProjects(succeeded);
  }

  private async _handleRefresh(): Promise<void> {
    const scope = this.provider.getCurrentScope();
    if (!scope) return;

    if (scope.kind === 'solution') {
      // One CLI call per list operation covers all projects — much faster
      await this._refreshForSolution(scope.solutionPath);
    } else if (scope.projectPath) {
      await this._refreshPackagesForProjects([scope.projectPath]);
    }
  }

  private async _refreshForSolution(solutionPath: string): Promise<void> {
    const { installed, implicit } = await this.backend.listAllForSolution(solutionPath);

    this.provider.postMessage({ type: 'INSTALLED_PACKAGES', packages: installed });
    this.provider.postMessage({ type: 'IMPLICIT_PACKAGES',  packages: implicit  });

    if (installed.length > 0) {
      const signal = this._enrichAbort.signal;
      void this._enrichInstalledPackages(installed, signal);
    }
  }

  private async _refreshPackagesForProjects(projectPaths: string[]): Promise<void> {
    const concurrency = getConfig().enrichConcurrency;

    const installedResults: import('./types').InstalledPackage[][] = new Array(projectPaths.length);
    const implicitResults:  import('./types').ImplicitPackage[][]  = new Array(projectPaths.length);

    // One CLI call per project (--include-transitive covers both lists)
    await runWithConcurrency(
      projectPaths.map((p, i) => async () => {
        const { installed, implicit } = await this.backend.listAllForProject(p);
        installedResults[i] = installed;
        implicitResults[i]  = implicit;
      }),
      concurrency,
    );

    const installed = installedResults.flat();
    const implicit  = implicitResults.flat();

    // Send immediately — UI renders the list right away
    this.provider.postMessage({ type: 'INSTALLED_PACKAGES', packages: installed });
    this.provider.postMessage({ type: 'IMPLICIT_PACKAGES', packages: implicit });

    // Enrich in background — fire-and-forget, each update pushed individually
    if (installed.length > 0) {
      const signal = this._enrichAbort.signal;
      void this._enrichInstalledPackages(installed, signal);
    }
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

    if (needsFetch.length === 0) return;

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
