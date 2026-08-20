import * as vscode from 'vscode';
import { shouldShowContextMenu } from './solutionParser';

/** Context key for the NuGet panel view `when` clause. Set during activate(). */
export const HAS_DOTNET_WORKSPACE_CONTEXT = 'averenium.nugetManager.hasDotnetWorkspace';

/**
 * `workspaceContains` is an activation event, not a when-clause context key.
 * Visibility uses this module's setContext after VS Code activates us.
 */

/** Recursive glob: solution/project files anywhere in the workspace. */
export const DOTNET_PROJECT_GLOB = '**/*.{sln,slnx,csproj,fsproj}';

/** Skip restore output, git metadata, and JS deps when probing the workspace. */
export const DOTNET_PROJECT_EXCLUDE_GLOB = '{**/node_modules/**,**/bin/**,**/obj/**,**/.git/**}';

/**
 * True if any listed name is a .NET solution or project file.
 * Same rule as {@link shouldShowContextMenu}; used to unit-test the predicate
 * without VS Code `findFiles`.
 */
export function hasDotnetWorkspaceFiles(names: string[]): boolean {
  return shouldShowContextMenu(names);
}

export async function workspaceHasDotnetProject(): Promise<boolean> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return false;
  }

  const found = await vscode.workspace.findFiles(
    DOTNET_PROJECT_GLOB,
    DOTNET_PROJECT_EXCLUDE_GLOB,
    1,
  );
  return found.length > 0;
}

export async function refreshDotnetWorkspaceContext(): Promise<boolean> {
  const has = await workspaceHasDotnetProject();
  await vscode.commands.executeCommand('setContext', HAS_DOTNET_WORKSPACE_CONTEXT, has);
  return has;
}

/**
 * Sets the panel visibility context, then keeps it in sync when matching files
 * appear/disappear or workspace folders change.
 */
export async function watchDotnetWorkspaceContext(
  context: vscode.ExtensionContext,
): Promise<void> {
  await refreshDotnetWorkspaceContext();

  const run = (): void => {
    void refreshDotnetWorkspaceContext();
  };

  const watcher = vscode.workspace.createFileSystemWatcher(DOTNET_PROJECT_GLOB);
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(run),
    watcher.onDidDelete(run),
    vscode.workspace.onDidChangeWorkspaceFolders(run),
  );
}
