import { authorizingFetcher, CredentialRegistry, REFUSAL_HOLD_MS, refusalNote } from '../../nugetHttpAuth';
import { SourceCapabilityStore, type HttpJsonResponse } from '../../nugetSourceCapabilities';

/**
 * Three Nexus repositories on one host differ only in the `/repository/<name>/`
 * segment. Keyed by origin, giving credentials to one of them attached them to
 * all three, and a repository that serves anonymous readers answers 403 to a
 * credential it does not recognise (#133).
 */
const HOST = 'https://nexus.example.com';
const PRIVATE_A = `${HOST}/repository/private-a/index.json`;
const PUBLIC_B = `${HOST}/repository/pub-b/index.json`;
const SNAPSHOT_C = `${HOST}/repository/snap-c/index.json`;

const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const credential = (username: string, password = 'secret') => ({ username, password, encrypted: false });

describe('CredentialRegistry — one credential per source, not per host (#133)', () => {
  it('attaches the credential to the source it was configured for and to no other on the host', async () => {
    const registry = new CredentialRegistry();
    registry.remember(PRIVATE_A, credential('alice'));

    expect(await registry.headerFor(`${HOST}/repository/private-a/index.json`)).toBe(basic('alice', 'secret'));
    expect(await registry.headerFor(`${HOST}/repository/pub-b/index.json`)).toBeUndefined();
    expect(await registry.headerFor(`${HOST}/repository/snap-c/v3/search?q=x`)).toBeUndefined();
  });

  it('covers what lies below the source\'s own address', async () => {
    const registry = new CredentialRegistry();
    registry.remember(PRIVATE_A, credential('alice'));

    expect(await registry.headerFor(`${HOST}/repository/private-a/flatcontainer/example.core/index.json`))
      .toBe(basic('alice', 'secret'));
  });

  it('does not let one source\'s address cover a sibling that merely starts with the same letters', async () => {
    const registry = new CredentialRegistry();
    registry.remember(`${HOST}/repository/a/index.json`, credential('alice'));

    expect(await registry.headerFor(`${HOST}/repository/ab/index.json`)).toBeUndefined();
  });

  it('keeps two credentialed sources on one host apart instead of the last overwriting the first', async () => {
    const registry = new CredentialRegistry();
    registry.remember(PRIVATE_A, credential('alice', 'a-secret'));
    registry.remember(SNAPSHOT_C, credential('carol', 'c-secret'));

    expect(await registry.headerFor(PRIVATE_A)).toBe(basic('alice', 'a-secret'));
    expect(await registry.headerFor(SNAPSHOT_C)).toBe(basic('carol', 'c-secret'));
    expect(await registry.headerFor(PUBLIC_B)).toBeUndefined();
  });

  it('prefers the longest matching source when one lies below another', async () => {
    const registry = new CredentialRegistry();
    registry.remember(`${HOST}/repository/index.json`, credential('outer'));
    registry.remember(PRIVATE_A, credential('inner'));

    expect(await registry.headerFor(`${HOST}/repository/private-a/x`)).toBe(basic('inner', 'secret'));
    expect(await registry.headerFor(`${HOST}/repository/other/x`)).toBe(basic('outer', 'secret'));
  });

  it('still sends nothing to another host or another port', async () => {
    const registry = new CredentialRegistry();
    registry.remember(PRIVATE_A, credential('alice'));

    expect(await registry.headerFor('https://other.example.com/repository/private-a/index.json')).toBeUndefined();
    expect(await registry.headerFor('https://nexus.example.com:8443/repository/private-a/index.json')).toBeUndefined();
  });

  it('does not treat the protocol\'s own v3 segment as part of the feed\'s identity', async () => {
    const registry = new CredentialRegistry();
    registry.remember('https://feed.example/nuget/team/v3/index.json', credential('alice'));

    expect(await registry.headerFor('https://feed.example/nuget/team/v3-flatcontainer/a/index.json'))
      .toBe(basic('alice', 'secret'));
    expect(await registry.headerFor('https://feed.example/nuget/other/v3/index.json')).toBeUndefined();
  });
});

