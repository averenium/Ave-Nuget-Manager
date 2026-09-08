import { rowsNeeded, visibleBadgeCount } from '../../webview/utils/badgeRows';

const WIDTH = 138;
const GAP = 5;

describe('rowsNeeded', () => {
  it('packs greedily, counting the gap only between items on a row', () => {
    // 43 + 5 + 43 + 5 + 43 = 139 > 138, so the third starts a second row.
    expect(rowsNeeded([43, 43, 43], WIDTH, GAP)).toBe(2);
    expect(rowsNeeded([43, 43], WIDTH, GAP)).toBe(1);
  });

  it('gives an item wider than the row a row of its own rather than looping', () => {
    expect(rowsNeeded([300, 40], WIDTH, GAP)).toBe(2);
  });

  it('counts one row for an empty list', () => {
    expect(rowsNeeded([], WIDTH, GAP)).toBe(1);
  });
});

describe('visibleBadgeCount', () => {
  it('returns null when everything already fits', () => {
    expect(visibleBadgeCount([40, 40, 40], 18, WIDTH, GAP, 3)).toBeNull();
  });

  it('gives back only the badges the marker actually displaces', () => {
    // Ten 40px badges, three to a row (40+5+40+5+40 = 130 of 138). Nine plus
    // the marker would push it onto a fourth row (130+5+18 = 153), eight would
    // not (85+5+18 = 108).
    expect(visibleBadgeCount(Array<number>(10).fill(40), 18, WIDTH, GAP, 3)).toBe(8);
  });

  it('keeps a badge the shorter list would have room for once it re-packs', () => {
    // System.Linq's real shape: two narrow monikers, then a run of
    // `netstandard*` ones wide enough to take a row each.
    const widths = [43, 43, 75, 75, 75, 75, 75, 73, 38, 38, 38, 33, 33, 138];

    expect(visibleBadgeCount(widths, 18, WIDTH, GAP, 3)).toBe(4);

    // Counting what lands in the untruncated list's first three rows and
    // handing one back to the marker gives three — and those three, re-packed
    // without the tail, only occupy two rows, wasting the third.
    expect(rowsNeeded([...widths.slice(0, 3), 18], WIDTH, GAP)).toBe(2);
    expect(rowsNeeded([...widths.slice(0, 4), 18], WIDTH, GAP)).toBe(3);
  });

  it('handles a list of full-width badges, one per row', () => {
    // Each badge takes its own row, so two of them plus the marker's row fit.
    expect(visibleBadgeCount([130, 130, 130, 130], 18, WIDTH, GAP, 3)).toBe(2);
  });

  it('never returns zero — one badge plus the marker beats the marker alone', () => {
    expect(visibleBadgeCount([130, 130], 130, WIDTH, GAP, 1)).toBe(1);
  });

  it('returns null for an empty list or an unmeasured container', () => {
    expect(visibleBadgeCount([], 18, WIDTH, GAP, 3)).toBeNull();
    expect(visibleBadgeCount([40, 40], 18, 0, GAP, 3)).toBeNull();
  });
});
