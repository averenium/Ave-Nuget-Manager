import { SourceCapabilityStore, type HttpJsonResponse } from '../../nugetSourceCapabilities';
import { VersionLadder } from '../../nugetVersionLadder';

/**
 * Every case is a behaviour some server showed, named by that behaviour. What
 * a feed calls itself never reaches this file, and must never reach the code
 * it exercises.
 */
const SOURCE = 'https://feed.example/v3/index.json';
const CONTENT = 'https://feed.example/v3/flat/';
const REGISTRATION = 'https://feed.example/v3/reg/';
const AUTOCOMPLETE = 'https://feed.example/v3/autocomplete';

const serviceIndex = (...types: Array<[string, string]>) => ({
  resources: types.map(([type, id]) => ({ '@type': type, '@id': id })),
});

const FULL_INDEX = serviceIndex(
  ['PackageBaseAddress/3.0.0', CONTENT],
  ['RegistrationsBaseUrl/3.6.0', REGISTRATION],
  ['SearchAutocompleteService/3.5.0', AUTOCOMPLETE],
);

/** A server described as a map from URL to answer; anything else is a 404. */
function server(routes: Record<string, HttpJsonResponse>) {
  const calls: string[] = [];
  const fetchJson = async (url: string): Promise<HttpJsonResponse> => {
    calls.push(url);
    return routes[url] ?? { status: 404 };
  };
  return { fetchJson, calls };
}

const ok = (json: unknown): HttpJsonResponse => ({ status: 200, json });

function ladderOver(routes: Record<string, HttpJsonResponse>) {
  const { fetchJson, calls } = server(routes);
  const capabilities = new SourceCapabilityStore(fetchJson, undefined, Date.now, () => true);
  return { ladder: new VersionLadder(capabilities, fetchJson, { isEnabled: () => true }), capabilities, calls };
}

const target = { url: SOURCE };

describe('VersionLadder first rung', () => {
  it('answers from the cheapest resource and asks no other', async () => {
    const { ladder, calls } = ladderOver({
      [SOURCE]: ok(FULL_INDEX),
      [`${CONTENT}newtonsoft.json/index.json`]: ok({ versions: ['12.0.3', '13.0.1', '13.0.4-beta'] }),
    });

    const listing = await ladder.versionsFromSource(target, { packageId: 'Newtonsoft.Json', includePrerelease: true });

    expect(listing).toEqual({
      sourceUrl: SOURCE,
      versions: ['13.0.4-beta', '13.0.1', '12.0.3'],
      rung: 'content',
    });
    expect(calls.some((c) => c.startsWith(REGISTRATION))).toBe(false);
  });

  it('lowercases the id for the predictable path, whatever case the caller used', async () => {
    const { ladder, calls } = ladderOver({
      [SOURCE]: ok(FULL_INDEX),
      [`${CONTENT}newtonsoft.json/index.json`]: ok({ versions: ['13.0.1'] }),
    });

    await ladder.versionsFromSource(target, { packageId: '  NewtonSoft.JSON  ' });

    expect(calls).toContain(`${CONTENT}newtonsoft.json/index.json`);
  });

  it('drops pre-release versions unless they were asked for, flag absent or false', async () => {
    const { ladder } = ladderOver({
      [SOURCE]: ok(FULL_INDEX),
      [`${CONTENT}a/index.json`]: ok({ versions: ['1.0.0', '2.0.0-rc.1'] }),
    });

    const listing = await ladder.versionsFromSource(target, { packageId: 'A', includePrerelease: false });
    const byDefault = await ladder.versionsFromSource(target, { packageId: 'A' });

    expect(listing?.versions).toEqual(['1.0.0']);
    // The CLI shows no pre-release without being asked; so does this.
    expect(byDefault?.versions).toEqual(['1.0.0']);
  });

  it('climbs when the cheapest resource is not advertised at all', async () => {
    const { ladder } = ladderOver({
      [SOURCE]: ok(serviceIndex(['RegistrationsBaseUrl/3.6.0', REGISTRATION])),
      [`${REGISTRATION}a/index.json`]: ok({
        items: [{ items: [{ catalogEntry: { version: '1.0.0' } }, { catalogEntry: { version: '2.0.0' } }] }],
      }),
    });

    const listing = await ladder.versionsFromSource(target, { packageId: 'A' });

    expect(listing).toEqual({ sourceUrl: SOURCE, versions: ['2.0.0', '1.0.0'], rung: 'metadata' });
  });

  it('says on the log why it condemned an address, and what it answered', async () => {
    // Removing a resource is the one decision here with an hour-long
    // consequence; without this the log showed a successful-looking row and
    // the feed silently stopped being used.
    const notes: Array<[string, string | undefined]> = [];
    const { fetchJson } = server({
      [SOURCE]: ok(FULL_INDEX),
      [`${CONTENT}a/index.json`]: {
        status: 200,
        json: { message: 'proxy error' },
        preview: '<html><body>502 Bad Gateway</body></html>',
      },
      [`${REGISTRATION}a/index.json`]: ok({ items: [{ items: [{ catalogEntry: { version: '1.0.0' } }] }] }),
    });
    const capabilities = new SourceCapabilityStore(fetchJson, undefined, Date.now, () => true);
    const ladder = new VersionLadder(capabilities, fetchJson, {
      isEnabled: () => true,
      log: { request: () => {}, note: (message, detail) => notes.push([message, detail]) },
    });

    await ladder.versionsFromSource(target, { packageId: 'A' });

    const verdict = notes.find(([message]) => message.includes('unexpected shape'));
    expect(verdict?.[0]).toContain('PackageBaseAddress');
    expect(verdict?.[0]).toContain('not used for an hour');
    expect(verdict?.[1]).toContain('502 Bad Gateway');
  });

  it('says "no body" when there was nothing to show', async () => {
    const notes: Array<[string, string | undefined]> = [];
    const { fetchJson } = server({
      [SOURCE]: ok(serviceIndex(['PackageBaseAddress/3.0.0', CONTENT])),
      [`${CONTENT}a/index.json`]: ok({ nothing: 'useful' }),
    });
    const capabilities = new SourceCapabilityStore(fetchJson, undefined, Date.now, () => true);
    const ladder = new VersionLadder(capabilities, fetchJson, {
      isEnabled: () => true,
      log: { request: () => {}, note: (message, detail) => notes.push([message, detail]) },
    });

    await ladder.versionsFromSource(target, { packageId: 'A' });

    expect(notes.find(([m]) => m.includes('unexpected shape'))?.[1]).toBe('no body');
  });

  it('condemns an address that answers in the wrong shape and climbs', async () => {
    const { ladder, capabilities } = ladderOver({
      [SOURCE]: ok(FULL_INDEX),
      [`${CONTENT}a/index.json`]: ok({ data: ['1.0.0'] }),
      [`${REGISTRATION}a/index.json`]: ok({ items: [{ items: [{ catalogEntry: { version: '1.0.0' } }] }] }),
    });

    const listing = await ladder.versionsFromSource(target, { packageId: 'A' });

    expect(listing?.rung).toBe('metadata');
    expect(capabilities.get(SOURCE)?.resources.PackageBaseAddress?.status).toBe('unavailable');
  });
});

