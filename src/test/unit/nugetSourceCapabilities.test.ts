import {
  capabilityStorage,
  normalizeSourceKey,
  SourceCapabilityStore,
  type CapabilityStorage,
  type HttpJsonResponse,
} from '../../nugetSourceCapabilities';

/**
 * Cases describe what a server did, never which server did it: a feed nobody
 * has tried yet is another combination of the same behaviours.
 */
const V3 = 'https://feed.example/v3/index.json';

const indexJson = (...types: string[]) => ({
  resources: types.map((t) => ({ '@type': t, '@id': `https://feed.example/v3/${t.split('/')[0]}/` })),
});

const ok = (json: unknown): HttpJsonResponse => ({ status: 200, json });

/** A fetcher that answers from a script and counts how often it was called. */
function scripted(...responses: Array<HttpJsonResponse | Error>) {
  const calls: string[] = [];
  let i = 0;
  const fetchJson = async (url: string): Promise<HttpJsonResponse> => {
    calls.push(url);
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchJson, calls };
}

function memoryStorage(): CapabilityStorage & { value: unknown } {
  return {
    value: undefined,
    read() { return this.value; },
    write(v: unknown) { this.value = v; },
  };
}

const enabled = () => true;

describe('normalizeSourceKey', () => {
  it('treats host case as equal and path case as distinct', () => {
    expect(normalizeSourceKey('https://FEED.example/v3/index.json'))
      .toBe(normalizeSourceKey('https://feed.example/v3/index.json'));
    expect(normalizeSourceKey('https://feed.example/V3/index.json'))
      .not.toBe(normalizeSourceKey('https://feed.example/v3/index.json'));
  });

  it('ignores a trailing slash and survives an address it cannot parse', () => {
    expect(normalizeSourceKey('https://feed.example/v3/')).toBe('https://feed.example/v3');
    expect(normalizeSourceKey('  not a url/  ')).toBe('not a url');
  });
});

