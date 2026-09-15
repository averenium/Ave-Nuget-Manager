import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger, formatUnknownError } from './logger';
import { CliRunner } from './cliRunner';
import { CliBackend } from './backend/cliBackend';
import { SolutionParser } from './solutionParser';
import { NuGetConfigChainResolver } from './nugetConfigChainResolver';
import { NugetManagerViewProvider } from './nugetManagerViewProvider';
import { CommandRegistrar } from './commandRegistrar';
import { WebviewMessageBroker } from './webviewMessageBroker';
import { watchDotnetWorkspaceContext } from './dotnetWorkspace';
import { createConcurrencyGate } from './concurrency';
import { getConfig } from './config';
import { registerAgentSkillCommand, installAgentSkill, updateOutdatedAgentSkills, readSkillStatus } from './agentSkillInstall';
import { TraceController } from './traceController';
import { RoslynSdkProbe } from './roslynSdkProbe';
import { HttpCatalogBackend } from './backend/httpCatalogBackend';
import { createConfigSourceResolver } from './backend/httpSourceResolver';
import { SourceCapabilityStore, capabilityStorage } from './nugetSourceCapabilities';
import { VersionLadder } from './nugetVersionLadder';
import { PackageSearch } from './nugetSearch';
import { VulnerabilityDatabase } from './nugetVulnerabilityDatabase';
import { vdbFileStore } from './nugetVdbFileStore';
import { isHttpPackageUrl } from './vulnerabilityScanPolicy';
import { expandNuGetConfigValue } from './nugetConfigEnv';
import { createJsonFetcher, DEFAULT_PREVIEW_BYTES } from './nugetHttpJson';
import { authorizingFetcher, CredentialRegistry } from './nugetHttpAuth';
import { ProxyRegistry } from './nugetProxyRegistry';
import { httpLogSink, loggingFetcher } from './nugetHttpLog';
import { HttpResponseCache } from './nugetHttpCache';
import { NuspecReader } from './nugetNuspecFetch';
import { retryingFetcher } from './nugetHttpRetry';