describe('a source owns the resources its own service index published (#133)', () => {
  // Azure Artifacts: configured by project and feed name, published under the
  // GUIDs of both. Measured on the public dnceng/dotnet-public feed.
  const AZURE = 'https://pkgs.example.com';
  const SOURCE = `${AZURE}/org/public/_packaging/team-feed/nuget/v3/index.json`;
  const QUERY = `${AZURE}/org/9ee6d478-0000/_packaging/45bacae2-0000/nuget/v3/query2/`;
  const FLAT = `${AZURE}/org/9ee6d478-0000/_packaging/45bacae2-0000/nuget/v3/flat2/`;

  const publishing = (...urls: string[]) => ({ publishedResources: () => urls });

  it('attaches the credential to a resource published outside the source\'s own path', async () => {
    const registry = new CredentialRegistry(publishing(QUERY, FLAT));
    registry.remember(SOURCE, credential('alice'));

    expect(await registry.headerFor(`${QUERY}?q=Example.Core`)).toBe(basic('alice', 'secret'));
    expect(await registry.headerFor(`${FLAT}example.core/index.json`)).toBe(basic('alice', 'secret'));
  });

  it('still sends nothing to another path on the host that nothing published', async () => {
    const registry = new CredentialRegistry(publishing(QUERY));
    registry.remember(SOURCE, credential('alice'));

    expect(await registry.headerFor(`${AZURE}/org/public/_packaging/other-feed/nuget/v3/index.json`)).toBeUndefined();
  });

  it('never extends a credential to a published address on another host', async () => {
    const registry = new CredentialRegistry(publishing('https://elsewhere.example.com/v3/query2/'));
    registry.remember(SOURCE, credential('alice'));

    expect(await registry.headerFor('https://elsewhere.example.com/v3/query2/?q=x')).toBeUndefined();
  });

  it('gives a published resource to the source that published it, not to a neighbour whose path happens to contain it', async () => {
    const registry = new CredentialRegistry({
      publishedResources: (url) => (url === SOURCE ? [QUERY] : []),
    });
    registry.remember(`${AZURE}/org/index.json`, credential('outer'));
    registry.remember(SOURCE, credential('inner'));

    expect(await registry.headerFor(`${QUERY}?q=x`)).toBe(basic('inner', 'secret'));
  });

  it('holds a refusal for a published resource against the source it belongs to', async () => {
    const told: Array<{ source: string; status: number }> = [];
    const registry = new CredentialRegistry({
      ...publishing(QUERY),
      onRefused: (source, status) => told.push({ source, status }),
    });
    registry.remember(SOURCE, credential('alice'));
    const fetch = authorizingFetcher(async () => ({ status: 401 }), registry);

    await fetch(`${QUERY}?q=x`);

    expect(told).toEqual([{ source: SOURCE, status: 401 }]);
  });

  it('works through the capability store the extension wires in: the index is read, then its resources are covered', async () => {
    const index = {
      version: '3.0.0',
      resources: [
        { '@id': QUERY, '@type': 'SearchQueryService' },
        { '@id': FLAT, '@type': 'PackageBaseAddress/3.0.0' },
      ],
    };
    const seen: Array<string | undefined> = [];
    // The registry asks the store, and the store fetches through the registry —
    // the same loop the extension wires, closed by the store being read lazily.
    const registry = new CredentialRegistry({ publishedResources: (url) => store.publishedUrls(url) });
    const fetch = authorizingFetcher(async (_url, _signal, headers) => {
      seen.push(headers?.authorization);
      return { status: 200, json: index };
    }, registry);
    const store = new SourceCapabilityStore(fetch, undefined, Date.now, () => true);
    registry.remember(SOURCE, credential('alice'));

    expect(await registry.headerFor(`${QUERY}?q=x`)).toBeUndefined(); // index not read yet
    await store.ensure({ url: SOURCE });

    expect(seen).toEqual([basic('alice', 'secret')]);
    expect(await registry.headerFor(`${QUERY}?q=x`)).toBe(basic('alice', 'secret'));
    expect(await registry.headerFor(`${FLAT}example.core/index.json`)).toBe(basic('alice', 'secret'));
  });
});