describe('VersionLadder and a package that is simply not there', () => {
  it('says nothing when only one unproven resource missed, since that 404 might be itself', async () => {
    const { ladder } = ladderOver({
      [SOURCE]: ok(serviceIndex(['PackageBaseAddress/3.0.0', CONTENT])),
    });

    expect(await ladder.versionsFromSource(target, { packageId: 'Missing' })).toBeUndefined();
  });

  it('settles absence when two advertised resources independently miss', async () => {
    // Neither has proved itself, but two resources do not fail the same way by
    // coincidence — and without this every unknown id costs three requests on a
    // feed whose cheap resource is never otherwise exercised.
    const { ladder, calls } = ladderOver({ [SOURCE]: ok(FULL_INDEX) });

    const listing = await ladder.versionsFromSource(target, { packageId: 'Missing' });

    expect(listing).toEqual({ sourceUrl: SOURCE, versions: [], rung: 'metadata' });
    expect(calls.some((c) => c.startsWith(AUTOCOMPLETE))).toBe(false);
  });

  it('reports an empty list once that resource has proved itself', async () => {
    const { ladder } = ladderOver({
      [SOURCE]: ok(FULL_INDEX),
      [`${CONTENT}known/index.json`]: ok({ versions: ['1.0.0'] }),
    });

    await ladder.versionsFromSource(target, { packageId: 'Known' });
    const listing = await ladder.versionsFromSource(target, { packageId: 'Missing' });

    expect(listing).toEqual({ sourceUrl: SOURCE, versions: [], rung: 'content' });
  });
});

