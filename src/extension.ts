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

let logger: Logger | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  try {
    logger = new Logger();
    await activateCore(context, logger);
  } catch (err) {
    const text = formatUnknownError(err);
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
      appName: vscode.env.appName,
      vscodeVersion: vscode.version,
      os: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
    },
  );
  runner = new CliRunner(
    log,
    createConcurrencyGate(() => getConfig().dotnetConcurrency),
    trace,
  );
  const backend = new CliBackend(runner);
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
