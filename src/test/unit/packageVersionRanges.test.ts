import {
  classifyDependencyRow,
  formatNuGetVersionRange,
  parseNuGetVersionRange,
  rangeHasCeiling,
  versionSatisfiesRange,
} from '../../packageVersionRanges';

describe('parseNuGetVersionRange', () => {
  it('parses a bare version as a minimum-inclusive floor with no ceiling', () => {
    expect(parseNuGetVersionRange('6.8.1')).toEqual({
      minVersion: '6.8.1', minInclusive: true, maxInclusive: true, isExact: false,
    });
  });

  it('parses an exact pin [1.0.0]', () => {
    expect(parseNuGetVersionRange('[1.0.0]')).toEqual({
      minVersion: '1.0.0', minInclusive: true, maxVersion: '1.0.0', maxInclusive: true, isExact: true,
    });
  });

  it('parses [min, max) with the right inclusivity per bracket', () => {
    expect(parseNuGetVersionRange('[2.7.5, 3.0.0)')).toEqual({
      minVersion: '2.7.5', minInclusive: true, maxVersion: '3.0.0', maxInclusive: false, isExact: false,
    });
  });

  it('parses (min, max] with exclusive min', () => {
    expect(parseNuGetVersionRange('(1.0.0, 2.0.0]')).toEqual({
      minVersion: '1.0.0', minInclusive: false, maxVersion: '2.0.0', maxInclusive: true, isExact: false,
    });
  });

  it('parses a max-only range (,2.0.0]', () => {
    const r = parseNuGetVersionRange('(,2.0.0]');
    expect(r.minVersion).toBeUndefined();
    expect(r.maxVersion).toBe('2.0.0');
    expect(rangeHasCeiling(r)).toBe(true);
  });
});

describe('versionSatisfiesRange', () => {
  it('respects exclusive vs inclusive bounds', () => {
    const r = parseNuGetVersionRange('[2.7.5, 3.0.0)');
    expect(versionSatisfiesRange('2.7.5', r)).toBe(true);
    expect(versionSatisfiesRange('2.9.9', r)).toBe(true);
    expect(versionSatisfiesRange('3.0.0', r)).toBe(false);
    expect(versionSatisfiesRange('3.10.2', r)).toBe(false);
    expect(versionSatisfiesRange('2.0.0', r)).toBe(false);
  });
});

describe('formatNuGetVersionRange', () => {
  it('round-trips bracket notation', () => {
    expect(formatNuGetVersionRange(parseNuGetVersionRange('[2.7.5, 3.0.0)'))).toBe('[2.7.5, 3.0.0)');
    expect(formatNuGetVersionRange(parseNuGetVersionRange('[1.0.0]'))).toBe('[1.0.0]');
  });
});

describe('classifyDependencyRow', () => {
  it('is "ok" with nothing to show when resolved exactly equals a bare floor', () => {
    expect(classifyDependencyRow('6.8.1', '6.8.1')).toEqual({ status: 'ok', showDeclared: false });
  });

  it('is "ok" with nothing to show when only minor/patch was lifted above a bare floor', () => {
    expect(classifyDependencyRow('8.0.0', '8.2.3')).toEqual({ status: 'ok', showDeclared: false });
  });

  it('is "major-lifted" with an annotation when the major differs from a bare floor (RabbitMQ.Client case)', () => {
    expect(classifyDependencyRow('6.8.1', '7.2.2')).toEqual({ status: 'major-lifted', showDeclared: true });
  });

  it('always shows a ceiling range, "ok" when satisfied', () => {
    expect(classifyDependencyRow('[2.7.5, 3.0.0)', '2.9.0')).toEqual({ status: 'ok', showDeclared: true });
  });

  it('is "outside-range" when resolved violates a ceiling (Microsoft.OpenApi / NU1608 case)', () => {
    expect(classifyDependencyRow('[2.7.5, 3.0.0)', '3.10.2')).toEqual({ status: 'outside-range', showDeclared: true });
  });

  it('is "outside-range" when an exact pin does not match the resolved version', () => {
    expect(classifyDependencyRow('[1.0.0]', '1.0.1')).toEqual({ status: 'outside-range', showDeclared: true });
  });

  it('is "ok" when an exact pin matches exactly', () => {
    expect(classifyDependencyRow('[1.0.0]', '1.0.0')).toEqual({ status: 'ok', showDeclared: false });
  });
});