describe('SourceCapabilityStore probing', () => {
  it('records every advertised resource as an intention, not yet a fact', async () => {
    const { fetchJson } = scripted(ok(indexJson('PackageBaseAddress/3.0.0', 'RegistrationsBaseUrl/3.6.0')));
    const store = new SourceCapabilityStore(fetchJson, undefined, Date.now, enabled);

    const record = await store.ensure({ url: V3 });

    expect(record.index).toBe('ok');
    expect(record.resources.PackageBaseAddress).toEqual({
      status: 'advertised',
      urls: ['https://feed.example/v3/PackageBaseAddress/'],
    });
    expect(record.resources.SearchQueryService?.status).toBe('unavailable');
  });

  it('probes a source once however many callers ask at the same time', async () => {
    const { fetchJson, calls } = scripted(ok(indexJson('PackageBaseAddress/3.0.0')));
    const store = new SourceCapabilityStore(fetchJson, undefined, Date.now, enabled);

    await Promise.all([store.ensure({ url: V3 }), store.ensure({ url: V3 }), store.ensure({ url: V3 })]);
    await store.ensure({ url: V3 });

    expect(calls).toHaveLength(1);
  });

  it('asks nothing at all while the feature is switched off', async () => {
    const { fetchJson, calls } = scripted(ok(indexJson('PackageBaseAddress/3.0.0')));
    const store = new SourceCapabilityStore(fetchJson, undefined, Date.now, () => false);

    expect((await store.ensure({ url: V3 })).index).toBe('unknown');
    expect(calls).toEqual([]);
  });

  it('asks nothing of a source that speaks the older protocol', async () => {
    const { fetchJson, calls } = scripted(ok(indexJson('PackageBaseAddress/3.0.0')));
    const store = new SourceCapabilityStore(fetchJson, undefined, Date.now, enabled);

    const record = await store.ensure({ url: 'https://gallery.example/api/v2' });

    expect(record.index).toBe('unavailable');
    expect(calls).toEqual([]);
  });

  it('separates missing credentials from a broken feed', async () => {
    const { fetchJson } = scripted({ status: 401 });
    const store = new SourceCapabilityStore(fetchJson, undefined, Date.now, enabled);

    expect((await store.ensure({ url: V3 })).index).toBe('unauthorized');
  });

  it('treats an answer that is not a service index as no v3 support', async () => {
    const { fetchJson } = scripted(ok({ message: 'hello' }));
    const store = new SourceCapabilityStore(fetchJson, undefined, Date.now, enabled);

    expect((await store.ensure({ url: V3 })).index).toBe('unavailable');
  });

  it('writes no verdict when the failure was momentary', async () => {
    const { fetchJson } = scripted({ status: 503 }, new Error('socket hang up'), { status: 429 });
    let clock = 1_000;
    const store = new SourceCapabilityStore(fetchJson, undefined, () => clock, enabled);

    expect((await store.ensure({ url: V3 })).index).toBe('unknown');
    expect(store.get(V3)).toBeUndefined();

    clock += 60_000;
    expect((await store.ensure({ url: V3 })).index).toBe('unknown');
    expect(store.get(V3)).toBeUndefined();
  });

  it('separates a proxy that wants credentials from a feed that is down', async () => {
    // The feed said nothing at all here; the verdict is about the hop, and it
    // expires soonest because the proxy may accept the very next request.
    const refusal = Object.assign(new Error('Proxy refused'), { name: 'ProxyRefusedError', status: 407 });
    let clock = 1_000;
    const store = new SourceCapabilityStore(
      async () => { throw refusal; }, undefined, () => clock, enabled,
    );

    expect((await store.ensure({ url: V3 })).index).toBe('proxy-auth');
    clock += 4 * 60 * 1000;
    expect(store.get(V3)?.index).toBe('proxy-auth');
    clock += 2 * 60 * 1000;
    expect(store.get(V3)).toBeUndefined();
  });

  it('records a proxy it cannot execute as a source it cannot use', async () => {
    // Nothing will change until the configuration does, and a configuration
    // change drops every verdict anyway.
    const unsupported = Object.assign(new Error('socks5'), { name: 'ProxyUnsupportedError' });
    const store = new SourceCapabilityStore(
      async () => { throw unsupported; }, undefined, Date.now, enabled,
    );

    expect((await store.ensure({ url: V3 })).index).toBe('unavailable');
  });

  it('waits before retrying a source that just failed momentarily', async () => {
    const { fetchJson, calls } = scripted({ status: 500 });
    let clock = 1_000;
    const store = new SourceCapabilityStore(fetchJson, undefined, () => clock, enabled);

    await store.ensure({ url: V3 });
    clock += 5_000;
    await store.ensure({ url: V3 });
    expect(calls).toHaveLength(1);

    clock += 60_000;
    await store.ensure({ url: V3 });
    expect(calls).toHaveLength(2);
  });
});

describe('SourceCapabilityStore origins', () => {
  it('keeps a rewritten address ahead of the one the server published', async () => {
    // A reverse proxy makes the server advertise the host it sees rather than
    // the host the client configured.
    const source = 'https://feed.example/repository/group/index.json';
    const { fetchJson } = scripted(ok({
      resources: [{
        '@type': 'PackageBaseAddress/3.0.0',
        '@id': 'http://internal:8081/repository/group/v3/flat/',
      }],
    }));
    const store = new SourceCapabilityStore(fetchJson, undefined, Date.now, enabled);

    const record = await store.ensure({ url: source });

    expect(record.resources.PackageBaseAddress?.urls).toEqual([
      'https://feed.example/repository/group/v3/flat/',
      'http://internal:8081/repository/group/v3/flat/',
    ]);
  });

  it('drops a resource aimed at a service the user never configured', async () => {
    const { fetchJson } = scripted(ok({
      resources: [{ '@type': 'VulnerabilityInfo/6.7.0', '@id': 'https://elsewhere.example/v3/vulnerabilities/index.json' }],
    }));
    const store = new SourceCapabilityStore(fetchJson, undefined, Date.now, enabled);

    expect((await store.ensure({ url: V3 })).resources.VulnerabilityInfo?.status).toBe('unavailable');
  });

  it('keeps that same resource when its host is one of the configured sources', async () => {
    const { fetchJson } = scripted(ok({
      resources: [{ '@type': 'VulnerabilityInfo/6.7.0', '@id': 'https://elsewhere.example/v3/vulnerabilities/index.json' }],
    }));
    const store = new SourceCapabilityStore(fetchJson, undefined, Date.now, enabled);

    const record = await store.ensure({
      url: V3,
      knownOrigins: ['https://elsewhere.example/v3/index.json'],
    });

    expect(record.resources.VulnerabilityInfo?.urls)
      .toEqual(['https://elsewhere.example/v3/vulnerabilities/index.json']);
  });
});

