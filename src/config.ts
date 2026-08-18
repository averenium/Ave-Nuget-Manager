import * as vscode from 'vscode';

const SECTION = 'averenium.nugetManager';

/** Read current config values from VSCode settings (with defaults). */
export function getConfig() {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    enrichConcurrency: cfg.get<number>('enrichConcurrency', 4),
    cacheTtlMs: 5 * 60 * 1000, // 5 min — not user-configurable yet
    includePrerelease: cfg.get<boolean>('includePrerelease', true),
  };
}

/** Persist the prerelease flag to user settings. */
export async function setIncludePrerelease(value: boolean): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  await cfg.update('includePrerelease', value, vscode.ConfigurationTarget.Global);
}
