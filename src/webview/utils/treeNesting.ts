/**
 * How a nested dependency tree is indented (#137).
 *
 * A level below the top draws a guide line and steps in by `TREE_STEP_PX`, for
 * at most `TREE_MAX_STEPS` levels. Past that a level steps in only
 * `TREE_CAPPED_STEP_PX` and draws no line, so one pathological graph cannot eat
 * a details pane that can be dragged down to 180px. Stacked lines were tried
 * and dropped — two pixels apart they merge into one thick stroke.
 *
 * `depth` is the number of ancestors a row has: 0 for a top-level row (no
 * guide, no step), 1 for its children, and so on. The CSS in `global.css`
 * (`.dep-tree__children`) spells out the same numbers — its test reads the
 * stylesheet so the two cannot drift apart.
 */
export const TREE_STEP_PX = 14;
export const TREE_MAX_STEPS = 3;
/** What a level past the cap adds: a small step, no line. */
export const TREE_CAPPED_STEP_PX = 4;

/** True when this depth takes the small step and draws no line of its own. */
export function isTreeDepthCapped(depth: number): boolean {
  return depth > TREE_MAX_STEPS;
}

/** What one level at `depth` adds to the row's left edge. */
export function treeStepPx(depth: number): number {
  if (depth <= 0) return 0;
  return isTreeDepthCapped(depth) ? TREE_CAPPED_STEP_PX : TREE_STEP_PX;
}

/** The left edge of a row at `depth`, guide lines included. */
export function treeIndentPx(depth: number): number {
  let total = 0;
  for (let level = 1; level <= depth; level += 1) total += treeStepPx(level);
  return total;
}

/** Guide lines that run beside a row at `depth` — one per ancestor, up to the cap. */
export function treeGuideCount(depth: number): number {
  return Math.min(Math.max(0, depth), TREE_MAX_STEPS);
}
