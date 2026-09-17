import { isEmptyDiff, versionDependencyDiff } from '../../packageVersionDiff';
import type { DeclaredDependencyGroup } from '../../types';

const group = (
  targetFramework: string | undefined,
  deps: Array<[string, string?]>,
): DeclaredDependencyGroup => ({
  targetFramework,
  dependencies: deps.map(([id, range]) => ({ id, range })),
});

const NET10 = ['net10.0'];

describe('versionDependencyDiff', () => {
  it('names what the update would add, move and drop', () => {
    const before = [group('.NETCoreApp10.0', [['Example.Core', '[3.1.0, 4.0.0)'], ['Old.Thing', '>= 1.0.0']])];
    const after = [group('.NETCoreApp10.0', [['Example.Core', '[4.0.0, 5.0.0)'], ['System.Text.Json', '>= 8.0.4']])];

    expect(versionDependencyDiff(before, after, NET10)).toEqual({
      added: [{ id: 'System.Text.Json', to: '>= 8.0.4' }],
      changed: [{ id: 'Example.Core', from: '[3.1.0, 4.0.0)', to: '[4.0.0, 5.0.0)' }],
      dropped: [{ id: 'Old.Thing', from: '>= 1.0.0' }],
      frameworksDropped: [],
    });
  });

  it('compares the framework an install would use, not every group at once', () => {
    // A package declaring different dependencies per framework would otherwise
    // report the difference between its own groups as a change the update makes.
    const before = [
      group('.NETCoreApp10.0', [['Example.Core', '>= 3.0.0']]),
      group('.NETStandard2.0', [['Legacy.Shim', '>= 1.0.0']]),
    ];
    const after = [
      group('.NETCoreApp10.0', [['Example.Core', '>= 3.0.0']]),
      group('.NETStandard2.0', [['Legacy.Shim', '>= 2.0.0']]),
    ];
    expect(isEmptyDiff(versionDependencyDiff(before, after, NET10))).toBe(true);
  });

  it('reads the two spellings of a framework as one', () => {
    const before = [group('.NETCoreApp10.0', [['Example.Core', '>= 3.0.0']])];
    const after = [group('net10.0', [['Example.Core', '>= 4.0.0']])];
    expect(versionDependencyDiff(before, after, NET10).changed).toHaveLength(1);
  });

  it('ignores spacing in a range, which carries no meaning', () => {
    const before = [group('net10.0', [['Example.Core', '[3.1.0, 4.0.0)']])];
    const after = [group('net10.0', [['Example.Core', '[3.1.0,4.0.0)']])];
    expect(isEmptyDiff(versionDependencyDiff(before, after, NET10))).toBe(true);
  });

  it('matches a dependency id case-insensitively, as NuGet does', () => {
    const before = [group('net10.0', [['example.core', '>= 1.0.0']])];
    const after = [group('net10.0', [['Example.Core', '>= 2.0.0']])];
    expect(versionDependencyDiff(before, after, NET10)).toMatchObject({
      added: [], dropped: [], changed: [{ id: 'Example.Core' }],
    });
  });

  it('reports a framework the newer version stops serving, if the workspace targets it', () => {
    // netstandard2.0 cannot take a net10.0 group, so that project framework
    // genuinely loses its way in.
    const before = [group('net10.0', []), group('.NETStandard2.0', [])];
    const after = [group('net10.0', [])];
    expect(versionDependencyDiff(before, after, ['net10.0', 'netstandard2.0']).frameworksDropped)
      .toEqual(['netstandard2.0']);
  });

  it('says nothing when another group still serves the framework', () => {
    // Measured: installed declares `.NETFramework4.7.2` and `netstandard2.0`,
    // the next version declares only `netstandard2.0` — which a net472 project
    // takes without a word from restore. Looking for the framework's own key
    // among the declared groups called that a dropped framework, which is the
    // one distinction this whole section is careful about.
    const before = [group('.NETFramework4.7.2', []), group('.NETStandard2.0', [])];
    const after = [group('.NETStandard2.0', [])];
    expect(versionDependencyDiff(before, after, ['net472']).frameworksDropped).toEqual([]);
  });

  it('reports a framework nothing in the newer version can serve', () => {
    // The real drop: a net472 project has no way into a version that declares
    // only net8.0.
    const before = [group('.NETFramework4.7.2', []), group('.NETStandard2.0', [])];
    const after = [group('net8.0', [])];
    expect(versionDependencyDiff(before, after, ['net472']).frameworksDropped).toEqual(['net472']);
  });

  it('says nothing about a framework the workspace does not target', () => {
    // A package dropping net472 is no consequence to a solution with none.
    const before = [group('net10.0', []), group('net472', [])];
    const after = [group('net10.0', [])];
    expect(versionDependencyDiff(before, after, NET10).frameworksDropped).toEqual([]);
  });

  it('answers nothing when either side was never described', () => {
    // Not the same as nothing changing, but the caller renders nothing either
    // way — and inventing a difference from an absent side would be a guess.
    const one = [group('net10.0', [['Example.Core', '>= 1.0.0']])];
    expect(isEmptyDiff(versionDependencyDiff(undefined, one, NET10))).toBe(true);
    expect(isEmptyDiff(versionDependencyDiff(one, undefined, NET10))).toBe(true);
  });

  it('still compares when the workspace frameworks are not known yet', () => {
    // `projectFrameworks` is empty until `dotnet list` answers and stays empty
    // if it failed. Asking for a compatible group with no target answers only
    // with the catch-all, which most packages do not have — so this compared two
    // empty groups and reported that an update changes nothing.
    const before = [group('net10.0', [['Example.Core', '>= 1.0.0']])];
    const after = [group('net10.0', [['Example.Core', '>= 2.0.0']])];
    expect(versionDependencyDiff(before, after, []).changed).toEqual([
      { id: 'Example.Core', from: '>= 1.0.0', to: '>= 2.0.0' },
    ]);
  });

  it('falls back to the group that names no framework when the project one is unknown', () => {
    const before = [group(undefined, [['Example.Core', '>= 1.0.0']])];
    const after = [group(undefined, [['Example.Core', '>= 2.0.0']])];
    expect(versionDependencyDiff(before, after, []).changed).toHaveLength(1);
  });

  // The lab Nexus's own registration output (#123): net8.0/net9.0/net10.0
  // rewritten into `.NETFramework` monikers — see frameworkMoniker.test.ts.
  it('compares two versions a Nexus-hosted feed described', () => {
    const NEXUS3: Array<[string, Array<[string, string?]>]> = [
      ['.NETFramework1.0.0', []], ['.NETFramework9.0', []], ['.NETFramework8.0', []],
    ];
    const before = NEXUS3.map(([tfm, deps]) => group(tfm, tfm === '.NETFramework1.0.0'
      ? [['Example.Core', '>= 1.0.0']] : deps));
    const after = NEXUS3.map(([tfm, deps]) => group(tfm, tfm === '.NETFramework1.0.0'
      ? [['Example.Core', '>= 2.0.0']] : deps));

    expect(versionDependencyDiff(before, after, ['net10.0'])).toEqual({
      added: [],
      changed: [{ id: 'Example.Core', from: '>= 1.0.0', to: '>= 2.0.0' }],
      dropped: [],
      frameworksDropped: [],
    });
  });

  it('does not read a change of spelling between two versions as a change of framework', () => {
    // Guards against only one side of a diff being repaired, which would
    // invent a framework the newer version "drops" when it is the same one,
    // spelled the other way.
    const before = [group('.NETFramework9.0', [['Example.Core', '>= 1.0.0']])];
    const after = [group('net9.0', [['Example.Core', '>= 1.0.0']])];
    expect(versionDependencyDiff(before, after, ['net9.0'])).toEqual({
      added: [], changed: [], dropped: [], frameworksDropped: [],
    });
  });
});
