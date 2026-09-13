import { HttpCatalogBackend, type ResolvedConfigSources } from '../../backend/httpCatalogBackend';
import type { INuGetBackend } from '../../backend/INuGetBackend';
import type { CatalogVersionEntry } from '../../nugetRegistration';
import type { SourceCapabilityStore } from '../../nugetSourceCapabilities';
import type { VersionLadder } from '../../nugetVersionLadder';
import type { PackageSearch } from '../../nugetSearch';
import { compareSemVer } from '../../semver';

/**
 * The decorator is judged by one question only: when does the CLI still run?
 * Everything here describes a situation, never a product.
 */
const FEED_A = 'https://a.example/v3/index.json';
const FEED_B = 'https://b.example/v3/index.json';

function cliStub(answer: Record<string, { versions: string[]; versionFlags?: Record<string, { vulnerable?: boolean; deprecation?: string }> }>) {
  const calls: string[][] = [];
  const backend = {
    getAllVersions: async (_id: string, configFiles: string[]) => {
      calls.push(configFiles);
      const versions = new Set<string>();
      const versionFlags: Record<string, { vulnerable?: boolean; deprecation?: string }> = {};
      for (const file of configFiles) {
        for (const v of answer[file]?.versions ?? []) versions.add(v);
        Object.assign(versionFlags, answer[file]?.versionFlags ?? {});
      }
      return { versions: [...versions], versionFlags };
    },
  } as unknown as INuGetBackend;
  return { backend, calls };
}

function ladderStub(options: {
  catalog?: Record<string, CatalogVersionEntry[] | undefined>;
  versions?: Record<string, string[] | undefined>;
}) {
  return {
    catalogFromSource: async (target: { url: string }) => options.catalog?.[target.url],
    versionsFromSource: async (target: { url: string }) => {
      const versions = options.versions?.[target.url];
      // The real ladder always answers newest first; the stub must too, or a
      // caller reading the first entry would be tested against a fiction.
      return versions
        ? { sourceUrl: target.url, versions: [...versions].sort((a, b) => compareSemVer(b, a)), rung: 'content' as const }
        : undefined;
    },
  } as unknown as VersionLadder;
}

function capabilityStub(withRegistration: string[]) {
  return {
    ensure: async (target: { url: string }) => ({ source: target.url, probedAt: 0, index: 'ok', resources: {} }),
    resourceUrls: (sourceUrl: string, baseType: string) =>
      baseType === 'RegistrationsBaseUrl' && withRegistration.includes(sourceUrl) ? ['https://x/reg/'] : [],
  } as unknown as SourceCapabilityStore;
}

const resolverFor = (map: Record<string, ResolvedConfigSources>) =>
  async (configFile: string) => map[configFile] ?? { targets: [], hasNonHttpSource: false };

const httpOnly = (...urls: string[]): ResolvedConfigSources => ({
  targets: urls.map((url) => ({ url })),
  hasNonHttpSource: false,
});

const entry = (version: string, extra: Partial<CatalogVersionEntry> = {}): CatalogVersionEntry =>
  ({ version, ...extra });

describe('HttpCatalogBackend with the feature switched off', () => {
  it('passes the call through untouched', async () => {
    const cli = cliStub({ 'a.config': { versions: ['1.0.0'] } });
    const ladder = ladderStub({ catalog: { [FEED_A]: [entry('9.9.9')] } });
    const backend = new HttpCatalogBackend(
      cli.backend,
      ladder,
      capabilityStub([]),
      resolverFor({ 'a.config': httpOnly(FEED_A) }),
      { isEnabled: () => false },
    );

    expect(await backend.getAllVersions('X', ['a.config'])).toEqual({
      versions: ['1.0.0'],
      versionFlags: {},
    });
    expect(cli.calls).toEqual([['a.config']]);
  });
});

