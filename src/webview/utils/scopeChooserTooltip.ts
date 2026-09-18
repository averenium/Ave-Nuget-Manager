import type { ScopeChoiceProject, ScopeChoiceSolution } from '../../types';

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Full identity of a solution row, for its `title`/`aria-label` (#127) — the
 * left column is a fraction of a bottom panel, so the name and its directory
 * clip independently and neither is readable without this. Relative to the
 * folder the chooser is for, like the row itself, rather than `s.path`: the
 * absolute prefix is the part the reader already knows.
 */
export function solutionRowLabel(s: ScopeChoiceSolution): string {
  const name = fileNameOf(s.path);
  const relativePath = s.relativeDir ? `${s.relativeDir}/${name}` : name;
  return `${relativePath} — ${s.projectCount} project${s.projectCount === 1 ? '' : 's'}`;
}

/**
 * Full identity of a project row (#127) — its path relative to the folder.
 * In `tight` mode the row drops the directory entirely to save width, so
 * this tooltip is the only place two same-named projects in different
 * folders can still be told apart.
 */
export function projectRowLabel(p: ScopeChoiceProject): string {
  return p.relativePath;
}

/** Full identity of the "all projects" row (#127), in the row's own words. */
export function allProjectsRowLabel(totalProjects: number, folderCovers: string): string {
  return `All ${totalProjects} project${totalProjects === 1 ? '' : 's'} — ${folderCovers}`;
}
