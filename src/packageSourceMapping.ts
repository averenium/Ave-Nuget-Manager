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
