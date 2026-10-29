import { effectiveVersionFor } from '../../webview/utils/effectiveVersion';

const groups = (byVersion: Record<string, string>) =>
  (v: string) => (byVersion[v] ? [{ targetFramework: byVersion[v], dependencies: [] }] : undefined);

const base = {
  selectedVersion: '',
  allVersions: ['10.0.0', '9.0.3', '9.0.0'],
  declaredGroups: groups({ '10.0.0': 'net10.0', '9.0.3': 'net8.0', '9.0.0': 'net8.0' }),
  projectTfms: ['net8.0'],
  installedVersions: ['9.0.3'],
};

describe('effectiveVersionFor (#132)', () => {
  it('is the installed version when the feed has a newer one the project cannot take', () => {
    // The question about a version's release notes has to be asked about this,
    // not about 10.0.0, which the selector does not show.
    expect(effectiveVersionFor(base)).toBe('9.0.3');
  });

  it('prefers the reader\'s own pick', () => {
    expect(effectiveVersionFor({ ...base, selectedVersion: '9.0.0' })).toBe('9.0.0');
  });

  it('stays where the package is when nothing is compatible, instead of the feed\'s newest', () => {
    expect(effectiveVersionFor({ ...base, projectTfms: ['net6.0'] })).toBe('9.0.3');
  });

  it('falls back to the feed\'s newest for a package that is installed nowhere', () => {
    expect(effectiveVersionFor({ ...base, projectTfms: [], installedVersions: [] })).toBe('10.0.0');
  });

  it('falls back to the metadata\'s version before the feed has listed anything', () => {
    expect(effectiveVersionFor({ ...base, allVersions: [], installedVersions: [], metadataVersion: '2.0.0' })).toBe('2.0.0');
  });
});
