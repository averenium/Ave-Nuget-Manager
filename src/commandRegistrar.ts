import * as vscode from 'vscode';
import * as path from 'path';
import { shouldShowContextMenu } from './solutionParser';
import {
  scopeFromDotnetFile,
  scopeFromFolder,
  findDotnetTargetsInFolder,
  toProjectInfo,
  SOLUTION_EXTENSIONS,
  DOTNET_TARGET_EXTENSIONS,
} from './dotnetWorkspace';
import type { NugetManagerViewProvider } from './nugetManagerViewProvider';
import type { WebviewMessageBroker } from './webviewMessageBroker';
import type { SolutionParser } from './solutionParser';
import type { ProjectInfo } from './types';

/** Picked "manage all projects" instead of a single solution/project file. */
export interface FolderScopeTarget {
  kind: 'folder';
  folderPath: string;
  /** Already scanned while building the picker — passed through to skip a second scan. */
  projects: ProjectInfo[];
}

export type ResolvedTarget = string | FolderScopeTarget;

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
      vscode.commands.registerCommand('averenium.nugetManager.openSettings', () => {
        void vscode.commands.executeCommand(
          'workbench.action.openSettings',
          '@ext:averenium.averenium-nuget-manager',
        );
      }),
    );
  }

  // ─── Core handler ──────────────────────────────────────────────────────────

  private async _handleOpen(uri?: vscode.Uri): Promise<void> {
    let target: ResolvedTarget | undefined;

    if (uri) {
      target = await this._resolveTargetFromUri(uri);
    } else {
      target = await this._pickFromWorkspaceRoot();
    }

    if (!target) return;

    await this._openForTarget(target);
  }

  // ─── URI resolution ────────────────────────────────────────────────────────

  async resolveTargetFromUri(uri: vscode.Uri): Promise<ResolvedTarget | undefined> {
    return this._resolveTargetFromUri(uri);
  }

  private async _resolveTargetFromUri(uri: vscode.Uri): Promise<ResolvedTarget | undefined> {
    const fsPath = uri.fsPath;
    const ext = path.extname(fsPath).toLowerCase();

    // Direct file click — return immediately
    if (DOTNET_TARGET_EXTENSIONS.has(ext)) {
      return fsPath;
    }

    const matching = await findDotnetTargetsInFolder(fsPath);
    if (matching.length === 0) {
      // Show a helpful message instead of silently doing nothing
      await vscode.window.showWarningMessage(
        `Averenium NuGet Manager: No .sln, .slnx, .csproj, or .fsproj found in "${path.basename(fsPath)}".`,
      );
      return undefined;
    }
    return this._resolveFromMatches(matching, fsPath);
  }

  // ─── Workspace root picker ────────────────────────────────────────────────

  private async _pickFromWorkspaceRoot(): Promise<ResolvedTarget | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      await vscode.window.showErrorMessage(
        'Averenium NuGet Manager: No workspace folder is open.',
      );
      return undefined;
    }

    const rootPath = folders[0].uri.fsPath;
    const matching = await findDotnetTargetsInFolder(rootPath);
    if (matching.length === 0) {
      await vscode.window.showErrorMessage(
        'Averenium NuGet Manager: No .sln, .slnx, .csproj, or .fsproj files found in workspace root.',
      );
      return undefined;
    }
    return this._resolveFromMatches(matching, rootPath);
  }

  private async _resolveFromMatches(matching: string[], folderPath: string): Promise<ResolvedTarget | undefined> {
    if (matching.length === 1) return matching[0];
    return this._pickAmongMultiple(matching, folderPath, 'Select a solution or project to manage');
  }

  // ─── Multiple matches ──────────────────────────────────────────────────────

  /**
   * Multiple .sln/.csproj/.fsproj found in one folder. A single solution
   * wins outright; otherwise the user picks — with a "manage all projects"
   * option added when the folder has several loose projects and no solution
   * at all (the "folder without a solution" workspace scope).
   */
  private async _pickAmongMultiple(
    matching: string[],
    folderPath: string,
    placeholder: string,
  ): Promise<ResolvedTarget | undefined> {
    const solutions = matching.filter((p) =>
      SOLUTION_EXTENSIONS.has(path.extname(p).toLowerCase()),
    );
    if (solutions.length === 1) return solutions[0];

    const folderOption = solutions.length === 0 && matching.length > 1
      ? {
        folderPath,
        projects: matching
          .map((p) => toProjectInfo(folderPath, p))
          .sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
      }
      : undefined;

    return this._showQuickPick(matching, placeholder, folderOption);
  }

  // ─── QuickPick ────────────────────────────────────────────────────────────

  private async _showQuickPick(
    paths: string[],
    placeholder: string,
    folderOption?: { folderPath: string; projects: ProjectInfo[] },
  ): Promise<ResolvedTarget | undefined> {
    const items: Array<{ label: string; description: string; target: ResolvedTarget }> = paths.map((p) => ({
      label: path.basename(p),
      description: path.dirname(p),
      target: p,
    }));

    if (folderOption) {
      items.unshift({
        label: `$(folder-library) Manage all ${folderOption.projects.length} projects in this folder`,
        description: folderOption.folderPath,
        target: { kind: 'folder', folderPath: folderOption.folderPath, projects: folderOption.projects },
      });
    }

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: placeholder,
      matchOnDescription: true,
    });

    return selected?.target;
  }

  // ─── Open for resolved target ──────────────────────────────────────────────

  private async _openForTarget(target: ResolvedTarget): Promise<void> {
    const scope = typeof target === 'string'
      ? await scopeFromDotnetFile(target, this.solutionParser)
      : await scopeFromFolder(target.folderPath, target.projects);
    await this.viewProvider.reveal();
    await this.broker.activateScope(scope);
  }
}

export { shouldShowContextMenu };