describe('HttpCatalogBackend when HTTP can answer', () => {
  it('skips the CLI entirely and carries the per-version labels', async () => {
    const cli = cliStub({});
    const ladder = ladderStub({
      catalog: {
        [FEED_A]: [
          entry('1.0.0', { vulnerabilities: [{ advisoryUrl: 'https://example.com/a', severity: 2 }] }),
          entry('2.0.0', { deprecation: { message: 'Use the successor.', reasons: ['Legacy'] } }),
          entry('3.0.0'),
        ],
      },
    });
    const backend = new HttpCatalogBackend(
      cli.backend,
      ladder,
      capabilityStub([FEED_A]),
      resolverFor({ 'a.config': httpOnly(FEED_A) }),
      { isEnabled: () => true },
    );

    const result = await backend.getAllVersions('X', ['a.config']);

    expect(cli.calls).toEqual([]);
    expect(result.versions).toEqual(['3.0.0', '2.0.0', '1.0.0']);
    expect(result.versionFlags).toEqual({
      '1.0.0': { vulnerable: true, deprecation: undefined },
      '2.0.0': { vulnerable: undefined, deprecation: 'Use the successor.' },
    });
  });

  it('describes a deprecation the feed left unworded', async () => {
    const ladder = ladderStub({
      catalog: {
        [FEED_A]: [entry('1.0.0', {
          deprecation: { reasons: ['CriticalBugs'], alternatePackage: { id: 'Example.Next' } },
        })],
      },
    });
    const backend = new HttpCatalogBackend(
      cliStub({}).backend,
      ladder,
      capabilityStub([FEED_A]),
      resolverFor({ 'a.config': httpOnly(FEED_A) }),
      { isEnabled: () => true },
    );

    const result = await backend.getAllVersions('X', ['a.config']);

    expect(result.versionFlags['1.0.0'].deprecation).toBe('Deprecated (CriticalBugs). Use Example.Next instead.');
  });

  it('asks the same feed once across two configuration files', async () => {
    const cli = cliStub({});
    const ladder = ladderStub({ catalog: { [FEED_A]: [entry('1.0.0')] } });
    const seen: string[] = [];
    const watching = {
      catalogFromSource: async (target: { url: string }) => {
        seen.push(target.url);
        return (ladder as unknown as { catalogFromSource: (t: { url: string }) => Promise<unknown> })
          .catalogFromSource(target);
      },
      versionsFromSource: async () => undefined,
    } as unknown as VersionLadder;
    const backend = new HttpCatalogBackend(
      cli.backend,
      watching,
      capabilityStub([FEED_A]),
      resolverFor({
        'user.config': { targets: [{ url: FEED_A }], hasNonHttpSource: false },
        'solution.config': { targets: [{ url: `${FEED_A}/` }], hasNonHttpSource: false },
      }),
      { isEnabled: () => true },
    );

    const result = await backend.getAllVersions('X', ['user.config', 'solution.config']);

    expect(seen).toEqual([FEED_A]);
    expect(result.versions).toEqual(['1.0.0']);
    expect(cli.calls).toEqual([]);
  });

  it('unions two feeds behind one config file', async () => {
    const ladder = ladderStub({
      catalog: { [FEED_A]: [entry('1.0.0'), entry('2.0.0')], [FEED_B]: [entry('2.0.0'), entry('3.0.0')] },
    });
    const backend = new HttpCatalogBackend(
      cliStub({}).backend,
      ladder,
      capabilityStub([FEED_A, FEED_B]),
      resolverFor({ 'a.config': httpOnly(FEED_A, FEED_B) }),
      { isEnabled: () => true },
    );

    expect((await backend.getAllVersions('X', ['a.config'])).versions).toEqual(['3.0.0', '2.0.0', '1.0.0']);
  });

  it('accepts a plain version list from a feed that has no metadata resource', async () => {
    // The CLI reads its labels from that same resource, so a feed without one
    // would have produced an unlabelled list either way.
    const cli = cliStub({});
    const ladder = ladderStub({ catalog: { [FEED_A]: undefined }, versions: { [FEED_A]: ['1.0.0'] } });
    const backend = new HttpCatalogBackend(
      cli.backend,
      ladder,
      capabilityStub([]),
      resolverFor({ 'a.config': httpOnly(FEED_A) }),
      { isEnabled: () => true },
    );

    expect((await backend.getAllVersions('X', ['a.config'])).versions).toEqual(['1.0.0']);
    expect(cli.calls).toEqual([]);
  });
});

