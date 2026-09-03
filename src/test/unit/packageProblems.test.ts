import { buildPackageProblems } from '../../webview/utils/packageProblems';
import type { VulnerabilityFinding } from '../../types';

function finding(over: Partial<VulnerabilityFinding> & Pick<VulnerabilityFinding, 'packageId'>): VulnerabilityFinding {
  return { severity: 'high', source: 'dotnet', ...over };
}

const NO_MAPPING = { packageId: 'Pkg', findings: [], viaFindings: [], isInstalled: true, packageSourceMapping: [], updatesBlocked: false };

describe('buildPackageProblems', () => {
  it('is empty when there is nothing to report', () => {
    expect(buildPackageProblems(NO_MAPPING)).toEqual([]);
  });

  it('maps a high/critical vulnerability to tone "error" and low/moderate to "warning"', () => {
    const problems = buildPackageProblems({
      ...NO_MAPPING,
      findings: [
        finding({ packageId: 'Pkg', severity: 'critical', id: 'GHSA-1' }),
        finding({ packageId: 'Pkg', severity: 'moderate', id: 'GHSA-2' }),
      ],
    });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatchObject({ kind: 'vulnerability', tone: 'error', label: 'critical' });
    expect(problems[1]).toMatchObject({ kind: 'vulnerability', tone: 'warning', label: 'moderate' });
  });

  it('marks a transitive (via) finding with the dependency id', () => {
    const via = finding({ packageId: 'Newtonsoft.Json', id: 'GHSA-3' });
    const problems = buildPackageProblems({ ...NO_MAPPING, findings: [via], viaFindings: [via] });
    expect(problems[0]).toMatchObject({ kind: 'vulnerability', via: 'Newtonsoft.Json' });
  });

  it('adds a mapping problem only when installed, mapping is active, and nothing matches (#40/#57)', () => {
    const mapping = [{ sourceName: 'contoso', patterns: ['Contoso.*'] }];

    expect(buildPackageProblems({ ...NO_MAPPING, packageSourceMapping: mapping })).toEqual([
      expect.objectContaining({ kind: 'mapping', tone: 'error', mappedSourceNames: ['contoso'] }),
    ]);

    // Matches a pattern — no problem.
    expect(buildPackageProblems({ ...NO_MAPPING, packageId: 'Contoso.Utils', packageSourceMapping: mapping }))
      .toEqual([]);

    // Not installed yet — mapping only applies to installed packages.
    expect(buildPackageProblems({ ...NO_MAPPING, isInstalled: false, packageSourceMapping: mapping }))
      .toEqual([]);

    // No mapping configured at all — nothing to report.
    expect(buildPackageProblems({ ...NO_MAPPING, packageSourceMapping: [] })).toEqual([]);
  });

  it('adds a blocked problem with tone "warning" when updates are blocked', () => {
    expect(buildPackageProblems({ ...NO_MAPPING, updatesBlocked: true })).toEqual([
      expect.objectContaining({ kind: 'blocked', tone: 'warning' }),
    ]);
  });

  it('combines all three kinds together', () => {
    const mapping = [{ sourceName: 'contoso', patterns: ['Contoso.*'] }];
    const problems = buildPackageProblems({
      packageId: 'Pkg',
      findings: [finding({ packageId: 'Pkg', severity: 'high', id: 'GHSA-1' })],
      viaFindings: [],
      isInstalled: true,
      packageSourceMapping: mapping,
      updatesBlocked: true,
    });
    expect(problems.map((p) => p.kind)).toEqual(['vulnerability', 'mapping', 'blocked']);
  });
});
