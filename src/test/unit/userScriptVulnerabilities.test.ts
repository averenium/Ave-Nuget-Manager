import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as config from '../../config';
import { Logger } from '../../logger';
import type { WorkspaceScope } from '../../types';
import type { VulnerabilityScanContext } from '../../vulnerabilityProvider';

// ─── Mock child_process ───────────────────────────────────────────────────────

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

import { spawn } from 'child_process';
import { UserScriptVulnerabilityProvider, resolveScriptPath } from '../../userScriptVulnerabilities';

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

/** Fake child process whose stdout/stderr/close can be driven programmatically. */
function makeFakeProcess() {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: jest.Mock };
  stdout.setEncoding = jest.fn();
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: jest.Mock };
  stderr.setEncoding = jest.fn();
  const stdin = { on: jest.fn(), end: jest.fn() };

  const proc = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    stdin: typeof stdin;
    kill: jest.Mock;
  };
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.stdin = stdin;
  proc.kill = jest.fn();

  return { proc, stdout, stderr, stdin };
}

/** Runs `spawn` immediately, emits `stdout` then a clean `close(0)` — the common success path. */
function respondWith(stdout: string): void {
  const { proc, stdout: out } = makeFakeProcess();
  mockSpawn.mockReturnValueOnce(proc as any);
  queueMicrotask(() => {
    out.emit('data', stdout);
    proc.emit('close', 0);
  });
}

/** Minimal PE header with a CLR Runtime Header data directory — same builder as `vulnerabilities.test.ts`. */
function buildPeBuffer(opts: { clrRva?: number; clrSize?: number }): Buffer {
  const peOffset = 0x80;
  const dataDirOffset = peOffset + 24 + 96; // PE32
  const clrHeaderOffset = dataDirOffset + 14 * 8;
  const buf = Buffer.alloc(clrHeaderOffset + 8);
  buf.writeUInt16LE(0x5a4d, 0);
  buf.writeUInt32LE(peOffset, 0x3c);
  buf.writeUInt32LE(0x00004550, peOffset);
  buf.writeUInt16LE(0x10b, peOffset + 24);
  buf.writeUInt32LE(opts.clrRva ?? 0, clrHeaderOffset);
  buf.writeUInt32LE(opts.clrSize ?? 0, clrHeaderOffset + 4);
  return buf;
}

const SCOPE: WorkspaceScope = { kind: 'project', projectPath: '/p/App.csproj' };

function makeCtx(over?: Partial<VulnerabilityScanContext>): VulnerabilityScanContext {
  return {
    targetPath: '/p/App.csproj',
    cwd: '/p',
    scope: SCOPE,
    installed: [
      { id: 'Contoso.Legacy', requestedVersion: '1.0.0', resolvedVersion: '1.0.0', projectPath: '/p/App.csproj' },
    ],
    implicit: [],
    signal: new AbortController().signal,
    ...over,
  };
}

