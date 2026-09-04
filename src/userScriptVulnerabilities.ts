import { spawn } from 'child_process';
import * as fs from 'fs';
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
  if (ext === '.fsx') {
    return { command: 'dotnet', args: ['fsi', scriptPath] };
  }
  if (ext === '.csx') {
    return { command: 'dotnet', args: ['script', scriptPath] };
  }
  if (ext === '.dll' && isDotnetAssembly(scriptPath)) {
    return { command: 'dotnet', args: [scriptPath] };
  }
  return { command: scriptPath, args: [] };
}

const PE_HEADER_MZ = 0x5a4d;
const PE_SIGNATURE = 0x00004550;
const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;
/** Index of the CLR Runtime Header (COM Descriptor) in the PE optional header's data directories. */
const CLR_HEADER_DIRECTORY_INDEX = 14;

/**
 * True when `filePath` is a managed (.NET) PE assembly — has a non-empty CLR
 * Runtime Header data directory entry, the same signal the CLR/hostfxr use to
 * tell a managed DLL apart from a native one. Reads only the PE header (a
 * small fixed-size probe), not the whole file, and never throws — any
 * mismatch (missing file, not a PE file, truncated/unexpected header layout)
 * just means "not a .NET assembly" so `.dll` falls back to running the file
 * directly, same as any other unrecognized extension.
 */
function isDotnetAssembly(filePath: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(1024);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    if (bytesRead < 0x40 || buf.readUInt16LE(0) !== PE_HEADER_MZ) return false;

    const peOffset = buf.readUInt32LE(0x3c);
    if (peOffset < 0 || peOffset + 24 > bytesRead || buf.readUInt32LE(peOffset) !== PE_SIGNATURE) return false;

    const optHeaderOffset = peOffset + 24;
    if (optHeaderOffset + 2 > bytesRead) return false;
    const magic = buf.readUInt16LE(optHeaderOffset);
    if (magic !== PE32_MAGIC && magic !== PE32_PLUS_MAGIC) return false;

    // Data directories sit right after the optional header's fixed fields —
    // 96 bytes in for PE32, 112 for PE32+ (ImageBase and a few others are
    // 8 bytes instead of 4, and PE32+ drops BaseOfData).
    const dataDirOffset = optHeaderOffset + (magic === PE32_PLUS_MAGIC ? 112 : 96);
    const clrHeaderOffset = dataDirOffset + CLR_HEADER_DIRECTORY_INDEX * 8;
    if (clrHeaderOffset + 8 > bytesRead) return false;

    const clrHeaderRva = buf.readUInt32LE(clrHeaderOffset);
    const clrHeaderSize = buf.readUInt32LE(clrHeaderOffset + 4);
    return clrHeaderRva !== 0 && clrHeaderSize !== 0;
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
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

