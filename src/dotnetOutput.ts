/**
 * Helpers for `dotnet` CLI stdout/stderr.
 *
 * Restore errors (NU1605, etc.) usually go to stdout, not stderr. A failed
 * `dotnet add` can still rewrite the PackageReference, then fail restore —
 * sometimes with exit code 0.
 */

import type { CliResult } from './types';

const MAX_ERROR_LINES = 24;

/** Pull the first JSON object out of mixed CLI output (warnings + JSON). */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  const end = text.lastIndexOf('}');
  if (end <= start) return null;
  return text.slice(start, end + 1);
}

/** Lines from `dotnet add` that explain why restore failed (skip X.509 / CACHE / NU1903). */
function isAddFailureDetailLine(line: string): boolean {
  return (
    /^error[:\s]/i.test(line) ||
    /^warn\s*:\s*NU1608\b/i.test(line) ||
    /^log\s*:\s*Failed to restore/i.test(line)
  );
}

export function hasDotnetErrorOutput(stdout: string, stderr: string): boolean {
  const text = `${stderr}\n${stdout}`;
  return /(?:^|\n)error[:\s]/i.test(text) || /Failed to restore/i.test(text);
}

/** True when add/remove should be reported as success — exit 0 is not enough. */
export function isCliOperationSuccess(result: CliResult): boolean {
  if (result.cancelled) return false;
  if (result.timedOut) return false;
  if (result.exitCode !== 0) return false;
  return !hasDotnetErrorOutput(result.stdout, result.stderr);
}

/** `dotnet list --format json` on a broken restore: `{ problems: [{ text, level }] }`, no projects. */
export function summarizeListProblems(stdout: string): string | undefined {
  const raw = extractJsonObject(stdout);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as {
      problems?: Array<{ text?: string; level?: string }>;
    };
    const texts = (parsed.problems ?? [])
      .map((p) => (typeof p?.text === 'string' ? p.text.trim() : ''))
      .filter((t) => t.length > 0);
    return texts.length > 0 ? texts.join('\n') : undefined;
  } catch {
    return undefined;
  }
}

function joinLimited(lines: string[]): string {
  if (lines.length === 0) return 'dotnet command failed';
  if (lines.length > MAX_ERROR_LINES) {
    return `${lines.slice(0, MAX_ERROR_LINES).join('\n')}\n…`;
  }
  return lines.join('\n');
}

/**
 * Message for a failed `dotnet add` / `dotnet remove`.
 * Uses NU1605 graphs from stdout — not the later `dotnet list` JSON
 * ("Restore failed. Run `dotnet restore`…").
 */
export function summarizeDotnetFailure(stdout: string, stderr: string): string {
  const text = [stderr, stdout].filter((s) => s.trim().length > 0).join('\n');
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);

  const details = lines.filter(isAddFailureDetailLine);
  if (details.length > 0) return joinLimited(details);

  return joinLimited(lines.slice(-12));
}

/** Raw CLI dump for the error banner (no filtering). */
export function cliOutputText(result: Pick<CliResult, 'stdout' | 'stderr'>): string {
  return [result.stdout, result.stderr]
    .filter((s) => s.trim().length > 0)
    .join('\n')
    .replace(/\r\n/g, '\n')
    .trimEnd();
}

/**
 * Combines N independent `dotnet restore <project>` results (folder scope has
 * no single solution to restore in one call) into one CliResult: any failure
 * fails the whole operation, output is concatenated in project order.
 */
export function mergeCliResults(results: CliResult[]): CliResult {
  if (results.length === 0) return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  const firstFailure = results.find((r) => r.exitCode !== 0);
  return {
    exitCode: firstFailure ? firstFailure.exitCode : 0,
    stdout: results.map((r) => r.stdout).filter((s) => s.trim().length > 0).join('\n'),
    stderr: results.map((r) => r.stderr).filter((s) => s.trim().length > 0).join('\n'),
    timedOut: results.some((r) => r.timedOut),
    cancelled: results.some((r) => r.cancelled),
  };
}
