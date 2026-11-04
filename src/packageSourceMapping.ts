/**
 * `<packageSourceMapping>` pattern matching — NuGet's own syntax
 * (https://learn.microsoft.com/en-us/nuget/consume-packages/package-source-mapping):
 * a pattern is either an exact package id or an id prefix ending in a single
 * `*`, matched case-insensitively. No other glob syntax exists.
 *
 * Pure and Node-free so it can run in both the extension host and the webview
 * (`PackageRow.tsx`) — same reason `vulnerabilities.ts` has no imports.
 */

import type { PackageSourceMapping } from './types';

function matchesPattern(packageIdLower: string, pattern: string): boolean {
  const p = pattern.toLowerCase();
  if (p.endsWith('*')) return packageIdLower.startsWith(p.slice(0, -1));
  return packageIdLower === p;
}

/** True when `packageId` matches at least one pattern across any mapped source. */
export function packageMatchesAnyMapping(
  packageId: string,
  mappings: readonly PackageSourceMapping[],
): boolean {
  const id = packageId.toLowerCase();
  return mappings.some((m) => m.patterns.some((pattern) => matchesPattern(id, pattern)));
}

/**
 * The sources NuGet would take `packageId` from under these mappings (#136):
 * the ones whose best-matching pattern is the most specific. An exact id beats
 * any prefix, a longer prefix beats a shorter one, and `*` alone is the weakest
 * of all. Names are returned lowercase.
 *
 * `undefined` means no restriction is known: mapping is off, or nothing in it
 * matches this id. NuGet would refuse to restore an unmatched id from anywhere,
 * but that is for the restore to say; a catalog read that finds nothing at all
 * there would be a worse answer than reading every source.
 */
export function mappedSourceNames(
  packageId: string,
  mappings: readonly PackageSourceMapping[],
): Set<string> | undefined {
  const id = packageId.toLowerCase();
  let best = -1;
  const names = new Set<string>();
  for (const mapping of mappings) {
    let mine = -1;
    for (const pattern of mapping.patterns) {
      const p = pattern.toLowerCase();
      const score = p.endsWith('*')
        ? (id.startsWith(p.slice(0, -1)) ? p.length - 1 : -1)
        : (id === p ? Number.MAX_SAFE_INTEGER : -1);
      mine = Math.max(mine, score);
    }
    if (mine < 0) continue;
    if (mine > best) {
      best = mine;
      names.clear();
    }
    if (mine === best) names.add(mapping.sourceName.toLowerCase());
  }
  return names.size > 0 ? names : undefined;
}
