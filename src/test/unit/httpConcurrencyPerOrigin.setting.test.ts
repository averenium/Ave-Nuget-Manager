import * as vscode from 'vscode';
import { getHttpConcurrencyPerOrigin } from '../../config';

describe('httpConcurrencyPerOrigin setting (#116)', () => {
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

  it('defaults to 6 — the number browsers settled on per host for HTTP/1.1', () => {
    expect(getHttpConcurrencyPerOrigin()).toBe(6);
  });

  it('reads the configured value', () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((_key: string, _def: number) => 12),
    });
    expect(getHttpConcurrencyPerOrigin()).toBe(12);
  });

  it('clamps to 1–32', () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn(() => 99),
    });
    expect(getHttpConcurrencyPerOrigin()).toBe(32);

    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn(() => 0),
    });
    expect(getHttpConcurrencyPerOrigin()).toBe(1);
  });
});
