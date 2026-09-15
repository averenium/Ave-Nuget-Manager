import { flagsForVersion } from '../../webview/utils/versionFlags';
import { nearestUnaffectedVersion } from '../../webview/utils/nearestUnaffected';
import type { VersionFlag } from '../../types';

/**
 * The record is keyed by the feed's spelling; the version asked about comes from
 * the restore graph, a project file or the picker. `1.0` and `1.0.0` are one
 * version to NuGet and two keys to an object, so an exact-key lookup answers
 * "nothing known" about a version the feed described in full — and every use of
 * this fails silently when it does: no publication date, no advisory, and no
 * warning that the installed version has been withdrawn.
 */
describe('flagsForVersion', () => {
  const flags: Record<string, VersionFlag> = {
    '1.0.0': { listed: false, published: '2024-01-01T00:00:00Z' },
    '2.0.0': { vulnerable: true },
  };

  it('finds a version however either side spelled it', () => {
    expect(flagsForVersion(flags, '1.0')?.listed).toBe(false);
    expect(flagsForVersion(flags, '1.0.0.0')?.listed).toBe(false);
    expect(flagsForVersion(flags, ' 1.0.0 ')?.listed).toBe(false);
    expect(flagsForVersion(flags, '1.0.0+sha.abc')?.listed).toBe(false);
  });

  it('answers the exact key when there is one', () => {
    expect(flagsForVersion(flags, '2.0.0')?.vulnerable).toBe(true);
  });

  it('says nothing about a version the feed never described', () => {
    expect(flagsForVersion(flags, '3.0.0')).toBeUndefined();
    expect(flagsForVersion(flags, undefined)).toBeUndefined();
    expect(flagsForVersion({}, '1.0.0')).toBeUndefined();
  });
});

describe('nearestUnaffectedVersion across spellings', () => {
  it('places the selected version in the list however it is spelled', () => {
    // An index lookup read `1.0` as absent from a list holding `1.0.0`, and the
    // offer never appeared.
    const all = ['3.0.0', '2.0.0', '1.0.0'];
    const flags: Record<string, VersionFlag> = {
      '1.0.0': { advisories: [{ severity: 'high' }] },
      '2.0.0': { advisories: [{ severity: 'high' }] },
    };
    expect(nearestUnaffectedVersion(all, flags, '1.0')).toBe('3.0.0');
  });
});
