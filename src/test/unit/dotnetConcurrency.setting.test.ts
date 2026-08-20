import * as vscode from 'vscode';
import { getDotnetConcurrency } from '../../config';

describe('dotnetConcurrency setting', () => {
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

  it('defaults to 4', () => {
    expect(getDotnetConcurrency()).toBe(4);
  });

  it('reads the configured value', () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((_key: string, _def: number) => 8),
    });
    expect(getDotnetConcurrency()).toBe(8);
  });

  it('clamps to 1–16', () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn(() => 99),
    });
    expect(getDotnetConcurrency()).toBe(16);

    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn(() => 0),
    });
    expect(getDotnetConcurrency()).toBe(1);
  });
});
