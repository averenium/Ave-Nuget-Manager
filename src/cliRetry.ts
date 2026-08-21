/**
 * Transient `dotnet add` failures that are worth one extra attempt.
 * Matches NU codes and HTTP/network phrases **in CLI stdout/stderr**.
 * Future NuGet HTTP API v3 (`HttpBackend`) retries belong in that backend, not here.
 * Graph / not-found / auth errors stay failed. Used by group (batch) update.
 */

import type { CliResult } from './types';
import { isCliOperationSuccess } from './dotnetOutput';

/** One extra `dotnet add` after a retryable failure. */
export const INSTALL_RETRY_EXTRA_ATTEMPTS = 1;

/** Pause between the failed add and the retry. */
export const INSTALL_RETRY_DELAY_MS = 750;

const DO_NOT_RETRY_CODES = /\b(?:NU1605|NU1608|NU1101|NU1102|NU1103|NU1107|NU1201|NU1202|NU1302)\b/;

const HTTP_AUTH = /(?:HTTP\s*(?:401|403)\b|status(?:\s+code)?[^\n]{0,40}(?:401|403)\b|\b(?:401|403)\s*\((?:Unauthorized|Forbidden)\))/i;

const DOTNET_MISSING =
  /dotnet(?:\.exe)?['"]?\s+is not recognized|\.NET SDK not found|ENOENT[\s\S]{0,80}dotnet/i;

const NU1301 = /\bNU1301\b/;

const HTTP_TRANSIENT =
  /(?:HTTP\s*(?:429|502|503)\b|status(?:\s+code)?[^\n]{0,40}(?:429|502|503)\b|\b(?:429|502|503)\s*\(|Too Many Requests|Bad Gateway|Service Unavailable)/i;

const NETWORK =
  /connection reset|HttpRequestException|The HTTP request\b[\s\S]{0,120}?timed out|TaskCanceledException/i;

const FILE_LOCK =
  /being used by another process|The process cannot access the file|Unable to obtain lock file access/i;

function cliText(result: CliResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

/**
 * True when a failed add may succeed on a second `dotnet add` of the same version.
 * `timedOut` retries even if partial stdout already shows a graph code (process was killed).
 */
export function isRetryableCliFailure(result: CliResult): boolean {
  if (result.cancelled) return false;
  if (isCliOperationSuccess(result)) return false;
  if (result.timedOut) return true;

  const text = cliText(result);
  if (DO_NOT_RETRY_CODES.test(text)) return false;
  if (HTTP_AUTH.test(text)) return false;
  if (DOTNET_MISSING.test(text)) return false;

  return NU1301.test(text) || HTTP_TRANSIENT.test(text) || NETWORK.test(text) || FILE_LOCK.test(text);
}

/** Abortable pause before a retry. Resolves immediately when `signal` is already aborted. */
export async function delayInstallRetry(signal?: AbortSignal): Promise<void> {
  if (INSTALL_RETRY_DELAY_MS <= 0) return;
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, INSTALL_RETRY_DELAY_MS);
    signal?.addEventListener('abort', done);
  });
}
