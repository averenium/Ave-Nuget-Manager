/**
 * Not asking the same server the same question twice (#27).
 *
 * Three callers want overlapping things about one package — the version list,
 * the picker's per-version fields, the details panel — and each of them reaches
 * the same metadata document. Measured on a real feed, that document is over
 * half a megabyte, and it was being downloaded three times within half a
 * second. The same happens across configuration files: two files that enable
 * the same feed produced two identical rounds of requests.
 *
 * So responses are held briefly, and requests already in flight are shared
 * rather than duplicated. The window is the same one the panel already uses for
 * its own package cache, which keeps "refresh" meaning the same thing
 * everywhere.
 *
 * What is deliberately *not* cached: a failure. A timeout or a 5xx says nothing
 * about the resource, and holding it would extend one bad moment across the
 * whole window.
 *
 * Past the window an entry is not thrown away but **revalidated**: the request
 * carries the validator the server gave, and a server that answers "unchanged"
 * refreshes the held copy for the price of the headers. That matters most for
 * the documents that are both large and stable — a package's metadata is over
 * half a megabyte and changes only when the package does.
 */

import { getConfig } from './config';
import { SILENT_HTTP_LOG, type HttpLogSink } from './nugetHttpLog';
import { worthCaching } from './nugetHttpStatus';
import type { FetchIntent, HttpFetcher, HttpJsonResponse } from './nugetSourceCapabilities';

interface CacheEntry {
  response: HttpJsonResponse;
  at: number;
  bytes: number;
  /** Kept past expiry: it is what makes revalidation possible. */
  etag?: string;
  lastModified?: string;
}

/**
 * One request several callers are waiting on.
 *
 * The request runs on a controller of its own rather than on any caller's
 * signal. Otherwise the first caller to cancel would cancel everyone: a
 * superseded search would abort the request a still-wanted panel refresh had
 * joined. The shared request is abandoned only when the last waiter has left.
 */
interface SharedRequest {
  promise: Promise<HttpJsonResponse>;
  controller: AbortController;
  waiters: number;
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Ceilings, so a long session cannot grow without bound. A metadata document
 * of half a megabyte is normal, so the byte ceiling is what actually binds.
 */
const MAX_ENTRIES = 128;
const MAX_BYTES = 48 * 1024 * 1024;
/** A body this large is served rather than held; re-fetching it is the cheaper risk. */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

export interface CacheOptions {
  now?: () => number;
  /** How long an entry is served without asking the server about it. */
  ttlMs?: () => number;
  log?: HttpLogSink;
}

export class HttpResponseCache {
  private readonly _entries = new Map<string, CacheEntry>();
  private readonly _inFlight = new Map<string, SharedRequest>();
  private _bytes = 0;
  /**
   * Bumped on every clear. A request already in the air when the configuration
   * changed would otherwise land afterwards and write a pre-invalidation answer
   * into a cache that was just emptied.
   */
  private _generation = 0;

  private readonly _now: () => number;
  private readonly _ttlMs: () => number;
  /**
   * Hits are logged too. A request that never happened is still worth seeing on
   * the log: without it the record would have gaps where a consumer plainly
   * asked for something.
   */
  private readonly _log: HttpLogSink;

  constructor(options: CacheOptions = {}) {
    this._now = options.now ?? (() => Date.now());
    this._ttlMs = options.ttlMs ?? (() => getConfig().cacheTtlMs);
    this._log = options.log ?? SILENT_HTTP_LOG;
  }

  /** Drops everything — used when the configuration or the credentials change. */
  clear(): void {
    this._entries.clear();
    this._bytes = 0;
    this._generation += 1;
  }

