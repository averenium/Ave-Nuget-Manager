import * as vscode from 'vscode';
import {
  DOTNET_PROJECT_EXCLUDE_GLOB,
  DOTNET_PROJECT_GLOB,
  HAS_DOTNET_WORKSPACE_CONTEXT,
  hasDotnetWorkspaceFiles,
  refreshDotnetWorkspaceContext,
  watchDotnetWorkspaceContext,
  workspaceHasDotnetProject,
} from '../../dotnetWorkspace';

function folder(fsPath: string): vscode.WorkspaceFolder {
  return { uri: vscode.Uri.file(fsPath), name: 'repo', index: 0 };
}

function setWorkspaceFolders(folders: vscode.WorkspaceFolder[]): void {
  (vscode.workspace as { workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined }).workspaceFolders =
    folders;
}

function emptyContext(): vscode.ExtensionContext {
  return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('hasDotnetWorkspaceFiles', () => {
  it('is true when a solution or project file is listed', () => {
    expect(hasDotnetWorkspaceFiles(['readme.md', 'App.csproj'])).toBe(true);
    expect(hasDotnetWorkspaceFiles(['My.sln'])).toBe(true);
    expect(hasDotnetWorkspaceFiles(['Lib.fsproj'])).toBe(true);
    expect(hasDotnetWorkspaceFiles(['App.SLNX'])).toBe(true);
  });

  it('is false when none match', () => {
    expect(hasDotnetWorkspaceFiles(['package.json', 'src'])).toBe(false);
    expect(hasDotnetWorkspaceFiles([])).toBe(false);
  });
});

describe('workspaceHasDotnetProject', () => {
  beforeEach(() => {
    setWorkspaceFolders([]);
    (vscode.workspace.findFiles as jest.Mock).mockReset();
  });

  it('is false with no workspace folders and does not search', async () => {
    await expect(workspaceHasDotnetProject()).resolves.toBe(false);
    expect(vscode.workspace.findFiles).not.toHaveBeenCalled();
  });

  it('is false when findFiles returns nothing', async () => {
    setWorkspaceFolders([folder('/repo')]);
    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([]);
    await expect(workspaceHasDotnetProject()).resolves.toBe(false);
    expect(vscode.workspace.findFiles).toHaveBeenCalledWith(
      DOTNET_PROJECT_GLOB,
      DOTNET_PROJECT_EXCLUDE_GLOB,
      1,
    );
  });

  it('is true when a nested project file exists', async () => {
    setWorkspaceFolders([folder('/repo')]);
    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([
      vscode.Uri.file('/repo/src/App.csproj'),
    ]);
    await expect(workspaceHasDotnetProject()).resolves.toBe(true);
  });
});

describe('refreshDotnetWorkspaceContext', () => {
  beforeEach(() => {
    setWorkspaceFolders([folder('/repo')]);
    (vscode.workspace.findFiles as jest.Mock).mockReset();
    (vscode.commands.executeCommand as jest.Mock).mockClear();
  });

  it('sets the context key to false when nothing is found', async () => {
    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([]);
    await expect(refreshDotnetWorkspaceContext()).resolves.toBe(false);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'setContext',
      HAS_DOTNET_WORKSPACE_CONTEXT,
      false,
    );
  });

  it('sets the context key to true when a project is found', async () => {
    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([
      vscode.Uri.file('/repo/App.csproj'),
    ]);
    await expect(refreshDotnetWorkspaceContext()).resolves.toBe(true);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'setContext',
      HAS_DOTNET_WORKSPACE_CONTEXT,
      true,
    );
  });
});

describe('watchDotnetWorkspaceContext', () => {
  let onCreate: () => void;
  let onDelete: () => void;
  let onFolders: () => void;

  beforeEach(() => {
    onCreate = () => undefined;
    onDelete = () => undefined;
    onFolders = () => undefined;
    setWorkspaceFolders([folder('/repo')]);
    (vscode.workspace.findFiles as jest.Mock).mockReset();
    (vscode.commands.executeCommand as jest.Mock).mockClear();
    (vscode.workspace.createFileSystemWatcher as jest.Mock).mockReturnValue({
      onDidCreate: (fn: () => void) => {
        onCreate = fn;
        return new vscode.Disposable(() => undefined);
      },
      onDidDelete: (fn: () => void) => {
        onDelete = fn;
        return new vscode.Disposable(() => undefined);
      },
      onDidChange: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined,
    });
    (vscode.workspace.onDidChangeWorkspaceFolders as jest.Mock).mockImplementation(
      (fn: () => void) => {
        onFolders = fn;
        return new vscode.Disposable(() => undefined);
      },
    );
  });

  it('sets context on start and again when a matching file is created', async () => {
    (vscode.workspace.findFiles as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([vscode.Uri.file('/repo/src/App.csproj')]);

    const ctx = emptyContext();
    await watchDotnetWorkspaceContext(ctx);

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'setContext',
      HAS_DOTNET_WORKSPACE_CONTEXT,
      false,
    );

    onCreate();
    await flush();
    await flush();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'setContext',
      HAS_DOTNET_WORKSPACE_CONTEXT,
      true,
    );
  });

  it('re-scans after delete and folder changes', async () => {
    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([]);
    const ctx = emptyContext();
    await watchDotnetWorkspaceContext(ctx);
    (vscode.workspace.findFiles as jest.Mock).mockClear();

    onDelete();
    await flush();
    onFolders();
    await flush();

    expect(vscode.workspace.findFiles).toHaveBeenCalledTimes(2);
  });
});
