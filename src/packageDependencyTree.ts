/**
 * Resolves one package's own dependency tree (declared range + resolved
 * version, recursively) straight from `project.assets.json` — not
 * `.deps.json`, which is a build output carrying only resolved versions and
 * where the declared range is lost (#86 design pass, "Dependencies").
 * `assets.json` holds both sides for every package in the restore graph,
 * plus the full supported-framework list and which asset was selected.
 */

import {
  findLibrary,
  findTarget,
  parseEdgeTable,
  type AssetsEdge,
  type AssetsLibrary,
  type AssetsTarget,
} from './assetsEdgeTable';
import { packageIdKey } from './pathCompare';
import { classifyDependencyRow } from './packageVersionRanges';
import { sortTargetFrameworksDesc } from './targetFrameworks';
import type { DependencyRow, PackageDependencyInfo } from './types';

export type { DependencyRow, PackageDependencyInfo };

/** Every `lib/<tfm>/...` folder name a library's package declares support for, deduped, newest first. */
export function supportedFrameworksFromFiles(files: string[] | undefined): string[] {
  if (!files) return [];
  const seen = new Set<string>();
  for (const f of files) {
    const m = /^lib\/([^/]+)\//.exec(f);
    if (m) seen.add(m[1]);
  }
  return sortTargetFrameworksDesc([...seen]);
}

interface AssetsJson {
  libraries?: Record<string, { files?: string[] }>;
}

interface PendingRow {
  row: DependencyRow;
  lib?: AssetsLibrary;
}

function makeRow(target: AssetsTarget, depId: string, declaredRange: string): PendingRow {
  const lib = findLibrary(target, depId);
  const resolvedVersion = lib?.version;
  if (!resolvedVersion) {
    return { row: { id: depId, resolvedVersion, declaredRange, status: 'ok', showDeclared: false, children: [] } };
  }
  const { status, showDeclared } = classifyDependencyRow(declaredRange, resolvedVersion);
  return { row: { id: depId, resolvedVersion, declaredRange, status, showDeclared, children: [] }, lib };
}

/**
 * Breadth-first, and every package is listed once — at its shallowest position,
 * so direct dependencies always stay at the top level. A restore graph re-states
 * the same package under every parent that asks for it (Roslyn's analyzer package
 * under a dozen of them), and since a target resolves exactly one version, those
 * repeats say nothing new. The cost is that a second parent's *declared range*
 * for an already-listed package isn't shown; the range that is shown is the one
 * from the parent that reaches it first.
 */
function buildRows(
  target: AssetsTarget,
  rootId: string,
  directDependencies: AssetsEdge[],
): DependencyRow[] {
  const seen = new Set<string>([packageIdKey(rootId)]);
  const roots: DependencyRow[] = [];
  let frontier: PendingRow[] = [];

  for (const { id: depId, range } of directDependencies) {
    if (seen.has(packageIdKey(depId))) continue;
    seen.add(packageIdKey(depId));
    const pending = makeRow(target, depId, range);
    roots.push(pending.row);
    frontier.push(pending);
  }

  while (frontier.length > 0) {
    const next: PendingRow[] = [];
    for (const { row, lib } of frontier) {
      for (const { id: childId, range: childRange } of lib?.edges ?? []) {
        if (seen.has(packageIdKey(childId))) continue;
        seen.add(packageIdKey(childId));
        const pending = makeRow(target, childId, childRange);
        row.children.push(pending.row);
        next.push(pending);
      }
    }
    frontier = next;
  }

  return roots;
}

/**
 * `packageId`'s own dependency tree for `framework`, or undefined if that
 * package isn't in this target at all (wrong TFM, or never restored).
 */
export function resolvePackageDependencyTree(
  assetsJson: unknown,
  packageId: string,
  resolvedVersion: string,
  framework: string,
): PackageDependencyInfo | undefined {
  const target = findTarget(parseEdgeTable(assetsJson), framework);
  if (!target) return undefined;
  const lib = findLibrary(target, packageId);
  if (!lib) return undefined;
  // Guard against a stale caller-supplied version: assets.json only ever
  // resolves one version per package per target, so a mismatch means the
  // caller's `resolvedVersion` no longer matches what was actually restored.
  if (lib.version !== resolvedVersion) return undefined;

  return {
    framework,
    selectedAsset: lib.selectedAsset,
    rows: buildRows(target, packageId, lib.edges),
  };
}

/** Every `lib/<tfm>/` framework the resolved package itself declares support for, from `libraries[id/version].files`. */
export function packageSupportedFrameworks(
  assetsJson: unknown,
  packageId: string,
  resolvedVersion: string,
): string[] {
  const json = assetsJson as AssetsJson;
  const libraries = json.libraries ?? {};
  const want = `${packageId}/${resolvedVersion}`.toLowerCase();
  const key = Object.keys(libraries).find((k) => k.toLowerCase() === want);
  return supportedFrameworksFromFiles(key ? libraries[key].files : undefined);
}
