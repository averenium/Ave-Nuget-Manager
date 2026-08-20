import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { shouldShowContextMenu } from './solutionParser';
import { scopeFromDotnetFile } from './dotnetWorkspace';
import type { NugetManagerViewProvider } from './nugetManagerViewProvider';
import type { WebviewMessageBroker } from './webviewMessageBroker';
import type { SolutionParser } from './solutionParser';

const SOLUTION_EXTENSIONS = new Set(['.sln', '.slnx']);
const ALL_EXTENSIONS = new Set(['.sln', '.slnx', '.csproj', '.fsproj']);

export class CommandRegistrar {
  constructor(
    private readonly viewProvider: NugetManagerViewProvider,
    private readonly broker: WebviewMessageBroker,
    private readonly solutionParser: SolutionParser,
  ) {}

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        'averenium.nugetManager.open',
        async (uri?: vscode.Uri) => {
          await this._handleOpen(uri);
        },
      ),
      vscode.commands.registerCommand('averenium.nugetManager.openInEditor', async () => {
        await this.viewProvider.openInEditor(false);
      }),
      vscode.commands.registerCommand('averenium.nugetManager.openInNewWindow', async () => {
        await this.viewProvider.openInEditor(true);
      }),
    );
  }

  // ─── Core handler ──────────────────────────────────────────────────────────

  private async _handleOpen(uri?: vscode.Uri): Promise<void> {
    let targetPath: string | undefined;

    if (uri) {
      targetPath = await this._resolveTargetFromUri(uri);
    } else {
      targetPath = await this._pickFromWorkspaceRoot();
    }

    if (!targetPath) return;

    await this._openForPath(targetPath);
  }

  // ─── URI resolution ────────────────────────────────────────────────────────

  async resolveTargetFromUri(uri: vscode.Uri): Promise<string | undefined> {
    return this._resolveTargetFromUri(uri);
  }

  private async _resolveTargetFromUri(uri: vscode.Uri): Promise<string | undefined> {
    const fsPath = uri.fsPath;
    const ext = path.extname(fsPath).toLowerCase();

    // Direct file click — return immediately
    if (ALL_EXTENSIONS.has(ext)) {
      return fsPath;
    }

    // Directory click — list direct children (non-recursive, as per requirements)
    let entries: string[];
    try {
      const dirents = await fs.readdir(fsPath, { withFileTypes: true });
      // Only consider actual files, not subdirectories
      entries = dirents
        .filter((d) => d.isFile())
        .map((d) => d.name);
    } catch {
      return undefined;
    }

    const matching = entries
      .filter((name) => ALL_EXTENSIONS.has(path.extname(name).toLowerCase()))
      .map((name) => path.join(fsPath, name));

    if (matching.length === 0) {
      // Show a helpful message instead of silently doing nothing
      await vscode.window.showWarningMessage(
        `Averenium NuGet Manager: No .sln, .slnx, .csproj, or .fsproj found directly in "${path.basename(fsPath)}".`,
      );
      return undefined;
    }

    if (matching.length === 1) return matching[0];

    // Multiple matches — prefer a single solution if present
    const solutions = matching.filter((p) =>
      SOLUTION_EXTENSIONS.has(path.extname(p).toLowerCase()),
    );
    if (solutions.length === 1) return solutions[0];

    // Otherwise let user pick
    return this._showQuickPick(matching, 'Select a solution or project to manage');
  }

  // ─── Workspace root picker ────────────────────────────────────────────────

  private async _pickFromWorkspaceRoot(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      await vscode.window.showErrorMessage(
        'Averenium NuGet Manager: No workspace folder is open.',
      );
      return undefined;
    }

    const rootPath = folders[0].uri.fsPath;
    let entries: string[];
    try {
      const dirents = await fs.readdir(rootPath, { withFileTypes: true });
      entries = dirents.filter((d) => d.isFile()).map((d) => d.name);
    } catch {
      return undefined;
    }

    const matching = entries
      .filter((name) => ALL_EXTENSIONS.has(path.extname(name).toLowerCase()))
      .map((name) => path.join(rootPath, name));

    if (matching.length === 0) {
      await vscode.window.showErrorMessage(
        'Averenium NuGet Manager: No .sln, .slnx, .csproj, or .fsproj files found in workspace root.',
      );
      return undefined;
    }

    if (matching.length === 1) return matching[0];

    const solutions = matching.filter((p) =>
      SOLUTION_EXTENSIONS.has(path.extname(p).toLowerCase()),
    );
    if (solutions.length === 1) return solutions[0];

    return this._showQuickPick(matching, 'Select a solution or project to manage');
  }

  // ─── QuickPick ────────────────────────────────────────────────────────────

  private async _showQuickPick(
    paths: string[],
    placeholder: string,
  ): Promise<string | undefined> {
    const items = paths.map((p) => ({
      label: path.basename(p),
      description: path.dirname(p),
      fsPath: p,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: placeholder,
      matchOnDescription: true,
    });

    return selected?.fsPath;
  }

  // ─── Open for resolved path ───────────────────────────────────────────────

  private async _openForPath(targetPath: string): Promise<void> {
    const scope = await scopeFromDotnetFile(targetPath, this.solutionParser);
    await this.viewProvider.reveal();
    await this.broker.activateScope(scope);
  }
}

export { shouldShowContextMenu };
