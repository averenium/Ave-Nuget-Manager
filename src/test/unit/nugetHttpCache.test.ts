import { HttpResponseCache } from '../../nugetHttpCache';
import type { HttpJsonResponse } from '../../nugetSourceCapabilities';

const URL_A = 'https://feed.example/v3/registration/a/index.json';

function counting(response: (url: string) => HttpJsonResponse) {
  const calls: string[] = [];
  return {
    calls,
    fetcher: async (url: string) => { calls.push(url); return response(url); },
  };
}

const big = (bytes: number): HttpJsonResponse => ({ status: 200, json: { ok: true }, bytes });

describe('HttpResponseCache', () => {
  it('answers a repeat without touching the network', async () => {
    const { fetcher, calls } = counting(() => big(1024));
    const cached = new HttpResponseCache().wrap(fetcher);

    await cached(URL_A);
    const second = await cached(URL_A);

    expect(calls).toHaveLength(1);
    expect(second).toEqual(big(1024));
  });

  it('shares one request between callers that ask at the same moment', async () => {
    // Three consumers want the same metadata document; the second and third
    // start before the first has answered, so a plain cache would miss them.
    let resolveIt: (r: HttpJsonResponse) => void = () => {};
    const calls: string[] = [];
    const cached = new HttpResponseCache().wrap(async (url) => {
      calls.push(url);
      return new Promise<HttpJsonResponse>((resolve) => { resolveIt = resolve; });
    });

    const all = Promise.all([cached(URL_A), cached(URL_A), cached(URL_A)]);
    resolveIt(big(512));
    const results = await all;

    expect(calls).toHaveLength(1);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('keeps one caller cancellation away from another', async () => {
    // A superseded search cancelling must not cancel the panel refresh that
    // happened to want the same document.
    let resolveIt: (r: HttpJsonResponse) => void = () => {};
    const cached = new HttpResponseCache().wrap(async () =>
      new Promise<HttpJsonResponse>((resolve) => { resolveIt = resolve; }));

    const a = new AbortController();
    const first = cached(URL_A, a.signal).then(() => 'A:ok', (e: Error) => `A:${e.name}`);
    const second = cached(URL_A).then(() => 'B:ok', (e: Error) => `B:${e.name}`);

    a.abort();
    resolveIt(big(8));

    expect(await first).toBe('A:AbortError');
    expect(await second).toBe('B:ok');
  });

  it('abandons the request only when the last waiter has gone', async () => {
    const aborted: boolean[] = [];
    let resolveIt: (r: HttpJsonResponse) => void = () => {};
    const cached = new HttpResponseCache().wrap(async (_url, signal) => {
      signal?.addEventListener('abort', () => aborted.push(true));
      return new Promise<HttpJsonResponse>((resolve) => { resolveIt = resolve; });
    });

    const a = new AbortController();
    const b = new AbortController();
    const first = cached(URL_A, a.signal).catch(() => 'gone');
    const second = cached(URL_A, b.signal).catch(() => 'gone');

    a.abort();
    expect(aborted).toEqual([]);
    b.abort();
    expect(aborted).toEqual([true]);

    resolveIt(big(8));
    expect(await Promise.all([first, second])).toEqual(['gone', 'gone']);
  });

  it('refuses outright when the caller has already cancelled', async () => {
    const { fetcher, calls } = counting(() => big(8));
    const cached = new HttpResponseCache().wrap(fetcher);
    const controller = new AbortController();
    controller.abort();

    await expect(cached(URL_A, controller.signal)).rejects.toThrow('aborted');
    expect(calls).toEqual([]);
  });

  it('shows a joined caller on the log instead of leaving a gap', async () => {
    const rows: Array<{ reason?: string }> = [];
    let resolveIt: (r: HttpJsonResponse) => void = () => {};
    const cache = new HttpResponseCache({
      log: { request: (record) => rows.push(record), note: () => {} },
    });
    const cached = cache.wrap(async () =>
      new Promise<HttpJsonResponse>((resolve) => { resolveIt = resolve; }));

    const all = Promise.all([cached(URL_A), cached(URL_A), cached(URL_A)]);
    resolveIt(big(8));
    await all;

    expect(rows.map((r) => r.reason)).toEqual(['shared', 'shared']);
  });

  it('revalidates an expired entry instead of downloading it again', async () => {
    // The document is large and stable; "unchanged" costs the headers alone.
    let clock = 1_000;
    const seen: Array<Record<string, string> | undefined> = [];
    const cache = new HttpResponseCache({ now: () => clock, ttlMs: () => 5_000 });
    const cached = cache.wrap(async (_url, _signal, headers) => {
      seen.push(headers);
      return seen.length === 1
        ? { status: 200, json: { versions: ['1.0.0'] }, bytes: 512, etag: 'W/"v1"' }
        : { status: 304 };
    });

    await cached(URL_A);
    clock += 10_000;
    const second = await cached(URL_A);

    expect(seen[1]).toEqual({ 'if-none-match': 'W/\"v1\"' });
    expect(second.json).toEqual({ versions: ['1.0.0'] });
  });

  it('keeps a revalidated entry fresh for another window', async () => {
    let clock = 1_000;
    const calls: number[] = [];
    const cache = new HttpResponseCache({ now: () => clock, ttlMs: () => 5_000 });
    const cached = cache.wrap(async () => {
      calls.push(clock);
      return calls.length === 1
        ? { status: 200, json: { ok: true }, bytes: 8, lastModified: 'Thu, 01 Jan 2026 00:00:00 GMT' }
        : { status: 304 };
    });

    await cached(URL_A);
    clock += 10_000;
    await cached(URL_A);
    clock += 1_000;
    await cached(URL_A);

    expect(calls).toHaveLength(2);
  });

  it('asks with the date when that is all the server gave', async () => {
    let clock = 1_000;
    const seen: Array<Record<string, string> | undefined> = [];
    const cached = new HttpResponseCache({ now: () => clock, ttlMs: () => 5_000 }).wrap(async (_url, _signal, headers) => {
      seen.push(headers);
      return { status: 200, json: {}, bytes: 8, lastModified: 'Thu, 01 Jan 2026 00:00:00 GMT' };
    });

    await cached(URL_A);
    clock += 10_000;
    await cached(URL_A);

    expect(seen[1]).toEqual({ 'if-modified-since': 'Thu, 01 Jan 2026 00:00:00 GMT' });
  });

  it('asks again once the window has passed', async () => {
    let clock = 1_000;
    const { fetcher, calls } = counting(() => big(16));
    const cached = new HttpResponseCache({ now: () => clock, ttlMs: () => 5_000 }).wrap(fetcher);

    await cached(URL_A);
    clock += 4_000;
    await cached(URL_A);
    clock += 2_000;
    await cached(URL_A);

    expect(calls).toHaveLength(2);
  });

  it('keeps a definitive "not here" but never a failure', async () => {
    let status = 404;
    const { fetcher, calls } = counting(() => ({ status }));
    const cached = new HttpResponseCache().wrap(fetcher);

    await cached(URL_A);
    await cached(URL_A);
    expect(calls).toHaveLength(1);

    status = 503;
    const other = 'https://feed.example/v3/registration/b/index.json';
    await cached(other);
    await cached(other);
    expect(calls).toHaveLength(3);
  });

  it('forgets everything on demand', async () => {
    const { fetcher, calls } = counting(() => big(16));
    const cache = new HttpResponseCache();
    const cached = cache.wrap(fetcher);

    await cached(URL_A);
    cache.clear();
    await cached(URL_A);

    expect(calls).toHaveLength(2);
  });

  it('does not hold a body large enough to matter', async () => {
    const { fetcher, calls } = counting(() => big(16 * 1024 * 1024));
    const cached = new HttpResponseCache().wrap(fetcher);

    await cached(URL_A);
    await cached(URL_A);

    expect(calls).toHaveLength(2);
  });

  it('drops the oldest entries rather than growing without bound', async () => {
    // Seven documents of seven megabytes pass the total ceiling, and the first
    // one in is the first one out.
    const { fetcher, calls } = counting(() => big(7 * 1024 * 1024));
    const cached = new HttpResponseCache().wrap(fetcher);

    await cached(URL_A);
    for (let i = 0; i < 7; i++) await cached(`https://feed.example/v3/doc-${i}.json`);
    await cached(URL_A);

    expect(calls).toHaveLength(9);
    expect(calls[0]).toBe(URL_A);
    expect(calls[8]).toBe(URL_A);
  });

  it('puts a hit on the log, so the record has no unexplained gaps', async () => {
    const rows: Array<{ url: string; reason?: string; durationMs: number }> = [];
    const cache = new HttpResponseCache({
      log: { request: (record) => rows.push(record), note: () => {} },
    });
    const cached = cache.wrap(async () => big(2048));

    await cached(URL_A);
    await cached(URL_A);

    expect(rows).toEqual([{ url: URL_A, status: 200, durationMs: 0, bytes: 2048, reason: 'cached' }]);
  });
});
