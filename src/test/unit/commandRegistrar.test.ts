import * as fs from 'fs/promises';
import * as path from 'path';
import type { Dirent } from 'fs';
import { shouldShowContextMenu } from '../../solutionParser';

jest.mock('fs/promises');
const mockReaddir = fs.readdir as jest.MockedFunction<typeof fs.readdir>;

/** Helper — create a fake Dirent array for withFileTypes: true calls */
function makeDirents(names: string[]): Dirent[] {
  return names.map((name) => ({
    name,
    isFile: () => true,
    isDirectory: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    parentPath: '',
    path: '',
  } as unknown as Dirent));
}

// ── shouldShowContextMenu (re-exported from commandRegistrar) ─────────────────
// Tested here because CommandRegistrar delegates to it for directory filtering.

describe('shouldShowContextMenu (via solutionParser)', () => {
  it('true when .sln is present', () => {
    expect(shouldShowContextMenu(['readme.md', 'My.sln'])).toBe(true);
  });
  it('true when .csproj is present', () => {
    expect(shouldShowContextMenu(['App.csproj'])).toBe(true);
  });
  it('true when .fsproj is present', () => {
    expect(shouldShowContextMenu(['Lib.fsproj'])).toBe(true);
  });
  it('true when .slnx is present', () => {
    expect(shouldShowContextMenu(['MySol.slnx'])).toBe(true);
  });
  it('false when only non-solution files', () => {
    expect(shouldShowContextMenu(['package.json', 'src'])).toBe(false);
  });
  it('false for empty directory', () => {
    expect(shouldShowContextMenu([])).toBe(false);
  });
});

// ── CommandRegistrar.resolveTargetFromUri ─────────────────────────────────────
// We test the pure URI-resolution logic by constructing the registrar with
// minimal stubs for its dependencies.

import { CommandRegistrar } from '../../commandRegistrar';
import { SolutionParser } from '../../solutionParser';

// Minimal stubs — we only need resolveTargetFromUri logic here.
const vscode = require('vscode');

function makeRegistrar() {
  const viewProvider = {
    setScope: jest.fn(),
    getCurrentScope: jest.fn(),
    postMessage: jest.fn(),
    onDidReceiveMessage: jest.fn(),
    setOnViewReady: jest.fn(),
      isVisible: false,
      resolveWebviewView: jest.fn(),
      markClientReady: jest.fn(),
      isClientReady: false,
  } as any;

  const broker = {
    activateScope: jest.fn().mockResolvedValue(undefined),
    attach: jest.fn(),
    detach: jest.fn(),
  } as any;

  const solutionParser = new SolutionParser();
  return new CommandRegistrar(viewProvider, broker, solutionParser);
}

