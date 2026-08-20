import * as vscode from 'vscode';
import { getBlockedPackages, setPackageBlocked } from '../../config';

describe('blockedPackages setting', () => {
  const defaultConfig = () => ({
    get: jest.fn((key: string, defaultValue?: unknown) => defaultValue),
    update: jest.fn(() => Promise.resolve()),
    has: jest.fn(() => false),
    inspect: jest.fn(() => undefined),
  });

  afterEach(() => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReset();
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(defaultConfig);
  });

  it('reads Workspace value and ignores User', () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn(() => ['FromUser']),
      inspect: jest.fn(() => ({
        key: 'averenium.nugetManager.blockedPackages',
        defaultValue: [],
        globalValue: ['FromUser'],
        workspaceValue: ['Npgsql.EntityFrameworkCore.PostgreSQL'],
      })),
      update: jest.fn(),
    });
    expect(getBlockedPackages()).toEqual(['Npgsql.EntityFrameworkCore.PostgreSQL']);
  });

  it('writes Workspace settings when blocking an id', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((_k: string, d: unknown) => d),
      inspect: jest.fn(() => ({ workspaceValue: ['Already'] })),
      update,
    });
    const next = await setPackageBlocked('Newtonsoft.Json', true);
    expect(next).toEqual(['Already', 'Newtonsoft.Json']);
    expect(update).toHaveBeenCalledWith(
      'blockedPackages',
      ['Already', 'Newtonsoft.Json'],
      vscode.ConfigurationTarget.Workspace,
    );
  });

  it('removes an id on unblock', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((_k: string, d: unknown) => d),
      inspect: jest.fn(() => ({ workspaceValue: ['A', 'B'] })),
      update,
    });
    await setPackageBlocked('a', false);
    expect(update).toHaveBeenCalledWith(
      'blockedPackages',
      ['B'],
      vscode.ConfigurationTarget.Workspace,
    );
  });
});
