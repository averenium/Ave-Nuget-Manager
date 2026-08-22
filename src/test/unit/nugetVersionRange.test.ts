import { parseNuGetVersionRange, versionInNuGetRange } from '../../nugetVersionRange';

describe('parseNuGetVersionRange', () => {
  it('parses exclusive upper bound used by VDB pages', () => {
    expect(parseNuGetVersionRange('(, 2.0.0)')).toEqual({
      min: undefined, minInclusive: false, max: '2.0.0', maxInclusive: false,
    });
    expect(parseNuGetVersionRange('[1.0.0, 2.0.0)')).toEqual({
      min: '1.0.0', minInclusive: true, max: '2.0.0', maxInclusive: false,
    });
  });

  it('treats a bare version as exact', () => {
    expect(parseNuGetVersionRange('13.0.1')).toEqual({
      min: '13.0.1', minInclusive: true, max: '13.0.1', maxInclusive: true,
    });
  });
});

describe('versionInNuGetRange', () => {
  it('matches VDB-style exclusive max', () => {
    expect(versionInNuGetRange('0.30.1', '(, 0.32.0)')).toBe(true);
    expect(versionInNuGetRange('0.32.0', '(, 0.32.0)')).toBe(false);
    expect(versionInNuGetRange('1.5.0', '[1.0.0, 2.0.0)')).toBe(true);
    expect(versionInNuGetRange('2.0.0', '[1.0.0, 2.0.0)')).toBe(false);
    expect(versionInNuGetRange('13.0.1', '13.0.1')).toBe(true);
  });
});
