import { authorizingFetcher, CredentialRegistry } from '../../nugetHttpAuth';
import { HttpResponseCache } from '../../nugetHttpCache';
import { httpLogSink, loggingFetcher } from '../../nugetHttpLog';
import { retryingFetcher } from '../../nugetHttpRetry';
import type { HttpJsonResponse } from '../../nugetSourceCapabilities';
import type { CliLogEntry } from '../../logger';

/**
 * The layers composed exactly as the extension composes them.
 *
 * Each layer has its own tests, and they all passed while the assembled chain
 * was dropping the cache's validators on the floor: the credential layer built
 * a fresh header object and the test fetchers below it accepted whatever they
 * were given. A wrapper is only correct in the order it actually runs in, so
 * that order is what this file exercises.
 */
const URL_A = 'https://feed.example/v3/registration/a/index.json';

function chain(transport: (url: string, signal?: AbortSignal, headers?: Record<string, string>) => Promise<HttpJsonResponse>) {
  const rows: CliLogEntry[] = [];
  const log = httpLogSink({ logCliOperation: (entry) => { rows.push(entry); } });
  const credentials = new CredentialRegistry();
  const cache = new HttpResponseCache({ now: () => now, ttlMs: () => 5_000, log });
  const fetch = cache.wrap(authorizingFetcher(retryingFetcher(loggingFetcher(transport, log), {
    sleep: async () => {},
  }), credentials));
  return { fetch, cache, credentials, rows };
}

let now = 1_000;
beforeEach(() => { now = 1_000; });

describe('the composed fetch chain', () => {
  it('carries the cache validators all the way to the network', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const { fetch } = chain(async (_url, _signal, headers) => {
      seen.push(headers);
      return seen.length === 1
        ? { status: 200, json: { ok: true }, bytes: 8, etag: 'W/"v1"' }
        : { status: 304 };
    });

    await fetch(URL_A);
    now += 10_000;
    const second = await fetch(URL_A);

    expect(seen[1]?.['if-none-match']).toBe('W/"v1"');
    expect(second.json).toEqual({ ok: true });
  });

  it('carries them alongside a credential rather than instead of it', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const { fetch, credentials } = chain(async (_url, _signal, headers) => {
      seen.push(headers);
      return seen.length === 1
        ? { status: 200, json: { ok: true }, bytes: 8, etag: 'W/"v1"' }
        : { status: 304 };
    });
    credentials.remember('https://feed.example/v3/index.json', { username: 'u', password: 'p', encrypted: false });

    await fetch(URL_A);
    now += 10_000;
    await fetch(URL_A);

    expect(seen[1]).toEqual({
      'if-none-match': 'W/"v1"',
      authorization: `Basic ${Buffer.from('u:p').toString('base64')}`,
    });
  });

  it('retries under the credential layer, so the second attempt is authenticated too', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const { fetch, credentials, rows } = chain(async (_url, _signal, headers) => {
      seen.push(headers);
      return seen.length === 1 ? { status: 503 } : { status: 200, json: {}, bytes: 2 };
    });
    credentials.remember('https://feed.example/v3/index.json', { username: 'u', password: 'p', encrypted: false });

    await fetch(URL_A);

    expect(seen).toHaveLength(2);
    expect(seen.every((h) => !!h?.authorization)).toBe(true);
    // Both attempts are on the log, not just the one that worked.
    expect(rows.filter((r) => r.command.startsWith('GET '))).toHaveLength(2);
  });

  it('answers a repeat from the cache without reaching the network or the log', async () => {
    let calls = 0;
    const { fetch, rows } = chain(async () => { calls += 1; return { status: 200, json: {}, bytes: 4 }; });

    await fetch(URL_A);
    await fetch(URL_A);

    expect(calls).toBe(1);
    expect(rows.filter((r) => r.args.includes('cached'))).toHaveLength(1);
  });

  it('does not store what a request in flight brings back after an invalidation', async () => {
    let release: (r: HttpJsonResponse) => void = () => {};
    let calls = 0;
    const { fetch, cache } = chain(async () => {
      calls += 1;
      // Only the first call hangs; the second is the one that proves the cache
      // did not keep what the first brought back.
      if (calls > 1) return { status: 200, json: { fresh: true }, bytes: 8 };
      return new Promise<HttpJsonResponse>((resolve) => { release = resolve; });
    });

    const inFlight = fetch(URL_A);
    // The credential layer awaits before the transport is entered, so the
    // request is not in the air the instant `fetch` is called.
    while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    cache.clear();
    release({ status: 200, json: { stale: true }, bytes: 8 });
    await inFlight;

    expect((await fetch(URL_A)).json).toEqual({ fresh: true });
    expect(calls).toBe(2);
  });

  it('refuses a cancelled call instead of making one more request', async () => {
    let calls = 0;
    const { fetch } = chain(async () => { calls += 1; return { status: 503 }; });
    const controller = new AbortController();
    controller.abort();

    await expect(fetch(URL_A, controller.signal)).rejects.toThrow('aborted');
    expect(calls).toBe(0);
  });
});
