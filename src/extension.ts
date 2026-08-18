import * as vscode from 'vscode';
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

  // ── Commands ───────────────────────────────────────────────────────────────
  const registrar = new CommandRegistrar(viewProvider, broker, solutionParser);
  registrar.register(context);

  context.subscriptions.push(
    viewProviderDisposable,
    { dispose: () => broker.detach() },
    { dispose: () => logger?.dispose() },
  );
}

export function deactivate(): void {
  logger?.dispose();
  logger = undefined;
}
