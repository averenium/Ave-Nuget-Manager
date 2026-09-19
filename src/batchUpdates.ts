import { compareSemVer } from './semver';
import { frameworkScopedPins, isFrameworkScoped, latestInLine, pinGroupKey } from './frameworkPins';
import { isVersionCompatible } from './frameworkCompatibility';
import { pathsEqual } from './pathCompare';
import { packageFamilyId } from './packageFamily';
import { sortPackagesByDependencies } from './packageGraph';
import { groupsTargetVersion, isCodeAnalysisPackage, type RoslynCap } from './roslynSdkCap';
import type { BatchItemStatus, BatchUpdateItem, InstalledPackage, VersionFlag } from './types';

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

/**
 * The one ceiling every entry in a bucket can share (#107). Each entry's own
 * `.latestVersion` is already the highest version *that entry's own project
 * framework* can use — different projects referencing the same package can
 * disagree here, most visibly when one is on an older framework than the
 * other. Taking the first entry's answer for the whole bucket handed a
 * net10.0 project a net9.0-only ceiling when net9.0 happened to come first in
 * the list, or hid net10.0's own real update entirely behind a net9.0 entry
 * that had none at all. The lowest of the entries' own ceilings is always
 * achievable by every one of them — a newer framework takes an older one's
 * compatible version as readily as that framework does — the same "shared
 * target, not per-project" choice Groups reaches for when a split isn't
 * available (as here: "All"/"Other" apply one version to a whole bucket with
 * no per-project picker of their own).
 */
