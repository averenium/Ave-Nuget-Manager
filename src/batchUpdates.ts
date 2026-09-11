import { compareSemVer } from './semver';
import { frameworkScopedPins, isFrameworkScoped, latestInLine, pinGroupKey } from './frameworkPins';
import { packageFamilyId } from './packageFamily';
import { sortPackagesByDependencies } from './packageGraph';
import { groupsTargetVersion, isCodeAnalysisPackage, type RoslynCap } from './roslynSdkCap';
import type { BatchItemStatus, BatchUpdateItem, InstalledPackage } from './types';

export type { BatchUpdateItem };

export interface FamilyMember {
  packageId: string;
  fromVersion: string;
  projects: string[];
  latestVersion?: string;
  /** Direct deps from assets.json — used to order family updates. */
  dependencies?: string[];
  /** Set when every entry behind this member belongs to one framework-pinned TFM (#82). */
  framework?: string;
}

export interface FamilyGroup {
  family: string;
  fromVersion: string;
  /** Set when every member of the group is pinned to this one TFM (#82). */
  framework?: string;
  packageCount: number;
  /** Members whose latest is newer than `fromVersion` (All/Other-style count). */
  updateCount: number;
  members: FamilyMember[];
}

function isNewer(latest: string | undefined, current: string): latest is string {
  return !!latest && compareSemVer(latest, current) > 0;
}

