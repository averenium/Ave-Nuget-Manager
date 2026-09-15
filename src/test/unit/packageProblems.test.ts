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

  it('adds a deprecation problem with the feed message when the version shown is deprecated (#86)', () => {
    expect(buildPackageProblems({ ...NO_MAPPING, deprecation: 'Please upgrade to Azure.Storage.Common.' })).toEqual([
      expect.objectContaining({ kind: 'deprecation', tone: 'warning', message: 'Please upgrade to Azure.Storage.Common.' }),
    ]);
  });

  it('reports no deprecation problem when the field is absent', () => {
    expect(buildPackageProblems(NO_MAPPING)).toEqual([]);
  });

  it('combines all kinds together', () => {
    const mapping = [{ sourceName: 'contoso', patterns: ['Contoso.*'] }];
    const problems = buildPackageProblems({
      packageId: 'Pkg',
      findings: [finding({ packageId: 'Pkg', severity: 'high', id: 'GHSA-1' })],
      viaFindings: [],
      isInstalled: true,
      packageSourceMapping: mapping,
      updatesBlocked: true,
      deprecation: 'Deprecated notice',
    });
    expect(problems.map((p) => p.kind)).toEqual(['vulnerability', 'deprecation', 'mapping', 'blocked']);
  });

  it('adds an unlisted problem with tone "warning" when the installed version was withdrawn (#114)', () => {
    expect(buildPackageProblems({ ...NO_MAPPING, unlistedInstalledVersion: '2.1.4' })).toEqual([
      expect.objectContaining({ kind: 'unlisted', tone: 'warning', version: '2.1.4' }),
    ]);
  });

  it('reports no unlisted problem when the field is absent', () => {
    expect(buildPackageProblems(NO_MAPPING)).toEqual([]);
  });
});

describe('what the feed says about the version being looked at', () => {
  // Measured on `SixLabors.ImageSharp`: the feed attaches
  // `GHSA-rxmq-m78w-7wmc` (severity 1, moderate) to 3.1.10 and nothing to
  // 3.1.12. The restore-graph scan cannot know this — it only ever describes
  // what is installed — so without this row a user selecting 3.1.10 sees the
  // dropdown warn and the panel say nothing.
  const advisory = { url: 'https://github.com/advisories/GHSA-rxmq-m78w-7wmc', severity: 'moderate' as const };

  it('reports an advisory the feed attaches to the selected version', () => {
    const problems = buildPackageProblems({
      ...NO_MAPPING,
      selectedVersion: '3.1.10',
      selectedVersionAdvisories: [advisory],
    });
    expect(problems).toEqual([
      expect.objectContaining({ kind: 'feed-advisory', tone: 'warning', version: '3.1.10', url: advisory.url }),
    ]);
  });

  it('marks a high advisory as an error rather than a warning', () => {
    const [problem] = buildPackageProblems({
      ...NO_MAPPING,
      selectedVersion: '1.0.0',
      selectedVersionAdvisories: [{ url: 'https://example.com/a', severity: 'high' }],
    });
    expect(problem).toMatchObject({ kind: 'feed-advisory', tone: 'error' });
  });

  it('does not repeat an advisory the restore-graph scan already reported', () => {
    const problems = buildPackageProblems({
      ...NO_MAPPING,
      findings: [finding({ packageId: 'Pkg', url: advisory.url, id: 'GHSA-rxmq-m78w-7wmc' })],
      selectedVersion: '3.1.10',
      selectedVersionAdvisories: [advisory],
    });
    expect(problems.map((p) => p.kind)).toEqual(['vulnerability']);
  });

  it('still reports one the scan did not mention, which is a gap rather than a duplicate', () => {
    const problems = buildPackageProblems({
      ...NO_MAPPING,
      findings: [finding({ packageId: 'Pkg', url: 'https://example.com/other' })],
      selectedVersion: '3.1.10',
      selectedVersionAdvisories: [advisory],
    });
    expect(problems.map((p) => p.kind)).toEqual(['vulnerability', 'feed-advisory']);
  });

  it('says nothing when the feed flags the selected version with no advisory', () => {
    expect(buildPackageProblems({ ...NO_MAPPING, selectedVersion: '3.1.12' })).toEqual([]);
  });
});
