import { SourceCapabilityStore, type HttpJsonResponse } from '../../nugetSourceCapabilities';
import { VersionLadder } from '../../nugetVersionLadder';

/**
 * How much of a paged history a walk reads, and who decides.
 *
 * A registration document is paged, and three callers share this walk: the
 * version list and the enrich answer need every page, while the details panel
 * needs one version. The scope is therefore carried as its own flag and never
 * inferred from a version being absent — these cases exist to fail loudly if
 * anyone collapses the two again, because a short answer still looks like a
 * successful one and never falls back to the CLI.
 */
const SOURCE = 'https://feed.example/v3/index.json';
const REGISTRATION = 'https://feed.example/v3/reg/';
const INDEX = `${REGISTRATION}example.longhistory/index.json`;

const PAGES = [
  { url: `${REGISTRATION}example.longhistory/page/1.0.0/1.66.0.json`, lower: '1.0.0', upper: '1.66.0', versions: ['1.0.0', '1.66.0'] },
  { url: `${REGISTRATION}example.longhistory/page/1.67.0/1.122.0.json`, lower: '1.67.0', upper: '1.122.0', versions: ['1.67.0', '1.122.0'] },
  { url: `${REGISTRATION}example.longhistory/page/1.123.0/1.180.0.json`, lower: '1.123.0', upper: '1.180.0', versions: ['1.123.0', '1.180.0'] },
];

const ok = (json: unknown): HttpJsonResponse => ({ status: 200, json });

const leaf = (version: string) => ({ catalogEntry: { version, listed: true, description: `v${version}` } });

function feed() {
  const routes: Record<string, HttpJsonResponse> = {
    [SOURCE]: ok({ resources: [{ '@type': 'RegistrationsBaseUrl/3.6.0', '@id': REGISTRATION }] }),
    [INDEX]: ok({ items: PAGES.map((p) => ({ '@id': p.url, lower: p.lower, upper: p.upper })) }),
  };
  for (const page of PAGES) routes[page.url] = ok({ items: page.versions.map(leaf) });

  const calls: string[] = [];
  const fetchJson = async (url: string): Promise<HttpJsonResponse> => {
    calls.push(url);
    return routes[url] ?? { status: 404 };
  };
  const capabilities = new SourceCapabilityStore(fetchJson, undefined, Date.now, () => true);
  return {
    ladder: new VersionLadder(capabilities, fetchJson, { isEnabled: () => true }),
    calls,
    pagesRead: () => calls.filter((u) => u.includes('/page/')),
  };
}

const target = { url: SOURCE };
const base = { packageId: 'Example.LongHistory', includePrerelease: true };

describe('how much of a paged history a walk reads', () => {
  it('reads every page when no scope is named — the version list depends on it', async () => {
    const { ladder, pagesRead } = feed();

    const entries = await ladder.catalogFromSource(target, base);

    expect(entries?.map((e) => e.version)).toEqual(
      ['1.0.0', '1.66.0', '1.67.0', '1.122.0', '1.123.0', '1.180.0'],
    );
    expect(pagesRead()).toHaveLength(3);
  });

  it('reads only the last page when the caller wants the newest version', async () => {
    const { ladder, pagesRead } = feed();

    const entries = await ladder.catalogFromSource(target, { ...base, newestOnly: true });

    expect(entries?.map((e) => e.version)).toEqual(['1.123.0', '1.180.0']);
    expect(pagesRead()).toEqual([PAGES[2].url]);
  });

  it('reads only the page that covers a named version', async () => {
    const { ladder, pagesRead } = feed();

    await ladder.catalogFromSource(target, { ...base, version: '1.67.0' });

    expect(pagesRead()).toEqual([PAGES[1].url]);
  });

  it('lets a named version win over the newest-only flag', async () => {
    const { ladder, pagesRead } = feed();

    await ladder.catalogFromSource(target, { ...base, version: '1.0.0', newestOnly: true });

    expect(pagesRead()).toEqual([PAGES[0].url]);
  });
});

describe('two callers asking at the same moment', () => {
  it('share one walk when they want the same thing', async () => {
    const { ladder, calls } = feed();

    const [first, second] = await Promise.all([
      ladder.catalogFromSource(target, base),
      ladder.catalogFromSource(target, base),
    ]);

    expect(first).toEqual(second);
    // One index read and three pages: the second caller added nothing.
    expect(calls.filter((u) => u === INDEX)).toHaveLength(1);
    expect(calls.filter((u) => u.includes('/page/'))).toHaveLength(3);
  });

  it('do not share a walk of a different scope, which would answer the wrong question', async () => {
    const { ladder } = feed();

    const [everything, newest] = await Promise.all([
      ladder.catalogFromSource(target, base),
      ladder.catalogFromSource(target, { ...base, newestOnly: true }),
    ]);

    expect(everything).toHaveLength(6);
    expect(newest).toHaveLength(2);
  });

  it('walks again once the first walk has finished', async () => {
    const { ladder, calls } = feed();

    await ladder.catalogFromSource(target, base);
    await ladder.catalogFromSource(target, base);

    // Nothing here caches a response — that is the transport's business — so a
    // later caller reads the document again rather than being served a stale one.
    expect(calls.filter((u) => u === INDEX)).toHaveLength(2);
  });
});