describe('HttpCatalogBackend when the CLI must still run', () => {
  it('refuses to answer without labels a feed is known to publish', async () => {
    const cli = cliStub({ 'a.config': { versions: ['1.0.0'], versionFlags: { '1.0.0': { vulnerable: true } } } });
    const ladder = ladderStub({ catalog: { [FEED_A]: undefined }, versions: { [FEED_A]: ['1.0.0'] } });
    const backend = new HttpCatalogBackend(
      cli.backend,
      ladder,
      capabilityStub([FEED_A]),
      resolverFor({ 'a.config': httpOnly(FEED_A) }),
      { isEnabled: () => true },
    );

    const result = await backend.getAllVersions('X', ['a.config']);

    expect(cli.calls).toEqual([['a.config']]);
    expect(result.versionFlags['1.0.0']).toEqual({ vulnerable: true });
  });

  it('sends only the files HTTP could not answer, and merges both answers', async () => {
    const cli = cliStub({ 'b.config': { versions: ['5.0.0'] } });
    const ladder = ladderStub({ catalog: { [FEED_A]: [entry('1.0.0')] } });
    const backend = new HttpCatalogBackend(
      cli.backend,
      ladder,
      capabilityStub([FEED_A]),
      resolverFor({ 'a.config': httpOnly(FEED_A), 'b.config': httpOnly(FEED_B) }),
      { isEnabled: () => true },
    );

    const result = await backend.getAllVersions('X', ['a.config', 'b.config']);

    expect(cli.calls).toEqual([['b.config']]);
    expect(result.versions).toEqual(['5.0.0', '1.0.0']);
  });

  it('leaves a file enabling a folder source to the CLI, whatever HTTP could do', async () => {
    const cli = cliStub({ 'a.config': { versions: ['1.0.0'] } });
    const ladder = ladderStub({ catalog: { [FEED_A]: [entry('2.0.0')] } });
    const backend = new HttpCatalogBackend(
      cli.backend,
      ladder,
      capabilityStub([FEED_A]),
      resolverFor({ 'a.config': { targets: [{ url: FEED_A }], hasNonHttpSource: true } }),
      { isEnabled: () => true },
    );

    const result = await backend.getAllVersions('X', ['a.config']);

    expect(cli.calls).toEqual([['a.config']]);
    expect(result.versions).toEqual(['1.0.0']);
  });

  it('falls back when the configuration cannot be read at all', async () => {
    const cli = cliStub({ 'a.config': { versions: ['1.0.0'] } });
    const backend = new HttpCatalogBackend(
      cli.backend,
      ladderStub({}),
      capabilityStub([]),
      async () => { throw new Error('unreadable'); },
      { isEnabled: () => true },
    );

    expect((await backend.getAllVersions('X', ['a.config'])).versions).toEqual(['1.0.0']);
    expect(cli.calls).toEqual([['a.config']]);
  });

  it('falls back for a file that enables nothing at all', async () => {
    const cli = cliStub({ 'a.config': { versions: ['1.0.0'] } });
    const backend = new HttpCatalogBackend(
      cli.backend,
      ladderStub({}),
      capabilityStub([]),
      resolverFor({ 'a.config': { targets: [], hasNonHttpSource: false } }),
      { isEnabled: () => true },
    );

    expect((await backend.getAllVersions('X', ['a.config'])).versions).toEqual(['1.0.0']);
    expect(cli.calls).toEqual([['a.config']]);
  });
});

