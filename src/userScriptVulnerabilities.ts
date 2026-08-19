import { spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from './config';
import type { Logger } from './logger';
import { parseScriptFindings } from './vulnerabilities';
import type { IVulnerabilityProvider, VulnerabilityScanContext } from './vulnerabilityProvider';
import type { VulnerabilityFinding } from './types';

const SCRIPT_TIMEOUT_MS = 30_000;

/**
 * Optional user script from `averenium.nugetManager.vulnerabilityScript`.
 * JSON package snapshot on stdin → JSON array (or `{ findings }`) on stdout.
 */
export class UserScriptVulnerabilityProvider implements IVulnerabilityProvider {
  readonly id = 'script';

  constructor(private readonly logger: Logger) {}

  async scan(ctx: VulnerabilityScanContext): Promise<VulnerabilityFinding[]> {
    const spec = getConfig().vulnerabilityScript.trim();
    if (!spec) return [];
    const scriptPath = resolveScriptPath(spec);
    if (!scriptPath) return [];

    const { command, args } = scriptCommand(scriptPath);
    const stdin = JSON.stringify({
      scope: ctx.scope,
      installed: ctx.installed,
      implicit: ctx.implicit,
    });
    const result = await runProcess(command, args, ctx.cwd, stdin, SCRIPT_TIMEOUT_MS, ctx.signal);

    this.logger.logCliOperation({
      timestamp: new Date(),
      command: `${command} ${args.join(' ')}`.trim(),
      args,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    });

    if (result.timedOut || ctx.signal.aborted) return [];
    return parseScriptFindings(result.stdout, path.basename(scriptPath));
  }
}

export function resolveScriptPath(spec: string): string | null {
  if (!spec.trim()) return null;
  if (path.isAbsolute(spec)) return spec;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return null;
  return path.resolve(root, spec);
}

export function scriptCommand(scriptPath: string): { command: string; args: string[] } {
  const ext = path.extname(scriptPath).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return { command: 'node', args: [scriptPath] };
  }
  if (ext === '.py') {
    return { command: 'python', args: [scriptPath] };
  }
  return { command: scriptPath, args: [] };
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  stdin: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; durationMs: number }> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    if (signal.aborted) {
      resolve({ stdout: '', stderr: '', exitCode: null, timedOut: false, durationMs: 0 });
      return;
    }

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        exitCode,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    };

    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch { /* already exited */ }
      finish(null);
    };

    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      }, 500);
    }, timeoutMs);

    signal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: string) => stderrChunks.push(chunk));
    child.stdin?.on('error', () => { /* closed */ });
    child.stdin?.end(stdin);
    child.on('close', (code) => finish(code ?? null));
    child.on('error', (err) => {
      stderrChunks.push(err.message);
      finish(null);
    });
  });
}