function latestForId(
  entries: InstalledPackage[],
  cap?: RoslynCap | null,
): string | undefined {
  for (const e of entries) {
    const target = groupsTargetVersion(e.id, e.latestVersion, e.versions, cap);
    if (target) return target;
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
  const byId = new Map<string, { latestVersion?: string; sourceName?: string; versions?: string[] }>();
  for (const pkg of previous) {
    const key = pkg.id.toLowerCase();
    if (byId.has(key) || (!pkg.latestVersion && !pkg.sourceName && !pkg.versions?.length)) continue;
    byId.set(key, {
      latestVersion: pkg.latestVersion,
      sourceName: pkg.sourceName,
      versions: pkg.versions,
    });
  }
  return incoming.map((pkg) => {
    const prev = byId.get(pkg.id.toLowerCase());
    if (!prev) return pkg;
    return {
      ...pkg,
      latestVersion: pkg.latestVersion || prev.latestVersion,
      sourceName: pkg.sourceName || prev.sourceName,
      versions: pkg.versions?.length ? pkg.versions : prev.versions,
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
 * current prerelease enrich. `Microsoft.CodeAnalysis.*` uses max enrich version
 * ≤ SDK `csc` (omitted when the probe failed).
 */
export function collectUpdatableItems(
  installed: InstalledPackage[],
  cap?: RoslynCap | null,
): BatchUpdateItem[] {
  const scopedPins = frameworkScopedPins(installed);
  const byKey = new Map<string, InstalledPackage[]>();
  for (const pkg of installed) {
    const key = pinGroupKey(pkg, scopedPins);
    const list = byKey.get(key);
    if (list) list.push(pkg);
    else byKey.set(key, [pkg]);
  }

  const items: Array<BatchUpdateItem & { dependencies?: string[] }> = [];
  for (const entries of byKey.values()) {
    const ceiling = latestForId(entries, cap);
    if (!ceiling) continue;
    // A framework-pinned bucket advances inside its own major line: that pin
    // exists to keep net9.0 on 9.x while net10.0 moves through 10.x, and the
    // feed's newest version belongs to whichever line it belongs to (#82).
    // Every entry in such a bucket is framework-pinned by construction — an
    // ordinary reference to the same id keys on the id alone and lands in its
    // own bucket, where it keeps the plain latest-version target it always had.
    const framework = isFrameworkScoped(entries[0], scopedPins) ? entries[0].framework : undefined;
    const latest = framework ? targetInsideLine(entries, ceiling) : ceiling;
    if (!latest) continue;

    const behind = entries.filter((e) => isNewer(latest, e.resolvedVersion));
    const projects = behind.map((e) => e.projectPath);
    if (projects.length === 0) continue;
    const fromVersions = [...new Set(behind.map((e) => e.resolvedVersion))];
    items.push({
      packageId: entries[0].id,
      fromVersion: fromVersions.join(' / '),
      toVersion: latest,
      projects: [...new Set(projects)],
      framework,
      dependencies: [...new Set(entries.flatMap((e) => e.dependencies ?? []))],
    });
  }

  return sortByPackageDeps(items).map(({ dependencies: _deps, ...item }) => item);
}

/**
 * The highest version inside the line this bucket already sits in, never above
 * the ceiling an id-wide policy allows (the Roslyn SDK cap). The line is taken
 * from the newest version in the bucket, so a project left further behind in
 * the same framework still moves — one further behind in a *different* major
 * simply gets no proposal here, and none of the alternatives to that are safe.
 */
function targetInsideLine(
  entries: InstalledPackage[],
  ceiling: string,
): string | undefined {
  const current = [...entries]
    .sort((a, b) => compareSemVer(b.resolvedVersion, a.resolvedVersion))[0].resolvedVersion;
  const candidates = [...new Set(entries.flatMap((e) => e.versions ?? []))]
    .filter((v) => compareSemVer(v, ceiling) <= 0);
  // With no enrich list the ceiling is the only candidate there is, and it
  // counts only if it happens to be in the line already.
  return latestInLine(current, candidates.length > 0 ? candidates : [ceiling]);
}

/**
 * The one TFM a set of entries belongs to, when every entry names it and at
 * least one of them is for an id somebody pins per framework (#82). A group
 * that is only incidentally all-`net10.0` — because that is what the whole
 * solution targets — gets nothing: the badge is there to explain why two groups
 * of one family exist, not to restate the TFM on every group in the tab.
 */
function singleFramework(
  entries: readonly InstalledPackage[],
  scopedPins: ReadonlySet<string>,
): string | undefined {
  if (!entries.some((e) => isFrameworkScoped(e, scopedPins))) return undefined;
  const frameworks = new Set(entries.map((e) => e.framework));
  if (frameworks.size !== 1) return undefined;
  const [only] = frameworks;
  return only || undefined;
}

/**
 * Families (A.B.*) with 2+ distinct packages on the same resolved version.
 * Includes every member — the UI picks a shared target version.
 */
export function collectFamilyGroups(
  installed: InstalledPackage[],
  cap?: RoslynCap | null,
): FamilyGroup[] {
  const scopedPins = frameworkScopedPins(installed);
  const buckets = new Map<string, InstalledPackage[]>();
  for (const pkg of installed) {
    if (isCodeAnalysisPackage(pkg.id) && cap === null) continue;
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
      latestVersion: latestForId(idEntries, cap),
      dependencies: [...new Set(idEntries.flatMap((e) => e.dependencies ?? []))],
      framework: singleFramework(idEntries, scopedPins),
    }));

    const sortedMembers = sortFamilyMembers(members);
    groups.push({
      family,
      fromVersion,
      framework: singleFramework(entries, scopedPins),
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
  cap?: RoslynCap | null,
): BatchUpdateItem[] {
  const inFamily = new Set(
    families.flatMap((g) => g.members.map((m) => m.packageId.toLowerCase())),
  );
  return collectUpdatableItems(installed, cap).filter(
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
      framework: m.framework,
    }));
}

export function suggestedFamilyVersion(members: FamilyMember[], fromVersion: string): string | undefined {
  const newer = sortVersionsDesc(
    members.map((m) => m.latestVersion ?? '').filter((v) => isNewer(v, fromVersion)),
  );
  return newer[0];
}

export interface EntangledClusterInput {
  /** Current resolved version per package id (lowercase keys) on this one project. */
  currentVersions: ReadonlyMap<string, string>;
  /** Version floor a `ProjectReference` imposes per package id (lowercase keys). */
  floors: ReadonlyMap<string, string>;
  /** Package -> its own dependency ids (lowercase keys), from `project.assets.json`. */
  depsGraph: ReadonlyMap<string, readonly string[]>;
  /** Package ids (lowercase) this batch targets on this project. */
  batchPackageIds: ReadonlySet<string>;
}

/**
 * #38: packages (lowercase ids) that must be applied to one project together,
 * with a single restore at the end, instead of one `dotnet add` + implicit
 * restore per package. A package already below a `ProjectReference` floor
 * fails *every* restore until it (and anything else needed to satisfy the
 * resulting graph) lands — including packages whose own restart isn't
 * floor-violating but got rolled back by an earlier, unrelated failure in the
 * same batch (e.g. a dependency of the floor-violating package).
 *
 * Seeds are every batch package currently below its own floor; the cluster is
 * the union of each seed's reachable set in the (batch-restricted, undirected)
 * dependency graph — seeds do not need to be connected to *each other* (#38's
 * real trace had two unrelated floor violations in the same project, neither
 * depending on the other, both required in the same no-restore pass).
 *
 * A cluster of one (a lone floor violation with no batch-mate) gets nothing
 * from this — either the batch's target version already satisfies the floor
 * and the normal per-item flow succeeds, or it doesn't and no reordering
 * fixes that. Returns an empty set in both the "nothing to do" and "no help
 * possible" cases.
 */
export function computeEntangledCluster(input: EntangledClusterInput): Set<string> {
  const { currentVersions, floors, depsGraph, batchPackageIds } = input;

  const seeds = [...batchPackageIds].filter((id) => {
    const floor = floors.get(id);
    const current = currentVersions.get(id);
    return !!floor && !!current && compareSemVer(current, floor) < 0;
  });
  if (seeds.length === 0) return new Set();

  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a)!.add(b);
  };
  for (const id of batchPackageIds) {
    for (const dep of depsGraph.get(id) ?? []) {
      const depKey = dep.toLowerCase();
      if (!batchPackageIds.has(depKey)) continue;
      link(id, depKey);
      link(depKey, id);
    }
  }

  const cluster = new Set<string>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (cluster.has(id)) continue;
    cluster.add(id);
    for (const neighbor of adjacency.get(id) ?? []) {
      if (!cluster.has(neighbor)) stack.push(neighbor);
    }
  }

  return cluster.size > 1 ? cluster : new Set();
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
