/**
 * Every HTTP request the catalog makes, on the Log tab (#27).
 *
 * The CLI path has always been inspectable: each `dotnet` invocation appears in
 * the log with its arguments and its output. Moving work to HTTP would have
 * removed that, leaving the extension doing things nobody can see. So requests
 * are logged the same way, as their own kind of row, along with the decisions
 * that explain them — which rung of the ladder answered, what a probe found,
 * where a fallback to the CLI came from.
 *
 * What a row never contains: an `Authorization` value, a password, or any part
 * of a credential. The row records *whether* a request was authenticated, which
 * is the part worth seeing when a feed answers 401.
 *
 * Bodies are not in the log, and on purpose. The ones worth reading are small —
 * a proxy error page, a portal's HTML, a document of the wrong shape — and they
 * are shown where the decision is made, next to the verdict that explains them.
 * The large ones are exactly the ones that answered correctly and have nothing
 * left to explain. Full bodies belong to the trace, which is opt-in and
 * sanitised on the way out.
 */

import type { CliLogEntry } from './logger';
import { readsAsFailure } from './nugetHttpStatus';
import type { HttpFetcher } from './nugetSourceCapabilities';

export interface HttpRequestRecord {
  url: string;
  /** HTTP status, or 0 when no response arrived at all. */
  status: number;
  durationMs: number;
  bytes?: number;
  /** Whether a credential was attached — never which one. */
  authorized?: boolean;
  /** Why the request was made: "probe", "versions", "search", … */
  reason?: string;
  /** Present when the request failed outright. */
  error?: string;
  /** The start of the body, when the transport kept one. */
  preview?: string;
}

/** Where the catalog reports what it did. */
export interface HttpLogSink {
  request(record: HttpRequestRecord): void;
  /** A decision worth seeing next to the requests that caused it. */
  note(message: string, detail?: string): void;
}

/** Discards everything — the default for code paths given no log. */
export const SILENT_HTTP_LOG: HttpLogSink = { request: () => {}, note: () => {} };

function formatBytes(bytes?: number): string | undefined {
  if (bytes === undefined) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Where a recording trace wants the requests, bodies included. */
export interface HttpTraceSink {
  recordHttp(entry: {
    url: string;
    status: number;
    durationMs: number;
    bytes?: number;
    authorized?: boolean;
    reason?: string;
    error?: string;
    body?: string;
  }): void;
}

/** A single body may not fill the trace on its own. */
const MAX_TRACE_BODY_BYTES = 256 * 1024;

/** Builds the sink over anything that accepts the extension's log entries. */
export function httpLogSink(
  log: { logCliOperation(entry: CliLogEntry): void },
  trace?: HttpTraceSink,
): HttpLogSink {
  return {
    request(record) {
      // The trace takes every request while it records, with as much of the
      // body as the transport kept — which is large only while recording.
      trace?.recordHttp({
        url: record.url,
        status: record.status,
        durationMs: record.durationMs,
        bytes: record.bytes,
        authorized: record.authorized,
        reason: record.reason,
        error: record.error,
        body: record.preview?.slice(0, MAX_TRACE_BODY_BYTES),
      });

      const details = [
        record.status > 0 ? String(record.status) : 'no response',
        formatBytes(record.bytes),
        record.authorized ? 'authenticated' : undefined,
        record.reason,
      ].filter((part): part is string => !!part);

      log.logCliOperation({
        timestamp: new Date(),
        kind: 'http',
        command: `GET ${record.url}`,
        args: details,
        stdout: '',
        stderr: record.error ?? '',
        // The status is shown among the details; the exit code only says
        // whether the row reads as a failure, and a 404 does not.
        exitCode: record.error || readsAsFailure(record.status) ? (record.status || 1) : 0,
        timedOut: false,
        durationMs: record.durationMs,
      });
    },

    note(message, detail) {
      log.logCliOperation({
        timestamp: new Date(),
        kind: 'http',
        command: message,
        args: detail ? [detail] : [],
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 0,
      });
    },
  };
}

/**
 * Wraps a fetcher so every call it makes appears in the log, with how long it
 * took and how much came back. Sits *inside* the credential wrapper, so it can
 * report that a request carried a credential without ever seeing its value.
 */
export function loggingFetcher(fetchJson: HttpFetcher, log: HttpLogSink): HttpFetcher {
  return async (url, signal, headers) => {
    const startedAt = Date.now();
    const authorized = !!headers?.authorization;
    try {
      const response = await fetchJson(url, signal, headers);
      log.request({
        url,
        status: response.status,
        durationMs: Date.now() - startedAt,
        bytes: response.bytes,
        authorized,
        preview: response.preview,
      });
      return response;
    } catch (err) {
      log.request({
        url,
        status: 0,
        durationMs: Date.now() - startedAt,
        authorized,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };
}
