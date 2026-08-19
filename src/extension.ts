import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';
import { CliRunner } from './cliRunner';
import { CliBackend } from './backend/cliBackend';
import { SolutionParser } from './solutionParser';
import { NuGetConfigChainResolver } from './nugetConfigChainResolver';
import { NugetManagerViewProvider } from './nugetManagerViewProvider';
import { CommandRegistrar } from './commandRegistrar';
import { WebviewMessageBroker } from './webviewMessageBroker';

let logger: Logger | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // ── Core services ──────────────────────────────────────────────────────────
  logger = new Logger();
  const runner = new CliRunner(logger);
  const backend = new CliBackend(runner);
  const solutionParser = new SolutionParser();
  const configResolver = new NuGetConfigChainResolver();

  // ── Verify dotnet availability ─────────────────────────────────────────────
  try {
    await runner.checkDotnetAvailable();
  } catch {
    // Don't block activation — just send DOTNET_NOT_FOUND once the webview connects
    logger.logCliOperation({
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

  // ── View provider ──────────────────────────────────────────────────────────
  const viewProvider = new NugetManagerViewProvider(context.extensionUri);

  const viewProviderDisposable = vscode.window.registerWebviewViewProvider(
    NugetManagerViewProvider.viewId,
    viewProvider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );

  // ── Message broker ─────────────────────────────────────────────────────────
  const broker = new WebviewMessageBroker(
    viewProvider,
    backend,
    solutionParser,
    configResolver,
    logger,
  );
  broker.attach();

  // ── Reload webview when Vite rebuilds the bundle (watch mode) ────────────
  // fs.watch: vscode FileSystemWatcher often skips gitignored dist/
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleReload = () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => viewProvider.reloadHtml(), 200);
  };
  const webviewDir = path.join(context.extensionPath, 'dist', 'webview');
  let bundleWatcher: fs.FSWatcher | undefined;
  try {
    fs.mkdirSync(webviewDir, { recursive: true });
    bundleWatcher = fs.watch(webviewDir, (_event, filename) => {
      if (!filename) return;
      const name = filename.toString();
      if (name === 'bundle.js' || name === 'bundle.css') scheduleReload();
    });
  } catch {
    bundleWatcher = undefined;
  }

  // ── Commands ───────────────────────────────────────────────────────────────
  const registrar = new CommandRegistrar(viewProvider, broker, solutionParser);
  registrar.register(context);

  context.subscriptions.push(
    viewProviderDisposable,
    { dispose: () => bundleWatcher?.close() },
    { dispose: () => { if (reloadTimer) clearTimeout(reloadTimer); } },
    { dispose: () => broker.detach() },
    { dispose: () => logger?.dispose() },
  );
}

export function deactivate(): void {
  logger?.dispose();
  logger = undefined;
}
