import {
  normalizeSeverity,
  parseCatalogEntry,
  parseRegistrationIndex,
  parseRegistrationPageEntries,
} from '../../nugetRegistration';
import nexusHostedRegistration from '../fixtures/nexus-hosted-registration.json';

/** Named after what a document contained, never after who served it. */
const leaf = (catalogEntry: Record<string, unknown>, packageContent?: string) =>
  ({ catalogEntry, packageContent });

describe('parseCatalogEntry', () => {
  it('keeps every field a rich document carries', () => {
    const entry = parseCatalogEntry(leaf({
      version: '13.0.4',
      authors: 'Example Author',
      description: 'A library.',
      tags: ['json', 'serializer'],
      projectUrl: 'https://example.com/',
      licenseExpression: 'MIT',
      published: '2024-05-01T10:00:00Z',
      listed: true,
    }, 'https://feed.example/flat/x/13.0.4/x.13.0.4.nupkg'));

    expect(entry).toMatchObject({
      version: '13.0.4',
      authors: 'Example Author',
      tags: ['json', 'serializer'],
      licenseExpression: 'MIT',
      listed: true,
      packageContent: 'https://feed.example/flat/x/13.0.4/x.13.0.4.nupkg',
    });
  });

  it('reads a leaner document without inventing what it did not say', () => {
    const entry = parseCatalogEntry(leaf({ version: '1.0.0', description: 'Short.' }));

    expect(entry).toMatchObject({ version: '1.0.0', description: 'Short.' });
    expect(entry?.deprecation).toBeUndefined();
    expect(entry?.vulnerabilities).toBeUndefined();
    expect(entry?.licenseExpression).toBeUndefined();
  });

  it('refuses an entry with no version, since nothing else identifies it', () => {
    expect(parseCatalogEntry(leaf({ description: 'No version here.' }))).toBeUndefined();
    expect(parseCatalogEntry({})).toBeUndefined();
    expect(parseCatalogEntry(null)).toBeUndefined();
  });

  it('accepts tags as one string as readily as a list', () => {
    expect(parseCatalogEntry(leaf({ version: '1.0.0', tags: 'json serializer' }))?.tags)
      .toEqual(['json', 'serializer']);
  });

  it('reads the hidden-package sentinel date as unlisted when no flag is given', () => {
    expect(parseCatalogEntry(leaf({ version: '1.0.0', published: '1900-01-01T00:00:00Z' }))?.listed)
      .toBe(false);
    expect(parseCatalogEntry(leaf({ version: '1.0.0', published: '2024-01-01T00:00:00Z' }))?.listed)
      .toBe(true);
    expect(parseCatalogEntry(leaf({ version: '1.0.0' }))?.listed).toBeUndefined();
  });

  it('lets an explicit flag override that date', () => {
    expect(parseCatalogEntry(leaf({ version: '1.0.0', published: '1900-01-01T00:00:00Z', listed: true }))?.listed)
      .toBe(true);
  });

  it('normalises severity however the document encoded it', () => {
    expect(parseCatalogEntry(leaf({
      version: '1.0.0',
      vulnerabilities: [
        { advisoryUrl: 'https://example.com/a', severity: '2' },
        { advisoryUrl: 'https://example.com/b', severity: 3 },
      ],
    }))?.vulnerabilities).toEqual([
      { advisoryUrl: 'https://example.com/a', severity: 2 },
      { advisoryUrl: 'https://example.com/b', severity: 3 },
    ]);
  });

  it('keeps a deprecation whose reasons this build does not recognise', () => {
    // The set is closed, so an unfamiliar value still means the package is
    // deprecated — for a reason that cannot be named here.
    expect(parseCatalogEntry(leaf({
      version: '1.0.0',
      deprecation: { message: 'Use the other one.', reasons: ['SomethingNew'] },
    }))?.deprecation).toEqual({
      message: 'Use the other one.',
      reasons: ['Other'],
      alternatePackage: undefined,
    });
  });

  it('reads reasons case-insensitively and carries the replacement package', () => {
    expect(parseCatalogEntry(leaf({
      version: '1.0.0',
      deprecation: { reasons: ['legacy', 'CRITICALBUGS'], alternatePackage: { id: 'Example.Next', range: '*' } },
    }))?.deprecation).toEqual({
      message: undefined,
      reasons: ['Legacy', 'CriticalBugs'],
      alternatePackage: { id: 'Example.Next', range: '*' },
    });
  });

  it('keeps declared ranges exactly as written, brackets included', () => {
    expect(parseCatalogEntry(leaf({
      version: '1.0.0',
      dependencyGroups: [
        { targetFramework: 'net9.0', dependencies: [{ id: 'Example.Core', range: '[7.2.0, )' }] },
        { targetFramework: 'net10.0', dependencies: [] },
      ],
    }))?.dependencyGroups).toEqual([
      { targetFramework: 'net9.0', dependencies: [{ id: 'Example.Core', range: '[7.2.0, )' }] },
      { targetFramework: 'net10.0', dependencies: [] },
    ]);
  });

  it('keeps a group with no dependencies, because it still states a framework', () => {
    const groups = parseCatalogEntry(leaf({
      version: '1.0.0',
      dependencyGroups: [{ targetFramework: 'net8.0' }],
    }))?.dependencyGroups;

    expect(groups).toEqual([{ targetFramework: 'net8.0', dependencies: [] }]);
  });
});

