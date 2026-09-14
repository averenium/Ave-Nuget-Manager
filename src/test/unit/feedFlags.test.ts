import { feedFlags } from '../../webviewMessageBroker';
import type { SearchedVersionMetadata } from '../../types';

function enriched(rows: Record<string, Partial<SearchedVersionMetadata>>): Record<string, SearchedVersionMetadata> {
  return rows as Record<string, SearchedVersionMetadata>;
}

describe('feedFlags', () => {
  it('keeps only the versions the feed actually marks', () => {
    const flags = feedFlags(enriched({
      '1.0.0': { description: 'first', authors: 'Example' },
      '2.0.0': { description: 'second', deprecation: 'Use Example.Next instead.' },
      '3.0.0': { description: 'third', vulnerable: true },
    }));
    expect(flags).toEqual({
      '2.0.0': { vulnerable: undefined, deprecation: 'Use Example.Next instead.' },
      '3.0.0': { vulnerable: true, deprecation: undefined },
    });
  });

  it('drops the rest of the enrich answer, which the list cannot use', () => {
    const flags = feedFlags(enriched({
      '1.0.0': {
        description: 'a long description',
        authors: 'Example',
        projectUrl: 'https://example.com',
        licenseUrl: 'https://example.com/licence',
        tags: 'one two three',
        deprecation: 'Deprecated.',
      },
    }));
    // `advisories` is part of the mark, not part of the rest: the panel names
    // which advisory and how bad, and only the feed states that. `published` is
    // carried for the same reason — the panel needs the newest version's date
    // and that is not the version it fetched metadata for (#114).
    expect(Object.keys(flags!['1.0.0']))
      .toEqual(['vulnerable', 'deprecation', 'advisories', 'published']);
  });

  it('says nothing at all when no version is marked', () => {
    expect(feedFlags(enriched({ '1.0.0': { description: 'plain' } }))).toBeUndefined();
  });

  it('keeps a version the feed only dated, which the facts line needs (#114)', () => {
    // Nothing is wrong with a version for having a date, but the panel cannot
    // say how long a package has gone without a release unless the date of the
    // newest version travels — and that is not the version it fetched.
    const flags = feedFlags(enriched({ '1.0.0': { published: '2024-05-01T10:00:00Z' } }));
    expect(flags!['1.0.0'].published).toBe('2024-05-01T10:00:00Z');
    expect(flags!['1.0.0'].vulnerable).toBeUndefined();
  });

  it('says nothing when the enrich answer carried no per-version data', () => {
    expect(feedFlags(undefined)).toBeUndefined();
  });

  it('carries a version that is both vulnerable and deprecated', () => {
    expect(feedFlags(enriched({
      '1.0.0': { vulnerable: true, deprecation: 'Deprecated and unsafe.' },
    }))).toEqual({ '1.0.0': { vulnerable: true, deprecation: 'Deprecated and unsafe.' } });
  });
});
