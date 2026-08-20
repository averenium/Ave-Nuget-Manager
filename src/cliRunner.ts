import { spawn } from 'child_process';
import type { CliCommand, CliResult } from './types';
import type { Logger } from './logger';
import type { ConcurrencyGate } from './concurrency';
import type { ITrace } from './traceSession';

/**
 * Executes `dotnet` CLI commands via child_process.spawn.
 *
 * Features:
 * - Collects stdout / stderr in full before resolving
 * - Hard timeout (SIGTERM then SIGKILL) defaulting to 30 000 ms
 * - Every invocation is logged through the provided Logger instance
 * - Optional gate caps overlapping `dotnet` processes (`dotnetConcurrency`)
 */
export class CliRunner {
  constructor(
    private readonly logger: Logger,
    private readonly gate?: ConcurrencyGate,
    private readonly trace?: ITrace,
  ) {}

  /**
   * Run a dotnet command and return the result.
   * `command.args` is passed directly to `dotnet`, e.g.
   *   ['list', '/abs/path/Foo.csproj', 'package', '--format', 'json']
   */
  run(command: CliCommand): Promise<CliResult> {
    if (command.signal?.aborted) {
      return Promise.resolve(this._cancelled(command));
    }
    const exec = () => {
      if (command.signal?.aborted) {
        return Promise.resolve(this._cancelled(command));
      }
      return this._spawn(command);
    };
    return this.gate ? this.gate.run(exec) : exec();
  }

  private _cancelled(command: CliCommand): CliResult {
    const result: CliResult = {
      exitCode: null,
      stdout: '',
      stderr: 'Cancelled',
      timedOut: false,
      cancelled: true,
    };
    this._logCli(command, {
      stdout: '',
      stderr: 'Cancelled',
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      startedAt: Date.now(),
    });
    return result;
  }

  private _spawn(command: CliCommand): Promise<CliResult> {
    return new Promise<CliResult>((resolve) => {

      const startedAt = Date.now();
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      let timedOut = false;
      let cancelled = false;
      let settled = false;

      const child = spawn('dotnet', command.args, {
        cwd: command.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      child.stdout?.setEncoding('utf-8');
      child.stderr?.setEncoding('utf-8');

      child.stdout?.on('data', (chunk: string) => stdoutChunks.push(chunk));
      child.stderr?.on('data', (chunk: string) => stderrChunks.push(chunk));

      const killChild = () => {
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already exited */ }
        }, 500);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killChild();
      }, command.timeoutMs);

      const onAbort = () => {
        cancelled = true;
        killChild();
      };
      command.signal?.addEventListener('abort', onAbort);

      const finish = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        command.signal?.removeEventListener('abort', onAbort);

        const stdout = stdoutChunks.join('');
        const stderr = stderrChunks.join('');
        const result: CliResult = {
          exitCode,
          stdout,
          stderr,
          timedOut: timedOut && !cancelled,
          cancelled,
        };

        this._logCli(command, {
          stdout,
          stderr,
          exitCode,
          timedOut: result.timedOut,
          durationMs: Date.now() - startedAt,
          startedAt,
        });

        resolve(result);
      };

      child.on('close', (code) => finish(code ?? null));
      child.on('error', (err) => {
        stderrChunks.push(err.message);
        finish(null);
      });
    });
  }

  private _logCli(command: CliCommand, result: {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number;
    startedAt: number;
  }): void {
    this.logger.logCliOperation({
      timestamp: new Date(result.startedAt),
      command: `dotnet ${command.args.join(' ')}`,
      args: command.args,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    });
    this.trace?.record({
      kind: 'cli',
      at: new Date(result.startedAt).toISOString(),
      command: `dotnet ${command.args.join(' ')}`,
      args: command.args,
      cwd: command.cwd,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    });
    for (const arg of command.args) {
      if (/\.(csproj|fsproj|sln|slnx)$/i.test(arg)) this.trace?.noteTouchedProject(arg);
    }
  }

  /**
   * Verify that `dotnet` is available on the system PATH.
   * Returns the version string on success, or throws if dotnet is not found.
   */
  async checkDotnetAvailable(): Promise<string> {
    const result = await this.run({
      args: ['--version'],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    if (result.timedOut || result.exitCode !== 0) {
      throw new Error(
        `dotnet not found or not responding. stderr: ${result.stderr}`,
      );
    }
    return result.stdout.trim();
  }
}
