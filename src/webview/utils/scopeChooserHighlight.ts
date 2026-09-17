import { pathsEqual } from '../../pathCompare';
import type { ScopeChoiceSolution } from '../../types';

/** Projects the hovered solution covers, or `null` when nothing is hovered. */
export function litProjectPathsFor(
  solutions: ScopeChoiceSolution[],
  hoveredSolutionPath: string | null,
): string[] | null {
  if (!hoveredSolutionPath) return null;
  const solution = solutions.find((s) => s.path === hoveredSolutionPath);
  return solution ? solution.projectPaths : null;
}

/**
 * Whether a project's row should dim while a solution is hovered — `false`
 * when nothing is hovered, or when the project belongs to the hovered
 * solution. Compared with `pathsEqual` rather than `===`: a solution's own
 * `projectPaths` (from `SolutionParser`) and the folder's independently
 * scanned project list can name the same file with different casing or as
 * relative vs. absolute, and a `===` mismatch there would dim a project that
 * genuinely belongs to the hovered solution.
 */
export function isProjectDimmed(litProjectPaths: string[] | null, projectPath: string): boolean {
  if (litProjectPaths === null) return false;
  return !litProjectPaths.some((sp) => pathsEqual(sp, projectPath));
}
