import * as vscode from 'vscode';
import { normalizeBlockedIds } from './blockedPackages';

const SECTION = 'averenium.nugetManager';
const BLOCKED_PACKAGES_KEY = 'blockedPackages';
const DOTNET_CONCURRENCY_KEY = 'dotnetConcurrency';
const DEFAULT_DOTNET_CONCURRENCY = 4;
const MIN_DOTNET_CONCURRENCY = 1;
const MAX_DOTNET_CONCURRENCY = 16;

function clampDotnetConcurrency(n: number): number {
  return Math.min(MAX_DOTNET_CONCURRENCY, Math.max(MIN_DOTNET_CONCURRENCY, Math.round(n)));
}

/** Max parallel `dotnet` processes (list, search, enrich, install, remove, restore). */
export function getDotnetConcurrency(): number {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const raw = cfg.get<number>(DOTNET_CONCURRENCY_KEY, DEFAULT_DOTNET_CONCURRENCY);
  return clampDotnetConcurrency(typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_DOTNET_CONCURRENCY);
}

/** Read current config values from VSCode settings (with defaults). */
export function getConfig() {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    dotnetConcurrency: getDotnetConcurrency(),
    cacheTtlMs: 5 * 60 * 1000, // 5 min — not user-configurable yet
    includePrerelease: cfg.get<boolean>('includePrerelease', false),
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
    /** Workspace-only block list (not User settings). */
    blockedPackages: getBlockedPackages(),
  };
}

/**
 * Package ids that must not change version in this workspace.
 * Reads Workspace / WorkspaceFolder only — User-level values are ignored.
 */
export function getBlockedPackages(): string[] {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const inspected = cfg.inspect<unknown>(BLOCKED_PACKAGES_KEY);
  const raw = inspected?.workspaceValue ?? inspected?.workspaceFolderValue ?? [];
  return normalizeBlockedIds(raw);
}

/** Add or remove an id in `.vscode/settings.json` (`ConfigurationTarget.Workspace`). */
export async function setPackageBlocked(packageId: string, blocked: boolean): Promise<string[]> {
  const id = packageId.trim();
  const current = getBlockedPackages();
  const next = blocked
    ? [...current.filter((existing) => existing.toLowerCase() !== id.toLowerCase()), id]
    : current.filter((existing) => existing.toLowerCase() !== id.toLowerCase());
  const cfg = vscode.workspace.getConfiguration(SECTION);
  await cfg.update(
    BLOCKED_PACKAGES_KEY,
    next,
    vscode.ConfigurationTarget.Workspace,
  );
  return normalizeBlockedIds(next);
}

/** Persist the prerelease flag to user settings. */
export async function setIncludePrerelease(value: boolean): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  await cfg.update('includePrerelease', value, vscode.ConfigurationTarget.Global);
}
