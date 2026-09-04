import {
  mergeFindings,
  normalizeFinding,
  parseDotnetVulnerableJson,
  parseScriptFindings,
  findingsForPackage,
  findingsAffectingPackage,
  vulnerabilityAffectRank,
  normalizeSeverity,
} from '../../vulnerabilities';
import { scriptCommand } from '../../userScriptVulnerabilities';
import { collectVulnerabilityFindings, type IVulnerabilityProvider } from '../../vulnerabilityProvider';
import type { VulnerabilityFinding } from '../../types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const finding = (over: Partial<VulnerabilityFinding> & Pick<VulnerabilityFinding, 'packageId'>): VulnerabilityFinding => ({
  severity: 'high',
  source: 'dotnet',
  ...over,
});

describe('normalizeSeverity', () => {
  it('maps NuGet and common aliases', () => {
    expect(normalizeSeverity('Critical')).toBe('critical');
    expect(normalizeSeverity('HIGH')).toBe('high');
    expect(normalizeSeverity('Medium')).toBe('moderate');
    expect(normalizeSeverity('low')).toBe('low');
    expect(normalizeSeverity('')).toBe('unknown');
  });
});

describe('parseDotnetVulnerableJson', () => {
  it('reads top-level and transitive advisories', () => {
    const findings = parseDotnetVulnerableJson(JSON.stringify({
      version: 1,
      projects: [{
        path: 'App.csproj',
        frameworks: [{
          framework: 'net8.0',
          topLevelPackages: [{
            id: 'Newtonsoft.Json',
            requestedVersion: '12.0.1',
            resolvedVersion: '12.0.1',
            vulnerabilities: [{
              severity: 'High',
              advisoryurl: 'https://github.com/advisories/GHSA-5crp-9r3c-p9vr',
            }],
          }],
          transitivePackages: [{
            id: 'System.Text.Encodings.Web',
            resolvedVersion: '6.0.0',
            vulnerabilities: [{
              severity: 'Moderate',
              advisoryurl: 'https://github.com/advisories/GHSA-ghhp-88w8-63m5',
            }],
          }],
        }],
      }],
    }));
    expect(findings).toEqual([
      expect.objectContaining({
        packageId: 'Newtonsoft.Json',
        version: '12.0.1',
        severity: 'high',
        id: 'GHSA-5crp-9r3c-p9vr',
        source: 'dotnet',
      }),
      expect.objectContaining({
        packageId: 'System.Text.Encodings.Web',
        severity: 'moderate',
        source: 'dotnet',
      }),
    ]);
  });

  it('returns empty for non-json', () => {
    expect(parseDotnetVulnerableJson('not json')).toEqual([]);
  });
});

describe('parseScriptFindings', () => {
  it('accepts an array or a findings wrapper', () => {
    expect(parseScriptFindings(JSON.stringify([
      { packageId: 'A', severity: 'critical', id: 'CVE-2024-1', url: 'https://ex' },
    ]), 'mine.js')).toEqual([
      expect.objectContaining({ packageId: 'A', severity: 'critical', id: 'CVE-2024-1', source: 'mine.js' }),
    ]);
    expect(parseScriptFindings(JSON.stringify({
      findings: [{ packageId: 'B', severity: 'low' }],
    }), 'mine.js')[0].packageId).toBe('B');
  });

  it('ignores objects without packageId', () => {
    expect(normalizeFinding({ severity: 'high' }, 'x')).toBeNull();
  });
});

describe('mergeFindings', () => {
  it('dedupes by package/version/advisory and keeps the higher severity', () => {
    const merged = mergeFindings([
      [finding({ packageId: 'A', version: '1.0.0', id: 'GHSA-1', severity: 'low', source: 'dotnet' })],
      [finding({ packageId: 'A', version: '1.0.0', id: 'GHSA-1', severity: 'critical', source: 'script' })],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].severity).toBe('critical');
    expect(merged[0].source).toBe('script');
  });
});

describe('collectVulnerabilityFindings', () => {
  it('merges providers and swallows a failing one', async () => {
    const ok: IVulnerabilityProvider = {
      id: 'dotnet',
      scan: async () => [finding({ packageId: 'A', id: '1' })],
    };
    const boom: IVulnerabilityProvider = {
      id: 'script',
      scan: async () => { throw new Error('nope'); },
    };
    const extra: IVulnerabilityProvider = {
      id: 'extra',
      scan: async () => [finding({ packageId: 'B', id: '2', severity: 'low' })],
    };
    const merged = await collectVulnerabilityFindings(
      [ok, boom, extra],
      {
        targetPath: '/p/App.csproj',
        cwd: '/p',
        scope: { kind: 'project', projectPath: '/p/App.csproj' },
        installed: [],
        implicit: [],
        signal: new AbortController().signal,
      },
    );
    expect(findingsForPackage(merged, 'A')).toHaveLength(1);
    expect(findingsForPackage(merged, 'B')).toHaveLength(1);
  });
});

