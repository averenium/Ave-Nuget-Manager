import * as vscode from 'vscode';
import {
  DOTNET_PROJECT_EXCLUDE_GLOB,
  DOTNET_PROJECT_GLOB,
  FOLDER_PROJECT_GLOB,
  HAS_DOTNET_WORKSPACE_CONTEXT,
  hasDotnetWorkspaceFiles,
  capFoundUris,
  findProjectsInFolder,
  listWorkspaceNuGetConfigFiles,
  NUGET_CONFIG_FIND_LIMIT,
  NUGET_CONFIG_GLOB,
  refreshDotnetWorkspaceContext,
  scopeFromDotnetFile,
  scopeFromFolder,
  sortDotnetTargetPaths,
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

describe('sortDotnetTargetPaths', () => {
  it('lists solutions before projects, then basename', () => {
    expect(sortDotnetTargetPaths([
      '/repo/src/B.csproj',
      '/repo/Z.sln',
      '/repo/src/A.csproj',
      '/repo/App.slnx',
    ])).toEqual([
      '/repo/App.slnx',
      '/repo/Z.sln',
      '/repo/src/A.csproj',
      '/repo/src/B.csproj',
    ]);
  });
});

describe('scopeFromDotnetFile', () => {
  it('builds solution scope from .sln', async () => {
    const parser = { getProjects: jest.fn().mockResolvedValue([{ name: 'A', relativePath: 'A.csproj', absolutePath: '/s/A.csproj' }]) };
    await expect(scopeFromDotnetFile('/s/App.sln', parser as never)).resolves.toEqual({
      kind: 'solution',
      solutionPath: '/s/App.sln',
      projects: [{ name: 'A', relativePath: 'A.csproj', absolutePath: '/s/A.csproj' }],
    });
  });

  it('builds project scope from .csproj', async () => {
    const parser = { getProjects: jest.fn() };
    await expect(scopeFromDotnetFile('/s/A.csproj', parser as never)).resolves.toEqual({
      kind: 'project',
      projectPath: '/s/A.csproj',
    });
    expect(parser.getProjects).not.toHaveBeenCalled();
  });
});

describe('findProjectsInFolder', () => {
  beforeEach(() => {
    (vscode.workspace.findFiles as jest.Mock).mockReset();
  });

  it('scopes the search with a RelativePattern rooted at the folder', async () => {
    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([]);
    await findProjectsInFolder('/repo/tools');
    const [pattern, exclude] = (vscode.workspace.findFiles as jest.Mock).mock.calls[0];
    expect(pattern).toEqual(new vscode.RelativePattern('/repo/tools', FOLDER_PROJECT_GLOB));
    expect(exclude).toBe(DOTNET_PROJECT_EXCLUDE_GLOB);
  });

  it('maps found files to ProjectInfo with folder-relative paths, sorted', async () => {
    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([
      vscode.Uri.file('/repo/tools/src/Tool.csproj'),
      vscode.Uri.file('/repo/tools/Lib/Lib.fsproj'),
    ]);
    const result = await findProjectsInFolder('/repo/tools');
    expect(result).toEqual([
      { name: 'Lib', relativePath: 'Lib/Lib.fsproj', absolutePath: '/repo/tools/Lib/Lib.fsproj' },
      { name: 'Tool', relativePath: 'src/Tool.csproj', absolutePath: '/repo/tools/src/Tool.csproj' },
    ]);
  });

  it('returns an empty list when nothing matches', async () => {
    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([]);
    await expect(findProjectsInFolder('/empty')).resolves.toEqual([]);
  });
});

describe('scopeFromFolder', () => {
  it('builds a folder scope from the discovered projects', async () => {
    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([
      vscode.Uri.file('/repo/tools/Tool.csproj'),
    ]);
    await expect(scopeFromFolder('/repo/tools')).resolves.toEqual({
      kind: 'folder',
      folderPath: '/repo/tools',
      projects: [{ name: 'Tool', relativePath: 'Tool.csproj', absolutePath: '/repo/tools/Tool.csproj' }],
    });
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

describe('capFoundUris / listWorkspaceNuGetConfigFiles', () => {
  beforeEach(() => {
    setWorkspaceFolders([]);
    (vscode.workspace.findFiles as jest.Mock).mockReset();
  });

  it('marks truncation when the list is over the limit', () => {
    expect(capFoundUris([1, 2, 3], 2)).toEqual({ items: [1, 2], truncated: true });
    expect(capFoundUris([1, 2], 2)).toEqual({ items: [1, 2], truncated: false });
  });

  it('passes maxResults to findFiles and reports truncated', async () => {
    setWorkspaceFolders([folder('/repo')]);
    const uris = Array.from({ length: NUGET_CONFIG_FIND_LIMIT + 1 }, (_, i) =>
      vscode.Uri.file(`/repo/p${i}/nuget.config`),
    );
    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue(uris);
    await expect(listWorkspaceNuGetConfigFiles()).resolves.toEqual({
      uris: uris.slice(0, NUGET_CONFIG_FIND_LIMIT),
      truncated: true,
    });
    expect(vscode.workspace.findFiles).toHaveBeenCalledWith(
      NUGET_CONFIG_GLOB,
      DOTNET_PROJECT_EXCLUDE_GLOB,
      NUGET_CONFIG_FIND_LIMIT + 1,
    );
  });
});