describe('CommandRegistrar.resolveTargetFromUri', () => {
  beforeEach(() => {
    mockReaddir.mockReset();
    vscode.window.showQuickPick.mockReset();
  });

  it('returns path directly for a .sln file URI', async () => {
    const registrar = makeRegistrar();
    const uri = vscode.Uri.file('/projects/My.sln');
    const result = await registrar.resolveTargetFromUri(uri);
    expect(result).toBe('/projects/My.sln');
  });

  it('returns path directly for a .csproj file URI', async () => {
    const registrar = makeRegistrar();
    const uri = vscode.Uri.file('/projects/App/App.csproj');
    const result = await registrar.resolveTargetFromUri(uri);
    expect(result).toBe('/projects/App/App.csproj');
  });

  it('returns path directly for a .fsproj file URI', async () => {
    const registrar = makeRegistrar();
    const uri = vscode.Uri.file('/lib/Lib.fsproj');
    const result = await registrar.resolveTargetFromUri(uri);
    expect(result).toBe('/lib/Lib.fsproj');
  });

  it('returns undefined for a directory with no solution files', async () => {
    mockReaddir.mockResolvedValue(makeDirents(['readme.md', 'src']) as any);
    const registrar = makeRegistrar();
    const uri = vscode.Uri.file('/empty-dir');
    const result = await registrar.resolveTargetFromUri(uri);
    expect(result).toBeUndefined();
  });

  it('returns the single file without QuickPick when directory has exactly one match', async () => {
    mockReaddir.mockResolvedValue(makeDirents(['My.sln', 'readme.md']) as any);
    const registrar = makeRegistrar();
    const uri = vscode.Uri.file('/projects');
    const result = await registrar.resolveTargetFromUri(uri);
    expect(result).toBe(path.join('/projects', 'My.sln'));
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it('shows QuickPick when directory has multiple matches and returns selected', async () => {
    mockReaddir.mockResolvedValue(makeDirents(['App.csproj', 'Lib.csproj', 'readme.md']) as any);
    vscode.window.showQuickPick.mockResolvedValue({
      label: 'App.csproj',
      description: '/projects',
      target: '/projects/App.csproj',
    });
    const registrar = makeRegistrar();
    const uri = vscode.Uri.file('/projects');
    const result = await registrar.resolveTargetFromUri(uri);
    expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
    expect(result).toBe('/projects/App.csproj');
  });

  it('returns undefined when user cancels QuickPick', async () => {
    mockReaddir.mockResolvedValue(makeDirents(['App.csproj', 'Lib.csproj']) as any);
    vscode.window.showQuickPick.mockResolvedValue(undefined);
    const registrar = makeRegistrar();
    const uri = vscode.Uri.file('/projects');
    const result = await registrar.resolveTargetFromUri(uri);
    expect(result).toBeUndefined();
  });

  it('offers a "manage all projects" option when multiple projects and no solution exist', async () => {
    mockReaddir.mockResolvedValue(makeDirents(['App.csproj', 'Lib.csproj', 'Tools.csproj']) as any);
    vscode.window.showQuickPick.mockImplementation((items: any[]) => Promise.resolve(items[0]));
    const registrar = makeRegistrar();
    const uri = vscode.Uri.file('/projects');
    const result = await registrar.resolveTargetFromUri(uri);

    const call = vscode.window.showQuickPick.mock.calls[0][0];
    const expectedProjects = [
      { name: 'App', relativePath: 'App.csproj', absolutePath: path.join('/projects', 'App.csproj') },
      { name: 'Lib', relativePath: 'Lib.csproj', absolutePath: path.join('/projects', 'Lib.csproj') },
      { name: 'Tools', relativePath: 'Tools.csproj', absolutePath: path.join('/projects', 'Tools.csproj') },
    ];
    expect(call[0]).toEqual({
      label: '$(folder-library) Manage all 3 projects in this folder',
      description: '/projects',
      target: { kind: 'folder', folderPath: '/projects', projects: expectedProjects },
    });
    expect(result).toEqual({ kind: 'folder', folderPath: '/projects', projects: expectedProjects });
  });

  it('does not offer "manage all projects" when a single solution is also present', async () => {
    mockReaddir.mockResolvedValue(
      makeDirents(['App.csproj', 'Lib.csproj', 'My.sln']) as any,
    );
    const registrar = makeRegistrar();
    const uri = vscode.Uri.file('/projects');
    const result = await registrar.resolveTargetFromUri(uri);

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(result).toBe(path.join('/projects', 'My.sln'));
  });

  // ── Recursive fallback: nothing directly in the clicked folder ────────────
  // The common "one subfolder per project" layout — e.g. Root/ServiceA/A.csproj,
  // Root/ServiceB/B.csproj — has zero .csproj/.sln directly under Root.

  it('falls back to a recursive scan when the folder has no direct matches', async () => {
    mockReaddir.mockResolvedValue(makeDirents(['README.md']) as any);
    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([
      vscode.Uri.file('/root/ServiceA/A.csproj'),
    ]);
    const registrar = makeRegistrar();
    const uri = vscode.Uri.file('/root');
    const result = await registrar.resolveTargetFromUri(uri);

    expect(result).toBe('/root/ServiceA/A.csproj');
  });

  it('offers "manage all projects" for a recursively-found set with no .sln', async () => {
    mockReaddir.mockResolvedValue(makeDirents([]) as any);
    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([
      vscode.Uri.file('/root/ServiceA/A.csproj'),
      vscode.Uri.file('/root/ServiceB/B.csproj'),
    ]);
    vscode.window.showQuickPick.mockImplementation((items: any[]) => Promise.resolve(items[0]));
    const registrar = makeRegistrar();
    const uri = vscode.Uri.file('/root');
    const result = await registrar.resolveTargetFromUri(uri);

    expect(result).toEqual({
      kind: 'folder',
      folderPath: '/root',
      projects: [
        { name: 'A', relativePath: 'ServiceA/A.csproj', absolutePath: '/root/ServiceA/A.csproj' },
        { name: 'B', relativePath: 'ServiceB/B.csproj', absolutePath: '/root/ServiceB/B.csproj' },
      ],
    });
  });

  it('prefers a single recursively-found .sln over the loose projects beside it', async () => {
    mockReaddir.mockResolvedValue(makeDirents([]) as any);
    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([
      vscode.Uri.file('/root/ServiceA/A.csproj'),
      vscode.Uri.file('/root/nested/My.sln'),
    ]);
    const registrar = makeRegistrar();
    const uri = vscode.Uri.file('/root');
    const result = await registrar.resolveTargetFromUri(uri);

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(result).toBe('/root/nested/My.sln');
  });

  it('warns when neither direct children nor a recursive scan find anything', async () => {
    mockReaddir.mockResolvedValue(makeDirents(['README.md']) as any);
    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([]);
    const registrar = makeRegistrar();
    const uri = vscode.Uri.file('/root');
    const result = await registrar.resolveTargetFromUri(uri);

    expect(result).toBeUndefined();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('No .sln, .slnx, .csproj, or .fsproj found in "root"'),
    );
  });
});

describe('CommandRegistrar.openSettings', () => {
  beforeEach(() => {
    vscode.commands.registerCommand.mockClear();
    vscode.commands.executeCommand.mockClear();
  });

  it('opens Settings UI filtered to this extension', () => {
    const registrar = makeRegistrar();
    registrar.register({ subscriptions: [] } as any);
    const call = vscode.commands.registerCommand.mock.calls.find(
      ([id]: [string]) => id === 'averenium.nugetManager.openSettings',
    );
    expect(call).toBeDefined();
    call[1]();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'workbench.action.openSettings',
      '@ext:averenium.averenium-nuget-manager',
    );
  });
});