describe('VersionLadder reading paged metadata', () => {
  it('follows page addresses from the document instead of constructing them', async () => {
    const pageOne = 'https://feed.example/v3/reg/a/page/0.0.0/1.9.9.json';
    const { ladder, calls } = ladderOver({
      [SOURCE]: ok(serviceIndex(['RegistrationsBaseUrl/3.6.0', REGISTRATION])),
      [`${REGISTRATION}a/index.json`]: ok({
        items: [
          { '@id': pageOne, lower: '0.0.0', upper: '1.9.9' },
          { items: [{ catalogEntry: { version: '2.0.0' } }], lower: '2.0.0', upper: '2.0.0' },
        ],
      }),
      [pageOne]: ok({ items: [{ catalogEntry: { version: '1.0.0' } }] }),
    });

    const listing = await ladder.versionsFromSource(target, { packageId: 'A' });

    expect(listing?.versions).toEqual(['2.0.0', '1.0.0']);
    expect(calls).toContain(pageOne);
  });

  it('fetches only the page whose stated range covers the wanted version', async () => {
    const older = 'https://feed.example/v3/reg/a/page/1.0.0/1.9.9.json';
    const newer = 'https://feed.example/v3/reg/a/page/2.0.0/2.9.9.json';
    const { ladder, calls } = ladderOver({
      [SOURCE]: ok(serviceIndex(['RegistrationsBaseUrl/3.6.0', REGISTRATION])),
      [`${REGISTRATION}a/index.json`]: ok({
        items: [
          { '@id': older, lower: '1.0.0', upper: '1.9.9' },
          { '@id': newer, lower: '2.0.0', upper: '2.9.9' },
        ],
      }),
      [older]: ok({ items: [{ catalogEntry: { version: '1.5.0' } }] }),
      [newer]: ok({ items: [{ catalogEntry: { version: '2.5.0' } }] }),
    });

    const catalog = await ladder.catalogFromSource(target, { packageId: 'A', version: '2.5.0' });

    expect(catalog?.map((e) => e.version)).toEqual(['2.5.0']);
    expect(calls).toContain(newer);
    expect(calls).not.toContain(older);
  });

  it('reads a page whose bounds the server did not state', async () => {
    // The bounds are mandatory, but an unstated range is unknown, not empty.
    const page = 'https://feed.example/v3/reg/a/page/anon.json';
    const { ladder, calls } = ladderOver({
      [SOURCE]: ok(serviceIndex(['RegistrationsBaseUrl/3.6.0', REGISTRATION])),
      [`${REGISTRATION}a/index.json`]: ok({ items: [{ '@id': page }] }),
      [page]: ok({ items: [{ catalogEntry: { version: '2.5.0' } }] }),
    });

    const catalog = await ladder.catalogFromSource(target, { packageId: 'A', version: '2.5.0' });

    expect(catalog?.map((e) => e.version)).toEqual(['2.5.0']);
    expect(calls).toContain(page);
  });

  it('answers empty, not broken, when no page covers the wanted version', async () => {
    const { ladder, capabilities } = ladderOver({
      [SOURCE]: ok(serviceIndex(['RegistrationsBaseUrl/3.6.0', REGISTRATION])),
      [`${REGISTRATION}a/index.json`]: ok({
        items: [{ '@id': 'https://feed.example/v3/reg/a/page/1.json', lower: '1.0.0', upper: '1.9.9' }],
      }),
    });

    expect(await ladder.catalogFromSource(target, { packageId: 'A', version: '9.9.9' })).toEqual([]);
    expect(capabilities.get(SOURCE)?.resources.RegistrationsBaseUrl?.status).toBe('ready');
  });

  it('gives no answer rather than a truncated one when a page cannot be read', async () => {
    const { ladder } = ladderOver({
      [SOURCE]: ok(serviceIndex(['RegistrationsBaseUrl/3.6.0', REGISTRATION])),
      [`${REGISTRATION}a/index.json`]: ok({
        items: [{ '@id': 'https://feed.example/v3/reg/a/page/1.json' }],
      }),
    });

    expect(await ladder.versionsFromSource(target, { packageId: 'A' })).toBeUndefined();
  });
});

