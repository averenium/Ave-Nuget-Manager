import { SourceCapabilityStore, type HttpJsonResponse } from '../../nugetSourceCapabilities';
import { looksLikePackageId, PackageSearch, parseSearchResponse, searchUrl } from '../../nugetSearch';

const SOURCE = 'https://feed.example/v3/index.json';
const QUERY = 'https://feed.example/v3/query';

const ok = (json: unknown): HttpJsonResponse => ({ status: 200, json });

function server(routes: Record<string, HttpJsonResponse>) {
  const calls: string[] = [];
  const fetchJson = async (url: string): Promise<HttpJsonResponse> => {
    calls.push(url);
    return routes[url] ?? { status: 404 };
  };
  return { fetchJson, calls };
}

const indexWithSearch = ok({
  resources: [{ '@type': 'SearchQueryService/3.5.0', '@id': QUERY }],
});

function searchOver(routes: Record<string, HttpJsonResponse>) {
  const { fetchJson, calls } = server({ [SOURCE]: indexWithSearch, ...routes });
  const capabilities = new SourceCapabilityStore(fetchJson, undefined, Date.now, () => true);
  return { search: new PackageSearch(capabilities, fetchJson, { isEnabled: () => true }), capabilities, calls };
}

describe('looksLikePackageId', () => {
  it('accepts what an identifier can look like, including a single word', () => {
    expect(looksLikePackageId('Newtonsoft.Json')).toBe(true);
    expect(looksLikePackageId('EasyNetQ')).toBe(true);
    expect(looksLikePackageId('Microsoft.Extensions.Logging.Abstractions')).toBe(true);
  });

  it('rejects what an identifier cannot be', () => {
    expect(looksLikePackageId('json serializer')).toBe(false);
    expect(looksLikePackageId('a')).toBe(false);
    expect(looksLikePackageId('.leading')).toBe(false);
    expect(looksLikePackageId('has/slash')).toBe(false);
    expect(looksLikePackageId('   ')).toBe(false);
  });
});

describe('searchUrl', () => {
  it('always states the SemVer level and the pre-release flag', () => {
    // Without either one the server silently omits part of its catalog.
    const url = new URL(searchUrl(QUERY, { query: 'json', prerelease: true }));

    expect(url.searchParams.get('semVerLevel')).toBe('2.0.0');
    expect(url.searchParams.get('prerelease')).toBe('true');
    expect(url.searchParams.get('q')).toBe('json');
    expect(url.searchParams.get('take')).toBe('20');
  });

  it('keeps parameters a feed already put in its own address', () => {
    const url = new URL(searchUrl('https://feed.example/query?api-version=2.0', { query: 'json' }));

    expect(url.searchParams.get('api-version')).toBe('2.0');
    expect(url.searchParams.get('prerelease')).toBe('false');
  });
});

describe('parseSearchResponse', () => {
  it('reads records regardless of what the match count claims', () => {
    // One server reports zero matches for every query while returning records.
    const hits = parseSearchResponse({
      totalHits: 0,
      data: [{ id: 'Example.Core', version: '2.0.0', description: 'Core bits.' }],
    });

    expect(hits).toEqual([{ id: 'Example.Core', latestVersion: '2.0.0', description: 'Core bits.' }]);
  });

  it('falls back to the newest entry of the per-version list', () => {
    const hits = parseSearchResponse({
      data: [{ id: 'Example.Core', versions: [{ version: '1.0.0' }, { version: '2.0.0' }] }],
    });

    expect(hits).toEqual([{ id: 'Example.Core', latestVersion: '2.0.0', description: undefined }]);
  });

  it('separates "found nothing" from "not a search response"', () => {
    expect(parseSearchResponse({ data: [] })).toEqual([]);
    expect(parseSearchResponse({ totalHits: 3 })).toBeUndefined();
    expect(parseSearchResponse(null)).toBeUndefined();
  });

  it('skips records with no id or no version instead of dropping the answer', () => {
    expect(parseSearchResponse({
      data: [{ id: 'Example.Core', version: '1.0.0' }, { id: 'Example.Broken' }, { version: '9.9.9' }],
    })).toEqual([{ id: 'Example.Core', latestVersion: '1.0.0', description: undefined }]);
  });
});

describe('PackageSearch', () => {
  it('answers from the search resource and remembers it works', async () => {
    const { search, capabilities } = searchOver({
      [searchUrl(QUERY, { query: 'json', prerelease: false })]: ok({
        data: [{ id: 'Example.Json', version: '1.0.0' }],
      }),
    });

    const hits = await search.searchSource({ url: SOURCE }, { query: 'json' });

    expect(hits).toEqual([{ id: 'Example.Json', latestVersion: '1.0.0', description: undefined }]);
    expect(capabilities.get(SOURCE)?.resources.SearchQueryService?.status).toBe('ready');
  });

  it('reports an empty result as an answer, not as a failure', async () => {
    const { search } = searchOver({
      [searchUrl(QUERY, { query: 'nothing', prerelease: false })]: ok({ data: [] }),
    });

    expect(await search.searchSource({ url: SOURCE }, { query: 'nothing' })).toEqual([]);
  });

  it('condemns an address that answers in the wrong shape', async () => {
    const { search, capabilities } = searchOver({
      [searchUrl(QUERY, { query: 'json', prerelease: false })]: ok({ packages: [] }),
    });

    expect(await search.searchSource({ url: SOURCE }, { query: 'json' })).toBeUndefined();
    expect(capabilities.get(SOURCE)?.resources.SearchQueryService?.status).toBe('unavailable');
  });

  it('says a source without the resource has no search, without asking', async () => {
    const { fetchJson } = server({
      [SOURCE]: ok({ resources: [{ '@type': 'PackageBaseAddress/3.0.0', '@id': 'https://feed.example/v3/flat/' }] }),
    });
    const capabilities = new SourceCapabilityStore(fetchJson, undefined, Date.now, () => true);
    const search = new PackageSearch(capabilities, fetchJson, { isEnabled: () => true });
    await capabilities.ensure({ url: SOURCE });

    expect(search.hasSearch({ url: SOURCE })).toBe(false);
  });

  it('opens no connection while the feature is switched off', async () => {
    const { fetchJson, calls } = server({ [SOURCE]: indexWithSearch });
    const capabilities = new SourceCapabilityStore(fetchJson, undefined, Date.now, () => false);
    const search = new PackageSearch(capabilities, fetchJson, { isEnabled: () => false });

    expect(await search.searchSource({ url: SOURCE }, { query: 'json' })).toBeUndefined();
    expect(calls).toEqual([]);
  });
});
