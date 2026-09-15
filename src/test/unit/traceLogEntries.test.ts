import { TraceController } from '../../traceController';
import type { TraceEvent } from '../../traceSession';

/**
 * A trace is what anyone takes to investigate, and it was fed only by the call
 * sites that make calls — `dotnet`, HTTP, webview messages. So it recorded work
 * that happened and nothing about work that was skipped, and an investigation
 * into an empty field saw the request arrive and nothing after it, while the Log
 * tab held the answer the whole time (#114).
 */
function controllerRecording(): { trace: TraceController; events: TraceEvent[] } {
  const events: TraceEvent[] = [];
  const trace = new TraceController(
    '/storage', {} as never, {} as never, {} as never,
    () => undefined, async () => '10.0.0',
    { extensionVersion: '0.8.0', appName: 'Code', vscodeVersion: '1.137.0', os: 'win32', arch: 'x64' },
  );
  trace.isRecording = () => true;
  trace.record = (event) => { events.push(event); };
  return { trace, events };
}

const row = (kind: string, command: string, args: string[] = [], stderr?: string) =>
  ({ kind, timestamp: '2026-09-15T17:27:12.524Z', command, args, stderr });

describe('synthetic log rows in the trace', () => {
  it('records what the extension decided, not only what it called', () => {
    const { trace, events } = controllerRecording();

    trace.recordLogEntry(row('info', 'Versions answered from cache: Example.Imaging', ['37 versions', '0 dated']));

    expect(events).toEqual([{
      kind: 'log',
      at: '2026-09-15T17:27:12.524Z',
      level: 'info',
      message: 'Versions answered from cache: Example.Imaging',
      args: ['37 versions', '0 dated'],
    }]);
  });

  it('keeps an error detail, which is the whole of the row', () => {
    const { trace, events } = controllerRecording();

    trace.recordLogEntry(row('error', 'Could not open the licence file', [], 'EACCES'));

    expect(events[0]).toMatchObject({ level: 'error', args: ['EACCES'] });
  });

  it('leaves cli and http rows to the call sites that make them', () => {
    // Both already reach the trace with a cwd or a response body this
    // subscription never sees; recording them here would double every one.
    const { trace, events } = controllerRecording();

    trace.recordLogEntry(row('cli', 'dotnet --version'));
    trace.recordLogEntry(row('http', 'GET https://feed.example/index.json'));

    expect(events).toEqual([]);
  });

  it('records nothing while no trace is recording', () => {
    const { trace, events } = controllerRecording();
    trace.isRecording = () => false;

    trace.recordLogEntry(row('info', 'Versions answered from cache: Example.Imaging'));

    expect(events).toEqual([]);
  });
});
