import { versionBandFor } from '../../webview/utils/versionBand';
import type { VersionDependencyDiff } from '../../packageVersionDiff';

const diff: VersionDependencyDiff = {
  added: [{ id: 'Example.Core', to: '[2.0.0, )' }], changed: [], dropped: [], frameworksDropped: [],
} as never;

const base = {
  diff: undefined,
  isInstalled: true,
  installedFrom: '2.1.9',
  to: '2.1.9',
  hasReleaseNotesLink: false,
  hasChangelog: false,
};

describe('versionBandFor (#132)', () => {
  it('renders the release-notes link with no dependency difference, titled with the version', () => {
    expect(versionBandFor({ ...base, hasReleaseNotesLink: true })).toEqual({
      diff: undefined, from: '2.1.9', title: 'Version 2.1.9',
    });
  });

  it('renders the changelog button with no dependency difference', () => {
    expect(versionBandFor({ ...base, hasChangelog: true })).toMatchObject({ diff: undefined, title: 'Version 2.1.9' });
  });

  it('renders the link for a package that is not installed, with nothing to compare from', () => {
    expect(versionBandFor({
      ...base, isInstalled: false, installedFrom: '', to: '4.1.2', hasReleaseNotesLink: true,
    })).toEqual({ diff: undefined, from: undefined, title: 'Version 4.1.2' });
  });

  it('is still "What changes" when there is a difference', () => {
    expect(versionBandFor({ ...base, to: '3.0.0', diff })).toEqual({ diff, from: '2.1.9', title: 'What changes' });
  });

  it('keeps the changelog of a transitive package, stamped with the version it is on', () => {
    // Direct-only isInstalled is false, yet the host found the changelog in the
    // package's folder and installedFrom already counts the transitive entry.
    expect(versionBandFor({ ...base, isInstalled: false, installedFrom: '1.2.3', to: '1.2.3', hasChangelog: true }))
      .toEqual({ diff: undefined, from: '1.2.3', title: 'Version 1.2.3' });
  });

  it('is never a heading with nothing under it: a changelog with no version to stamp it counts for nothing', () => {
    expect(versionBandFor({ ...base, isInstalled: false, installedFrom: '', hasChangelog: true })).toBeUndefined();
  });

  it('does not render for nothing: no difference, no link, no changelog', () => {
    expect(versionBandFor(base)).toBeUndefined();
  });

  it('does not show a difference for a package that is not installed', () => {
    expect(versionBandFor({ ...base, isInstalled: false, installedFrom: '', diff })).toBeUndefined();
  });
});
