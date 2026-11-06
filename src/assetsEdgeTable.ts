/**
 * `project.assets.json` read once into a per-target-framework edge table (#109).
 *
 * The file used to be read three ways — `parseAssetsDependencies` merged every
 * framework into one map and dropped the ranges, `parseAssetsFloors` kept only
 * the `type: "project"` entries, and `resolvePackageDependencyTree` walked a
 * forward tree with ranges. All three are derived from this table now, and the
 * reverse index the dependents proposal needs (who declares an edge to this
 * package, with what range) is a lookup on it rather than a fourth reader.
 */

import { frameworkKey } from './frameworkMoniker';
import { packageIdKey, packageIdsEqual } from './pathCompare';

/** Split `PackageId/1.2.3` library keys used in assets `targets`. */
export function assetsLibraryId(libKey: string): string | null {
  const slash = libKey.lastIndexOf('/');
  if (slash <= 0) return null;
  return libKey.slice(0, slash);
}

/** The version half of an `Id/1.2.3` assets library key. */
export function assetsLibraryVersion(libKey: string): string | null {
  const slash = libKey.lastIndexOf('/');
  if (slash < 0 || slash === libKey.length - 1) return null;
  return libKey.slice(slash + 1);
}

/** One declared dependency of a library: the package it asks for and the range it asks with. */
export interface AssetsEdge {
  id: string;
  range: string;
}

/** One entry of a target: a package or project with the edges it declares. */
export interface AssetsLibrary {
  id: string;
  version: string;
  /** `package` when the file does not say. */
  type: string;
  edges: AssetsEdge[];
  /** The `lib/<tfm>/` folder of the first compile (else runtime) asset, when it has one. */
  selectedAsset?: string;
}

/** Everything one target framework resolved, in the file's own order. */
export interface AssetsTarget {
  framework: string;
  libraries: AssetsLibrary[];
  /** First library of that id, keyed with {@link packageIdKey}. */
  byId: Map<string, AssetsLibrary>;
  /**
   * The packages the project references itself for this framework, keyed with
   * {@link packageIdKey} — `projectFileDependencyGroups` in the file. Empty when
   * the file does not carry the group.
   */
  directIds: Set<string>;
}

export interface AssetsEdgeTable {
  targets: AssetsTarget[];
}

/** A library that declares an edge to a package, and the range it declares. */
export interface AssetsDependent {
  library: AssetsLibrary;
  range: string;
}

interface RawLibrary {
  type?: string;
  dependencies?: Record<string, string>;
  compile?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
}

function selectedAssetFolder(lib: RawLibrary): string | undefined {
  const path = Object.keys(lib.compile ?? {})[0] ?? Object.keys(lib.runtime ?? {})[0];
  return path ? /^lib\/([^/]+)\//.exec(path)?.[1] : undefined;
}

/** Reads the `targets` of an assets file. Anything that is not an object is skipped, never thrown on. */
export function parseEdgeTable(json: unknown): AssetsEdgeTable {
  const table: AssetsEdgeTable = { targets: [] };
  if (!json || typeof json !== 'object') return table;
  const targets = (json as { targets?: Record<string, Record<string, unknown>> }).targets;
  if (!targets || typeof targets !== 'object') return table;
  const groups = (json as { projectFileDependencyGroups?: Record<string, unknown> }).projectFileDependencyGroups;

  for (const [framework, raw] of Object.entries(targets)) {
    if (!raw || typeof raw !== 'object') continue;
    const target: AssetsTarget = { framework, libraries: [], byId: new Map(), directIds: directIdsFor(groups, framework) };
    for (const [libKey, value] of Object.entries(raw)) {
      if (!value || typeof value !== 'object') continue;
      const id = assetsLibraryId(libKey);
      if (!id) continue;
      const version = assetsLibraryVersion(libKey) ?? '';
      const lib = value as RawLibrary;
      const library: AssetsLibrary = {
        id,
        version,
        type: lib.type || 'package',
        edges: Object.entries(lib.dependencies ?? {}).map(([depId, range]) => ({ id: depId, range })),
        selectedAsset: selectedAssetFolder(lib),
      };
      target.libraries.push(library);
      if (!target.byId.has(packageIdKey(id))) target.byId.set(packageIdKey(id), library);
    }
    table.targets.push(target);
  }
  return table;
}

/**
 * `"Example.Core >= 2.0.0"` lines of the group that names `framework`. The
 * file keys groups by the short moniker today, but an older restore wrote the
 * long one, so the key is compared through {@link frameworkKey}.
 */
function directIdsFor(groups: Record<string, unknown> | undefined, framework: string): Set<string> {
  const ids = new Set<string>();
  if (!groups || typeof groups !== 'object') return ids;
  const key = frameworkKey(framework);
  for (const [name, lines] of Object.entries(groups)) {
    if (!Array.isArray(lines) || frameworkKey(name) !== key) continue;
    for (const line of lines) {
      if (typeof line !== 'string') continue;
      const id = /^\s*([^\s>=<]+)/.exec(line)?.[1];
      if (id) ids.add(packageIdKey(id));
    }
  }
  return ids;
}

export function findTarget(table: AssetsEdgeTable, framework: string): AssetsTarget | undefined {
  return table.targets.find((t) => t.framework === framework);
}

export function findLibrary(target: AssetsTarget, id: string): AssetsLibrary | undefined {
  return target.byId.get(packageIdKey(id));
}

/**
 * What the projects this one references require of package `id`: the
 * `type: "project"` entries of the target, whose own `dependencies` NuGet unifies
 * into the referencing project's restore graph. A `PackageReference` below one
 * is `NU1605` — the failure #38 exists for. They are a minimum: they can forbid
 * a version from going back, never from going forward.
 */
export function floorsOn(target: AssetsTarget, id: string): Array<{ project: string; range: string }> {
  const found: Array<{ project: string; range: string }> = [];
  for (const library of target.libraries) {
    if (library.type !== 'project') continue;
    const edge = library.edges.find((e) => packageIdsEqual(e.id, id));
    if (edge && edge.range) found.push({ project: library.id, range: edge.range });
  }
  return found;
}

/**
 * Every package-type library of `target` that declares an edge to `id`, with
 * the range it declares — the reverse of the edges the table holds. Project
 * references are not dependents a version can be proposed for.
 */
export function dependentsOf(target: AssetsTarget, id: string): AssetsDependent[] {
  const found: AssetsDependent[] = [];
  for (const library of target.libraries) {
    if (library.type !== 'package') continue;
    const edge = library.edges.find((e) => packageIdsEqual(e.id, id));
    if (edge) found.push({ library, range: edge.range });
  }
  return found;
}
