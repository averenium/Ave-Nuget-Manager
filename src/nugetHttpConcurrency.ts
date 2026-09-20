/**
 * A ceiling on how many requests are in flight to one origin at once (#116).
 *
 * The only limiter this feature has today is `dotnetConcurrency` — a setting
 * documented as governing parallel `dotnet` processes, applied to the enrich
 * wave because nothing else was there to ask. Two things are wrong with that
 * once the work is HTTP: raising it to speed up restores also widens the feed
 * fan-out nobody asked to widen, and packages in parallel is the wrong axis to
 * cap in the first place — `getAllVersions` and search fan out across every
 * source *for each* package, so four packages against three sources is twelve
 * concurrent walks with nothing bounding how many land on one host.
 *
 * A per-origin cap is the one a feed's operator would actually ask for, so
 * this gates by the request's own origin rather than by which caller made it.
 * The default of 6 borrows the number a decade of browsers settled on for
 * HTTP/1.1 connections per host — this transport is HTTP/1.1, one connection
 * per request on the proxied path — and it sits an order of magnitude below
 * `maxHttpRequestsPerSource`, the restore client's own default, on the
 * reasoning that a panel populating a picker can afford a second or two more
 * than a shared feed can afford being read as a burst.
 */

import { createKeyedConcurrencyGates } from './concurrency';
import type { HttpFetcher } from './nugetSourceCapabilities';

/** The origin a URL's requests are gated by, or the whole string when it cannot be parsed as one. */
export function originKey(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Wraps a fetcher so no more than `getLimit()` of its requests are in flight
 * to the same origin at once. Placed around the innermost transport call —
 * beneath the cache, so a hit or a joined in-flight request never occupies a
 * slot, and beneath the retry, so a repeat waiting out `Retry-After` releases
 * its slot for the wait instead of holding a connection nothing is using.
 */
export function originConcurrencyFetcher(fetchJson: HttpFetcher, getLimit: () => number): HttpFetcher {
  const gates = createKeyedConcurrencyGates(getLimit);
  return (url, signal, headers, intent) =>
    gates.gateFor(originKey(url)).run(() => fetchJson(url, signal, headers, intent));
}
