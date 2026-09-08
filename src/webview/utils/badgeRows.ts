/**
 * How many badges of a wrapping row survive a row limit (#86, the target
 * framework list). Counting the badges that land in the first N rows of the
 * full list is not the answer: the ones that remain re-pack once the tail is
 * gone, and the `…` that replaces it is narrower than what it replaced, so a
 * naive count leaves the last row half empty. Simulating the wrap is exact,
 * and it is pure arithmetic — the DOM is only asked for the widths.
 */

/** Greedy line breaking, the same rule flex-wrap uses: an item starts a new row when it no longer fits the current one. */
export function rowsNeeded(widths: number[], containerWidth: number, gap: number): number {
  let rows = 1;
  let used = 0;
  for (const width of widths) {
    if (used === 0) {
      used = width;
    } else if (used + gap + width <= containerWidth) {
      used += gap + width;
    } else {
      rows++;
      used = width;
    }
  }
  return rows;
}

/**
 * The number of leading badges to render, or `null` when they all fit and no
 * `…` is needed. Never returns 0: one badge plus the marker says more than the
 * marker alone.
 */
export function visibleBadgeCount(
  widths: number[],
  ellipsisWidth: number,
  containerWidth: number,
  gap: number,
  maxRows: number,
): number | null {
  if (widths.length === 0 || containerWidth <= 0) return null;
  if (rowsNeeded(widths, containerWidth, gap) <= maxRows) return null;

  for (let count = widths.length - 1; count >= 1; count--) {
    const withMarker = [...widths.slice(0, count), ellipsisWidth];
    if (rowsNeeded(withMarker, containerWidth, gap) <= maxRows) return count;
  }
  return 1;
}