  /** Wraps a fetcher so repeats within the window cost nothing. */
  wrap(fetchJson: HttpFetcher): HttpFetcher {
    return async (url, signal, headers, intent) => {
      if (signal?.aborted) throw abortError();

      const held = this._get(url);
      if (held) {
        this._log.request({
          url,
          status: held.status,
          durationMs: 0,
          bytes: held.bytes,
          reason: 'cached',
        });
        return held;
      }

      // Two callers asking at the same moment share one request; without this
      // the cache never sees the second one, because it starts before the first
      // has answered.
      const existing = this._inFlight.get(url);
      const shared = existing ?? this._start(url, fetchJson, headers, intent);
      const response = await this._join(url, shared, signal, !!existing);
      // A revalidated entry answers with the document it always held.
      if (response.status === 304) {
        const held = this._entries.get(url);
        if (held) return held.response;
      }
      return response;
    };
  }

  private _start(
    url: string,
    fetchJson: HttpFetcher,
    headers?: Record<string, string>,
    intent?: FetchIntent,
  ): SharedRequest {
    const controller = new AbortController();
    const shared: SharedRequest = { controller, waiters: 0, promise: undefined as never };
    const validators = this._validators(url);
    const generation = this._generation;
    shared.promise = fetchJson(url, controller.signal, { ...headers, ...validators }, intent)
      .then((response) => {
        // The caller is still answered; only the storing is skipped, because
        // what arrived describes the configuration as it was before the clear.
        if (generation === this._generation) this._put(url, response);
        return response;
      })
      .finally(() => this._inFlight.delete(url));
    this._inFlight.set(url, shared);
    return shared;
  }

  /**
   * Waits for a shared request on behalf of one caller. Cancelling here removes
   * this caller only; the request itself stops when nobody is left waiting.
   */
  private _join(
    url: string,
    shared: SharedRequest,
    signal: AbortSignal | undefined,
    joined: boolean,
  ): Promise<HttpJsonResponse> {
    shared.waiters += 1;
    const startedAt = this._now();

    return new Promise<HttpJsonResponse>((resolve, reject) => {
      let settled = false;
      const leave = () => {
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        shared.waiters -= 1;
      };
      const onAbort = () => {
        if (settled) return;
        leave();
        if (shared.waiters === 0) shared.controller.abort();
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      shared.promise.then(
        (response) => {
          if (settled) return;
          leave();
          // A caller that joined made no request of its own; the log says so,
          // rather than leaving an unexplained gap where it asked.
          if (joined) {
            this._log.request({
              url,
              status: response.status,
              durationMs: this._now() - startedAt,
              bytes: response.bytes,
              reason: 'shared',
            });
          }
          resolve(response);
        },
        (error) => {
          if (settled) return;
          leave();
          reject(error);
        },
      );
    });
  }

  private _get(url: string): HttpJsonResponse | undefined {
    const entry = this._entries.get(url);
    if (!entry) return undefined;
    if (this._now() - entry.at > this._ttlMs()) return undefined;
    return entry.response;
  }

  /** Headers that ask the server whether the held copy is still current. */
  private _validators(url: string): Record<string, string> | undefined {
    const entry = this._entries.get(url);
    if (!entry) return undefined;
    if (entry.etag) return { 'if-none-match': entry.etag };
    if (entry.lastModified) return { 'if-modified-since': entry.lastModified };
    return undefined;
  }

  private _put(url: string, response: HttpJsonResponse): void {
    const existing = this._entries.get(url);

    // "Unchanged" refers to the copy already held; it renews that copy rather
    // than replacing it with an empty answer.
    if (response.status === 304) {
      if (existing) existing.at = this._now();
      return;
    }
    if (!worthCaching(response.status)) return;
    const bytes = response.bytes ?? 0;
    if (bytes > MAX_ENTRY_BYTES) return;

    if (existing) this._bytes -= existing.bytes;
    this._entries.set(url, {
      response,
      at: this._now(),
      bytes,
      etag: response.etag,
      lastModified: response.lastModified,
    });
    this._bytes += bytes;

    // Oldest first, which for a Map is insertion order — good enough here,
    // since what is dropped is re-fetched rather than lost.
    while (this._entries.size > MAX_ENTRIES || this._bytes > MAX_BYTES) {
      const oldest = this._entries.keys().next();
      if (oldest.done) break;
      const dropped = this._entries.get(oldest.value);
      this._entries.delete(oldest.value);
      this._bytes -= dropped?.bytes ?? 0;
    }
  }
}