describe('SourceCapabilityStore proof and failover', () => {
  const twoIds = ok({
    resources: [
      { '@type': 'SearchQueryService/3.5.0', '@id': 'https://feed.example/v3/query-a' },
      { '@type': 'SearchQueryService/3.5.0', '@id': 'https://feed.example/v3/query-b' },
    ],
  });

  it('promotes the address that answered, so failover is not rediscovered', async () => {
    const { fetchJson } = scripted(twoIds);
    const store = new SourceCapabilityStore(fetchJson, undefined, Date.now, enabled);
    await store.ensure({ url: V3 });

    store.markProved(V3, 'SearchQueryService', 'https://feed.example/v3/query-b');

    expect(store.get(V3)?.resources.SearchQueryService).toEqual({
      status: 'ready',
      urls: ['https://feed.example/v3/query-b', 'https://feed.example/v3/query-a'],
    });
  });

  it('writes to storage once, however many times the same proof arrives', async () => {
    // An enrichment wave proves the same resource for every package it asks
    // about; persisting each time turned one probe into fifty writes to the
    // editor's state store.
    let writes = 0;
    const storage: CapabilityStorage = { read: () => undefined, write: () => { writes += 1; } };
    const { fetchJson } = scripted(twoIds);
    const store = new SourceCapabilityStore(fetchJson, storage, Date.now, enabled);
    await store.ensure({ url: V3 });
    const afterProbe = writes;

    for (let i = 0; i < 50; i++) store.markProved(V3, 'SearchQueryService', 'https://feed.example/v3/query-a');

    expect(afterProbe).toBe(1);
    expect(writes).toBe(2);
  });

  it('still writes when the proof actually changes the order', async () => {
    let writes = 0;
    const storage: CapabilityStorage = { read: () => undefined, write: () => { writes += 1; } };
    const { fetchJson } = scripted(twoIds);
    const store = new SourceCapabilityStore(fetchJson, storage, Date.now, enabled);
    await store.ensure({ url: V3 });

    store.markProved(V3, 'SearchQueryService', 'https://feed.example/v3/query-b');
    store.markProved(V3, 'SearchQueryService', 'https://feed.example/v3/query-a');

    expect(writes).toBe(3);
    expect(store.get(V3)?.resources.SearchQueryService?.urls[0]).toBe('https://feed.example/v3/query-a');
  });

  it('condemns one address without condemning the resource', async () => {
    const { fetchJson } = scripted(twoIds);
    const store = new SourceCapabilityStore(fetchJson, undefined, Date.now, enabled);
    await store.ensure({ url: V3 });

    store.markBroken(V3, 'SearchQueryService', 'https://feed.example/v3/query-a');

    expect(store.resourceUrls(V3, 'SearchQueryService')).toEqual(['https://feed.example/v3/query-b']);

    store.markBroken(V3, 'SearchQueryService', 'https://feed.example/v3/query-b');

    expect(store.get(V3)?.resources.SearchQueryService?.status).toBe('unavailable');
    expect(store.resourceUrls(V3, 'SearchQueryService')).toEqual([]);
  });

  it('offers no address for a resource nothing is known about', () => {
    const { fetchJson } = scripted(twoIds);
    const store = new SourceCapabilityStore(fetchJson, undefined, Date.now, enabled);

    expect(store.resourceUrls(V3, 'RegistrationsBaseUrl')).toEqual([]);
  });
});

