import { sortByRelevance } from '../../webview/utils/search';

/**
 * Measured on the public feed, query `imagesharp`: the results that end with
 * `.ImageSharp` all score the same, so the local score cannot tell them apart.
 * The feed had
 * already ranked them — `SixLabors.ImageSharp` led with 309 million downloads
 * against 6 million for the next — and breaking the tie alphabetically threw
 * that away, burying the obvious answer in sixth place.
 */
const FEED_ORDER = [
  'SixLabors.ImageSharp',
  'Umbraco.Cms.Imaging.ImageSharp',
  'Blurhash.ImageSharp',
  'OxyPlot.ImageSharp',
].map((id) => ({ id }));

describe('sortByRelevance', () => {
  it('keeps the order it was given where it cannot tell results apart', () => {
    const sorted = sortByRelevance(FEED_ORDER, 'imagesharp', { keepOrderOnTies: true });
    expect(sorted.map((p) => p.id)).toEqual(FEED_ORDER.map((p) => p.id));
  });

  it('falls back to the alphabet when there is no order worth keeping', () => {
    // An installed list arrives in no meaningful order, so the alphabet is the
    // only tie-break that reads as deliberate.
    const sorted = sortByRelevance(FEED_ORDER, 'imagesharp');
    expect(sorted.map((p) => p.id)).toEqual([
      'Blurhash.ImageSharp',
      'OxyPlot.ImageSharp',
      'SixLabors.ImageSharp',
      'Umbraco.Cms.Imaging.ImageSharp',
    ]);
  });

  it('still lifts a better match above the order it was given', () => {
    // Keeping ties is not the same as keeping everything: a package the query
    // names outright still comes first, and one it scores worse still sinks.
    const sorted = sortByRelevance(
      [
        { id: 'Umbraco.Cms.Imaging.ImageSharp' },
        { id: 'SixLabors.ImageSharp.Drawing' },
        { id: 'ImageSharp' },
      ],
      'imagesharp',
      { keepOrderOnTies: true },
    );
    expect(sorted.map((p) => p.id)).toEqual([
      'ImageSharp',
      'Umbraco.Cms.Imaging.ImageSharp',
      'SixLabors.ImageSharp.Drawing',
    ]);
  });

  it('leaves a query too short to mean anything untouched', () => {
    const sorted = sortByRelevance(FEED_ORDER, 'i', { keepOrderOnTies: true });
    expect(sorted.map((p) => p.id)).toEqual(FEED_ORDER.map((p) => p.id));
  });
});
