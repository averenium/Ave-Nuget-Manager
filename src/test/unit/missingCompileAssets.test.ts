import { findMissingCompileAssets } from '../../missingCompileAssets';

function assets(overrides: {
  targets: Record<string, Record<string, unknown>>;
  libraries?: Record<string, { files?: string[] }>;
}) {
  return overrides;
}

describe('findMissingCompileAssets', () => {
  it('flags a package matched by a non-compile asset while shipping lib/ for another TFM (#107 repro)', () => {
    // Microsoft.AspNetCore.OpenApi 10.0.12 on a net8.0 project: ships
    // lib/net10.0 only, restore accepts it via the build/ targets file, and
    // `dotnet restore` prints no warning at all — measured in #107.
    const json = assets({
      targets: {
        'net8.0': {
          'Microsoft.AspNetCore.OpenApi/10.0.12': {
            type: 'package',
            build: { 'build/Microsoft.AspNetCore.OpenApi.targets': {} },
          },
        },
      },
      libraries: {
        'Microsoft.AspNetCore.OpenApi/10.0.12': {
          files: ['lib/net10.0/Microsoft.AspNetCore.OpenApi.dll', 'build/Microsoft.AspNetCore.OpenApi.targets'],
        },
      },
    });

    expect(findMissingCompileAssets(json)).toEqual([
      { id: 'Microsoft.AspNetCore.OpenApi', version: '10.0.12', framework: 'net8.0', shipsOnly: ['lib/net10.0'] },
    ]);
  });

  it('does not flag a normal package with a compile asset', () => {
    const json = assets({
      targets: {
        'net8.0': {
          'Newtonsoft.Json/13.0.3': {
            type: 'package',
            compile: { 'lib/netstandard2.0/Newtonsoft.Json.dll': {} },
          },
        },
      },
      libraries: {
        'Newtonsoft.Json/13.0.3': { files: ['lib/netstandard2.0/Newtonsoft.Json.dll'] },
      },
    });

    expect(findMissingCompileAssets(json)).toEqual([]);
  });

  it('does not flag a metapackage/analyzer with empty compile and no lib/ or ref/ at all (xunit, xunit.analyzers)', () => {
    const json = assets({
      targets: {
        'net8.0': {
          'xunit/2.9.2': { type: 'package', dependencies: { 'xunit.core': '2.9.2' } },
          'xunit.analyzers/1.16.0': { type: 'package' },
        },
      },
      libraries: {
        'xunit/2.9.2': { files: ['xunit.nuspec'] },
        'xunit.analyzers/1.16.0': { files: ['analyzers/dotnet/cs/xunit.analyzers.dll'] },
      },
    });

    expect(findMissingCompileAssets(json)).toEqual([]);
  });

  it('does not flag a ProjectReference entry', () => {
    const json = assets({
      targets: {
        'net8.0': {
          '../Other/Other.csproj': { type: 'project' },
        },
      },
      libraries: {},
    });

    expect(findMissingCompileAssets(json)).toEqual([]);
  });

  it('ignores a RID-qualified target so the same mismatch is not reported twice', () => {
    const json = assets({
      targets: {
        'net8.0': {
          'Pkg/1.0.0': { type: 'package', build: {} },
        },
        'net8.0/win-x64': {
          'Pkg/1.0.0': { type: 'package', build: {} },
        },
      },
      libraries: {
        'Pkg/1.0.0': { files: ['lib/net10.0/Pkg.dll'] },
      },
    });

    expect(findMissingCompileAssets(json)).toEqual([
      { id: 'Pkg', version: '1.0.0', framework: 'net8.0', shipsOnly: ['lib/net10.0'] },
    ]);
  });

  it('reports one row per affected framework in a multi-target project', () => {
    const json = assets({
      targets: {
        'net8.0': { 'Pkg/1.0.0': { type: 'package' } },
        'net10.0': { 'Pkg/1.0.0': { type: 'package', compile: { 'lib/net10.0/Pkg.dll': {} } } },
      },
      libraries: {
        'Pkg/1.0.0': { files: ['lib/net10.0/Pkg.dll'] },
      },
    });

    expect(findMissingCompileAssets(json)).toEqual([
      { id: 'Pkg', version: '1.0.0', framework: 'net8.0', shipsOnly: ['lib/net10.0'] },
    ]);
  });

  it('matches library keys case-insensitively, the way NuGet writes them', () => {
    const json = assets({
      targets: {
        'net8.0': {
          'pkg/1.0.0': { type: 'package' },
        },
      },
      libraries: {
        'Pkg/1.0.0': { files: ['lib/net10.0/Pkg.dll'] },
      },
    });

    expect(findMissingCompileAssets(json)).toEqual([
      { id: 'pkg', version: '1.0.0', framework: 'net8.0', shipsOnly: ['lib/net10.0'] },
    ]);
  });

  it('returns nothing for a missing or malformed assets document', () => {
    expect(findMissingCompileAssets(null)).toEqual([]);
    expect(findMissingCompileAssets({})).toEqual([]);
    expect(findMissingCompileAssets({ targets: 'nope' })).toEqual([]);
  });
});
