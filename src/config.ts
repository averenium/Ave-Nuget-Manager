import * as vscode from 'vscode';

const SECTION = 'averenium.nugetManager';

/** Read current config values from VSCode settings (with defaults). */
export function getConfig() {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    enrichConcurrency: cfg.get<number>('enrichConcurrency', 4),
    cacheTtlMs: 5 * 60 * 1000, // 5 min — not user-configurable yet
    includePrerelease: cfg.get<boolean>('includePrerelease', true),
    /**
     * `rollback` — restore previous PackageReference after a failed add.
     * `keep` — leave the new version in the project file and offer a Rollback button.
     */
    onFailedUpdate: cfg.get<'rollback' | 'keep'>('onFailedUpdate', 'rollback'),
    /**
     * Path to a user script that emits extra `VulnerabilityFinding[]` as JSON.
     * Relative paths are resolved from the first workspace folder.
     */
    vulnerabilityScript: cfg.get<string>('vulnerabilityScript', ''),
  };
}

/** Persist the prerelease flag to user settings. */
export async function setIncludePrerelease(value: boolean): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  await cfg.update('includePrerelease', value, vscode.ConfigurationTarget.Global);
}
