import { compareSemVer } from './semver';
import { packageFamilyId } from './packageFamily';
import { sortPackagesByDependencies } from './packageGraph';
import type { BatchItemStatus, BatchUpdateItem, InstalledPackage } from './types';

export type { BatchUpdateItem };

export interface FamilyMember {
  packageId: string;
  fromVersion: string;
  projects: string[];
  latestVersion?: string;
  /** Direct deps from assets.json — used to order family updates. */
  dependencies?: string[];
}

export interface FamilyGroup {
  family: string;
  fromVersion: string;
  packageCount: number;
  /** Members whose latest is newer than `fromVersion` (All/Other-style count). */
  updateCount: number;
  members: FamilyMember[];
}

function isNewer(latest: string | undefined, current: string): latest is string {
  return !!latest && compareSemVer(latest, current) > 0;
}

function latestForId(entries: InstalledPackage[]): string | undefined {
  for (const e of entries) {
    if (e.latestVersion) return e.latestVersion;
  }
  return undefined;
}

/**
 * `dotnet list` does not include enrich fields. Keep the previous latest/source
 * so Updates All/family counts do not drop to zero until PACKAGE_INFO_UPDATE.
 */
export function preserveInstalledEnrichment(
  incoming: InstalledPackage[],
  previous: InstalledPackage[],
): InstalledPackage[] {
  const byId = new Map<string, { latestVersion?: string; sourceName?: string }>();
  for (const pkg of previous) {
    const key = pkg.id.toLowerCase();
    if (byId.has(key) || (!pkg.latestVersion && !pkg.sourceName)) continue;
    byId.set(key, { latestVersion: pkg.latestVersion, sourceName: pkg.sourceName });
  }
  return incoming.map((pkg) => {
    const prev = byId.get(pkg.id.toLowerCase());
    if (!prev) return pkg;
    return {
      ...pkg,
      latestVersion: pkg.latestVersion || prev.latestVersion,
      sourceName: pkg.sourceName || prev.sourceName,
    };
  });
}

function sortByPackageDeps<T extends { packageId: string; dependencies?: string[] }>(items: T[]): T[] {
  const order = sortPackagesByDependencies(
    items.map((m) => m.packageId),
    new Map(items.map((m) => [m.packageId.toLowerCase(), m.dependencies ?? []])),
  );
  const rank = new Map(order.map((id, i) => [id.toLowerCase(), i]));
  return [...items].sort(
    (a, b) => (rank.get(a.packageId.toLowerCase()) ?? 0) - (rank.get(b.packageId.toLowerCase()) ?? 0),
  );
}

function sortFamilyMembers(members: FamilyMember[]): FamilyMember[] {
  return sortByPackageDeps(members);
}

export function sortVersionsDesc(versions: string[]): string[] {
  return [...new Set(versions.filter(Boolean))].sort((a, b) => compareSemVer(b, a));
}

/** Versions present in every non-empty list. */
export function intersectVersions(lists: string[][]): string[] {
  const nonempty = lists.filter((l) => l.length > 0);
  if (nonempty.length === 0) return [];
  const common = nonempty.reduce((acc, list) => {
    const set = new Set(list);
    return acc.filter((v) => set.has(v));
  });
  return sortVersionsDesc(common);
}

/**
 * Every installed package (per id) that has a known latest version newer than
 * at least one project. Target is that latest — already filtered by the
 * current prerelease enrich.
 */
export function collectUpdatableItems(installed: InstalledPackage[]): BatchUpdateItem[] {
  const byId = new Map<string, InstalledPackage[]>();
  for (const pkg of installed) {
    const key = pkg.id.toLowerCase();
    const list = byId.get(key);
    if (list) list.push(pkg);
    else byId.set(key, [pkg]);
  }

  const items: Array<BatchUpdateItem & { dependencies?: string[] }> = [];
  for (const entries of byId.values()) {
    const latest = latestForId(entries);
    if (!latest) continue;
    const projects = entries
      .filter((e) => isNewer(latest, e.resolvedVersion))
      .map((e) => e.projectPath);
    if (projects.length === 0) continue;
    const fromVersions = [...new Set(
      entries.filter((e) => isNewer(latest, e.resolvedVersion)).map((e) => e.resolvedVersion),
    )];
    items.push({
      packageId: entries[0].id,
      fromVersion: fromVersions.join(' / '),
      toVersion: latest,
      projects: [...new Set(projects)],
      dependencies: [...new Set(entries.flatMap((e) => e.dependencies ?? []))],
    });
  }

  return sortByPackageDeps(items).map(({ dependencies: _deps, ...item }) => item);
}

