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
});

describe('scriptCommand', () => {
  it('runs js with node and py with python', () => {
    expect(scriptCommand('/ws/audit.js')).toEqual({ command: 'node', args: ['/ws/audit.js'] });
    expect(scriptCommand('/ws/audit.py')).toEqual({ command: 'python', args: ['/ws/audit.py'] });
  });
});
