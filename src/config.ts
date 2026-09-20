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

const HTTP_CONCURRENCY_KEY = 'httpConcurrencyPerOrigin';
/**
 * The number the web settled on: browsers cap HTTP/1.1 at six connections per
 * host, and this transport is HTTP/1.1 too (#116).
 */
const DEFAULT_HTTP_CONCURRENCY_PER_ORIGIN = 6;
const MIN_HTTP_CONCURRENCY_PER_ORIGIN = 1;
const MAX_HTTP_CONCURRENCY_PER_ORIGIN = 32;

function clampHttpConcurrencyPerOrigin(n: number): number {
  return Math.min(MAX_HTTP_CONCURRENCY_PER_ORIGIN, Math.max(MIN_HTTP_CONCURRENCY_PER_ORIGIN, Math.round(n)));
}

/**
 * Max parallel HTTP requests to one origin (#27's catalog: versions, search,
 * metadata, capability probes). Separate from `dotnetConcurrency`, which
 * governs `dotnet` process spawns and stays at its own default regardless of
 * this one — an HTTP request holds no process slot and costs the machine
 * nothing like what a process does, so the two were never the same limit
 * wearing two names, only ever sharing one setting because HTTP had none of
 * its own.
 */
export function getHttpConcurrencyPerOrigin(): number {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const raw = cfg.get<number>(HTTP_CONCURRENCY_KEY, DEFAULT_HTTP_CONCURRENCY_PER_ORIGIN);
  return clampHttpConcurrencyPerOrigin(
    typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_HTTP_CONCURRENCY_PER_ORIGIN,
  );
}

/** Read current config values from VSCode settings (with defaults). */
export function getConfig() {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    dotnetConcurrency: getDotnetConcurrency(),
    httpConcurrencyPerOrigin: getHttpConcurrencyPerOrigin(),
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
    /**
     * Experimental HTTP catalog (#27). Off by default: every catalog operation
     * keeps its CLI path, and each HTTP step falls back to it, so switching
     * this off returns the extension to exactly its previous behaviour.
     */
    experimentalHttpCatalog: cfg.get<boolean>('experimentalHttpCatalog', false),
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