describe('VersionLadder reading the per-version catalog', () => {
  const REG_ONLY = serviceIndex(['RegistrationsBaseUrl/3.6.0', REGISTRATION]);

  it('keeps the labels that belong to each version separately', async () => {
    const { ladder } = ladderOver({
      [SOURCE]: ok(REG_ONLY),
      [`${REGISTRATION}a/index.json`]: ok({
        items: [{
          items: [
            {
              catalogEntry: {
                version: '1.0.0',
                vulnerabilities: [{ advisoryUrl: 'https://example.com/a', severity: '2' }],
              },
            },
            {
              catalogEntry: {
                version: '2.0.0',
                deprecation: { reasons: ['Legacy'], alternatePackage: { id: 'Example.Next' } },
              },
            },
          ],
        }],
      }),
    });

    const catalog = await ladder.catalogFromSource(target, { packageId: 'A' });

    expect(catalog?.map((e) => e.version)).toEqual(['1.0.0', '2.0.0']);
    expect(catalog?.[0].vulnerabilities).toEqual([{ advisoryUrl: 'https://example.com/a', severity: 2 }]);
    expect(catalog?.[1].deprecation?.alternatePackage?.id).toBe('Example.Next');
    expect(catalog?.[0].deprecation).toBeUndefined();
  });

  it('drops pre-release entries when they were not asked for', async () => {
    const { ladder } = ladderOver({
      [SOURCE]: ok(REG_ONLY),
      [`${REGISTRATION}a/index.json`]: ok({
        items: [{ items: [{ catalogEntry: { version: '1.0.0' } }, { catalogEntry: { version: '2.0.0-rc.1' } }] }],
      }),
    });

    const catalog = await ladder.catalogFromSource(target, { packageId: 'A', includePrerelease: false });

    expect(catalog?.map((e) => e.version)).toEqual(['1.0.0']);
  });

  it('gives no catalog at all while the feature is switched off', async () => {
    const { fetchJson } = server({ [SOURCE]: ok(REG_ONLY) });
    const off = new VersionLadder(
      new SourceCapabilityStore(fetchJson, undefined, Date.now, () => false),
      fetchJson,
      { isEnabled: () => false },
    );

    expect(await off.catalogFromSource(target, { packageId: 'A' })).toBeUndefined();
  });

  it('gives no catalog from a feed that publishes no metadata resource', async () => {
    const { ladder } = ladderOver({
      [SOURCE]: ok(serviceIndex(['PackageBaseAddress/3.0.0', CONTENT])),
      [`${CONTENT}a/index.json`]: ok({ versions: ['1.0.0'] }),
    });

    expect(await ladder.catalogFromSource(target, { packageId: 'A' })).toBeUndefined();
  });
});

describe('VersionLadder last rung', () => {
  const autocompleteOnly = serviceIndex(['SearchAutocompleteService/3.5.0', AUTOCOMPLETE]);

  it('asks for versions of one id, with the parameters that keep the list complete', async () => {
    const url = `${AUTOCOMPLETE}?id=A&prerelease=true&semVerLevel=2.0.0`;
    const { ladder } = ladderOver({
      [SOURCE]: ok(autocompleteOnly),
      [url]: ok({ data: ['1.0.0', '2.0.0'] }),
    });

    const listing = await ladder.versionsFromSource(target, { packageId: 'A' });

    expect(listing).toEqual({ sourceUrl: SOURCE, versions: ['2.0.0', '1.0.0'], rung: 'autocomplete' });
  });

  it('treats an empty answer as no answer, since that resource can be advertised and inert', async () => {
    const { ladder } = ladderOver({
      [SOURCE]: ok(autocompleteOnly),
      [`${AUTOCOMPLETE}?id=A&prerelease=true&semVerLevel=2.0.0`]: ok({ data: [] }),
    });

    expect(await ladder.versionsFromSource(target, { packageId: 'A' })).toBeUndefined();
  });
});

describe('VersionLadder falling back', () => {
  it('gives no answer while the feature is switched off', async () => {
    const { ladder: on } = ladderOver({
      [SOURCE]: ok(FULL_INDEX),
      [`${CONTENT}a/index.json`]: ok({ versions: ['1.0.0'] }),
    });
    expect(await on.versionsFromSource(target, { packageId: 'A' })).toBeDefined();

    const { fetchJson, calls } = server({
      [SOURCE]: ok(FULL_INDEX),
      [`${CONTENT}a/index.json`]: ok({ versions: ['1.0.0'] }),
    });
    const off = new VersionLadder(
      new SourceCapabilityStore(fetchJson, undefined, Date.now, () => false),
      fetchJson,
      { isEnabled: () => false },
    );

    expect(await off.versionsFromSource(target, { packageId: 'A' })).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('gives no answer for a source with no usable index', async () => {
    const { ladder } = ladderOver({ [SOURCE]: { status: 401 } });

    expect(await ladder.versionsFromSource(target, { packageId: 'A' })).toBeUndefined();
  });

  it('records nothing and gives no answer when the connection drops', async () => {
    const fetchJson = async (url: string): Promise<HttpJsonResponse> => {
      if (url === SOURCE) return ok(FULL_INDEX);
      throw new Error('socket hang up');
    };
    const capabilities = new SourceCapabilityStore(fetchJson, undefined, Date.now, () => true);
    const ladder = new VersionLadder(capabilities, fetchJson, { isEnabled: () => true });

    expect(await ladder.versionsFromSource(target, { packageId: 'A' })).toBeUndefined();
    expect(capabilities.get(SOURCE)?.resources.PackageBaseAddress?.status).toBe('advertised');
  });
});
