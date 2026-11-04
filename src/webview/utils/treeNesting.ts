/**
 * How a nested dependency tree is indented (#137).
 *
 * A level below the top draws a guide line and steps in by `TREE_STEP_PX`, for
 * at most `TREE_MAX_STEPS` levels. Past that the step stops growing: every
 * further level adds only its own guide line, `TREE_CAPPED_STEP_PX` apart, so
 * the nesting stays legible while one pathological graph cannot eat a details
 * pane that can be dragged down to 180px.
 *
 * `depth` is the number of ancestors a row has: 0 for a top-level row (no
 * guide, no step), 1 for its children, and so on. The CSS in `global.css`
 * (`.dep-tree__children`) spells out the same numbers — its test reads the
 * stylesheet so the two cannot drift apart.
 */
export const TREE_STEP_PX = 14;
export const TREE_MAX_STEPS = 3;
/** One guide line plus the pixel that keeps it apart from the one before. */
export const TREE_CAPPED_STEP_PX = 2;

/** True when this depth no longer indents — only its guide line is added. */
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

/** Guide lines that run beside a row at `depth` — one per ancestor. */
export function treeGuideCount(depth: number): number {
  return Math.max(0, depth);
}
