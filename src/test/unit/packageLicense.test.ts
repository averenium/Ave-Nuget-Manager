import { resolveLicenseDisplay, spdxBadgeUrl, splitSpdxExpression } from '../../packageLicense';

describe('splitSpdxExpression', () => {
  it('returns a single id for a simple expression', () => {
    expect(splitSpdxExpression('MIT')).toEqual({ ids: ['MIT'], operators: [] });
  });

  it('splits a compound AND expression, keeping the operator', () => {
    expect(splitSpdxExpression('MIT AND Apache-2.0')).toEqual({ ids: ['MIT', 'Apache-2.0'], operators: ['AND'] });
  });

  it('splits a compound OR expression', () => {
    expect(splitSpdxExpression('Apache-2.0 OR MPL-2.0')).toEqual({ ids: ['Apache-2.0', 'MPL-2.0'], operators: ['OR'] });
  });

  it('strips a single outer paren wrapping the whole expression', () => {
    expect(splitSpdxExpression('(MIT OR Apache-2.0)')).toEqual({ ids: ['MIT', 'Apache-2.0'], operators: ['OR'] });
  });
});

describe('spdxBadgeUrl', () => {
  it('links to licenses.nuget.org/<id>', () => {
    expect(spdxBadgeUrl('Apache-2.0')).toBe('https://licenses.nuget.org/Apache-2.0');
  });
});

describe('resolveLicenseDisplay', () => {
  it('prefers an expression license, split into ids/operators', () => {
    expect(resolveLicenseDisplay({ type: 'expression', value: 'MIT' }, 'https://licenses.nuget.org/MIT')).toEqual({
      kind: 'expression', ids: ['MIT'], operators: [], fullExpression: 'MIT',
    });
  });

  it('shows a file license by its filename, distinct from a link (EasyNetQ case)', () => {
    expect(resolveLicenseDisplay({ type: 'file', value: 'licence.txt' }, 'https://aka.ms/deprecateLicenseUrl')).toEqual({
      kind: 'file', fileName: 'licence.txt',
    });
  });

  it('falls back to licenseUrl as a link when there is no <license> element', () => {
    expect(resolveLicenseDisplay(undefined, 'https://go.microsoft.com/fwlink/?linkid=2028464')).toEqual({
      kind: 'url', url: 'https://go.microsoft.com/fwlink/?linkid=2028464',
    });
  });

  it('filters the deprecated aka.ms placeholder by exact value, leaving no badge', () => {
    expect(resolveLicenseDisplay(undefined, 'https://aka.ms/deprecateLicenseUrl')).toEqual({ kind: 'none' });
  });

  it('is "none" when nothing at all is present', () => {
    expect(resolveLicenseDisplay(undefined, undefined)).toEqual({ kind: 'none' });
  });
});