describe('HttpCatalogBackend filling the details panel', () => {
  const richEntry = entry('13.0.4', {
    authors: 'Example Author',
    description: 'A library.',
    projectUrl: 'https://example.com/',
    licenseExpression: 'MIT',
    licenseUrl: 'https://licenses.example/MIT',
    tags: ['json', 'serializer'],
    published: '2024-05-01T10:00:00Z',
  });

  function panelBackend(catalog: Record<string, CatalogVersionEntry[] | undefined>, inner?: INuGetBackend) {
    return new HttpCatalogBackend(
      inner ?? cliStub({}).backend,
      ladderStub({ catalog }),
      capabilityStub(Object.keys(catalog)),
      resolverFor({ 'a.config': { targets: [{ url: FEED_A, name: 'example-feed' }], hasNonHttpSource: false } }),
      { isEnabled: () => true },
    );
  }

  it('states the date and the licence expression, which the CLI path cannot', async () => {
    const backend = panelBackend({ [FEED_A]: [richEntry] });

    expect(await backend.getMetadata('Newtonsoft.Json', '13.0.4', ['a.config'])).toEqual({
      id: 'Newtonsoft.Json',
      version: '13.0.4',
      authors: 'Example Author',
      projectUrl: 'https://example.com/',
      licenseUrl: 'https://licenses.example/MIT',
      license: { type: 'expression', value: 'MIT' },
      description: 'A library.',
      tags: ['json', 'serializer'],
      published: '2024-05-01T10:00:00Z',
      deprecation: undefined,
    });
  });

  it('describes the version asked for, not the newest one present', async () => {
    const backend = panelBackend({ [FEED_A]: [entry('1.0.0', { description: 'Old.' }), entry('2.0.0', { description: 'New.' })] });

    expect((await backend.getMetadata('X', '1.0.0', ['a.config'])).description).toBe('Old.');
  });

  it('describes a version withdrawn from the feed rather than pretending it is gone', async () => {
    // The caller already has it installed; an empty panel would be worse than
    // what the CLI shows.
    const backend = panelBackend({ [FEED_A]: [entry('1.0.0', { listed: false, description: 'Withdrawn.' })] });

    expect((await backend.getMetadata('X', '1.0.0', ['a.config'])).description).toBe('Withdrawn.');
  });

  it('hands a version no feed holds back to the CLI', async () => {
    const cli = cliStub({});
    const inner = {
      ...cli.backend,
      getMetadata: async (id: string, version: string) => ({ id, version, authors: 'from cli', description: '', tags: [] }),
    } as unknown as INuGetBackend;
    const backend = panelBackend({ [FEED_A]: [entry('1.0.0')] }, inner);

    expect((await backend.getMetadata('X', '9.9.9', ['a.config'])).authors).toBe('from cli');
  });

  it('names the feed that answered and keeps unlisted versions out of the picker', async () => {
    const backend = panelBackend({
      [FEED_A]: [
        entry('1.0.0'),
        entry('1.5.0', { listed: false }),
        entry('2.0.0', { description: 'Newest.', vulnerabilities: [{ severity: 1 }] }),
      ],
    });

    const enriched = await backend.enrichPackage('X', ['a.config']);

    expect(enriched.sourceName).toBe('example-feed');
    expect(enriched.latestVersion).toBe('2.0.0');
    expect(enriched.versions).toEqual(['2.0.0', '1.0.0']);
    expect(enriched.metadataByVersion?.['2.0.0']).toMatchObject({ description: 'Newest.', vulnerable: true });
    expect(enriched.metadataByVersion?.['1.5.0']).toBeUndefined();
  });

  it('skips a feed that does not hold the package and asks the next one', async () => {
    const backend = new HttpCatalogBackend(
      cliStub({}).backend,
      ladderStub({ catalog: { [FEED_A]: [], [FEED_B]: [entry('1.0.0')] } }),
      capabilityStub([FEED_A, FEED_B]),
      resolverFor({
        'a.config': {
          targets: [{ url: FEED_A, name: 'first' }, { url: FEED_B, name: 'second' }],
          hasNonHttpSource: false,
        },
      }),
      { isEnabled: () => true },
    );

    expect((await backend.enrichPackage('X', ['a.config'])).sourceName).toBe('second');
  });

  it('leaves both operations to the CLI while the feature is off', async () => {
    const inner = {
      getMetadata: async () => ({ id: 'X', version: '1.0.0', authors: 'cli', description: '', tags: [] }),
      enrichPackage: async () => ({ latestVersion: 'cli', sourceName: '', versions: [] }),
    } as unknown as INuGetBackend;
    const backend = new HttpCatalogBackend(
      inner,
      ladderStub({ catalog: { [FEED_A]: [richEntry] } }),
      capabilityStub([FEED_A]),
      resolverFor({ 'a.config': httpOnly(FEED_A) }),
      { isEnabled: () => false },
    );

    expect((await backend.getMetadata('X', '1.0.0', ['a.config'])).authors).toBe('cli');
    expect((await backend.enrichPackage('X', ['a.config'])).latestVersion).toBe('cli');
  });
});