describe('a refusal is held briefly, once per source (#133)', () => {
  const OK: HttpJsonResponse = { status: 200, json: {} };

  function setup(answer: (url: string, headers?: Record<string, string>) => HttpJsonResponse) {
    let now = 10_000;
    const told: Array<{ source: string; status: number }> = [];
    const registry = new CredentialRegistry({
      now: () => now,
      onRefused: (source, status) => told.push({ source, status }),
    });
    const seen: string[] = [];
    const fetch = authorizingFetcher(async (url, _signal, headers) => {
      seen.push(url);
      return answer(url, headers);
    }, registry);
    return { registry, fetch, seen, told, advance: (ms: number) => { now += ms; } };
  }

  it('does not ask a source again within the window after it refused the credential', async () => {
    const { registry, fetch, seen } = setup(() => ({ status: 403 }));
    registry.remember(PRIVATE_A, credential('alice'));

    const first = await fetch(`${HOST}/repository/private-a/v3/search?q=a`);
    const second = await fetch(`${HOST}/repository/private-a/v3/search?q=b`);

    expect(first.status).toBe(403);
    expect(second.status).toBe(403);
    expect(seen).toHaveLength(1);
  });

  it('asks again once the window has passed', async () => {
    const { registry, fetch, seen, advance } = setup(() => ({ status: 403 }));
    registry.remember(PRIVATE_A, credential('alice'));

    await fetch(`${HOST}/repository/private-a/x`);
    advance(REFUSAL_HOLD_MS + 1);
    await fetch(`${HOST}/repository/private-a/x`);

    expect(seen).toHaveLength(2);
  });

  it('says so once per held refusal, naming the source, not once per request', async () => {
    const { registry, fetch, told } = setup(() => ({ status: 403 }));
    registry.remember(PRIVATE_A, credential('alice'));

    await Promise.all([1, 2, 3].map((n) => fetch(`${HOST}/repository/private-a/x${n}`)));
    await fetch(`${HOST}/repository/private-a/y`);

    expect(told).toEqual([{ source: PRIVATE_A, status: 403 }]);
  });

  it('holds a refusal of one source without holding its neighbour on the same host', async () => {
    const { registry, fetch, seen } = setup((url) => (url.includes('/private-a/') ? { status: 403 } : OK));
    registry.remember(PRIVATE_A, credential('alice'));
    registry.remember(SNAPSHOT_C, credential('carol'));

    await fetch(`${HOST}/repository/private-a/x`);
    const other = await fetch(`${HOST}/repository/snap-c/x`);

    expect(other.status).toBe(200);
    expect(seen).toHaveLength(2);
  });

  it('forgets a held refusal when the configuration changes', async () => {
    const { registry, fetch, seen } = setup(() => ({ status: 403 }));
    registry.remember(PRIVATE_A, credential('alice'));
    await fetch(`${HOST}/repository/private-a/x`);

    registry.clear();
    registry.remember(PRIVATE_A, credential('alice'));
    await fetch(`${HOST}/repository/private-a/x`);

    expect(seen).toHaveLength(2);
  });

  it('keeps a held refusal when the same credential is read again from a cached configuration', async () => {
    const { registry, fetch, seen } = setup(() => ({ status: 403 }));
    registry.remember(PRIVATE_A, credential('alice'));
    await fetch(`${HOST}/repository/private-a/x`);

    registry.remember(PRIVATE_A, credential('alice'));
    await fetch(`${HOST}/repository/private-a/x`);

    expect(seen).toHaveLength(1);
  });

  it('does not hold the refusal of a request that carried no credential', async () => {
    const { fetch, seen, told } = setup(() => ({ status: 403 }));

    await fetch(`${HOST}/repository/pub-b/x`);
    await fetch(`${HOST}/repository/pub-b/x`);

    expect(seen).toHaveLength(2);
    expect(told).toEqual([]);
  });

  it('holds a 401 too, and the two notes say different things', async () => {
    const { registry, fetch, told } = setup(() => ({ status: 401 }));
    registry.remember(PRIVATE_A, credential('alice'));

    await fetch(`${HOST}/repository/private-a/x`);

    expect(told).toEqual([{ source: PRIVATE_A, status: 401 }]);
    expect(refusalNote(PRIVATE_A, 401)).toContain('not accepted (401)');
    expect(refusalNote(PRIVATE_A, 403)).toContain('not allowed to read it (403)');
    expect(refusalNote(PRIVATE_A, 403)).toContain(PRIVATE_A);
  });

  it('states the window it actually holds, not a number of its own', () => {
    const minutes = REFUSAL_HOLD_MS / 60_000;
    expect(refusalNote(PRIVATE_A, 403)).toContain(`for ${minutes} minute`);
  });
});
