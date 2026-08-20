import { spawn } from 'child_process';
import type { CliCommand, CliResult } from './types';
import type { Logger } from './logger';

/**
 * Executes `dotnet` CLI commands via child_process.spawn.
 *
 * Features:
 * - Collects stdout / stderr in full before resolving
 * - Hard timeout (SIGTERM then SIGKILL) defaulting to 30 000 ms
 * - Every invocation is logged through the provided Logger instance
 */
export class CliRunner {
  constructor(private readonly logger: Logger) {}

  /**
   * Run a dotnet command and return the result.
   * `command.args` is passed directly to `dotnet`, e.g.
   *   ['list', '/abs/path/Foo.csproj', 'package', '--format', 'json']
   */
  run(command: CliCommand): Promise<CliResult> {
    return new Promise<CliResult>((resolve) => {
      if (command.signal?.aborted) {
        resolve({
          exitCode: null,
          stdout: '',
          stderr: 'Cancelled',
          timedOut: false,
          cancelled: true,
        });
        return;
      }

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

        this.logger.logCliOperation({
          timestamp: new Date(startedAt),
          command: `dotnet ${command.args.join(' ')}`,
          args: command.args,
          stdout,
          stderr,
          exitCode,
          timedOut: result.timedOut,
          durationMs: Date.now() - startedAt,
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