describe('HttpCatalogBackend searching', () => {
  function searchStub(options: {
    hits?: Record<string, { id: string; latestVersion: string; description?: string }[] | undefined>;
    without?: string[];
  }) {
    const asked: string[] = [];
    const search = {
      hasSearch: (target: { url: string }) => !(options.without ?? []).includes(target.url),
      searchSource: async (target: { url: string }) => {
        asked.push(target.url);
        return options.hits?.[target.url];
      },
    } as unknown as PackageSearch;
    return { search, asked };
  }

  function searchBackend(
    options: Parameters<typeof searchStub>[0] & {
      versions?: Record<string, string[] | undefined>;
      inner?: INuGetBackend;
      targets?: ResolvedConfigSources;
    },
  ) {
    const stub = searchStub(options);
    const backend = new HttpCatalogBackend(
      options.inner ?? ({ searchPackages: async () => [] } as unknown as INuGetBackend),
      ladderStub({ versions: options.versions }),
      capabilityStub([]),
      resolverFor({
        'a.config': options.targets ?? {
          targets: [{ url: FEED_A, name: 'first' }, { url: FEED_B, name: 'second' }],
          hasNonHttpSource: false,
        },
      }),
      { isEnabled: () => true, search: stub.search },
    );
    return { backend, asked: stub.asked };
  }

  it('merges what each feed found, first source winning a duplicate id', async () => {
    const { backend } = searchBackend({
      hits: {
        [FEED_A]: [{ id: 'Example.Core', latestVersion: '1.0.0', description: 'From the first.' }],
        [FEED_B]: [{ id: 'Example.Core', latestVersion: '9.9.9' }, { id: 'Example.Extra', latestVersion: '2.0.0' }],
      },
    });

    expect(await backend.searchPackages('example', ['a.config'], [], false)).toEqual([
      { id: 'Example.Core', latestVersion: '1.0.0', description: 'From the first.', sourceName: 'first' },
      { id: 'Example.Extra', latestVersion: '2.0.0', description: undefined, sourceName: 'second' },
    ]);
  });

  it('finds a package by exact id on a feed whose search cannot see it', async () => {
    // A repository fronting an upstream searches only what it has cached, so
    // the package is invisible to search yet perfectly installable.
    const { backend } = searchBackend({
      hits: { [FEED_A]: [], [FEED_B]: [] },
      versions: { [FEED_A]: ['13.0.1', '13.0.4'] },
    });

    expect(await backend.searchPackages('Newtonsoft.Json', ['a.config'], [], false)).toEqual([
      { id: 'Newtonsoft.Json', latestVersion: '13.0.4', sourceName: 'first' },
    ]);
  });

  it('does not look up an exact id for a query that cannot be one', async () => {
    const { backend } = searchBackend({
      hits: { [FEED_A]: [], [FEED_B]: [] },
      versions: { [FEED_A]: ['1.0.0'] },
    });

    expect(await backend.searchPackages('json serializer', ['a.config'], [], false)).toEqual([]);
  });

  it('leaves out a feed with no search resource instead of failing the search', async () => {
    const cli = { searchPackages: async () => { throw new Error('CLI was used'); } } as unknown as INuGetBackend;
    const { backend, asked } = searchBackend({
      without: [FEED_B],
      hits: { [FEED_A]: [{ id: 'Example.Core', latestVersion: '1.0.0' }] },
      inner: cli,
    });

    const found = await backend.searchPackages('example', ['a.config'], [], false);

    expect(found.map((p) => p.id)).toEqual(['Example.Core']);
    expect(asked).toEqual([FEED_A]);
  });

  it('falls back to the CLI when a feed that has search could not answer', async () => {
    const cli = {
      searchPackages: async (_q: string, files: string[]) =>
        files.map((f) => ({ id: `from-${f}`, latestVersion: '1.0.0', sourceName: 'cli' })),
    } as unknown as INuGetBackend;
    const { backend } = searchBackend({ hits: { [FEED_A]: undefined }, inner: cli });

    expect((await backend.searchPackages('example', ['a.config'], [], false)).map((p) => p.id))
      .toEqual(['from-a.config']);
  });

  it('asks a feed once even when two configuration files enable it', async () => {
    // The chain routinely repeats a feed: a user-level file and a solution-level
    // one both enable it. Asking twice produced two identical rounds of requests.
    const stub = searchStub({ hits: { [FEED_A]: [{ id: 'Example.Core', latestVersion: '1.0.0' }] } });
    const backend = new HttpCatalogBackend(
      { searchPackages: async () => [] } as unknown as INuGetBackend,
      ladderStub({}),
      capabilityStub([]),
      resolverFor({
        'user.config': { targets: [{ url: FEED_A, name: 'first' }], hasNonHttpSource: false },
        'solution.config': { targets: [{ url: FEED_A, name: 'first' }], hasNonHttpSource: false },
      }),
      { isEnabled: () => true, search: stub.search },
    );

    const found = await backend.searchPackages('example', ['user.config', 'solution.config'], [], false);

    expect(stub.asked).toEqual([FEED_A]);
    expect(found.map((p) => p.id)).toEqual(['Example.Core']);
  });

  it('skips the exact lookup while search is plainly seeing that namespace', async () => {
    // Typing a name produces a query that is a prefix of real packages. A feed
    // returning them is not blind to this namespace, so there is nothing the
    // lookup could add — and this fires on every keystroke.
    const { backend } = searchBackend({
      hits: { [FEED_A]: [{ id: 'Elastic.Apm', latestVersion: '1.0.0' }], [FEED_B]: [{ id: 'Elastic.Clients', latestVersion: '1.0.0' }] },
      versions: { [FEED_A]: ['9.9.9'], [FEED_B]: ['9.9.9'] },
    });

    const found = await backend.searchPackages('Elas', ['a.config'], [], false);

    expect(found.map((p) => p.id)).toEqual(['Elastic.Apm', 'Elastic.Clients']);
  });

  it('skips the exact lookup when search already returned that id', async () => {
    const { backend } = searchBackend({
      hits: { [FEED_A]: [{ id: 'Newtonsoft.Json', latestVersion: '13.0.4' }], [FEED_B]: [] },
      versions: { [FEED_A]: ['13.0.4'], [FEED_B]: ['13.0.4'] },
    });

    const found = await backend.searchPackages('Newtonsoft.Json', ['a.config'], [], false);

    // One row for the package: the search hit, not a second lookup beside it.
    expect(found).toEqual([{ id: 'Newtonsoft.Json', latestVersion: '13.0.4', description: undefined, sourceName: 'first' }]);
  });

  it('puts the exact lookup first when search could not see the package', async () => {
    const { backend } = searchBackend({
      hits: { [FEED_A]: [{ id: 'Example.Other', latestVersion: '1.0.0' }], [FEED_B]: [] },
      versions: { [FEED_A]: ['13.0.4'] },
    });

    const found = await backend.searchPackages('Newtonsoft.Json', ['a.config'], [], false);

    expect(found.map((p) => p.id)).toEqual(['Newtonsoft.Json', 'Example.Other']);
  });

  it('honours the source filter the user set in the panel', async () => {
    const { backend, asked } = searchBackend({
      hits: { [FEED_A]: [{ id: 'A', latestVersion: '1.0.0' }], [FEED_B]: [{ id: 'B', latestVersion: '1.0.0' }] },
    });

    const found = await backend.searchPackages('example', ['a.config'], ['second'], false);

    expect(found.map((p) => p.id)).toEqual(['B']);
    expect(asked).toEqual([FEED_B]);
  });

  it('leaves a file that enables a folder source to the CLI', async () => {
    const cli = {
      searchPackages: async () => [{ id: 'from-cli', latestVersion: '1.0.0', sourceName: 'local' }],
    } as unknown as INuGetBackend;
    const { backend, asked } = searchBackend({
      inner: cli,
      targets: { targets: [{ url: FEED_A, name: 'first' }], hasNonHttpSource: true },
    });

    expect((await backend.searchPackages('example', ['a.config'], [], false)).map((p) => p.id))
      .toEqual(['from-cli']);
    expect(asked).toEqual([]);
  });

  it('stays on the CLI entirely while the feature is off', async () => {
    const cli = {
      searchPackages: async () => [{ id: 'from-cli', latestVersion: '1.0.0', sourceName: 'cli' }],
    } as unknown as INuGetBackend;
    const stub = searchStub({ hits: { [FEED_A]: [{ id: 'http', latestVersion: '1.0.0' }] } });
    const backend = new HttpCatalogBackend(
      cli,
      ladderStub({}),
      capabilityStub([]),
      resolverFor({ 'a.config': httpOnly(FEED_A) }),
      { isEnabled: () => false, search: stub.search },
    );

    expect((await backend.searchPackages('example', ['a.config'], [], false)).map((p) => p.id))
      .toEqual(['from-cli']);
    expect(stub.asked).toEqual([]);
  });

  it('stays on the CLI when no search implementation was supplied at all', async () => {
    const cli = {
      searchPackages: async () => [{ id: 'from-cli', latestVersion: '1.0.0', sourceName: 'cli' }],
    } as unknown as INuGetBackend;
    const backend = new HttpCatalogBackend(
      cli,
      ladderStub({}),
      capabilityStub([]),
      resolverFor({ 'a.config': httpOnly(FEED_A) }),
      { isEnabled: () => true },
    );

    expect((await backend.searchPackages('example', ['a.config'], [], false)).map((p) => p.id))
      .toEqual(['from-cli']);
  });
});

