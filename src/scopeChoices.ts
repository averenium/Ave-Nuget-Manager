import * as path from 'path';
import { promises as fs } from 'fs';
import { findProjectsInFolder, findSolutionsInFolder } from './dotnetWorkspace';
import type { SolutionParser } from './solutionParser';
import type { ScopeChoices, ScopeChoiceProject, ScopeChoiceSolution } from './types';

function relativeDir(folderPath: string, filePath: string): string {
  const rel = path.relative(folderPath, path.dirname(filePath)).split(path.sep).join('/');
  return rel === '.' ? '' : rel;
}

/** `''` (root) sorts first, then by how many segments deep the solution sits. */
function depthOf(dir: string): number {
  return dir === '' ? 0 : dir.split('/').length;
}

async function mtimeOf(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).mtimeMs;
  } catch {
    return 0;
  }
}

async function solutionCandidate(
  solutionPath: string,
  folderPath: string,
  solutionParser: SolutionParser,
): Promise<ScopeChoiceSolution> {
  const projects = await solutionParser.getProjects(solutionPath).catch(() => []);
  return {
    path: solutionPath,
    relativeDir: relativeDir(folderPath, solutionPath),
    projectCount: projects.length,
    projectPaths: projects.map((p) => p.absolutePath),
  };
}

/**
 * Most likely first (#113 item 5): the solution at the folder root, then by
 * directory depth, then — among ties — the one touched most recently.
 */
async function sortByLikelihood(solutions: ScopeChoiceSolution[]): Promise<ScopeChoiceSolution[]> {
  const withMtime = await Promise.all(
    solutions.map(async (s) => ({ s, mtime: await mtimeOf(s.path) })),
  );
  withMtime.sort((a, b) => {
    const byDepth = depthOf(a.s.relativeDir) - depthOf(b.s.relativeDir);
    if (byDepth !== 0) return byDepth;
    return b.mtime - a.mtime;
  });
  return withMtime.map((w) => w.s);
}

function projectCandidate(
  project: { name: string; relativePath: string; absolutePath: string },
): ScopeChoiceProject {
  return { path: project.absolutePath, name: project.name, relativePath: project.relativePath };
}

/**
 * Everything the in-panel folder-scope chooser needs to ask "what should be
 * managed?" for `folderPath` (#113) — every solution directly or recursively
 * under it, and every `.csproj`/`.fsproj` regardless of which solution (if
 * any) already covers it, so picking a single project directly is always
 * possible even when solutions exist.
 *
 * `null` when the folder holds nothing a scope could be built from.
 */
export async function buildScopeChoices(
  folderPath: string,
  solutionParser: SolutionParser,
): Promise<ScopeChoices | null> {
  const [solutionPaths, allProjects] = await Promise.all([
    findSolutionsInFolder(folderPath),
    findProjectsInFolder(folderPath),
  ]);
  if (solutionPaths.length === 0 && allProjects.length === 0) return null;

  const solutions = await Promise.all(solutionPaths.map((p) => solutionCandidate(p, folderPath, solutionParser)));
  const projects = allProjects.map(projectCandidate);

  return {
    folderPath,
    totalProjects: projects.length,
    solutions: await sortByLikelihood(solutions),
    offerAllProjects: projects.length > 1,
    projects,
  };
}
