/**
 * Resolves one package's own dependency tree (declared range + resolved
 * version, recursively) straight from `project.assets.json` — not
 * `.deps.json`, which is a build output carrying only resolved versions and
 * where the declared range is lost (#86 design pass, "Dependencies").
 * `assets.json` holds both sides for every package in the restore graph,
 * plus the full supported-framework list and which asset was selected.
 */

import { assetsLibraryId } from './packageGraph';
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

interface AssetsTargetLib {
  type?: string;
  dependencies?: Record<string, string>;
  compile?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
}

interface AssetsJson {
  targets?: Record<string, Record<string, AssetsTargetLib>>;
  libraries?: Record<string, { files?: string[] }>;
}

function findLibKey(target: Record<string, AssetsTargetLib>, id: string): string | undefined {
  const wantLower = id.toLowerCase();
  return Object.keys(target).find((k) => assetsLibraryId(k)?.toLowerCase() === wantLower);
}

/** The version half of an `Id/1.2.3` assets library key — `assetsLibraryId` already strips it off to get the id half. */
function versionFromLibKey(libKey: string): string | undefined {
  const slash = libKey.lastIndexOf('/');
  return slash >= 0 ? libKey.slice(slash + 1) : undefined;
}

function selectedAssetFolder(lib: AssetsTargetLib): string | undefined {
  const path = Object.keys(lib.compile ?? {})[0] ?? Object.keys(lib.runtime ?? {})[0];
  return path ? /^lib\/([^/]+)\//.exec(path)?.[1] : undefined;
}

interface PendingRow {
  row: DependencyRow;
  lib?: AssetsTargetLib;
}

function makeRow(
  target: Record<string, AssetsTargetLib>,
  depId: string,
  declaredRange: string,
): PendingRow {
  const libKey = findLibKey(target, depId);
  const lib = libKey ? target[libKey] : undefined;
  const resolvedVersion = libKey ? versionFromLibKey(libKey) : undefined;
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
  target: Record<string, AssetsTargetLib>,
  rootId: string,
  directDependencies: Record<string, string>,
): DependencyRow[] {
  const seen = new Set<string>([rootId.toLowerCase()]);
  const roots: DependencyRow[] = [];
  let frontier: PendingRow[] = [];

  for (const [depId, range] of Object.entries(directDependencies)) {
    if (seen.has(depId.toLowerCase())) continue;
    seen.add(depId.toLowerCase());
    const pending = makeRow(target, depId, range);
    roots.push(pending.row);
    frontier.push(pending);
  }

  while (frontier.length > 0) {
    const next: PendingRow[] = [];
    for (const { row, lib } of frontier) {
      for (const [childId, childRange] of Object.entries(lib?.dependencies ?? {})) {
        if (seen.has(childId.toLowerCase())) continue;
        seen.add(childId.toLowerCase());
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
  const json = assetsJson as AssetsJson;
  const target = json.targets?.[framework];
  if (!target) return undefined;
  const libKey = findLibKey(target, packageId);
  if (!libKey) return undefined;
  // Guard against a stale caller-supplied version: assets.json only ever
  // resolves one version per package per target, so a mismatch means the
  // caller's `resolvedVersion` no longer matches what was actually restored.
  if (versionFromLibKey(libKey) !== resolvedVersion) return undefined;
  const lib = target[libKey];

  return {
    framework,
    selectedAsset: selectedAssetFolder(lib),
    rows: buildRows(target, packageId, lib.dependencies ?? {}),
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
