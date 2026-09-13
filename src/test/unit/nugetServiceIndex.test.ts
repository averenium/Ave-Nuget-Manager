import {
  classifyOrigin,
  parseServiceIndex,
  selectResources,
} from '../../nugetServiceIndex';

/**
 * Cases are named after the *shape* a server produced, never after the server.
 * Every one of them was observed on some real feed, and a feed nobody has tried
 * yet will be another combination of the same shapes.
 */
const index = (...resources: Array<{ '@type': string; '@id': string }>) => ({ resources });

describe('parseServiceIndex', () => {
  it('keeps types this build has never heard of', () => {
    const parsed = parseServiceIndex(index(
      { '@type': 'PackageBaseAddress/3.0.0', '@id': 'https://f/content/' },
      { '@type': 'VssFeedId', '@id': 'https://f/vss' },
    ));
    expect(parsed.map((r) => r.baseType)).toEqual(['PackageBaseAddress', 'VssFeedId']);
  });

  it('splits the suffix off the base type, and leaves it unset when there is none', () => {
    const parsed = parseServiceIndex(index(
      { '@type': 'RegistrationsBaseUrl', '@id': 'https://f/reg/' },
      { '@type': 'RegistrationsBaseUrl/3.6.0', '@id': 'https://f/reg-gz/' },
    ));
    expect(parsed).toEqual([
      { baseType: 'RegistrationsBaseUrl', suffix: undefined, url: 'https://f/reg/' },
      { baseType: 'RegistrationsBaseUrl', suffix: '3.6.0', url: 'https://f/reg-gz/' },
    ]);
  });

  it('drops entries missing a type or an id rather than throwing', () => {
    expect(parseServiceIndex(index(
      { '@type': '', '@id': 'https://f/x' },
      { '@type': 'PackageBaseAddress/3.0.0', '@id': '' },
    ))).toEqual([]);
    expect(parseServiceIndex(null)).toEqual([]);
    expect(parseServiceIndex({ resources: 'nope' })).toEqual([]);
  });
});

describe('selectResources', () => {
  it('finds a resource published only under a version suffix', () => {
    // Some feeds publish no unversioned entry at all; looking up the bare type
    // string would find nothing while the resource is plainly there.
    const parsed = parseServiceIndex(index(
      { '@type': 'RegistrationsBaseUrl/3.0.0-beta', '@id': 'https://f/reg-beta/' },
      { '@type': 'RegistrationsBaseUrl/3.6.0', '@id': 'https://f/reg-gz2/' },
    ));
    expect(selectResources(parsed, 'RegistrationsBaseUrl')[0]).toBe('https://f/reg-gz2/');
  });

  it('finds a resource published only unversioned', () => {
    const parsed = parseServiceIndex(index(
      { '@type': 'RegistrationsBaseUrl', '@id': 'https://f/reg/' },
      { '@type': 'RegistrationsBaseUrl/3.0.0-rc', '@id': 'https://f/reg/' },
    ));
    expect(selectResources(parsed, 'RegistrationsBaseUrl')).toEqual(['https://f/reg/']);
  });

  it('skips a missing middle rank instead of stopping at it', () => {
    // 3.6.0 present, 3.4.0 absent: the walk must not give up at the gap.
    const parsed = parseServiceIndex(index(
      { '@type': 'RegistrationsBaseUrl/3.6.0', '@id': 'https://f/best/' },
      { '@type': 'RegistrationsBaseUrl/3.0.0-beta', '@id': 'https://f/old/' },
    ));
    expect(selectResources(parsed, 'RegistrationsBaseUrl')).toEqual(['https://f/best/', 'https://f/old/']);
  });

  it('prefers the hive that includes SemVer 2.0.0 packages', () => {
    // Below 3.6.0 those versions are absent from the response, and an absence
    // is indistinguishable from "no such version".
    const parsed = parseServiceIndex(index(
      { '@type': 'RegistrationsBaseUrl', '@id': 'https://f/plain/' },
      { '@type': 'RegistrationsBaseUrl/3.4.0', '@id': 'https://f/gz/' },
      { '@type': 'RegistrationsBaseUrl/3.6.0', '@id': 'https://f/gz-semver2/' },
    ));
    expect(selectResources(parsed, 'RegistrationsBaseUrl')[0]).toBe('https://f/gz-semver2/');
  });

  it('keeps several ids of one type as failover targets', () => {
    const parsed = parseServiceIndex(index(
      { '@type': 'SearchQueryService/3.5.0', '@id': 'https://a/query' },
      { '@type': 'SearchQueryService/3.5.0', '@id': 'https://b/query' },
    ));
    expect(selectResources(parsed, 'SearchQueryService')).toEqual(['https://a/query', 'https://b/query']);
  });

  it('collapses one address published under several suffixes', () => {
    const parsed = parseServiceIndex(index(
      { '@type': 'SearchQueryService', '@id': 'https://f/query' },
      { '@type': 'SearchQueryService/3.0.0-rc', '@id': 'https://f/query' },
      { '@type': 'SearchQueryService/3.5.0', '@id': 'https://f/query' },
    ));
    expect(selectResources(parsed, 'SearchQueryService')).toEqual(['https://f/query']);
  });

  it('still offers a suffix it does not recognise, ranked last', () => {
    const parsed = parseServiceIndex(index(
      { '@type': 'RegistrationsBaseUrl/9.9.9-future', '@id': 'https://f/future/' },
      { '@type': 'RegistrationsBaseUrl/3.6.0', '@id': 'https://f/known/' },
    ));
    expect(selectResources(parsed, 'RegistrationsBaseUrl')).toEqual(['https://f/known/', 'https://f/future/']);
  });

  it('returns nothing for a type the feed does not publish', () => {
    const parsed = parseServiceIndex(index(
      { '@type': 'PackageBaseAddress/3.0.0', '@id': 'https://f/content/' },
    ));
    expect(selectResources(parsed, 'VulnerabilityInfo')).toEqual([]);
  });
});

