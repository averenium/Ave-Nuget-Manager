import { parseRestoreAuditWarnings } from '../../restoreAuditWarnings';

describe('parseRestoreAuditWarnings', () => {
  it('reads NU1902 from restore output', () => {
    const text = `warning NU1902: Package 'SharpCompress' 0.30.1 has a known moderate severity vulnerability, https://github.com/advisories/GHSA-6c8g-7p36-r338`;
    expect(parseRestoreAuditWarnings(text)).toEqual([
      expect.objectContaining({
        packageId: 'SharpCompress',
        version: '0.30.1',
        severity: 'moderate',
        id: 'GHSA-6c8g-7p36-r338',
        source: 'dotnet',
      }),
    ]);
  });

  it('returns empty when there are no NU190x lines', () => {
    expect(parseRestoreAuditWarnings('Restore succeeded.')).toEqual([]);
  });

  it('keeps only packages in the current installed/implicit list', () => {
    const text = [
      `warning NU1902: Package 'SharpCompress' 0.30.1 has a known moderate severity vulnerability, https://github.com/advisories/GHSA-a`,
      `warning NU1903: Package 'Old.Other' 1.0.0 has a known high severity vulnerability, https://github.com/advisories/GHSA-b`,
    ].join('\n');
    expect(parseRestoreAuditWarnings(text, {
      installed: [{ id: 'SharpCompress', resolvedVersion: '0.30.1' }],
      implicit: [],
    }).map((f) => f.packageId)).toEqual(['SharpCompress']);
  });
});