describe('HttpCatalogBackend delegation', () => {
  it('leaves every other operation to the backend it wraps', async () => {
    const seen: string[] = [];
    const inner = new Proxy({}, {
      get: (_t, prop: string) => async (...args: unknown[]) => {
        seen.push(`${prop}:${args.length}`);
        return undefined;
      },
    }) as INuGetBackend;
    const backend = new HttpCatalogBackend(
      inner,
      ladderStub({}),
      capabilityStub([]),
      resolverFor({}),
      { isEnabled: () => true },
    );

    await backend.listAllForSolution('s.sln', 3);
    await backend.listAllForProject('p.csproj');
    await backend.listInstalled('p.csproj');
    await backend.listTransitive('p.csproj');
    await backend.searchPackages('q', ['a.config'], ['nuget.org'], true);
    await backend.getMetadata('X', '1.0.0', ['a.config']);
    await backend.enrichPackage('X', ['a.config'], false);
    await backend.installPackage('p.csproj', 'X', '1.0.0', undefined, 'net10.0');
    await backend.installPackageNoRestore('p.csproj', 'X', '1.0.0');
    await backend.removePackage('p.csproj', 'X');
    await backend.restoreProject('p.csproj');
    await backend.listVulnerable('s.sln', undefined, 3);

    expect(seen).toEqual([
      'listAllForSolution:2',
      'listAllForProject:1',
      'listInstalled:1',
      'listTransitive:1',
      'searchPackages:4',
      'getMetadata:3',
      'enrichPackage:3',
      'installPackage:5',
      'installPackageNoRestore:5',
      'removePackage:2',
      'restoreProject:2',
      'listVulnerable:3',
    ]);
  });
});
