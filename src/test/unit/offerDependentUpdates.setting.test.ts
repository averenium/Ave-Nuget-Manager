import * as vscode from 'vscode';
import { getConfig, setOfferDependentUpdates } from '../../config';

describe('offerDependentUpdates setting (#109)', () => {
  const configWith = (inspected: Record<string, unknown> | undefined, update = jest.fn().mockResolvedValue(undefined)) => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn((_k: string, d: unknown) => d),
      inspect: jest.fn(() => inspected),
      update,
      has: jest.fn(() => false),
    });
    return update;
  };

  afterEach(() => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReset();
  });

  it('is on when nothing has set it', () => {
    configWith(undefined);
    expect(getConfig().offerDependentUpdates).toBe(true);
  });

  it('writes the user settings when no workspace has a value: a standing personal preference', async () => {
    const update = configWith({ globalValue: true });
    await setOfferDependentUpdates(false);
    expect(update).toHaveBeenCalledWith('offerDependentUpdates', false, vscode.ConfigurationTarget.Global);
  });

  it('writes the workspace when it already has a value, which would win over the user settings', async () => {
    const update = configWith({ globalValue: true, workspaceValue: true });
    await setOfferDependentUpdates(false);
    expect(update).toHaveBeenCalledWith('offerDependentUpdates', false, vscode.ConfigurationTarget.Workspace);
  });

  it('writes the workspace folder when that is where the value is held', async () => {
    const update = configWith({ workspaceFolderValue: true });
    await setOfferDependentUpdates(false);
    expect(update).toHaveBeenCalledWith('offerDependentUpdates', false, vscode.ConfigurationTarget.WorkspaceFolder);
  });
});
