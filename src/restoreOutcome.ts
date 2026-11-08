import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * What restore said about one reference it could not resolve (#138). Read from
 * `obj/project.nuget.cache`, which sits beside the `project.assets.json` the
 * extension already reads: the assets file records what restore *resolved*, so a
 * reference it could not resolve is in neither `targets` nor `libraries`, and
 * the cache's `logs` are the one place its id, its code and the feed's own
 * wording survive.
 */
export interface RestoreFailure {
  /** `NU1101` (no such package), `NU1102` (no such version), … */
  code: string;
  /** The package id, in the log's own `libraryId` field. */
  libraryId: string;
  /** The feed's own wording. */
  message: string;
  /** The target frameworks it failed for. */
  frameworks: string[];
}

export interface RestoreOutcome {
  /** `undefined` when the file does not say. */
  success?: boolean;
  /** The `Error`-level entries that name a package. */
  failures: RestoreFailure[];
  /** When the cache was written, in ms. A project file edited after it has not been restored since. */
  writtenAt?: number;
}

/**
 * The failures of a parsed `project.nuget.cache`. Never throws: whatever is not
 * the shape this reads is "nothing known", which is not "nothing wrong".
 */
export function parseRestoreCache(json: unknown): Pick<RestoreOutcome, 'success' | 'failures'> {
  const failures: RestoreFailure[] = [];
  if (!json || typeof json !== 'object') return { failures };
  const { success, logs } = json as { success?: unknown; logs?: unknown };
  if (Array.isArray(logs)) {
    for (const entry of logs) {
      if (!entry || typeof entry !== 'object') continue;
      const log = entry as Record<string, unknown>;
      if (String(log.level ?? '').toLowerCase() !== 'error') continue;
      if (typeof log.libraryId !== 'string' || log.libraryId.length === 0) continue;
      failures.push({
        code: typeof log.code === 'string' ? log.code : '',
        libraryId: log.libraryId,
        message: typeof log.message === 'string' ? log.message : '',
        frameworks: Array.isArray(log.targetGraphs)
          ? log.targetGraphs.filter((g): g is string => typeof g === 'string')
          : [],
      });
    }
  }
  return { success: typeof success === 'boolean' ? success : undefined, failures };
}

/** `obj/project.nuget.cache` beside the project, parsed; `null` when missing or unreadable. */
export async function readRestoreOutcome(projectPath: string): Promise<RestoreOutcome | null> {
  const file = path.join(path.dirname(projectPath), 'obj', 'project.nuget.cache');
  try {
    const [raw, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    return { ...parseRestoreCache(JSON.parse(raw) as unknown), writtenAt: stat.mtimeMs };
  } catch {
    return null;
  }
}