let logger: Logger | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  try {
    logger = new Logger();
    await activateCore(context, logger);
  } catch (err) {
    try {
      console.error('[AVE NuGet Manager] activate failed', err);
    } catch { /* ignore */ }
    logger?.error('activate failed', err);
    logger?.show();
    void vscode.window.showErrorMessage(
      `AVE NuGet Manager failed to start: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

async function activateCore(context: vscode.ExtensionContext, log: Logger): Promise<void> {
  const version = readExtensionVersion(context.extensionPath);
  const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  log.info(`activate start v${version} ${vscode.env.appName} ${vscode.version} ${os.platform()}/${os.arch()}`);
  log.info(`folders: ${folders.length ? folders.join(' | ') : '(none)'}`);

  const hasDotnet = await watchDotnetWorkspaceContext(context);
  log.info(`workspace context hasDotnetProject=${hasDotnet}`);

  const configResolver = new NuGetConfigChainResolver();
  const viewProvider = new NugetManagerViewProvider(context.extensionUri, log);

  const storageRoot = context.globalStorageUri.fsPath;
  fs.mkdirSync(storageRoot, { recursive: true });
  log.info(`globalStorage: ${storageRoot}`);

  let runner!: CliRunner;
  const trace = new TraceController(
    storageRoot,
    log,
    viewProvider,
    configResolver,
    () => viewProvider.getCurrentScope() ?? undefined,
    () => runner.checkDotnetAvailable(),
    {
      extensionVersion: version,
      // Which build this is. The version alone cannot say: a debug run reads the
      // repository's own package.json, so a development host reports whatever
      // the working tree was last released as — which reads as the installed
      // extension and sends the reader looking for a bug in the wrong build.
      extensionMode: vscode.ExtensionMode[context.extensionMode],
      appName: vscode.env.appName,
      vscodeVersion: vscode.version,
      os: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
    },
  );
  // The trace is fed by the call sites that make calls — `dotnet`, HTTP, webview
  // messages — so it recorded work that happened and nothing about work that was
  // skipped. The extension's own account of its decisions ("answered from
  // cache", "scan skipped", "falling back to the CLI") lived only on the Log
  // tab, which is not what anyone takes to investigate (#114).
  context.subscriptions.push(log.subscribe((entry) => trace.recordLogEntry(entry)));
  runner = new CliRunner(
    log,
    createConcurrencyGate(() => getConfig().dotnetConcurrency),
    trace,
  );
  // The HTTP catalog (#27) wraps the CLI backend rather than replacing it: with
  // the experimental setting off — its default — every call passes straight
  // through, so the extension behaves exactly as it did before.
  // Credentials are read while the configuration is resolved and attached only
  // to requests to the origin they belong to (#27). Sources needing none are
  // unaffected; a source whose sign-in method this cannot express answers 401
  // and its work falls back to the CLI.
  const credentials = new CredentialRegistry();
  // Logging sits inside the credential wrapper: it sees that a request carried
  // a credential without ever seeing the credential.
  const httpLog = httpLogSink(log, trace);
  // Bodies are kept small until a trace is recording, and only then grow enough
  // to be worth reading — a trace taken to investigate the HTTP path must
  // contain the HTTP path (#27, #23).
  // A proxy declared in nuget.config outranks the editor setting, and the
  // editor cannot execute it for us — so the transport carries it (#27).
  const proxies = new ProxyRegistry();
  const httpTransport = createJsonFetcher(
    () => (trace.isRecording() ? 256 * 1024 : DEFAULT_PREVIEW_BYTES),
    (url) => proxies.routeFor(url),
  );
  // The cache sits outermost, so a repeat inside the window reaches neither the
  // log nor the network: three consumers want the same metadata document, and
  // two configuration files can enable the same feed.
  const httpCache = new HttpResponseCache({ log: httpLog });
  // Order matters: the cache answers repeats first; credentials are attached
  // before a request goes out; the retry sits above the log so every attempt is
  // visible, not just the one that succeeded.
  const httpFetch = httpCache.wrap(
    authorizingFetcher(retryingFetcher(loggingFetcher(httpTransport, httpLog)), credentials),
  );
  const capabilities = new SourceCapabilityStore(
    httpFetch,
    capabilityStorage(context.globalState),
  );
  const resolveSources = createConfigSourceResolver(credentials, proxies);
  const backend = new HttpCatalogBackend(
    new CliBackend(runner),
    new VersionLadder(capabilities, httpFetch, { log: httpLog }),
    capabilities,
    resolveSources,
    { search: new PackageSearch(capabilities, httpFetch, { log: httpLog }) },
  );
  // The licence of a version nobody has installed (#89). Reached only when the
  // catalog states none, which is the single case its metadata cannot settle.
  const nuspecs = new NuspecReader(capabilities, httpFetch);
  const vulnerabilityDatabase = new VulnerabilityDatabase(
    capabilities,
    httpFetch,
    vdbFileStore(path.join(context.globalStorageUri.fsPath, 'vdb')),
    undefined,
    httpLog,
  );
  const solutionParser = new SolutionParser();
  const roslynProbe = new RoslynSdkProbe(runner);

  const viewProviderDisposable = vscode.window.registerWebviewViewProvider(
    NugetManagerViewProvider.viewId,
    viewProvider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );
  log.info(`registered view ${NugetManagerViewProvider.viewId}`);

  const broker = new WebviewMessageBroker(
    viewProvider,
    backend,
    solutionParser,
    configResolver,
    log,
    async () => {
      try {
        await runner.checkDotnetAvailable();
      } catch {
        log.logCliOperation({
          timestamp: new Date(),
          command: 'dotnet --version',
          args: ['--version'],
          stdout: '',
          stderr: '.NET SDK not found in PATH',
          exitCode: null,
          timedOut: false,
          durationMs: 0,
        });
      }
    },
    trace,
    {
      readStatus: () => readSkillStatus({
        extensionPath: context.extensionPath,
        workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      }),
      install: (opts) => opts?.updateExisting
        ? updateOutdatedAgentSkills(context)
        : installAgentSkill(context),
    },
    roslynProbe,
    {
      // Consulted only when NuGet's own cache held nothing (#27). The database
      // is normally on a different host from the package source and may be
      // named only by an audit source, so both lists are offered as configured
      // origins — otherwise an ordinary corporate setup would look like an
      // address nobody asked for.
      fromDatabase: (sources, installed, implicit, signal) => {
        const urls = [...sources.packageSources, ...sources.auditSources]
          .map((source) => expandNuGetConfigValue(source.url).trim())
          .filter((url) => isHttpPackageUrl(url));
        const targets = urls.map((url) => ({ url, knownOrigins: urls }));
        return vulnerabilityDatabase.findings(targets, installed, implicit, signal);
      },
    },
    {
      invalidate: () => {
        httpCache.clear();
        credentials.clear();
        proxies.clear();
        nuspecs.clear();
        capabilities.forgetAll();
      },
    },
    {
      // One config file at a time, as everywhere else: the sources a file
      // enables are the ones that may be asked about a package it resolves.
      forVersion: async (packageId, version, configFiles, signal) => {
        for (const configFile of configFiles) {
          const { targets } = await resolveSources(configFile);
          for (const target of targets) {
            const license = await nuspecs.license(target, packageId, version, signal);
            if (license) return license;
          }
        }
        return undefined;
      },
    },
  );
  broker.attach();
  log.info('broker attached');

  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleReload = () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => viewProvider.reloadHtml(), 200);
  };
  const webviewDir = path.join(context.extensionPath, 'dist', 'webview');
  const bundleJs = path.join(webviewDir, 'bundle.js');
  log.info(`webview bundle ${fs.existsSync(bundleJs) ? 'ok' : 'MISSING'}: ${bundleJs}`);
  // Development only. The watcher exists so `vite build --watch` rewriting the
  // bundle reloads the panel without restarting the host; in an installed
  // extension the bundle cannot change while the host runs, so the watch is
  // pure cost — and on Linux it spends an inotify handle that a busy machine
  // may not have, which surfaced as an activation error (#95).
  let bundleWatcher: fs.FSWatcher | undefined;
  if (context.extensionMode === vscode.ExtensionMode.Development) {
    try {
      fs.mkdirSync(webviewDir, { recursive: true });
      bundleWatcher = fs.watch(webviewDir, (_event, filename) => {
        if (!filename) return;
        const name = filename.toString();
        if (name === 'bundle.js' || name === 'bundle.css') scheduleReload();
      });
    } catch (err) {
      // Losing hot reload costs a manual reload, nothing else — not an error.
      log.info(`webview bundle watcher unavailable, hot reload off: ${formatUnknownError(err)}`);
      bundleWatcher = undefined;
    }
  }

  const registrar = new CommandRegistrar(viewProvider, broker, solutionParser);
  registrar.register(context);
  registerAgentSkillCommand(context, () => broker.postSkillStatus());
  trace.register(context);
  void trace.recoverOrphan();
  log.info('commands registered');

  context.subscriptions.push(
    viewProviderDisposable,
    { dispose: () => bundleWatcher?.close() },
    { dispose: () => { if (reloadTimer) clearTimeout(reloadTimer); } },
    { dispose: () => broker.detach() },
    { dispose: () => logger?.dispose() },
  );
  log.info('activate done');
}

export function deactivate(): void {
  logger?.info('deactivate');
  logger?.dispose();
  logger = undefined;
}

function readExtensionVersion(extensionPath: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(extensionPath, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
