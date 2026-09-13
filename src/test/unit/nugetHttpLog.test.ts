import { httpLogSink, loggingFetcher } from '../../nugetHttpLog';
import type { CliLogEntry } from '../../logger';

function recordingLog() {
  const entries: CliLogEntry[] = [];
  return { entries, logCliOperation: (entry: CliLogEntry) => { entries.push(entry); } };
}

describe('httpLogSink', () => {
  it('records a request as its own kind of row, with what it cost', () => {
    const log = recordingLog();

    httpLogSink(log).request({
      url: 'https://feed.example/v3/flat/newtonsoft.json/index.json',
      status: 200,
      durationMs: 42,
      bytes: 1536,
      reason: 'versions',
    });

    expect(log.entries[0]).toMatchObject({
      kind: 'http',
      command: 'GET https://feed.example/v3/flat/newtonsoft.json/index.json',
      args: ['200', '1.5 KB', 'versions'],
      exitCode: 0,
      durationMs: 42,
    });
  });

  it('says that a request was authenticated, never with what', () => {
    const log = recordingLog();

    httpLogSink(log).request({ url: 'https://feed.example/v3/index.json', status: 200, durationMs: 5, authorized: true });

    const row = JSON.stringify(log.entries[0]);
    expect(log.entries[0].args).toContain('authenticated');
    expect(row).not.toMatch(/Basic |password|authorization/i);
  });

  it('does not paint a missing package as a failure', () => {
    // A 404 is how a feed says it does not have this package.
    const log = recordingLog();

    httpLogSink(log).request({ url: 'https://feed.example/v3/flat/nope/index.json', status: 404, durationMs: 3 });

    expect(log.entries[0].exitCode).toBe(0);
    expect(log.entries[0].args).toContain('404');
  });

  it('paints a refusal and a server error as failures', () => {
    const log = recordingLog();
    const sink = httpLogSink(log);

    sink.request({ url: 'https://feed.example/v3/index.json', status: 401, durationMs: 3 });
    sink.request({ url: 'https://feed.example/v3/index.json', status: 503, durationMs: 3 });

    expect(log.entries.map((e) => e.exitCode)).toEqual([401, 503]);
  });

  it('records a request that never got an answer', () => {
    const log = recordingLog();

    httpLogSink(log).request({
      url: 'https://feed.example/v3/index.json',
      status: 0,
      durationMs: 8000,
      error: 'The operation was aborted',
    });

    expect(log.entries[0]).toMatchObject({ args: ['no response'], stderr: 'The operation was aborted' });
    expect(log.entries[0].exitCode).not.toBe(0);
  });

  it('records a decision beside the requests that caused it', () => {
    const log = recordingLog();

    httpLogSink(log).note('versions of Newtonsoft.Json from content resource', '53 version(s) · nuget.org');

    expect(log.entries[0]).toMatchObject({
      kind: 'http',
      command: 'versions of Newtonsoft.Json from content resource',
      args: ['53 version(s) · nuget.org'],
      exitCode: 0,
    });
  });
});

describe('httpLogSink and the trace', () => {
  it('hands every request to a recording trace, body included', async () => {
    const recorded: Array<{ url: string; body?: string; authorized?: boolean }> = [];
    const log = recordingLog();
    const sink = httpLogSink(log, { recordHttp: (entry) => recorded.push(entry) });

    sink.request({
      url: 'https://feed.example/v3/index.json',
      status: 200,
      durationMs: 12,
      bytes: 900,
      authorized: true,
      preview: '{"resources":[]}',
    });

    expect(recorded).toEqual([{
      url: 'https://feed.example/v3/index.json',
      status: 200,
      durationMs: 12,
      bytes: 900,
      authorized: true,
      reason: undefined,
      error: undefined,
      body: '{"resources":[]}',
    }]);
  });

  it('keeps the body out of the log row itself', async () => {
    const log = recordingLog();

    httpLogSink(log).request({
      url: 'https://feed.example/v3/index.json',
      status: 200,
      durationMs: 3,
      preview: 'SECRET-LOOKING-BODY',
    });

    expect(JSON.stringify(log.entries)).not.toContain('SECRET-LOOKING-BODY');
  });

  it('does not let one body fill the trace on its own', async () => {
    const recorded: Array<{ body?: string }> = [];
    const sink = httpLogSink(recordingLog(), { recordHttp: (entry) => recorded.push(entry) });

    sink.request({
      url: 'https://feed.example/v3/reg/a/index.json',
      status: 200,
      durationMs: 3,
      preview: 'x'.repeat(2 * 1024 * 1024),
    });

    expect(recorded[0].body?.length).toBe(256 * 1024);
  });
});

describe('loggingFetcher', () => {
  it('logs every call with its duration and size', async () => {
    const log = recordingLog();
    const fetcher = loggingFetcher(async () => ({ status: 200, json: {}, bytes: 2048 }), httpLogSink(log));

    await fetcher('https://feed.example/v3/index.json');

    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].args).toEqual(['200', '2.0 KB']);
  });

  it('logs a failure and still lets it through to the caller', async () => {
    const log = recordingLog();
    const fetcher = loggingFetcher(async () => { throw new Error('socket hang up'); }, httpLogSink(log));

    await expect(fetcher('https://feed.example/v3/index.json')).rejects.toThrow('socket hang up');
    expect(log.entries[0].stderr).toBe('socket hang up');
  });

  it('carries the body preview from the transport to the sink', async () => {
    const log = recordingLog();
    const recorded: Array<{ body?: string }> = [];
    const fetcher = loggingFetcher(
      async () => ({ status: 200, json: {}, bytes: 4, preview: '{"data":[]}' }),
      httpLogSink(log, { recordHttp: (entry) => recorded.push(entry) }),
    );

    await fetcher('https://feed.example/v3/query');

    expect(recorded[0].body).toBe('{"data":[]}');
  });

  it('passes the headers it was given through untouched', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const fetcher = loggingFetcher(
      async (_url, _signal, headers) => { seen.push(headers); return { status: 200 }; },
      httpLogSink(recordingLog()),
    );

    await fetcher('https://feed.example/v3/index.json', undefined, { authorization: 'Basic dTpw' });

    expect(seen[0]).toEqual({ authorization: 'Basic dTpw' });
  });
});
