/** Hover / toast when an installed package cannot change version. */
export const BLOCKED_UPDATES_TOOLTIP =
  'Updates blocked for this workspace. Right-click the package and choose Unblock updates.';

/** Dedupe package ids (case-insensitive), keep first-seen casing, drop blanks. */
export function normalizeBlockedIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(id);
  }
  return ids;
}

export function isPackageBlocked(packageId: string, blocked: readonly string[]): boolean {
  const key = packageId.toLowerCase();
  return blocked.some((id) => id.toLowerCase() === key);
}

export function withoutBlocked<T extends { packageId: string }>(
  items: T[],
  blocked: readonly string[],
): T[] {
  return items.filter((item) => !isPackageBlocked(item.packageId, blocked));
}