/**
 * Families (A.B.*) with 2+ distinct packages on the same resolved version.
 * Includes every member — the UI picks a shared target version.
 */
export function collectFamilyGroups(installed: InstalledPackage[]): FamilyGroup[] {
  const buckets = new Map<string, InstalledPackage[]>();
  for (const pkg of installed) {
    const family = packageFamilyId(pkg.id);
    if (!family) continue;
    const key = `${family.toLowerCase()}\0${pkg.resolvedVersion}`;
    const list = buckets.get(key);
    if (list) list.push(pkg);
    else buckets.set(key, [pkg]);
  }

  const groups: FamilyGroup[] = [];
  for (const entries of buckets.values()) {
    const family = packageFamilyId(entries[0].id);
    if (!family) continue;
    const fromVersion = entries[0].resolvedVersion;
    const uniqueIds = [...new Set(entries.map((e) => e.id.toLowerCase()))];
    if (uniqueIds.length < 2) continue;

    const byId = new Map<string, InstalledPackage[]>();
    for (const pkg of entries) {
      const key = pkg.id.toLowerCase();
      const list = byId.get(key);
      if (list) list.push(pkg);
      else byId.set(key, [pkg]);
    }

    const members: FamilyMember[] = [...byId.values()].map((idEntries) => ({
      packageId: idEntries[0].id,
      fromVersion,
      projects: [...new Set(idEntries.map((e) => e.projectPath))],
      latestVersion: latestForId(idEntries),
      dependencies: [...new Set(idEntries.flatMap((e) => e.dependencies ?? []))],
    }));

    const sortedMembers = sortFamilyMembers(members);
    groups.push({
      family,
      fromVersion,
      packageCount: uniqueIds.length,
      updateCount: sortedMembers.filter((m) => isNewer(m.latestVersion, fromVersion)).length,
      members: sortedMembers,
    });
  }

  return groups.sort((a, b) => {
    const fam = a.family.localeCompare(b.family);
    return fam !== 0 ? fam : a.fromVersion.localeCompare(b.fromVersion);
  });
}

/** Updatable packages that are not members of any family group. */
export function collectOtherItems(
  installed: InstalledPackage[],
  families: FamilyGroup[],
): BatchUpdateItem[] {
  const inFamily = new Set(
    families.flatMap((g) => g.members.map((m) => m.packageId.toLowerCase())),
  );
  return collectUpdatableItems(installed).filter(
    (item) => !inFamily.has(item.packageId.toLowerCase()),
  );
}

export function familyItemsAtVersion(members: FamilyMember[], toVersion: string): BatchUpdateItem[] {
  if (!toVersion) return [];
  return sortFamilyMembers(members)
    .filter((m) => m.fromVersion !== toVersion)
    .map((m) => ({
      packageId: m.packageId,
      fromVersion: m.fromVersion,
      toVersion,
      projects: m.projects,
    }));
}

export function suggestedFamilyVersion(members: FamilyMember[], fromVersion: string): string | undefined {
  const newer = sortVersionsDesc(
    members.map((m) => m.latestVersion ?? '').filter((v) => isNewer(v, fromVersion)),
  );
  return newer[0];
}

/** Banner text for a finished batch: first line is the title, rest is the spoiler. */
export function formatBatchUpdateError(
  items: Array<{ packageId: string; status: BatchItemStatus; error?: string }>,
  canRollback?: boolean,
): string | null {
  const failed = items.filter((i) => i.status === 'error' || i.status === 'timeout');
  if (failed.length === 0) return null;
  const title = failed.length === 1
    ? `Batch update of ${failed[0].packageId} failed`
    : `Batch update finished with ${failed.length} error(s).`;
  const rollbackNote = canRollback
    ? 'Project file still has the new version. Use Rollback to restore the previous PackageReference.'
    : null;
  const blocks = failed.map((i) => {
    const body = i.error?.trim()
      || (i.status === 'timeout' ? 'Operation timed out' : 'Update failed');
    return `${i.packageId}\n${body}`;
  });
  return [title, rollbackNote, ...blocks].filter(Boolean).join('\n\n');
}
