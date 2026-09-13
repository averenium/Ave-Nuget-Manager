/**
 * Vulnerability database pages on disk, between windows (#27).
 *
 * The full page is hundreds of kilobytes, which is why it goes to a file in the
 * extension's own storage rather than into the editor's key-value state.
 *
 * Addresses carry timestamps, so a rebuilt page arrives under a new name and
 * the old file is simply never read again. Pruning keeps only the newest few:
 * the previous generation is worth keeping for the moment after a rebuild, and
 * everything older is dead weight.
 */

import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import * as path from 'path';
import type { VdbPageStore } from './nugetVulnerabilityDatabase';

/** Enough for the current pair of pages and the pair before them. */
const KEEP_FILES = 6;

function fileNameFor(url: string): string {
  return `${crypto.createHash('sha256').update(url).digest('hex').slice(0, 32)}.json`;
}

export function vdbFileStore(directory: string): VdbPageStore {
  return {
    async read(key) {
      try {
        return await fs.readFile(path.join(directory, fileNameFor(key)), 'utf8');
      } catch {
        return undefined;
      }
    },

    async write(key, value) {
      await fs.mkdir(directory, { recursive: true });
      const file = path.join(directory, fileNameFor(key));
      // Written beside the target and renamed, so a window closing mid-write
      // cannot leave a half file that reads as a corrupt page.
      const temporary = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, value, 'utf8');
      await fs.rename(temporary, file);
      await prune(directory);
    },
  };
}

async function prune(directory: string): Promise<void> {
  try {
    const names = (await fs.readdir(directory)).filter((n) => n.endsWith('.json'));
    if (names.length <= KEEP_FILES) return;

    const withTimes = await Promise.all(names.map(async (name) => {
      const stat = await fs.stat(path.join(directory, name)).catch(() => undefined);
      return { name, at: stat?.mtimeMs ?? 0 };
    }));
    withTimes.sort((a, b) => b.at - a.at);
    for (const stale of withTimes.slice(KEEP_FILES)) {
      await fs.rm(path.join(directory, stale.name), { force: true }).catch(() => undefined);
    }
  } catch {
    // A cache that cannot be tidied is still a working cache.
  }
}
