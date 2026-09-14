/**
 * A bounded second chance for a request that failed on the way (#27).
 *
 * A 502 from a load balancer, a 429 from a busy feed, a connection dropped by a
 * proxy: none of these say anything about the resource, and every one of them
 * currently costs the user a fallback to the CLI for that whole operation. One
 * retry recovers most of them.
 *
 * The limits are deliberate:
 *
 * - **Only what may be repeated.** A retry is safe here because every request
 *   this feature makes is a read. Nothing retries a 4xx: the server understood
 *   and declined, and asking again would only be slower.
 * - **One extra attempt, not a storm.** A feed that is genuinely down must see
 *   at most twice the traffic, never an escalating pile of it — and the
 *   capability store already remembers not to ask again for a while.
 * - **The server decides how long**, when it says so: `Retry-After` is honoured
 *   up to a ceiling, because a feed asking for a minute is asking for longer
 *   than any panel interaction should wait.
 */

import { worthRepeating } from './nugetHttpStatus';
import type { HttpFetcher } from './nugetSourceCapabilities';

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Wait before the extra attempt when the server names no delay of its own. */
  delayMs?: number;
  /** Longest wait honoured from a `Retry-After` header. */
  maxDelayMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULTS = { attempts: 2, delayMs: 300, maxDelayMs: 3_000 };

/** `Retry-After` in seconds, or as a date; anything else is ignored. */
export function retryAfterMs(value: string | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  // A numeric value is seconds, full stop: letting a negative one fall through
  // to the date reading below turns "-5" into a parseable year.
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wraps a fetcher so a repeatable failure gets one more chance. A caller that
 * cancels in the meantime is not made to wait for it.
 */
function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

export function retryingFetcher(
  fetchJson: HttpFetcher,
  options: RetryOptions = {},
): HttpFetcher {
  const attempts = Math.max(1, options.attempts ?? DEFAULTS.attempts);
  const delayMs = options.delayMs ?? DEFAULTS.delayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const sleep = options.sleep ?? wait;

  return async (url, signal, headers, intent) => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      // Cancelled before the first attempt, or while waiting between two: in
      // both cases the caller is gone and the feed must not be asked again.
      if (signal?.aborted) throw abortError();
      try {
        const response = await fetchJson(url, signal, headers, intent);
        if (attempt === attempts || !worthRepeating(response.status)) return response;
        const asked = retryAfterMs(response.retryAfter);
        await sleep(Math.min(asked ?? delayMs, maxDelayMs), signal);
        continue;
      } catch (error) {
        // A cancelled request is not a failed one; it must not be repeated.
        if ((error as Error)?.name === 'AbortError' || signal?.aborted) throw error;
        if (attempt === attempts) throw error;
        await sleep(delayMs, signal);
      }
    }
    // Only reachable once the loop has been cut short by cancellation.
    throw abortError();
  };
}
