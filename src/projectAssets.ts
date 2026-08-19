import { promises as fs } from 'fs';
import * as path from 'path';
import { parseAssetsDependencies, reachableAmong } from './packageGraph';
import type { ImplicitPackage, InstalledPackage } from './types';

export async function readProjectPackageDependencies(
  projectPath: string,
): Promise<Map<string, string[]>> {
  const assetsPath = path.join(path.dirname(projectPath), 'obj', 'project.assets.json');
  try {
    const raw = await fs.readFile(assetsPath, 'utf8');
    return parseAssetsDependencies(JSON.parse(raw) as unknown);
  } catch {
    return new Map();
  }
}

type GraphStamped<T extends { id: string; projectPath: string }> = T & { dependencies?: string[] };

async function loadProjectGraphs(
  projectPaths: string[],
): Promise<Map<string, Map<string, string[]>>> {
  const graphs = new Map<string, Map<string, string[]>>();
  await Promise.all([...new Set(projectPaths)].map(async (projectPath) => {
    graphs.set(projectPath, await readProjectPackageDependencies(projectPath));
  }));
  return graphs;
}

function stampFromGraphs<T extends { id: string; projectPath: string }>(
  packages: T[],
  among: Set<string>,
  graphs: Map<string, Map<string, string[]>>,
): GraphStamped<T>[] {
  return packages.map((pkg) => {
    const graph = graphs.get(pkg.projectPath);
    if (!graph) return pkg;
    const deps = reachableAmong(graph, pkg.id, among);
    return deps.length > 0 ? { ...pkg, dependencies: deps } : pkg;
  });
}

/** Stamp each installed package with restore-graph deps reachable among installed ids. */
export async function attachAssetsDependencies(
  packages: InstalledPackage[],
): Promise<InstalledPackage[]> {
  if (packages.length === 0) return packages;
  const among = new Set(packages.map((pkg) => pkg.id.toLowerCase()));
  const graphs = await loadProjectGraphs(packages.map((pkg) => pkg.projectPath));
  return stampFromGraphs(packages, among, graphs);
}

/**
 * Stamp installed + implicit packages with restore-graph deps reachable among
 * both sets, so a top-level package lists the implicit libs it pulls in.
 */
export async function stampListedDependencies(
  installed: InstalledPackage[],
  implicit: ImplicitPackage[],
): Promise<{ installed: InstalledPackage[]; implicit: ImplicitPackage[] }> {
  if (installed.length === 0 && implicit.length === 0) {
    return { installed, implicit };
  }
  const among = new Set(
    [...installed, ...implicit].map((pkg) => pkg.id.toLowerCase()),
  );
  const graphs = await loadProjectGraphs([
    ...installed.map((pkg) => pkg.projectPath),
    ...implicit.map((pkg) => pkg.projectPath),
  ]);
  return {
    installed: stampFromGraphs(installed, among, graphs),
    implicit: stampFromGraphs(implicit, among, graphs),
  };
}
