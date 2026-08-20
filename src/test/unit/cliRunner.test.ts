import { EventEmitter } from 'events';
import { CliRunner } from '../../cliRunner';
import type { CliCommand } from '../../types';
import { Logger } from '../../logger';

// ─── Mock child_process ───────────────────────────────────────────────────────

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

import { spawn } from 'child_process';
const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

/**
 * Creates a fake child process whose stdout/stderr can be programmatically
 * driven via the returned handles.
 */
function makeFakeProcess() {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: jest.Mock };
  stdout.setEncoding = jest.fn();

  const stderr = new EventEmitter() as EventEmitter & { setEncoding: jest.Mock };
  stderr.setEncoding = jest.fn();

  const proc = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: jest.Mock;
  };
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = jest.fn();

  return { proc, stdout, stderr };
}

function makeCmd(overrides?: Partial<CliCommand>): CliCommand {
  return {
    args: ['--version'],
    cwd: '/tmp',
    timeoutMs: 5_000,
    ...overrides,
  };
}

describe('CliRunner', () => {
  let logger: Logger;
  let runner: CliRunner;

  beforeEach(() => {
    jest.useFakeTimers();
    logger = new Logger();
    runner = new CliRunner(logger);
    mockSpawn.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
    logger.dispose();
  });

  // ── Successful exit ────────────────────────────────────────────────────────

  it('resolves with exitCode 0 and collected stdout', async () => {
    const { proc, stdout } = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as any);

    const promise = runner.run(makeCmd());

    stdout.emit('data', 'chunk one ');
    stdout.emit('data', 'chunk two');
    proc.emit('close', 0);

    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('chunk one chunk two');
    expect(result.stderr).toBe('');
    expect(result.timedOut).toBe(false);
  });

  // ── Non-zero exit ─────────────────────────────────────────────────────────

  it('resolves with non-zero exitCode and captured stderr', async () => {
    const { proc, stderr } = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as any);

    const promise = runner.run(makeCmd());

    stderr.emit('data', 'error: build failed');
    proc.emit('close', 1);

    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('error: build failed');
    expect(result.timedOut).toBe(false);
  });

  // ── Timeout ───────────────────────────────────────────────────────────────

  it('kills the process and sets timedOut=true when timeout fires', async () => {
    const { proc } = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as any);

    const promise = runner.run(makeCmd({ timeoutMs: 1_000 }));

    // Advance past the timeout
    jest.advanceTimersByTime(1_000);

    // Simulate SIGTERM causing the process to close
    proc.emit('close', null);

    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(result.exitCode).toBeNull();
  });

  // ── Many chunks ───────────────────────────────────────────────────────────

  it('concatenates many stdout chunks correctly', async () => {
    const { proc, stdout } = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as any);

    const promise = runner.run(makeCmd());
    const chunks = Array.from({ length: 50 }, (_, i) => `line${i}\n`);
    for (const c of chunks) stdout.emit('data', c);
    proc.emit('close', 0);

    const result = await promise;
    expect(result.stdout).toBe(chunks.join(''));
  });

  // ── spawn args ────────────────────────────────────────────────────────────

  it('passes args and cwd to spawn correctly', async () => {
    const { proc } = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as any);

    const cmd: CliCommand = {
      args: ['list', '/path/Foo.csproj', 'package', '--format', 'json'],
      cwd: '/projects/MySolution',
      timeoutMs: 30_000,
    };

    const promise = runner.run(cmd);
    proc.emit('close', 0);
    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'dotnet',
      cmd.args,
      expect.objectContaining({ cwd: '/projects/MySolution' }),
    );
  });

  // ── Logging ───────────────────────────────────────────────────────────────

  it('logs the operation via the Logger', async () => {
    const { proc, stdout } = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as any);

    const promise = runner.run(makeCmd({ args: ['list', '/p/A.csproj', 'package'] }));
    stdout.emit('data', 'output text');
    proc.emit('close', 0);
    await promise;

    const entries = logger.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].command).toBe('dotnet list /p/A.csproj package');
    expect(entries[0].stdout).toBe('output text');
    expect(entries[0].exitCode).toBe(0);
  });

  // ── spawn error ───────────────────────────────────────────────────────────

  it('resolves cancelled without spawning when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();

    const result = await runner.run(makeCmd({ signal: ac.signal }));

    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(logger.getEntries()).toHaveLength(1);
    expect(logger.getEntries()[0].stderr).toBe('Cancelled');
    expect(logger.getEntries()[0].command).toContain('dotnet');
  });

  it('kills the process and sets cancelled=true when the signal aborts', async () => {
    const { proc } = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as any);
    const ac = new AbortController();

    const promise = runner.run(makeCmd({ signal: ac.signal }));
    ac.abort();
    proc.emit('close', null);

    const result = await promise;
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(result.exitCode).toBeNull();
  });

  it('handles spawn error event (e.g. ENOENT) gracefully', async () => {
    const { proc } = makeFakeProcess();
    mockSpawn.mockReturnValue(proc as any);

    const promise = runner.run(makeCmd());
    proc.emit('error', new Error('spawn ENOENT'));
    proc.emit('close', null);

    const result = await promise;
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain('spawn ENOENT');
  });
});
