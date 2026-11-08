import { NOT_RESTORED_NOTE, isNeutral, restoreBandFor, unresolvedLabel, unresolvedOf } from '../../webview/utils/unresolvedView';
import type { InstalledPackage } from '../../types';

describe('how an unresolved reference reads (#138)', () => {
  it('says not found for NU1101 and no such version for NU1102, in the right-hand cell', () => {
    expect(unresolvedLabel({ code: 'NU1101' })).toBe('not found');
    expect(unresolvedLabel({ code: 'NU1102' })).toBe('no such version');
  });

  it('says restore failed for any other error rather than naming something it does not know', () => {
    expect(unresolvedLabel({ code: 'NU1301' })).toBe('restore failed');
    expect(unresolvedLabel({})).toBe('restore failed');
  });

  it('says not restored yet, neutrally, for a reference restore has not run on', () => {
    expect(unresolvedLabel({ notRestored: true })).toBe('not restored yet');
    expect(isNeutral({ notRestored: true })).toBe(true);
    expect(isNeutral({ code: 'NU1101' })).toBe(false);
  });

  it('never says …, which an installed row without a latest version shows and a package no feed has would show for ever', () => {
    for (const u of [{ code: 'NU1101' }, { code: 'NU1102' }, { code: 'NU1301' }, { notRestored: true }, {}]) {
      expect(unresolvedLabel(u)).not.toBe('…');
      expect(unresolvedLabel(u).length).toBeGreaterThan(0);
    }
  });

  it('puts the restore message in a band with its code and the frameworks it failed for', () => {
    expect(restoreBandFor({ code: 'NU1102', message: 'Unable to find package Example.Json', frameworks: ['net8.0'] })).toEqual({
      code: 'NU1102', message: 'Unable to find package Example.Json', frameworks: ' · net8.0',
    });
    expect(restoreBandFor({ code: 'NU1101', message: 'x', frameworks: ['net8.0', 'net10.0'] })?.frameworks).toBe(' · net8.0, net10.0');
    expect(restoreBandFor({ code: 'NU1101', message: 'x' })?.frameworks).toBe('');
  });

  it('draws no band for a reference restore has not run on, or for one with nothing to say', () => {
    expect(restoreBandFor({ notRestored: true })).toBeUndefined();
    expect(restoreBandFor({ code: 'NU1101' })).toBeUndefined();
    expect(restoreBandFor(undefined)).toBeUndefined();
  });

  it('has one muted line for the not-restored case', () => {
    expect(NOT_RESTORED_NOTE).toBe('Declared in the project file; this project has not been restored since it was added.');
  });

  it('takes the unresolved answer from whichever of the package\'s rows has one', () => {
    const rows = [
      { id: 'Example.A', projectPath: 'a', resolvedVersion: '1.0.0', requestedVersion: '1.0.0' },
      { id: 'Example.A', projectPath: 'b', resolvedVersion: '1.0.0', requestedVersion: '1.0.0', unresolved: { code: 'NU1101' } },
    ] as InstalledPackage[];
    expect(unresolvedOf(rows)).toEqual({ code: 'NU1101' });
    expect(unresolvedOf([rows[0]])).toBeUndefined();
  });
});
