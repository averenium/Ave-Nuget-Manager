import { Logger, formatUnknownError } from '../../logger';
import type { CliLogEntry } from '../../logger';
import type { LogEntry } from '../../types';

// The vscode module is auto-mocked via jest.config.ts moduleNameMapper
// pointing to src/test/__mocks__/vscode.ts

function makeOp(overrides?: Partial<CliLogEntry>): CliLogEntry {
  return {
    timestamp: new Date('2024-01-01T10:00:00.000Z'),
    command: 'dotnet list /path/A.csproj package',
    args: ['list', '/path/A.csproj', 'package'],
    stdout: 'stdout content',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    durationMs: 42,
    ...overrides,
  };
}

describe('Logger', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger();
  });

  afterEach(() => {
    logger.dispose();
  });

  // ── Basic storage ──────────────────────────────────────────────────────────

  it('starts with an empty entry list', () => {
    expect(logger.getEntries()).toHaveLength(0);
  });

  it('stores a logged entry in getEntries()', () => {
    logger.logCliOperation(makeOp());
    expect(logger.getEntries()).toHaveLength(1);
  });

  it('records all required fields', () => {
    const op = makeOp({
      timestamp: new Date('2024-06-15T12:30:00.000Z'),
      command: 'dotnet add /path/B.csproj package Newtonsoft.Json',
      args: ['add', '/path/B.csproj', 'package', 'Newtonsoft.Json'],
      stdout: 'Adding package...',
      stderr: 'warning: something',
      exitCode: 0,
      timedOut: false,
    });

    logger.logCliOperation(op);
    const [entry] = logger.getEntries();

    expect(entry.timestamp).toBe('2024-06-15T12:30:00.000Z');
    expect(entry.command).toBe(op.command);
    expect(entry.args).toEqual(op.args);
    expect(entry.stdout).toBe(op.stdout);
    expect(entry.stderr).toBe(op.stderr);
    expect(entry.exitCode).toBe(0);
    expect(entry.timedOut).toBe(false);
    expect(typeof entry.id).toBe('string');
    expect(entry.id).toHaveLength(36); // UUID v4 format
  });

  it('records timedOut=true correctly', () => {
    logger.logCliOperation(makeOp({ timedOut: true, exitCode: null }));
    const [entry] = logger.getEntries();
    expect(entry.timedOut).toBe(true);
    expect(entry.exitCode).toBeNull();
  });

  it('records non-zero exit codes', () => {
    logger.logCliOperation(makeOp({ exitCode: 1, stderr: 'error output' }));
    const [entry] = logger.getEntries();
    expect(entry.exitCode).toBe(1);
    expect(entry.stderr).toBe('error output');
  });

  // ── Chronological order ───────────────────────────────────────────────────

  it('preserves chronological order across multiple entries', () => {
    const ops = [
      makeOp({ command: 'dotnet list A', timestamp: new Date('2024-01-01T10:00:00.000Z') }),
      makeOp({ command: 'dotnet list B', timestamp: new Date('2024-01-01T10:01:00.000Z') }),
      makeOp({ command: 'dotnet list C', timestamp: new Date('2024-01-01T10:02:00.000Z') }),
    ];
    ops.forEach((op) => logger.logCliOperation(op));

    const entries = logger.getEntries();
    expect(entries).toHaveLength(3);
    expect(entries[0].command).toBe('dotnet list A');
    expect(entries[1].command).toBe('dotnet list B');
    expect(entries[2].command).toBe('dotnet list C');
  });

  // ── Immutable snapshot ────────────────────────────────────────────────────

  it('getEntries() returns a copy — mutating it does not affect the logger', () => {
    logger.logCliOperation(makeOp());
    const snapshot = logger.getEntries();
    snapshot.pop();
    expect(logger.getEntries()).toHaveLength(1);
  });

  // ── Subscriptions ─────────────────────────────────────────────────────────

  it('notifies a subscriber when an entry is logged', () => {
    const received: LogEntry[] = [];
    logger.subscribe((e) => received.push(e));

    logger.logCliOperation(makeOp());
    expect(received).toHaveLength(1);
    expect(received[0].command).toBe('dotnet list /path/A.csproj package');
  });

  it('notifies multiple subscribers independently', () => {
    const r1: LogEntry[] = [];
    const r2: LogEntry[] = [];
    logger.subscribe((e) => r1.push(e));
    logger.subscribe((e) => r2.push(e));

    logger.logCliOperation(makeOp());
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
  });

  it('stops notifying after the disposable is disposed', () => {
    const received: LogEntry[] = [];
    const disposable = logger.subscribe((e) => received.push(e));

    logger.logCliOperation(makeOp({ command: 'before dispose' }));
    disposable.dispose();
    logger.logCliOperation(makeOp({ command: 'after dispose' }));

    expect(received).toHaveLength(1);
    expect(received[0].command).toBe('before dispose');
  });

  // ── Fail-safe: listener error must not block the operation ─────────────────

  it('swallows a throwing listener and still logs the entry', () => {
    logger.subscribe(() => { throw new Error('listener explosion'); });

    expect(() => logger.logCliOperation(makeOp())).not.toThrow();
    expect(logger.getEntries()).toHaveLength(1);
  });

  it('notifies subsequent listeners even if an earlier one throws', () => {
    const received: LogEntry[] = [];
    logger.subscribe(() => { throw new Error('boom'); });
    logger.subscribe((e) => received.push(e));

    logger.logCliOperation(makeOp());
    expect(received).toHaveLength(1);
  });

  // ── Output Channel ────────────────────────────────────────────────────────

  it('writes to the VSCode Output Channel (appendLine called)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vscode = require('vscode');
    // The mock createOutputChannel pushes into _outputChannels; find the one
    // belonging to this test's logger (the last Averenium NuGet Manager channel).
    const channels: Array<{ name: string; lines: string[] }> = vscode.window._outputChannels;
    const averenium = channels.filter((c) => c.name === 'Averenium NuGet Manager');
    const ch = averenium[averenium.length - 1];
    expect(ch).toBeDefined();

    logger.logCliOperation(makeOp({ stdout: 'hello output' }));
    expect(ch.lines.some((l) => l.includes('dotnet list /path/A.csproj package'))).toBe(true);
    expect(ch.lines.some((l) => l.includes('hello output'))).toBe(true);
  });

  it('clear() drops entries and the Output Channel', () => {
    logger.logCliOperation(makeOp());
    expect(logger.getEntries()).toHaveLength(1);
    logger.clear();
    expect(logger.getEntries()).toHaveLength(0);
  });

  it('info writes to the Output Channel and does not create a LogEntry', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vscode = require('vscode');
    const channels: Array<{ name: string; lines: string[] }> = vscode.window._outputChannels;
    const ch = channels.filter((c) => c.name === 'Averenium NuGet Manager').at(-1);
    logger.info('activate start');
    expect(logger.getEntries()).toHaveLength(0);
    expect(ch?.lines.some((l) => l.includes('[info]') && l.includes('activate start'))).toBe(true);
  });

  it('error writes stack and does not throw', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vscode = require('vscode');
    const channels: Array<{ name: string; lines: string[] }> = vscode.window._outputChannels;
    const ch = channels.filter((c) => c.name === 'Averenium NuGet Manager').at(-1);
    expect(() => logger.error('activate failed', new Error('boom'))).not.toThrow();
    expect(ch?.lines.some((l) => l.includes('[error]') && l.includes('activate failed'))).toBe(true);
    expect(ch?.lines.some((l) => l.includes('boom'))).toBe(true);
  });
});

describe('formatUnknownError', () => {
  it('uses Error.stack when present', () => {
    const err = new Error('nope');
    expect(formatUnknownError(err)).toContain('nope');
  });

  it('stringifies non-Error values', () => {
    expect(formatUnknownError('x')).toBe('x');
  });
});