describe('UserScriptVulnerabilityProvider.scan', () => {
  let tmpDir: string;
  let logger: Logger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuget-manager-userscript-test-'));
    logger = new Logger();
    mockSpawn.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    logger.dispose();
    jest.restoreAllMocks();
  });

  function withScript(scriptPath: string) {
    jest.spyOn(config, 'getConfig').mockReturnValue({
      dotnetConcurrency: 4,
      cacheTtlMs: 1000,
      includePrerelease: false,
      onFailedUpdate: 'rollback',
      vulnerabilityScript: scriptPath,
      blockedPackages: [],
    } as any);
  }

  it('returns [] and never spawns when vulnerabilityScript is unset', async () => {
    withScript('');
    const provider = new UserScriptVulnerabilityProvider(logger);
    const findings = await provider.scan(makeCtx());
    expect(findings).toEqual([]);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('runs a .js script with node, parses a plain findings array', async () => {
    const scriptPath = path.join(tmpDir, 'audit.js');
    fs.writeFileSync(scriptPath, '// unused by the mock — spawn is faked');
    withScript(scriptPath);
    respondWith(JSON.stringify([
      { packageId: 'Contoso.Legacy', version: '1.0.0', severity: 'high', id: 'internal-1', title: 'Banned package' },
    ]));

    const provider = new UserScriptVulnerabilityProvider(logger);
    const findings = await provider.scan(makeCtx());

    expect(mockSpawn).toHaveBeenCalledWith('node', [scriptPath], expect.objectContaining({ cwd: '/p' }));
    expect(findings).toEqual([{
      packageId: 'Contoso.Legacy',
      version: '1.0.0',
      severity: 'high',
      id: 'internal-1',
      title: 'Banned package',
      url: undefined,
      source: 'audit.js',
    }]);
  });

  it('runs a .py script with python, parses the { findings: [...] } wrapper shape', async () => {
    const scriptPath = path.join(tmpDir, 'audit.py');
    fs.writeFileSync(scriptPath, '# unused by the mock');
    withScript(scriptPath);
    respondWith(JSON.stringify({
      findings: [{ packageId: 'Contoso.Legacy', resolvedVersion: '1.0.0', severity: 'medium', advisoryId: 'CVE-1' }],
    }));

    const provider = new UserScriptVulnerabilityProvider(logger);
    const findings = await provider.scan(makeCtx());

    expect(mockSpawn).toHaveBeenCalledWith('python', [scriptPath], expect.objectContaining({ cwd: '/p' }));
    expect(findings).toEqual([{
      packageId: 'Contoso.Legacy',
      version: '1.0.0',
      severity: 'moderate',
      id: 'CVE-1',
      title: undefined,
      url: undefined,
      source: 'audit.py',
    }]);
  });

  it('runs a .fsx script with dotnet fsi', async () => {
    const scriptPath = path.join(tmpDir, 'audit.fsx');
    fs.writeFileSync(scriptPath, '// unused by the mock');
    withScript(scriptPath);
    respondWith('[]');

    const provider = new UserScriptVulnerabilityProvider(logger);
    await provider.scan(makeCtx());

    expect(mockSpawn).toHaveBeenCalledWith('dotnet', ['fsi', scriptPath], expect.objectContaining({ cwd: '/p' }));
  });

  it('runs a .csx script with dotnet script', async () => {
    const scriptPath = path.join(tmpDir, 'audit.csx');
    fs.writeFileSync(scriptPath, '// unused by the mock');
    withScript(scriptPath);
    respondWith('[]');

    const provider = new UserScriptVulnerabilityProvider(logger);
    await provider.scan(makeCtx());

    expect(mockSpawn).toHaveBeenCalledWith('dotnet', ['script', scriptPath], expect.objectContaining({ cwd: '/p' }));
  });

  it('runs a managed .dll with dotnet, and finds+parses its findings', async () => {
    const scriptPath = path.join(tmpDir, 'audit.dll');
    fs.writeFileSync(scriptPath, buildPeBuffer({ clrRva: 0x2000, clrSize: 0x48 }));
    withScript(scriptPath);
    respondWith(JSON.stringify([{ packageId: 'Contoso.Legacy', severity: 'critical' }]));

    const provider = new UserScriptVulnerabilityProvider(logger);
    const findings = await provider.scan(makeCtx());

    expect(mockSpawn).toHaveBeenCalledWith('dotnet', [scriptPath], expect.objectContaining({ cwd: '/p' }));
    expect(findings[0]).toMatchObject({ packageId: 'Contoso.Legacy', severity: 'critical', source: 'audit.dll' });
  });

  it('runs a native .dll directly (no dotnet wrapper) since its CLR header is empty', async () => {
    const scriptPath = path.join(tmpDir, 'native.dll');
    fs.writeFileSync(scriptPath, buildPeBuffer({ clrRva: 0, clrSize: 0 }));
    withScript(scriptPath);
    respondWith('[]');

    const provider = new UserScriptVulnerabilityProvider(logger);
    await provider.scan(makeCtx());

    expect(mockSpawn).toHaveBeenCalledWith(scriptPath, [], expect.objectContaining({ cwd: '/p' }));
  });

  it('feeds scope/installed/implicit as JSON on stdin', async () => {
    const scriptPath = path.join(tmpDir, 'audit.js');
    fs.writeFileSync(scriptPath, '// unused');
    withScript(scriptPath);
    const { proc, stdout: out, stdin } = makeFakeProcess();
    mockSpawn.mockReturnValueOnce(proc as any);
    queueMicrotask(() => {
      out.emit('data', '[]');
      proc.emit('close', 0);
    });

    const provider = new UserScriptVulnerabilityProvider(logger);
    const ctx = makeCtx();
    await provider.scan(ctx);

    expect(stdin.end).toHaveBeenCalledWith(JSON.stringify({
      scope: ctx.scope,
      installed: ctx.installed,
      implicit: ctx.implicit,
    }));
  });

  it('drops findings for a package id the script did not report a packageId for', async () => {
    const scriptPath = path.join(tmpDir, 'audit.js');
    fs.writeFileSync(scriptPath, '// unused');
    withScript(scriptPath);
    respondWith(JSON.stringify([{ severity: 'high', title: 'No packageId here' }]));

    const provider = new UserScriptVulnerabilityProvider(logger);
    const findings = await provider.scan(makeCtx());
    expect(findings).toEqual([]);
  });

  it('returns [] and logs the operation when the script times out', async () => {
    jest.useFakeTimers();
    const scriptPath = path.join(tmpDir, 'audit.js');
    fs.writeFileSync(scriptPath, '// unused');
    withScript(scriptPath);
    const { proc } = makeFakeProcess();
    mockSpawn.mockReturnValueOnce(proc as any);
    const logSpy = jest.spyOn(logger, 'logCliOperation');

    const provider = new UserScriptVulnerabilityProvider(logger);
    const scanPromise = provider.scan(makeCtx());
    await jest.advanceTimersByTimeAsync(30_000);
    proc.emit('close', null); // SIGTERM from the timeout firing
    const findings = await scanPromise;

    expect(findings).toEqual([]);
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({ timedOut: true }));
    jest.useRealTimers();
  });

  it('resolveScriptPath resolves a relative path against the workspace root', () => {
    const vscode = require('vscode');
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' }, name: 'ws', index: 0 }];
    expect(resolveScriptPath('scripts/audit.js')).toBe(path.resolve('/ws', 'scripts/audit.js'));
    expect(resolveScriptPath('/abs/audit.js')).toBe('/abs/audit.js');
  });
});
