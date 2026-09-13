import { retryAfterMs, retryingFetcher } from '../../nugetHttpRetry';
import type { HttpJsonResponse } from '../../nugetSourceCapabilities';

/** A fetcher that answers from a script and records how long it was asked to wait. */
function scripted(...responses: Array<HttpJsonResponse | Error>) {
  const calls: string[] = [];
  const waits: number[] = [];
  let i = 0;
  const fetcher = async (url: string): Promise<HttpJsonResponse> => {
    calls.push(url);
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return next;
  };
  const sleep = async (ms: number) => { waits.push(ms); };
  return { fetcher, calls, waits, sleep };
}

const URL_A = 'https://feed.example/v3/index.json';

describe('retryAfterMs', () => {
  it('reads the delay a server names, in either form', () => {
    expect(retryAfterMs('5')).toBe(5000);
    expect(retryAfterMs('0')).toBe(0);
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(retryAfterMs('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30_000);
  });

  it('ignores what it cannot read', () => {
    expect(retryAfterMs(undefined)).toBeUndefined();
    expect(retryAfterMs('soon')).toBeUndefined();
    expect(retryAfterMs('-5')).toBeUndefined();
  });
});

describe('retryingFetcher', () => {
  it('gives a gateway error one more chance', async () => {
    const s = scripted({ status: 502 }, { status: 200, json: { ok: true } });

    const response = await retryingFetcher(s.fetcher, { sleep: s.sleep })(URL_A);

    expect(response.status).toBe(200);
    expect(s.calls).toHaveLength(2);
  });

  it('retries a dropped connection too', async () => {
    const s = scripted(new Error('socket hang up'), { status: 200 });

    expect((await retryingFetcher(s.fetcher, { sleep: s.sleep })(URL_A)).status).toBe(200);
    expect(s.calls).toHaveLength(2);
  });

  it('does not repeat an answer the server meant', async () => {
    // 401, 403, 404 are decisions, not accidents; asking again is only slower.
    for (const status of [401, 403, 404, 400]) {
      const s = scripted({ status });
      expect((await retryingFetcher(s.fetcher, { sleep: s.sleep })(URL_A)).status).toBe(status);
      expect(s.calls).toHaveLength(1);
    }
  });

  it('stops after the extra attempt rather than piling on', async () => {
    const s = scripted({ status: 503 });

    expect((await retryingFetcher(s.fetcher, { sleep: s.sleep })(URL_A)).status).toBe(503);
    expect(s.calls).toHaveLength(2);
  });

  it('waits as long as the server asked, up to the ceiling', async () => {
    const s = scripted({ status: 429, retryAfter: '2' }, { status: 200 });
    await retryingFetcher(s.fetcher, { sleep: s.sleep, maxDelayMs: 3000 })(URL_A);
    expect(s.waits).toEqual([2000]);

    const long = scripted({ status: 429, retryAfter: '600' }, { status: 200 });
    await retryingFetcher(long.fetcher, { sleep: long.sleep, maxDelayMs: 3000 })(URL_A);
    expect(long.waits).toEqual([3000]);
  });

  it('uses its own short pause when the server names none', async () => {
    const s = scripted({ status: 503 }, { status: 200 });

    await retryingFetcher(s.fetcher, { sleep: s.sleep, delayMs: 250 })(URL_A);

    expect(s.waits).toEqual([250]);
  });

  it('never repeats a request the caller cancelled', async () => {
    const controller = new AbortController();
    const s = scripted(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    await expect(retryingFetcher(s.fetcher, { sleep: s.sleep })(URL_A, controller.signal))
      .rejects.toThrow('aborted');
    expect(s.calls).toHaveLength(1);
  });

  it('passes the headers it was given to every attempt', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const fetcher = async (_url: string, _signal?: AbortSignal, headers?: Record<string, string>) => {
      seen.push(headers);
      return { status: seen.length === 1 ? 503 : 200 } as HttpJsonResponse;
    };

    await retryingFetcher(fetcher, { sleep: async () => {} })(URL_A, undefined, { authorization: 'Basic dTpw' });

    expect(seen).toEqual([{ authorization: 'Basic dTpw' }, { authorization: 'Basic dTpw' }]);
  });
});
