import { isPrerelease, versionsEqual } from '../../semver';

/**
 * The same version reaches this code spelled differently depending on where it
 * came from: a project file, the restore graph, a flat container (which strips
 * build metadata) or a registration leaf (which keeps it).
 */
describe('versionsEqual', () => {
  it('matches the same version written with different precision', () => {
    expect(versionsEqual('1.0', '1.0.0')).toBe(true);
    expect(versionsEqual('1.0.0.0', '1.0.0')).toBe(true);
  });

  it('ignores build metadata, which is never part of the identity', () => {
    expect(versionsEqual('1.2.3+build.7', '1.2.3')).toBe(true);
    expect(versionsEqual('2.0.0-alpha.1+sha.abc', '2.0.0-alpha.1')).toBe(true);
  });

  it('keeps a pre-release apart from its release', () => {
    expect(versionsEqual('2.0.0-rc.1', '2.0.0')).toBe(false);
    expect(versionsEqual('1.0.1', '1.0.0')).toBe(false);
  });

  it('tolerates surrounding space', () => {
    expect(versionsEqual(' 1.0.0 ', '1.0.0')).toBe(true);
  });
});

describe('isPrerelease', () => {
  it('recognises the standard pre-release suffixes', () => {
    expect(isPrerelease('11.0.0-rc.1')).toBe(true);
    expect(isPrerelease('2.0.0-preview.2')).toBe(true);
    expect(isPrerelease('1.0.0-alpha')).toBe(true);
  });

  it('does not flag a stable version', () => {
    expect(isPrerelease('10.0.12')).toBe(false);
    expect(isPrerelease('1.0')).toBe(false);
  });
});