describe('SourceCapabilityStore persistence', () => {
  it('does not probe again after the window is reopened', async () => {
    const storage = memoryStorage();
    const first = scripted(ok(indexJson('PackageBaseAddress/3.0.0')));
    await new SourceCapabilityStore(first.fetchJson, storage, Date.now, enabled).ensure({ url: V3 });

    const second = scripted(ok(indexJson('PackageBaseAddress/3.0.0')));
    const reopened = new SourceCapabilityStore(second.fetchJson, storage, Date.now, enabled);
    const record = await reopened.ensure({ url: V3 });

    expect(second.calls).toEqual([]);
    expect(record.resources.PackageBaseAddress?.status).toBe('advertised');
  });

  it('lets a negative verdict lapse long before a working one', async () => {
    const storage = memoryStorage();
    let clock = 1_000_000;
    const refused = scripted({ status: 401 });
    await new SourceCapabilityStore(refused.fetchJson, storage, () => clock, enabled).ensure({ url: V3 });

    clock += 2 * 60 * 60 * 1000;
    const retry = scripted(ok(indexJson('PackageBaseAddress/3.0.0')));
    const record = await new SourceCapabilityStore(retry.fetchJson, storage, () => clock, enabled)
      .ensure({ url: V3 });

    expect(retry.calls).toHaveLength(1);
    expect(record.index).toBe('ok');
  });

  it('holds a working verdict across a day of ordinary use', async () => {
    const storage = memoryStorage();
    let clock = 1_000_000;
    const first = scripted(ok(indexJson('PackageBaseAddress/3.0.0')));
    await new SourceCapabilityStore(first.fetchJson, storage, () => clock, enabled).ensure({ url: V3 });

    clock += 10 * 60 * 60 * 1000;
    const later = scripted(ok(indexJson('PackageBaseAddress/3.0.0')));
    await new SourceCapabilityStore(later.fetchJson, storage, () => clock, enabled).ensure({ url: V3 });

    expect(later.calls).toEqual([]);
  });

  it('probes again after the configuration of a source changed', async () => {
    const storage = memoryStorage();
    const first = scripted(ok(indexJson('PackageBaseAddress/3.0.0')));
    const store = new SourceCapabilityStore(first.fetchJson, storage, Date.now, enabled);
    await store.ensure({ url: V3 });

    store.forget(V3);

    expect(store.get(V3)).toBeUndefined();
    await store.ensure({ url: V3 });
    expect(first.calls).toHaveLength(2);
  });

  it('starts from nothing when the stored cache is damaged or of another shape', async () => {
    const damaged: CapabilityStorage = { read: () => ({ version: 99, entries: { x: 1 } }), write: () => {} };
    const { fetchJson, calls } = scripted(ok(indexJson('PackageBaseAddress/3.0.0')));
    const store = new SourceCapabilityStore(fetchJson, damaged, Date.now, enabled);

    await store.ensure({ url: V3 });

    expect(calls).toHaveLength(1);
  });

  it('survives a state object that answers with the wrong type', async () => {
    const state = { get: <T>(_k: string, _d: T) => ('garbage' as unknown as T), update: async () => {} };
    const { fetchJson } = scripted(ok(indexJson('PackageBaseAddress/3.0.0')));
    const store = new SourceCapabilityStore(fetchJson, capabilityStorage(state), Date.now, enabled);

    expect((await store.ensure({ url: V3 })).index).toBe('ok');
  });

  it('reads back through a key-value state what it wrote there', async () => {
    const values = new Map<string, unknown>();
    const state = {
      get: <T>(key: string, d: T) => (values.has(key) ? values.get(key) as T : d),
      update: async (key: string, value: unknown) => { values.set(key, value); },
    };
    const first = scripted(ok(indexJson('PackageBaseAddress/3.0.0')));
    await new SourceCapabilityStore(first.fetchJson, capabilityStorage(state), Date.now, enabled)
      .ensure({ url: V3 });

    const second = scripted(ok(indexJson('PackageBaseAddress/3.0.0')));
    await new SourceCapabilityStore(second.fetchJson, capabilityStorage(state), Date.now, enabled)
      .ensure({ url: V3 });

    expect(second.calls).toEqual([]);
  });

  it('keeps working when storage itself throws', async () => {
    const broken: CapabilityStorage = {
      read: () => { throw new Error('no access'); },
      write: () => { throw new Error('read-only'); },
    };
    const { fetchJson } = scripted(ok(indexJson('PackageBaseAddress/3.0.0')));
    const store = new SourceCapabilityStore(fetchJson, broken, Date.now, enabled);

    expect((await store.ensure({ url: V3 })).index).toBe('ok');
  });
});