describe('normalizeSeverity', () => {
  it('accepts the scale in either encoding and rejects anything else', () => {
    expect(normalizeSeverity(0)).toBe(0);
    expect(normalizeSeverity('3')).toBe(3);
    expect(normalizeSeverity(4)).toBeUndefined();
    expect(normalizeSeverity('high')).toBeUndefined();
    expect(normalizeSeverity(undefined)).toBeUndefined();
  });
});

describe('parseRegistrationIndex', () => {
  it('reads an inlined page without needing a second request', () => {
    const pages = parseRegistrationIndex({
      items: [{
        '@id': 'https://feed.example/reg/a/index.json#page/1.0.0/2.0.0',
        lower: '1.0.0',
        upper: '2.0.0',
        items: [leaf({ version: '1.0.0' }), leaf({ version: '2.0.0' })],
      }],
    });

    expect(pages?.[0].entries?.map((e) => e.version)).toEqual(['1.0.0', '2.0.0']);
    expect(pages?.[0].lower).toBe('1.0.0');
  });

  it('keeps the address of a page it must fetch, and states its bounds', () => {
    const pages = parseRegistrationIndex({
      items: [{ '@id': 'https://feed.example/reg/a/page/1.json', lower: '1.0.0', upper: '5.0.0' }],
    });

    expect(pages).toEqual([{
      url: 'https://feed.example/reg/a/page/1.json',
      lower: '1.0.0',
      upper: '5.0.0',
      entries: undefined,
    }]);
  });

  it('says it read nothing when the document is not a registration index', () => {
    expect(parseRegistrationIndex({ versions: ['1.0.0'] })).toBeUndefined();
    expect(parseRegistrationIndex(null)).toBeUndefined();
  });
});

describe('parseRegistrationPageEntries', () => {
  it('skips leaves it cannot read instead of discarding the page', () => {
    expect(parseRegistrationPageEntries({
      items: [leaf({ version: '1.0.0' }), { catalogEntry: {} }, 'nonsense'],
    })?.map((e) => e.version)).toEqual(['1.0.0']);
  });

  it('reports an empty page as empty, not as unreadable', () => {
    expect(parseRegistrationPageEntries({ items: [] })).toEqual([]);
    expect(parseRegistrationPageEntries({})).toBeUndefined();
  });

  // Recorded from the project's own lab Nexus (Sonatype Nexus 3.76.0, #123):
  // it rewrites every modern moniker into the `.NETFramework` family before
  // this parser ever sees it. Repairing that reading is `frameworkKey`'s job
  // (frameworkMoniker.test.ts) — a parser that corrected it here would hide
  // what the feed actually said from the cache and from a trace, which is
  // where the next feed like this one gets diagnosed.
  it('keeps the feed\'s own spelling, mangled or not', () => {
    const entries = parseRegistrationPageEntries(nexusHostedRegistration);
    expect(entries).toHaveLength(1);
    expect(entries?.[0].dependencyGroups?.map((g) => g.targetFramework)).toEqual([
      '.NETFramework1.0.0', '.NETStandard2.0', '.NETFramework9.0', '.NETFramework8.0',
    ]);
  });
});
