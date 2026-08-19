/**
 * Package dependency graph helpers.
 * Edges come from `project.assets.json` (restore), not from id heuristics.
 */

/** Split `PackageId/1.2.3` library keys used in assets `targets`. */
export function assetsLibraryId(libKey: string): string | null {
  const slash = libKey.lastIndexOf('/');
  if (slash <= 0) return null;
  return libKey.slice(0, slash);
}

/**
 * Direct package → dependency ids from NuGet `project.assets.json`.
 * TFMs are unioned. Project references (`type: project`) are skipped.
 */
export function parseAssetsDependencies(json: unknown): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (!json || typeof json !== 'object') return result;
  const targets = (json as { targets?: Record<string, Record<string, unknown>> }).targets;
  if (!targets || typeof targets !== 'object') return result;

  for (const tfm of Object.values(targets)) {
    if (!tfm || typeof tfm !== 'object') continue;
    for (const [libKey, lib] of Object.entries(tfm)) {
      if (!lib || typeof lib !== 'object') continue;
      const rec = lib as { type?: string; dependencies?: Record<string, string> };
      if (rec.type && rec.type !== 'package') continue;
      const id = assetsLibraryId(libKey);
      if (!id) continue;
      const deps = Object.keys(rec.dependencies ?? {});
      if (deps.length === 0) continue;
      const key = id.toLowerCase();
      result.set(key, [...new Set([...(result.get(key) ?? []), ...deps])]);
    }
  }
  return result;
}

/**
 * Package ids in `among` that `startId` can reach through the full restore graph,
 * including hops through packages that are not in `among`.
 */
export function reachableAmong(
  graph: Map<string, readonly string[]>,
  startId: string,
  amongLower: Set<string>,
): string[] {
  const start = startId.toLowerCase();
  const visited = new Set<string>([start]);
  const stack = [start];
  const found: string[] = [];
  while (stack.length > 0) {
    const key = stack.pop()!;
    for (const dep of graph.get(key) ?? []) {
      const d = dep.toLowerCase();
      if (visited.has(d)) continue;
      visited.add(d);
      stack.push(d);
      if (amongLower.has(d)) found.push(dep);
    }
  }
  return [...new Set(found)];
}

function depsForId(
  depsById: Map<string, readonly string[]>,
  packageId: string,
): readonly string[] {
  return depsById.get(packageId.toLowerCase()) ?? depsById.get(packageId) ?? [];
}

/**
 * Immediate listed children of `startId` in the restore subgraph.
 * `depsById` is the stamped reachable set (lowercase keys): a dep is immediate
 * if no other listed dep of start also reaches it.
 */
export function immediateListedDependencies(
  startId: string,
  depsById: Map<string, readonly string[]>,
): string[] {
  const start = startId.toLowerCase();
  const listed = [...new Set(
    depsForId(depsById, startId).filter((id) => id.toLowerCase() !== start),
  )];
  return listed
    .filter((id) => {
      const key = id.toLowerCase();
      return !listed.some((other) => {
        if (other.toLowerCase() === key) return false;
        return depsForId(depsById, other).some((d) => d.toLowerCase() === key);
      });
    })
    .sort((a, b) => a.localeCompare(b));
}

export interface ListedDepNode {
  id: string;
  children: ListedDepNode[];
}

/** Nested restore-graph among listed packages. Cycles stop at the ancestor. */
export function listedDependencyTree(
  startId: string,
  depsById: Map<string, readonly string[]>,
  ancestors: ReadonlySet<string> = new Set(),
): ListedDepNode[] {
  const start = startId.toLowerCase();
  if (ancestors.has(start)) return [];
  const next = new Set(ancestors);
  next.add(start);
  return immediateListedDependencies(startId, depsById)
    .filter((id) => !next.has(id.toLowerCase()))
    .map((id) => ({
      id,
      children: listedDependencyTree(id, depsById, next),
    }));
}

/**
 * Topological order: dependencies before dependents.
 * Rank is the longest path in this subgraph (dependency depth).
 * Same-depth packages stay in name order — a shared dependency does not
 * DFS through one subtree and delay the others.
 * Only edges whose both ends are in `packageIds` count.
 * Cycles keep `localeCompare` among the leftover set.
 */
export function sortPackagesByDependencies(
  packageIds: string[],
  dependenciesById: Map<string, readonly string[]>,
): string[] {
  const ids = [...new Set(packageIds.filter(Boolean))];
  const canonical = new Map(ids.map((id) => [id.toLowerCase(), id]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const depth = new Map<string, number>();

  for (const id of ids) {
    const key = id.toLowerCase();
    indegree.set(key, 0);
    dependents.set(key, []);
    depth.set(key, 0);
  }

  for (const id of ids) {
    const key = id.toLowerCase();
    const raw = dependenciesById.get(key) ?? dependenciesById.get(id) ?? [];
    const deps = [...new Set(raw.map((d) => d.toLowerCase()))]
      .filter((d) => d !== key && canonical.has(d));
    indegree.set(key, deps.length);
    for (const dep of deps) {
      dependents.get(dep)!.push(key);
    }
  }

  const ready = ids.filter((id) => indegree.get(id.toLowerCase()) === 0);
  const remaining = new Set(ids.map((id) => id.toLowerCase()));

  while (ready.length > 0) {
    const next = ready.pop()!;
    const key = next.toLowerCase();
    if (!remaining.has(key)) continue;
    remaining.delete(key);
    const from = depth.get(key) ?? 0;
    for (const dependent of dependents.get(key) ?? []) {
      depth.set(dependent, Math.max(depth.get(dependent) ?? 0, from + 1));
      const nextDegree = (indegree.get(dependent) ?? 1) - 1;
      indegree.set(dependent, nextDegree);
      if (nextDegree === 0 && remaining.has(dependent)) {
        ready.push(canonical.get(dependent)!);
      }
    }
  }

  const leftover = [...remaining]
    .map((key) => canonical.get(key)!)
    .sort((a, b) => a.localeCompare(b));
  const ordered = ids
    .filter((id) => !remaining.has(id.toLowerCase()))
    .sort((a, b) => {
      const da = depth.get(a.toLowerCase()) ?? 0;
      const db = depth.get(b.toLowerCase()) ?? 0;
      return da !== db ? da - db : a.localeCompare(b);
    });
  return [...ordered, ...leftover];
}
