import * as vscode from 'vscode';
import * as path from 'path';
import { shouldShowContextMenu } from './solutionParser';
import type { SolutionParser } from './solutionParser';
import type { WorkspaceScope } from './types';
import { trueCaseFilePath } from './nugetConfigChainResolver';

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

/** Workspace nuget.config files (VS Code glob is case-insensitive on Windows). */
export const NUGET_CONFIG_GLOB = '**/nuget.config';

export const SOLUTION_EXTENSIONS = new Set(['.sln', '.slnx']);

/**
 * True if any listed name is a .NET solution or project file.
 * Same rule as {@link shouldShowContextMenu}; used to unit-test the predicate
 * without VS Code `findFiles`.
 */
export function hasDotnetWorkspaceFiles(names: string[]): boolean {
  return shouldShowContextMenu(names);
}

export function isSolutionFile(filePath: string): boolean {
  return SOLUTION_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Solutions first, then basename. */
export function sortDotnetTargetPaths(paths: string[]): string[] {
  return [...paths].sort((a, b) => {
    const aSol = isSolutionFile(a) ? 0 : 1;
    const bSol = isSolutionFile(b) ? 0 : 1;
    if (aSol !== bSol) return aSol - bSol;
    return path.basename(a).localeCompare(path.basename(b));
  });
}

export async function listWorkspaceDotnetFiles(): Promise<vscode.Uri[]> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return [];
  }
  return vscode.workspace.findFiles(DOTNET_PROJECT_GLOB, DOTNET_PROJECT_EXCLUDE_GLOB);
}

/** Cap for nuget.config workspace scans so a huge monorepo does not walk the tree unbounded. */
export const NUGET_CONFIG_FIND_LIMIT = 200;

export function capFoundUris<T>(found: readonly T[], limit = NUGET_CONFIG_FIND_LIMIT): {
  items: T[];
  truncated: boolean;
} {
  if (found.length > limit) return { items: found.slice(0, limit), truncated: true };
  return { items: [...found], truncated: false };
}

export async function listWorkspaceNuGetConfigFiles(): Promise<{ uris: vscode.Uri[]; truncated: boolean }> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return { uris: [], truncated: false };
  }
  const found = await vscode.workspace.findFiles(
    NUGET_CONFIG_GLOB,
    DOTNET_PROJECT_EXCLUDE_GLOB,
    NUGET_CONFIG_FIND_LIMIT + 1,
  );
  const capped = capFoundUris(found, NUGET_CONFIG_FIND_LIMIT);
  const uris = await Promise.all(capped.items.map(async (uri) => {
    const actual = await trueCaseFilePath(uri.fsPath);
    return actual === uri.fsPath ? uri : vscode.Uri.file(actual);
  }));
  return { uris, truncated: capped.truncated };
}

export async function scopeFromDotnetFile(
  targetPath: string,
  solutionParser: SolutionParser,
): Promise<WorkspaceScope> {
  if (isSolutionFile(targetPath)) {
    const projects = await solutionParser.getProjects(targetPath);
    return { kind: 'solution', solutionPath: targetPath, projects };
  }
  return { kind: 'project', projectPath: targetPath };
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
): Promise<boolean> {
  const has = await refreshDotnetWorkspaceContext();

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
  return has;
}
