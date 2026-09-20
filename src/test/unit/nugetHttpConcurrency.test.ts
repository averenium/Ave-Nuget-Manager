import { originConcurrencyFetcher, originKey } from '../../nugetHttpConcurrency';
import type { HttpJsonResponse } from '../../nugetSourceCapabilities';

describe('originKey', () => {
  it('is the scheme and host, not the path or query — two resources on one feed share a cap', () => {
    expect(originKey('https://api.nuget.org/v3/registration/pkg/index.json')).toBe('https://api.nuget.org');
    expect(originKey('https://api.nuget.org/v3/search?q=pkg')).toBe('https://api.nuget.org');
  });

  it('keeps a different host or scheme apart', () => {
    expect(originKey('https://a.example/x')).not.toBe(originKey('https://b.example/x'));
    expect(originKey('https://a.example/x')).not.toBe(originKey('http://a.example/x'));
  });

  it('falls back to the raw string for an address it cannot parse as a URL', () => {
    expect(originKey('not a url')).toBe('not a url');
  });
});

describe('originConcurrencyFetcher (#116)', () => {
  function stubTransport(delayMs = 20) {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetcher = async (_url: string): Promise<HttpJsonResponse> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, delayMs));
      inFlight--;
      return { status: 200 };
    };
    return { fetcher, maxInFlight: () => maxInFlight };
  }

  it('never runs more than the limit at once against the same origin', async () => {
    const stub = stubTransport();
    const gated = originConcurrencyFetcher(stub.fetcher, () => 2);

    await Promise.all(
      Array.from({ length: 6 }, (_, i) => gated(`https://feed.example/v3/pkg${i}.json`)),
    );

    expect(stub.maxInFlight()).toBeGreaterThan(1);
    expect(stub.maxInFlight()).toBeLessThanOrEqual(2);
  });

  it('does not let a busy origin queue a request to a different one', async () => {
    const started: string[] = [];
    const fetcher = async (url: string): Promise<HttpJsonResponse> => {
      started.push(url);
      if (url.includes('busy')) await new Promise((r) => setTimeout(r, 30));
      return { status: 200 };
    };
    const gated = originConcurrencyFetcher(fetcher, () => 1);

    const busy1 = gated('https://busy.example/a');
    const busy2 = gated('https://busy.example/b');
    const other = gated('https://other.example/a');

    await other;
    // 'other' is on its own origin and must not wait behind busy.example's cap.
    expect(started).toEqual(['https://busy.example/a', 'https://other.example/a']);
    await Promise.all([busy1, busy2]);
  });

  it('reads the limit fresh on every acquire, so a setting change applies without a reload', async () => {
    let limit = 1;
    const stub = stubTransport();
    const gated = originConcurrencyFetcher(stub.fetcher, () => limit);

    await gated('https://feed.example/a');
    limit = 3;
    await Promise.all([
      gated('https://feed.example/b'),
      gated('https://feed.example/c'),
      gated('https://feed.example/d'),
    ]);

    expect(stub.maxInFlight()).toBe(3);
  });

  it('passes the signal, headers and intent through untouched', async () => {
    const seen: unknown[] = [];
    const fetcher = async (url: string, signal?: AbortSignal, headers?: Record<string, string>, intent?: { wantText?: boolean }) => {
      seen.push([url, signal, headers, intent]);
      return { status: 200 } as HttpJsonResponse;
    };
    const controller = new AbortController();
    const gated = originConcurrencyFetcher(fetcher, () => 4);

    await gated('https://feed.example/a', controller.signal, { accept: 'application/json' }, { wantText: true });

    expect(seen).toEqual([
      ['https://feed.example/a', controller.signal, { accept: 'application/json' }, { wantText: true }],
    ]);
  });
});
