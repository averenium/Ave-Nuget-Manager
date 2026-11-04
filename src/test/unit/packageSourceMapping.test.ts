import { mappedSourceNames, packageMatchesAnyMapping } from '../../packageSourceMapping';
import type { PackageSourceMapping } from '../../types';

function mapping(sourceName: string, ...patterns: string[]): PackageSourceMapping {
  return { sourceName, patterns };
}

describe('packageMatchesAnyMapping', () => {
  it('matches an exact package id', () => {
    expect(packageMatchesAnyMapping('Newtonsoft.Json', [mapping('nuget.org', 'Newtonsoft.Json')])).toBe(true);
    expect(packageMatchesAnyMapping('Newtonsoft.Json.Bson', [mapping('nuget.org', 'Newtonsoft.Json')])).toBe(false);
  });

  it('matches a prefix pattern ending in *', () => {
    expect(packageMatchesAnyMapping('Microsoft.Extensions.Logging', [mapping('nuget.org', 'Microsoft.Extensions.*')])).toBe(true);
    expect(packageMatchesAnyMapping('Microsoft.EntityFrameworkCore', [mapping('nuget.org', 'Microsoft.Extensions.*')])).toBe(false);
  });

  it('is case-insensitive on both the id and the pattern', () => {
    expect(packageMatchesAnyMapping('newtonsoft.json', [mapping('nuget.org', 'NEWTONSOFT.JSON')])).toBe(true);
    expect(packageMatchesAnyMapping('MICROSOFT.EXTENSIONS.LOGGING', [mapping('nuget.org', 'microsoft.extensions.*')])).toBe(true);
  });

  it('matches across multiple mapped sources, not just the first', () => {
    const mappings = [
      mapping('nuget.org', 'Microsoft.*', 'System.*'),
      mapping('internal', 'Contoso.*'),
    ];
    expect(packageMatchesAnyMapping('Contoso.Shared', mappings)).toBe(true);
    expect(packageMatchesAnyMapping('System.Text.Json', mappings)).toBe(true);
    expect(packageMatchesAnyMapping('Fabrikam.Widgets', mappings)).toBe(false);
  });

  it('is false for every package when mapping is not configured at all', () => {
    expect(packageMatchesAnyMapping('Newtonsoft.Json', [])).toBe(false);
  });

  it('does not let a bare "*" in one pattern swallow unrelated ids beyond its prefix', () => {
    // Sanity check on the "*" semantics: it is a prefix match, not "matches everything".
    expect(packageMatchesAnyMapping('OtherCompany.Lib', [mapping('nuget.org', 'Contoso.*')])).toBe(false);
  });
});

describe('mappedSourceNames (#136)', () => {
  const release = mapping('Release', 'Example.*');
  const snapshot = mapping('Snapshot', 'Example.Core', 'Example.Core.*');

  it('is unrestricted when mapping is off', () => {
    expect(mappedSourceNames('Example.Core', [])).toBeUndefined();
  });

  it('names every source that maps the id with equal weight', () => {
    expect(mappedSourceNames('Example.Core', [mapping('Release', 'Example.Core'), mapping('Snapshot', 'example.core')]))
      .toEqual(new Set(['release', 'snapshot']));
  });

  it('prefers an exact id over a prefix', () => {
    expect(mappedSourceNames('Example.Core', [release, snapshot])).toEqual(new Set(['snapshot']));
  });

  it('prefers the longer prefix', () => {
    expect(mappedSourceNames('Example.Core.Extras', [release, snapshot])).toEqual(new Set(['snapshot']));
    expect(mappedSourceNames('Example.Other', [release, snapshot])).toEqual(new Set(['release']));
  });

  it('takes a lone * only when nothing more specific matches', () => {
    const everything = mapping('Everything', '*');
    expect(mappedSourceNames('Example.Other', [everything, release])).toEqual(new Set(['release']));
    expect(mappedSourceNames('Another.Thing', [everything, release])).toEqual(new Set(['everything']));
  });

  it('is unrestricted for an id nothing in the mapping matches, rather than naming no source', () => {
    expect(mappedSourceNames('Another.Thing', [release, snapshot])).toBeUndefined();
  });
});
