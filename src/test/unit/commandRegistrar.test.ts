import * as fs from 'fs/promises';
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
// eslint-disable-next-line @typescript-eslint/no-require-imports
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
    expect(result).toBe('/projects/My.sln');
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it('shows QuickPick when directory has multiple matches and returns selected', async () => {
    mockReaddir.mockResolvedValue(makeDirents(['App.csproj', 'Lib.csproj', 'readme.md']) as any);
    vscode.window.showQuickPick.mockResolvedValue({
      label: 'App.csproj',
      description: '/projects',
      fsPath: '/projects/App.csproj',
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