describe('classifyOrigin', () => {
  const source = 'https://feed.corp/repository/group/index.json';

  it('accepts a resource on the configured origin', () => {
    expect(classifyOrigin('https://feed.corp/repository/group/v3/reg/', source))
      .toEqual({ kind: 'same', url: 'https://feed.corp/repository/group/v3/reg/' });
  });

  it('rewrites a resource that names another host for this feed\'s own path', () => {
    // A reverse proxy makes the server advertise the host it sees, not the one
    // the client configured.
    expect(classifyOrigin('http://internal:8081/repository/group/v3/reg/', source)).toEqual({
      kind: 'rewritten',
      url: 'https://feed.corp/repository/group/v3/reg/',
      original: 'http://internal:8081/repository/group/v3/reg/',
    });
  });

  it('refuses a resource that points at a different service', () => {
    // A feed relaying an upstream index can leave entries aimed at that
    // upstream; following them reaches a host the user never configured.
    expect(classifyOrigin('https://elsewhere.example/v3/catalog0/index.json', source))
      .toEqual({ kind: 'foreign', url: 'https://elsewhere.example/v3/catalog0/index.json' });
  });

  it('accepts a sibling host of the same domain', () => {
    // A feed spreads its resources across hostnames: the search service of a
    // large public feed answers from a different host than its package content.
    expect(classifyOrigin('https://search-eu.feed.corp/query', 'https://api.feed.corp/v3/index.json'))
      .toEqual({ kind: 'same', url: 'https://search-eu.feed.corp/query' });
  });

  it('keeps tenants of a shared hosting platform apart', () => {
    // Two accounts on one platform are neighbours, not siblings: a feed hosted
    // there must not be able to aim the client at somebody else's storage.
    expect(classifyOrigin(
      'https://evil.blob.core.windows.net/v3/query',
      'https://mycompany.blob.core.windows.net/feed/v3/index.json',
    ).kind).toBe('foreign');
    expect(classifyOrigin(
      'https://other-app.azurewebsites.net/v3/query',
      'https://our-app.azurewebsites.net/v3/index.json',
    ).kind).toBe('foreign');
  });

  it('carries the query of a rewritten address', () => {
    // A search resource published with parameters means nothing without them.
    expect(classifyOrigin(
      'http://internal:8081/repository/group/v3/query?api-version=2.0',
      'https://feed.corp/repository/group/index.json',
    )).toEqual({
      kind: 'rewritten',
      url: 'https://feed.corp/repository/group/v3/query?api-version=2.0',
      original: 'http://internal:8081/repository/group/v3/query?api-version=2.0',
    });
  });

  it('keeps hosts under a shared public suffix apart', () => {
    // Two projects on a user-content domain share a suffix and nothing else.
    expect(classifyOrigin('https://someone-else.github.io/v3/query', 'https://a-team.github.io/v3/index.json').kind)
      .toBe('foreign');
    expect(classifyOrigin('https://other.co.uk/v3/query', 'https://feed.co.uk/v3/index.json').kind)
      .toBe('foreign');
  });

  it('still refuses a host belonging to somebody else entirely', () => {
    expect(classifyOrigin('https://elsewhere.example/v3/query', 'https://feed.corp/v3/index.json').kind)
      .toBe('foreign');
  });

  it('refuses a foreign host whose path is only the conventional prefix', () => {
    // `/v3` belongs to every v3 feed, so sharing it is not evidence of a proxy;
    // rewriting on it would aim a request for another service at this host.
    expect(classifyOrigin(
      'https://elsewhere.example/v3/vulnerabilities/index.json',
      'https://feed.corp/v3/index.json',
    ).kind).toBe('foreign');
  });

  it('accepts a foreign origin the user has configured elsewhere', () => {
    // The vulnerability database is nearly always a different host, and it is
    // legitimate when that host is one of the configured sources.
    expect(classifyOrigin('https://elsewhere.example/v3/vulnerabilities/index.json', source, [
      'https://elsewhere.example/v3/index.json',
    ]).kind).toBe('same');
  });

  it('refuses anything it cannot parse', () => {
    expect(classifyOrigin('not a url', source).kind).toBe('foreign');
    expect(classifyOrigin('https://feed.corp/x', 'not a url').kind).toBe('foreign');
  });
});
