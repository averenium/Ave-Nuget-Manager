import {
  delayInstallRetry,
  INSTALL_RETRY_DELAY_MS,
  isRetryableCliFailure,
} from '../../cliRetry';
import type { CliResult } from '../../types';

function result(overrides: Partial<CliResult> = {}): CliResult {
  return { exitCode: 1, stdout: '', stderr: 'error', timedOut: false, ...overrides };
}

describe('isRetryableCliFailure', () => {
  it('retries host timeout (MongoDB.Driver / Operation timed out)', () => {
    expect(isRetryableCliFailure(result({
      timedOut: true,
      exitCode: null,
      stderr: 'Operation timed out',
    }))).toBe(true);
  });

  it('retries timedOut even if partial stdout already has NU1605', () => {
    expect(isRetryableCliFailure(result({
      timedOut: true,
      exitCode: null,
      stdout: 'error: NU1605: Warning As Error: downgrade',
    }))).toBe(true);
  });

  it('retries NU1301 service index / source blip', () => {
    expect(isRetryableCliFailure(result({
      stderr: 'error NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json',
    }))).toBe(true);
  });

  it('retries when dotnet add printed HTTP 429 / 502 / 503', () => {
    expect(isRetryableCliFailure(result({
      stderr: 'Response status code does not indicate success: 429 (Too Many Requests).',
    }))).toBe(true);
    expect(isRetryableCliFailure(result({ stderr: 'HTTP 502 Bad Gateway' }))).toBe(true);
    expect(isRetryableCliFailure(result({ stderr: '503 (Service Unavailable)' }))).toBe(true);
  });

  it('retries network phrases and NuGet cache file lock in CLI output', () => {
    expect(isRetryableCliFailure(result({ stderr: 'HttpRequestException: connection reset by peer' }))).toBe(true);
    expect(isRetryableCliFailure(result({
      stderr: 'The HTTP request to HTTPS://api.nuget.org/ timed out after 100000ms.',
    }))).toBe(true);
    expect(isRetryableCliFailure(result({ stderr: 'TaskCanceledException: A task was canceled.' }))).toBe(true);
    expect(isRetryableCliFailure(result({
      stderr: "The process cannot access the file because it is being used by another process.",
    }))).toBe(true);
    expect(isRetryableCliFailure(result({
      stderr: 'Unable to obtain lock file access on NuGet global packages folder',
    }))).toBe(true);
  });

  it('does not retry success, cancel, graph, not-found, insecure HTTP, auth, or missing SDK', () => {
    expect(isRetryableCliFailure(result({ exitCode: 0, stderr: '' }))).toBe(false);
    expect(isRetryableCliFailure(result({ cancelled: true, stderr: 'Cancelled', exitCode: null }))).toBe(false);
    expect(isRetryableCliFailure(result({ stdout: 'error: NU1605: Warning As Error: downgrade' }))).toBe(false);
    expect(isRetryableCliFailure(result({ stdout: 'warn : NU1608: Detected package version outside of dependency constraint' }))).toBe(false);
    expect(isRetryableCliFailure(result({ stderr: 'error NU1101: Unable to find package Foo.Bar' }))).toBe(false);
    expect(isRetryableCliFailure(result({ stderr: 'error NU1102: Unable to find version' }))).toBe(false);
    expect(isRetryableCliFailure(result({ stderr: 'error NU1103: Unable to find a stable package' }))).toBe(false);
    expect(isRetryableCliFailure(result({ stderr: 'error NU1107: Version conflict detected' }))).toBe(false);
    expect(isRetryableCliFailure(result({ stderr: 'error NU1201: Project is not compatible' }))).toBe(false);
    expect(isRetryableCliFailure(result({ stderr: 'error NU1202: Package is not compatible' }))).toBe(false);
    expect(isRetryableCliFailure(result({ stderr: 'error NU1302: You are running this command without the required HTTPS' }))).toBe(false);
    expect(isRetryableCliFailure(result({
      stderr: 'Response status code does not indicate success: 401 (Unauthorized).',
    }))).toBe(false);
    expect(isRetryableCliFailure(result({ stderr: 'HTTP 403 (Forbidden)' }))).toBe(false);
    expect(isRetryableCliFailure(result({
      stderr: "'dotnet' is not recognized as an internal or external command",
    }))).toBe(false);
  });

  it('does not treat NU1302 as NU1301', () => {
    expect(isRetryableCliFailure(result({
      stderr: 'error NU1302: You are running this command without the required HTTPS',
    }))).toBe(false);
  });
});

describe('delayInstallRetry', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('resolves after INSTALL_RETRY_DELAY_MS', async () => {
    const done = delayInstallRetry();
    jest.advanceTimersByTime(INSTALL_RETRY_DELAY_MS);
    await done;
  });

  it('resolves immediately when the signal is already aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    await delayInstallRetry(abort.signal);
  });

  it('resolves early when aborted during the wait', async () => {
    const abort = new AbortController();
    const done = delayInstallRetry(abort.signal);
    abort.abort();
    await done;
  });
});