describe('findingsAffectingPackage', () => {
  it('marks parents via restore-graph dependencies, not the finding id itself', () => {
    const findings = [
      finding({ packageId: 'Newtonsoft.Json', id: 'GHSA-1', severity: 'high' }),
    ];
    const { direct, via } = findingsAffectingPackage(
      findings,
      'Microsoft.Extensions.Http',
      ['Microsoft.Extensions.Logging.Abstractions', 'Newtonsoft.Json'],
    );
    expect(direct).toEqual([]);
    expect(via).toEqual([findings[0]]);
    expect(vulnerabilityAffectRank(findings, 'Microsoft.Extensions.Http', [
      'Newtonsoft.Json',
    ])).toBeGreaterThan(-1);
    expect(vulnerabilityAffectRank(findings, 'Newtonsoft.Json')).toBeGreaterThan(
      vulnerabilityAffectRank(findings, 'Microsoft.Extensions.Http', ['Newtonsoft.Json']),
    );
  });

  it('keeps a direct finding off the via list', () => {
    const findings = [finding({ packageId: 'Http', id: 'GHSA-2' })];
    const { direct, via } = findingsAffectingPackage(findings, 'Http', ['Logging']);
    expect(direct).toHaveLength(1);
    expect(via).toEqual([]);
  });

  it('does not attribute a different project\'s vulnerable version to a row on the patched one (#53)', () => {
    // A solution where one project has SSH.NET 2024.2.0 (vulnerable) transitively
    // and another has it upgraded to 2026.0.0 directly — the patched row must
    // not inherit the other project's finding just because the id matches.
    const findings = [
      finding({ packageId: 'SSH.NET', version: '2024.2.0', id: 'GHSA-q939-rpr3-3284' }),
    ];
    const patched = findingsAffectingPackage(findings, 'SSH.NET', undefined, '2026.0.0');
    expect(patched.direct).toEqual([]);
    const vulnerable = findingsAffectingPackage(findings, 'SSH.NET', undefined, '2024.2.0');
    expect(vulnerable.direct).toEqual(findings);
  });

  it('still matches when no version is given, or the finding itself carries none', () => {
    const findings = [finding({ packageId: 'SSH.NET', version: '2024.2.0' })];
    expect(findingsAffectingPackage(findings, 'SSH.NET').direct).toEqual(findings);
    const scriptFindings = [finding({ packageId: 'SSH.NET' })]; // no version field
    expect(findingsAffectingPackage(scriptFindings, 'SSH.NET', undefined, '2026.0.0').direct)
      .toEqual(scriptFindings);
  });
});

/** Minimal PE header with a CLR Runtime Header data directory — enough for `isDotnetAssembly` to inspect. */
function buildPeBuffer(opts: { peOffset?: number; magic?: number; clrRva?: number; clrSize?: number }): Buffer {
  const peOffset = opts.peOffset ?? 0x80;
  const magic = opts.magic ?? 0x10b; // PE32
  const dataDirOffset = peOffset + 24 + (magic === 0x20b ? 112 : 96);
  const clrHeaderOffset = dataDirOffset + 14 * 8;
  const buf = Buffer.alloc(clrHeaderOffset + 8);
  buf.writeUInt16LE(0x5a4d, 0); // 'MZ'
  buf.writeUInt32LE(peOffset, 0x3c);
  buf.writeUInt32LE(0x00004550, peOffset); // 'PE\0\0'
  buf.writeUInt16LE(magic, peOffset + 24);
  buf.writeUInt32LE(opts.clrRva ?? 0, clrHeaderOffset);
  buf.writeUInt32LE(opts.clrSize ?? 0, clrHeaderOffset + 4);
  return buf;
}

describe('scriptCommand', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuget-manager-script-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs js with node and py with python', () => {
    expect(scriptCommand('/ws/audit.js')).toEqual({ command: 'node', args: ['/ws/audit.js'] });
    expect(scriptCommand('/ws/audit.py')).toEqual({ command: 'python', args: ['/ws/audit.py'] });
  });

  it('runs fsx with dotnet fsi and csx with dotnet script', () => {
    expect(scriptCommand('/ws/audit.fsx')).toEqual({ command: 'dotnet', args: ['fsi', '/ws/audit.fsx'] });
    expect(scriptCommand('/ws/audit.csx')).toEqual({ command: 'dotnet', args: ['script', '/ws/audit.csx'] });
  });

  it('runs a managed .dll (PE32, non-empty CLR header) with dotnet', () => {
    const dllPath = path.join(tmpDir, 'audit.dll');
    fs.writeFileSync(dllPath, buildPeBuffer({ clrRva: 0x2000, clrSize: 0x48 }));
    expect(scriptCommand(dllPath)).toEqual({ command: 'dotnet', args: [dllPath] });
  });

  it('runs a managed .dll (PE32+, non-empty CLR header) with dotnet', () => {
    const dllPath = path.join(tmpDir, 'audit64.dll');
    fs.writeFileSync(dllPath, buildPeBuffer({ magic: 0x20b, clrRva: 0x2000, clrSize: 0x48 }));
    expect(scriptCommand(dllPath)).toEqual({ command: 'dotnet', args: [dllPath] });
  });

  it('falls back to running the file directly for a native .dll (empty CLR header)', () => {
    const dllPath = path.join(tmpDir, 'native.dll');
    fs.writeFileSync(dllPath, buildPeBuffer({ clrRva: 0, clrSize: 0 }));
    expect(scriptCommand(dllPath)).toEqual({ command: dllPath, args: [] });
  });

  it('falls back to running the file directly for a non-PE .dll or a missing one', () => {
    const notAPe = path.join(tmpDir, 'notapedll.dll');
    fs.writeFileSync(notAPe, 'not a PE file at all');
    expect(scriptCommand(notAPe)).toEqual({ command: notAPe, args: [] });

    const missing = path.join(tmpDir, 'does-not-exist.dll');
    expect(scriptCommand(missing)).toEqual({ command: missing, args: [] });
  });

  it('runs any other extension directly as an executable', () => {
    expect(scriptCommand('/ws/audit.sh')).toEqual({ command: '/ws/audit.sh', args: [] });
  });
});