function latestForId(
  entries: InstalledPackage[],
  cap?: RoslynCap | null,
): string | undefined {
  let lowest: string | undefined;
  for (const e of entries) {
    const target = groupsTargetVersion(e.id, e.latestVersion, e.versions, cap);
    if (!target) continue;
    if (!lowest || compareSemVer(target, lowest) < 0) lowest = target;
  }
  return lowest;
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
 * Every framework a family member's own project(s) declare (#107) — the one
 * shared reference covers all of them unless the member is itself
 * framework-pinned (#82), in which case it already names the one that
 * matters.
 */
export function memberProjectTfms(
  member: FamilyMember,
  projectFrameworks: Record<string, string[]>,
): string[] {
  if (member.framework) return [member.framework];
  return [...new Set(
    member.projects.flatMap((p) => projectFrameworks[p]
      ?? Object.entries(projectFrameworks).find(([key]) => pathsEqual(key, p))?.[1]
      ?? []),
  )];
}

/**
 * One member's own version list, narrowed to the versions its project
 * framework(s) can actually use (#107) — the family target has to work for
 * every member, so a version one member's own project can't use has to drop
 * out of that member's list before `intersectVersions` ever sees it.
 */
export function compatibleMemberVersions(
  member: FamilyMember,
  versions: readonly string[],
  flags: Record<string, VersionFlag> | undefined,
  projectFrameworks: Record<string, string[]>,
): string[] {
  const tfms = memberProjectTfms(member, projectFrameworks);
  if (!flags || tfms.length === 0) return [...versions];
  return versions.filter((v) => isVersionCompatible(flags[v]?.declaredDependencies, tfms));
}

/**
 * Whether any member of this family has already answered (its own raw
 * version list is non-empty) but has nothing compatible with its own project
 * framework(s) at all (#107) — a real "no version works here", not the
 * transitional "still loading" state a short/empty list otherwise means.
 *
 * The shared target picker must treat this as blocking rather than letting
 * the blocked member simply drop out of the union/intersection: dropping out
 * is indistinguishable from "hasn't answered yet" once a member's own
 * compatible list can legitimately come back empty, and the picker would
 * silently propose whichever other member's versions it does have — the
 * exact incompatible version #107 opens with.
 */
/**
 * Whether any of `members` has already answered (its own raw version list is
 * non-empty) but has nothing compatible with its own project framework(s) at
 * all (#107) — the one shared check `familyHasBlockedMember` and
 * `compatibleFamilyVersions` both need, kept in one place so a caller cannot
 * fix this reading for one and leave it wrong for the other, which is
 * exactly what happened before: `compatibleFamilyVersions` grew its own
 * "loaded.length < members.length" test that could not tell "hasn't
 * answered yet" apart from "answered with nothing at all", the same
 * ambiguity `familyHasBlockedMember` exists to resolve.
 */
function hasBlockedMember(
  members: readonly FamilyMember[],
  versionsByPackageId: Record<string, string[]>,
  flagsByPackageId: Record<string, Record<string, VersionFlag>>,
  projectFrameworks: Record<string, string[]>,
): boolean {
  return members.some((m) => {
    const raw = versionsByPackageId[m.packageId.toLowerCase()] ?? [];
    if (raw.length === 0) return false;
    const filtered = compatibleMemberVersions(m, raw, flagsByPackageId[m.packageId.toLowerCase()], projectFrameworks);
    return filtered.length === 0;
  });
}

export function familyHasBlockedMember(
  members: readonly FamilyMember[],
  versionsByPackageId: Record<string, string[]>,
  flagsByPackageId: Record<string, Record<string, VersionFlag>>,
  projectFrameworks: Record<string, string[]>,
): boolean {
  return hasBlockedMember(members, versionsByPackageId, flagsByPackageId, projectFrameworks);
}

/** One of the groups a family falls apart into when no version can serve every member at once (#107). */
export interface FamilySplitGroup {
  /** The exact framework set every member here has to satisfy, sorted; empty when none is known. */
  frameworks: string[];
  members: FamilyMember[];
}

/**
 * Partitions a family's members by the exact set of frameworks their own
 * project(s) declare (#107) — called only once a shared version has already
 * turned out to be impossible (`familyHasBlockedMember`), never eagerly: two
 * members whose frameworks merely differ can still share a version restore
 * would accept for both (a net9.0 member and a net8.0 member both take a
 * net8.0-declared release), and splitting them apart on framework alone would
 * offer two targets where one already worked. This groups by framework
 * *signature* rather than by which versions are actually achievable, so it
 * can occasionally split further than strictly necessary — the safe
 * direction for this to err in, matching `isVersionCompatible`'s own
 * "nothing ruled out without evidence" rule read the other way: nothing
 * merged without it either.
 */
export function splitFamilyMembers(
  members: readonly FamilyMember[],
  projectFrameworks: Record<string, string[]>,
): FamilySplitGroup[] {
  const buckets = new Map<string, FamilyMember[]>();
  const order: string[] = [];
  for (const m of members) {
    const key = [...memberProjectTfms(m, projectFrameworks)].sort().join('\0');
    const list = buckets.get(key);
    if (list) list.push(m);
    else {
      buckets.set(key, [m]);
      order.push(key);
    }
  }
  return order.map((key) => ({
    frameworks: key ? key.split('\0') : [],
    members: buckets.get(key)!,
  }));
}

/**
 * The version list a group of members (an unsplit family, or one of its
 * split groups) can share at all (#107) — the intersection once every member
 * has answered, or the union of what has answered so far while the rest is
 * still loading, the same "don't claim an intersection from a partial
 * answer" rule `familyVersions` already followed before a split could happen.
 *
 * A blocked member (`hasBlockedMember`) is neither of those: it has already
 * answered, with nothing at all. `loaded.length < members.length` alone
 * cannot tell that apart from "hasn't answered yet" — both leave this
 * member's own list empty — and reading it as "still loading" fell through
 * to the union of everyone else's versions, proposing exactly the version
 * the member cannot take. `splitFamilyMembers` groups a blocked member with
 * others sharing its own framework signature; a member with nothing
 * compatible at all blocks its *group's* shared target the same way it
 * blocked the whole family before the split, and must not have that target
 * quietly reassigned to whichever group it landed in.
 */
export function compatibleFamilyVersions(
  members: readonly FamilyMember[],
  versionsByPackageId: Record<string, string[]>,
  flagsByPackageId: Record<string, Record<string, VersionFlag>>,
  projectFrameworks: Record<string, string[]>,
): string[] {
  if (hasBlockedMember(members, versionsByPackageId, flagsByPackageId, projectFrameworks)) return [];
  const lists = members.map((m) => compatibleMemberVersions(
    m,
    versionsByPackageId[m.packageId.toLowerCase()] ?? [],
    flagsByPackageId[m.packageId.toLowerCase()],
    projectFrameworks,
  ));
  const loaded = lists.filter((l) => l.length > 0);
  if (loaded.length < members.length) return sortVersionsDesc(loaded.flat());
  return intersectVersions(loaded);
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
    const dependencies = [...new Set(entries.flatMap((e) => e.dependencies ?? []))];
    const framework = isFrameworkScoped(entries[0], scopedPins) ? entries[0].framework : undefined;

    if (framework) {
      // A framework-pinned bucket advances inside its own major line: that pin
      // exists to keep net9.0 on 9.x while net10.0 moves through 10.x, and the
      // feed's newest version belongs to whichever line it belongs to (#82).
      // Every entry here is framework-pinned by construction and already
      // keyed to this one framework, so one target still covers the bucket.
      const ceiling = latestForId(entries, cap);
      const latest = ceiling ? targetInsideLine(entries, ceiling) : undefined;
      if (!latest) continue;
      const behind = entries.filter((e) => isNewer(latest, e.resolvedVersion));
      if (behind.length === 0) continue;
      items.push({
        packageId: entries[0].id,
        fromVersion: [...new Set(behind.map((e) => e.resolvedVersion))].join(' / '),
        toVersion: latest,
        projects: [...new Set(behind.map((e) => e.projectPath))],
        framework,
        dependencies,
      });
      continue;
    }

    // An ordinary reference to the same id can still span several *projects*
    // whose own frameworks disagree (#107) — the same package referenced from
    // a net9.0 project and a net10.0 one, each with its own achievable
    // ceiling already computed per row. Grouping every entry under one
    // target taken from whichever answered first either handed a newer
    // project an older project's lower ceiling, or hid a real update
    // entirely behind a sibling project that had none at all. Grouping by
    // each entry's own achievable target instead keeps every project's own
    // best answer — entries that already agree on a target still end up in
    // one item together, exactly as before.
    const byTarget = new Map<string, InstalledPackage[]>();
    for (const e of entries) {
      const target = groupsTargetVersion(e.id, e.latestVersion, e.versions, cap);
      if (!target || !isNewer(target, e.resolvedVersion)) continue;
      const list = byTarget.get(target);
      if (list) list.push(e);
      else byTarget.set(target, [e]);
    }
    for (const [latest, behind] of byTarget) {
      items.push({
        packageId: entries[0].id,
        fromVersion: [...new Set(behind.map((e) => e.resolvedVersion))].join(' / '),
        toVersion: latest,
        projects: [...new Set(behind.map((e) => e.projectPath))],
        framework: undefined,
        dependencies,
      });
    }
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
