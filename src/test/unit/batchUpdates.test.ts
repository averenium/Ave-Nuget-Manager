import type { InstalledPackage, VersionFlag } from '../../types';
import {
  collectFamilyGroups,
  collectOtherItems,
  collectUpdatableItems,
  compatibleFamilyVersions,
  compatibleMemberVersions,
  computeEntangledCluster,
  familyHasBlockedMember,
  familyItemsAtVersion,
  formatBatchUpdateError,
  intersectVersions,
  memberProjectTfms,
  preserveInstalledEnrichment,
  splitFamilyMembers,
  type EntangledClusterInput,
  type FamilyMember,
} from '../../batchUpdates';

function pkg(
  id: string,
  version: string,
  latest?: string,
  projectPath = '/p/App.csproj',
  dependencies?: string[],
  versions?: string[],
): InstalledPackage {
  return {
    id,
    requestedVersion: version,
    resolvedVersion: version,
    projectPath,
    latestVersion: latest,
    dependencies,
    versions,
  };
}

describe('collectUpdatableItems', () => {
  it('skips packages without a newer latest version', () => {
    expect(collectUpdatableItems([
      pkg('A', '1.0.0', '1.0.0'),
      pkg('B', '1.0.0'),
    ])).toEqual([]);
  });

  it('uses each package own latest (prerelease included when enrich provided it)', () => {
    const items = collectUpdatableItems([
      pkg('Microsoft.Extensions.Logging', '8.0.0', '9.0.0-preview.1'),
      pkg('Newtonsoft.Json', '13.0.1', '13.0.3'),
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        packageId: 'Microsoft.Extensions.Logging',
        fromVersion: '8.0.0',
        toVersion: '9.0.0-preview.1',
      }),
      expect.objectContaining({
        packageId: 'Newtonsoft.Json',
        toVersion: '13.0.3',
      }),
    ]);
  });

  it('collects every project that is behind latest', () => {
    const items = collectUpdatableItems([
      pkg('Pkg', '1.0.0', '2.0.0', '/a/A.csproj'),
      pkg('Pkg', '1.1.0', '2.0.0', '/b/B.csproj'),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].projects).toEqual(['/a/A.csproj', '/b/B.csproj']);
    expect(items[0].fromVersion).toBe('1.0.0 / 1.1.0');
  });

  it('does not include projects already on latest', () => {
    const items = collectUpdatableItems([
      pkg('Pkg', '2.0.0', '2.0.0', '/a/A.csproj'),
      pkg('Pkg', '1.0.0', '2.0.0', '/b/B.csproj'),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].projects).toEqual(['/b/B.csproj']);
  });

  it('gives each project its own achievable target instead of capping every project to whichever one answered first (#107)', () => {
    // Example.Extensions.Http referenced from a net9.0 project (own ceiling
    // 9.1.0) and a net10.0 project (own ceiling 10.0.12, which net9.0 could
    // never take). Each project's own `.latestVersion` is already correct —
    // collectUpdatableItems must not collapse them into one shared value.
    const items = collectUpdatableItems([
      pkg('Example.Extensions.Http', '8.0.11', '9.1.0', '/p/Net9.csproj'),
      pkg('Example.Extensions.Http', '8.0.11', '10.0.12', '/p/Net10.csproj'),
    ]);
    expect(items).toHaveLength(2);
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ toVersion: '9.1.0', projects: ['/p/Net9.csproj'] }),
      expect.objectContaining({ toVersion: '10.0.12', projects: ['/p/Net10.csproj'] }),
    ]));
  });

  it('does not hide one project\'s real update behind a sibling project that has none at all (#107)', () => {
    // The net9.0 project has nothing newer at all (its own ceiling equals
    // what's installed); the net10.0 project does. The old first-entry
    // ceiling would have picked net9.0's non-upgrade and reported nothing.
    const items = collectUpdatableItems([
      pkg('Example.Extensions.Http', '8.0.11', '8.0.11', '/p/Net9.csproj'),
      pkg('Example.Extensions.Http', '8.0.11', '10.0.12', '/p/Net10.csproj'),
    ]);
    expect(items).toEqual([
      expect.objectContaining({ toVersion: '10.0.12', projects: ['/p/Net10.csproj'] }),
    ]);
  });

  it('still merges projects that already agree on the same achievable target', () => {
    const items = collectUpdatableItems([
      pkg('Example.Extensions.Http', '8.0.11', '9.1.0', '/p/A.csproj'),
      pkg('Example.Extensions.Http', '8.0.0', '9.1.0', '/p/B.csproj'),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].projects.sort()).toEqual(['/p/A.csproj', '/p/B.csproj']);
    expect(items[0].toVersion).toBe('9.1.0');
  });

  it('orders All by the restore dependency graph', () => {
    const items = collectUpdatableItems([
      pkg('Microsoft.Extensions.Http', '10.0.0', '10.0.11', '/p/App.csproj', [
        'Microsoft.Extensions.Logging.Abstractions',
      ]),
      pkg('Microsoft.Extensions.Logging.Abstractions', '10.0.0', '10.0.11'),
    ]);
    expect(items.map((i) => i.packageId)).toEqual([
      'Microsoft.Extensions.Logging.Abstractions',
      'Microsoft.Extensions.Http',
    ]);
  });
});

describe('collectUpdatableItems — a package pinned per target framework (#82)', () => {
  // The demo/multi-tfm fixture: one project, one id, two lines.
  const CORE = '/s/Core.csproj';
  const APP = '/s/App.csproj';
  const LINES = ['10.0.12', '10.0.0', '9.0.20', '9.0.0'];

  const tfmPkg = (
    id: string,
    version: string,
    framework: string,
    projectPath = CORE,
    versions = LINES,
  ): InstalledPackage => ({
    id,
    requestedVersion: version,
    resolvedVersion: version,
    projectPath,
    framework,
    latestVersion: versions[0],
    versions,
  });

  it('proposes one target per framework, each inside its own major line', () => {
    const items = collectUpdatableItems([
      tfmPkg('Microsoft.Extensions.Http', '9.0.0', 'net9.0'),
      tfmPkg('Microsoft.Extensions.Http', '10.0.0', 'net10.0'),
    ]);
    expect(items.map((i) => ({ to: i.toVersion, framework: i.framework }))).toEqual([
      { to: '9.0.20', framework: 'net9.0' },
      { to: '10.0.12', framework: 'net10.0' },
    ]);
  });

  it('leaves an unconditional reference as one item with no framework', () => {
    // Newtonsoft.Json in the fixture: same version under both TFMs.
    const items = collectUpdatableItems([
      tfmPkg('Newtonsoft.Json', '13.0.1', 'net9.0', CORE, ['13.0.4', '13.0.1']),
      tfmPkg('Newtonsoft.Json', '13.0.1', 'net10.0', CORE, ['13.0.4', '13.0.1']),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].framework).toBeUndefined();
    expect(items[0].toVersion).toBe('13.0.4');
    expect(items[0].projects).toEqual([CORE]);
  });

  it('leaves a neighbouring project out of the framework-pinned items entirely', () => {
    // APP references the id ordinarily. Pinning is a property of one project's
    // file, so CORE's conditional groups must not reach into APP: it keeps the
    // plain latest-version target it would have had on its own.
    const items = collectUpdatableItems([
      tfmPkg('Microsoft.Extensions.Http', '9.0.0', 'net9.0'),
      tfmPkg('Microsoft.Extensions.Http', '10.0.0', 'net10.0'),
      tfmPkg('Microsoft.Extensions.Http', '9.0.0', 'net9.0', APP),
    ]);
    expect(items.find((i) => i.framework === 'net9.0')?.projects).toEqual([CORE]);
    expect(items.find((i) => i.framework === 'net10.0')?.projects).toEqual([CORE]);
    const plain = items.find((i) => i.framework === undefined);
    expect(plain?.projects).toEqual([APP]);
    // The whole point: APP is offered the newest version, not CORE's 9.x line.
    expect(plain?.toVersion).toBe('10.0.12');
  });

  it('says nothing for a line that has nothing newer in it', () => {
    expect(collectUpdatableItems([
      tfmPkg('A', '9.0.20', 'net9.0'),
      tfmPkg('A', '10.0.0', 'net10.0'),
    ]).map((i) => i.framework)).toEqual(['net10.0']);
  });

  it('keeps every ordinary package on the id alone, framework or not', () => {
    const items = collectUpdatableItems([
      tfmPkg('Serilog', '3.1.0', 'net9.0', CORE, ['4.0.0', '3.1.0']),
      tfmPkg('Serilog', '3.1.0', 'net10.0', APP, ['4.0.0', '3.1.0']),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].framework).toBeUndefined();
    expect(items[0].projects).toEqual([CORE, APP]);
  });
});

describe('collectFamilyGroups', () => {
  it('groups Microsoft.**.** packages that share a version, including those without a newer latest', () => {
    const groups = collectFamilyGroups([
      pkg('Microsoft.Extensions.Logging', '8.0.0', '9.0.0'),
      pkg('Microsoft.Extensions.Http', '8.0.0', '8.0.0'),
      pkg('Microsoft.Extensions.Hosting', '8.0.1', '9.0.0'),
      pkg('Newtonsoft.Json', '13.0.1', '13.0.3'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].family).toBe('Microsoft.Extensions');
    expect(groups[0].fromVersion).toBe('8.0.0');
    expect(groups[0].packageCount).toBe(2);
    expect(groups[0].updateCount).toBe(1);
    expect(groups[0].members.map((m) => m.packageId)).toEqual([
      'Microsoft.Extensions.Http',
      'Microsoft.Extensions.Logging',
    ]);
  });

  it('includes the two-segment root in Microsoft.EntityFrameworkCore.*', () => {
    const groups = collectFamilyGroups([
      pkg('Microsoft.EntityFrameworkCore', '10.0.0', '10.0.11'),
      pkg('Microsoft.EntityFrameworkCore.Relational', '10.0.0', '10.0.11'),
      pkg('Microsoft.EntityFrameworkCore.SqlServer', '10.0.0', '10.0.11'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].family).toBe('Microsoft.EntityFrameworkCore');
    expect(groups[0].packageCount).toBe(3);
    expect(groups[0].updateCount).toBe(3);
    expect(groups[0].members.map((m) => m.packageId)).toEqual([
      'Microsoft.EntityFrameworkCore',
      'Microsoft.EntityFrameworkCore.Relational',
      'Microsoft.EntityFrameworkCore.SqlServer',
    ]);
  });

  it('orders family members from project.assets.json dependencies', () => {
    const groups = collectFamilyGroups([
      pkg('Microsoft.Extensions.Http', '10.0.0', '10.0.11', '/p/App.csproj', [
        'Microsoft.Extensions.Logging.Abstractions',
      ]),
      pkg('Microsoft.Extensions.Logging.Abstractions', '10.0.0', '10.0.11'),
    ]);
    expect(groups[0].members.map((m) => m.packageId)).toEqual([
      'Microsoft.Extensions.Logging.Abstractions',
      'Microsoft.Extensions.Http',
    ]);
  });

  it('does not group a family with only one package id', () => {
    expect(collectFamilyGroups([
      pkg('Microsoft.Extensions.Logging', '8.0.0', '9.0.0'),
    ])).toEqual([]);
  });

  it('counts only members that still have a newer latest', () => {
    const groups = collectFamilyGroups([
      pkg('Microsoft.Extensions.Logging', '10.0.11', '10.0.11'),
      pkg('Microsoft.Extensions.Http', '10.0.11', '10.0.11'),
    ]);
    expect(groups[0].packageCount).toBe(2);
    expect(groups[0].updateCount).toBe(0);
  });
});

describe('preserveInstalledEnrichment', () => {
  it('keeps latestVersion across a list refresh so All still sees updates', () => {
    const previous = [pkg('Newtonsoft.Json', '13.0.1', '13.0.3')];
    const incoming = [pkg('Newtonsoft.Json', '13.0.1')];
    const merged = preserveInstalledEnrichment(incoming, previous);
    expect(collectUpdatableItems(incoming)).toEqual([]);
    expect(collectUpdatableItems(merged)).toEqual([
      expect.objectContaining({ packageId: 'Newtonsoft.Json', toVersion: '13.0.3' }),
    ]);
  });

  it('drops the update once the refreshed list is already on latest', () => {
    const previous = [pkg('Newtonsoft.Json', '13.0.1', '13.0.3')];
    const incoming = [pkg('Newtonsoft.Json', '13.0.3')];
    const merged = preserveInstalledEnrichment(incoming, previous);
    expect(merged[0].latestVersion).toBe('13.0.3');
    expect(collectUpdatableItems(merged)).toEqual([]);
  });
});

describe('collectOtherItems', () => {
  it('keeps updatable packages that are not in a family group', () => {
    const installed = [
      pkg('Microsoft.Extensions.Logging', '8.0.0', '9.0.0'),
      pkg('Microsoft.Extensions.Http', '8.0.0', '9.0.0'),
      pkg('Newtonsoft.Json', '13.0.1', '13.0.3'),
      pkg('Serilog', '3.0.0', '4.0.0'),
    ];
    const other = collectOtherItems(installed, collectFamilyGroups(installed));
    expect(other.map((i) => i.packageId)).toEqual(['Newtonsoft.Json', 'Serilog']);
  });

  it('includes a lone family-shaped id that did not form a group', () => {
    const installed = [
      pkg('Microsoft.Extensions.Logging', '8.0.0', '9.0.0'),
      pkg('Newtonsoft.Json', '13.0.1', '13.0.3'),
    ];
    const other = collectOtherItems(installed, collectFamilyGroups(installed));
    expect(other.map((i) => i.packageId)).toEqual([
      'Microsoft.Extensions.Logging',
      'Newtonsoft.Json',
    ]);
  });
});

describe('Microsoft.CodeAnalysis SDK cap', () => {
  const cap = { sdkVersion: '10.0.301', compilerVersion: '5.6.0' };
  const versions = ['5.9.0', '5.6.0', '5.5.0'];

  it('All uses max enrich version at or below csc, not nuget.org latest', () => {
    const items = collectUpdatableItems([
      pkg('Microsoft.CodeAnalysis.CSharp', '5.6.0', '5.9.0', '/p/App.csproj', undefined, versions),
      pkg('Newtonsoft.Json', '13.0.1', '13.0.3'),
    ], cap);
    expect(items.map((i) => i.packageId)).toEqual(['Newtonsoft.Json']);
  });

  it('All includes CodeAnalysis when a capped version is newer than installed', () => {
    const items = collectUpdatableItems([
      pkg('Microsoft.CodeAnalysis.CSharp', '5.5.0', '5.9.0', '/p/App.csproj', undefined, versions),
    ], cap);
    expect(items).toEqual([
      expect.objectContaining({
        packageId: 'Microsoft.CodeAnalysis.CSharp',
        fromVersion: '5.5.0',
        toVersion: '5.6.0',
      }),
    ]);
  });

  it('omits CodeAnalysis from All and families when csc failed', () => {
    const installed = [
      pkg('Microsoft.CodeAnalysis.CSharp', '5.5.0', '5.9.0', '/p/App.csproj', undefined, versions),
      pkg('Microsoft.CodeAnalysis.Common', '5.5.0', '5.9.0', '/p/App.csproj', undefined, versions),
    ];
    expect(collectUpdatableItems(installed, null)).toEqual([]);
    expect(collectFamilyGroups(installed, null)).toEqual([]);
  });

  it('family suggested latest is the cap, not 5.9.0', () => {
    const groups = collectFamilyGroups([
      pkg('Microsoft.CodeAnalysis.CSharp', '5.5.0', '5.9.0', '/p/App.csproj', undefined, versions),
      pkg('Microsoft.CodeAnalysis.Common', '5.5.0', '5.9.0', '/p/App.csproj', undefined, versions),
    ], cap);
    expect(groups).toHaveLength(1);
    expect(groups[0].family).toBe('Microsoft.CodeAnalysis');
    expect(groups[0].updateCount).toBe(2);
    expect(groups[0].members.every((m) => m.latestVersion === '5.6.0')).toBe(true);
  });
});

describe('familyItemsAtVersion', () => {
  it('applies one target version and skips members already on it', () => {
    const items = familyItemsAtVersion(
      [
        { packageId: 'A', fromVersion: '8.0.0', projects: ['/a'] },
        { packageId: 'B', fromVersion: '8.0.0', projects: ['/b'] },
      ],
      '9.0.0',
    );
    expect(items.every((i) => i.toVersion === '9.0.0')).toBe(true);
    expect(familyItemsAtVersion(
      [{ packageId: 'A', fromVersion: '9.0.0', projects: ['/a'] }],
      '9.0.0',
    )).toEqual([]);
  });

  it('updates a dependency before the package that requires it', () => {
    const items = familyItemsAtVersion(
      [
        {
          packageId: 'Microsoft.Extensions.Http',
          fromVersion: '10.0.0',
          projects: ['/a'],
          dependencies: ['Microsoft.Extensions.Logging.Abstractions'],
        },
        {
          packageId: 'Microsoft.Extensions.Logging.Abstractions',
          fromVersion: '10.0.0',
          projects: ['/a'],
        },
      ],
      '10.0.11',
    );
    expect(items.map((i) => i.packageId)).toEqual([
      'Microsoft.Extensions.Logging.Abstractions',
      'Microsoft.Extensions.Http',
    ]);
  });
});

describe('intersectVersions', () => {
  it('keeps versions shared by every loaded list', () => {
    expect(intersectVersions([
      ['9.0.0', '8.0.0', '8.0.1'],
      ['9.0.0', '8.0.1'],
    ])).toEqual(['9.0.0', '8.0.1']);
  });
});

function familyMember(over: Partial<FamilyMember>): FamilyMember {
  return { packageId: 'Example.Extensions.Http', fromVersion: '8.0.11', projects: ['/p/App.csproj'], ...over };
}

describe('memberProjectTfms (#107)', () => {
  it('reads the member\'s own framework pin when it has one, ignoring the project map', () => {
    expect(memberProjectTfms(familyMember({ framework: 'net9.0' }), { '/p/App.csproj': ['net8.0'] }))
      .toEqual(['net9.0']);
  });

  it('unions every framework across the member\'s projects', () => {
    expect(memberProjectTfms(
      familyMember({ projects: ['/p/A.csproj', '/p/B.csproj'] }),
      { '/p/A.csproj': ['net8.0'], '/p/B.csproj': ['net9.0', 'net8.0'] },
    )).toEqual(['net8.0', 'net9.0']);
  });

  it('finds nothing for a project the map has no entry for', () => {
    expect(memberProjectTfms(familyMember({}), {})).toEqual([]);
  });
});

describe('compatibleMemberVersions (#107)', () => {
  const flags = (byVersion: Record<string, string | undefined>): Record<string, VersionFlag> =>
    Object.fromEntries(Object.entries(byVersion).map(([v, tfm]) =>
      [v, { declaredDependencies: tfm ? [{ targetFramework: tfm, dependencies: [] }] : undefined }]));

  it('drops a version the member\'s own project framework cannot use', () => {
    const member = familyMember({});
    const result = compatibleMemberVersions(
      member,
      ['10.0.12', '9.1.0', '8.0.11'],
      flags({ '10.0.12': 'net10.0', '9.1.0': 'net8.0', '8.0.11': 'net8.0' }),
      { '/p/App.csproj': ['net8.0'] },
    );
    expect(result).toEqual(['9.1.0', '8.0.11']);
  });

  it('leaves the list untouched when no flags are known (CLI-only path)', () => {
    const member = familyMember({});
    expect(compatibleMemberVersions(member, ['10.0.12', '8.0.11'], undefined, { '/p/App.csproj': ['net8.0'] }))
      .toEqual(['10.0.12', '8.0.11']);
  });

  it('leaves the list untouched when the project framework is unknown', () => {
    const member = familyMember({});
    expect(compatibleMemberVersions(
      member, ['10.0.12', '8.0.11'], flags({ '10.0.12': 'net10.0' }), {},
    )).toEqual(['10.0.12', '8.0.11']);
  });
});

describe('familyHasBlockedMember (#107)', () => {
  const flags = (byVersion: Record<string, string | undefined>): Record<string, VersionFlag> =>
    Object.fromEntries(Object.entries(byVersion).map(([v, tfm]) =>
      [v, { declaredDependencies: tfm ? [{ targetFramework: tfm, dependencies: [] }] : undefined }]));

  it('flags a family where one member\'s project can use none of its own versions at all', () => {
    // Example.Extensions.Http: member A on a net10.0 project. Member B is on
    // a net8.0 project, and every version its own package ever released
    // declares net10.0 only — the #107 repro, but for a sibling package in
    // the same family rather than the one the family itself is anchored on.
    const a = familyMember({ packageId: 'Example.Extensions.Http', projects: ['/p/A.csproj'] });
    const b = familyMember({ packageId: 'Example.Extensions.Json', projects: ['/p/B.csproj'] });
    const versionsByPackageId = {
      'example.extensions.http': ['9.1.0', '8.0.11'],
      'example.extensions.json': ['10.0.12', '10.0.0'],
    };
    const flagsByPackageId = {
      'example.extensions.http': flags({ '9.1.0': 'net8.0', '8.0.11': 'net8.0' }),
      'example.extensions.json': flags({ '10.0.12': 'net10.0', '10.0.0': 'net10.0' }),
    };
    const projectFrameworks = { '/p/A.csproj': ['net10.0'], '/p/B.csproj': ['net8.0'] };

    expect(familyHasBlockedMember([a, b], versionsByPackageId, flagsByPackageId, projectFrameworks)).toBe(true);
  });

  it('does not flag a member whose versions simply have not loaded yet', () => {
    const a = familyMember({ packageId: 'Example.Extensions.Http', projects: ['/p/A.csproj'] });
    const b = familyMember({ packageId: 'Example.Extensions.Json', projects: ['/p/B.csproj'] });
    const versionsByPackageId = { 'example.extensions.http': ['9.1.0', '8.0.11'] }; // B not loaded yet
    const flagsByPackageId = { 'example.extensions.http': flags({ '9.1.0': 'net8.0', '8.0.11': 'net8.0' }) };
    const projectFrameworks = { '/p/A.csproj': ['net10.0'], '/p/B.csproj': ['net8.0'] };

    expect(familyHasBlockedMember([a, b], versionsByPackageId, flagsByPackageId, projectFrameworks)).toBe(false);
  });

  it('does not flag a family where every member has at least one compatible version', () => {
    const a = familyMember({ packageId: 'Example.Extensions.Http', projects: ['/p/A.csproj'] });
    const b = familyMember({ packageId: 'Example.Extensions.Json', projects: ['/p/B.csproj'] });
    const versionsByPackageId = {
      'example.extensions.http': ['9.1.0', '8.0.11'],
      'example.extensions.json': ['9.0.0', '8.0.0'],
    };
    const flagsByPackageId = {
      'example.extensions.http': flags({ '9.1.0': 'net8.0', '8.0.11': 'net8.0' }),
      'example.extensions.json': flags({ '9.0.0': 'net8.0', '8.0.0': 'net8.0' }),
    };
    const projectFrameworks = { '/p/A.csproj': ['net8.0'], '/p/B.csproj': ['net8.0'] };

    expect(familyHasBlockedMember([a, b], versionsByPackageId, flagsByPackageId, projectFrameworks)).toBe(false);
  });

  it('flags one member referenced from two projects on different frameworks, when the target only covers the newer one', () => {
    // The exact report: Example.Extensions.Http referenced from a net9.0
    // project and a net10.0 project. Every version the feed declares a
    // framework for here only declares net10.0 — none of them can serve the
    // net9.0 project too, even though a plain per-tfm compatibility check
    // (net10.0 accepts net10.0) would say each version is "fine" on its own.
    const a = familyMember({ packageId: 'Example.Extensions.Http', projects: ['/p/Net9.csproj', '/p/Net10.csproj'] });
    const b = familyMember({ packageId: 'Example.Extensions.Json', projects: ['/p/Net9.csproj'] });
    const versionsByPackageId = {
      'example.extensions.http': ['10.0.12', '10.0.0'],
      'example.extensions.json': ['9.0.0', '8.0.0'],
    };
    const flagsByPackageId = {
      'example.extensions.http': flags({ '10.0.12': 'net10.0', '10.0.0': 'net10.0' }),
      'example.extensions.json': flags({ '9.0.0': 'net8.0', '8.0.0': 'net8.0' }),
    };
    const projectFrameworks = { '/p/Net9.csproj': ['net9.0'], '/p/Net10.csproj': ['net10.0'] };

    expect(familyHasBlockedMember([a, b], versionsByPackageId, flagsByPackageId, projectFrameworks)).toBe(true);
  });

  it('does not flag one member spanning two frameworks when a version covers both', () => {
    const a = familyMember({ packageId: 'Example.Extensions.Http', projects: ['/p/Net9.csproj', '/p/Net10.csproj'] });
    const versionsByPackageId = { 'example.extensions.http': ['10.0.12', '9.1.0', '8.0.11'] };
    const flagsByPackageId = {
      // 9.1.0 declares net8.0, which both net9.0 and net10.0 projects accept.
      'example.extensions.http': flags({ '10.0.12': 'net10.0', '9.1.0': 'net8.0', '8.0.11': 'net8.0' }),
    };
    const projectFrameworks = { '/p/Net9.csproj': ['net9.0'], '/p/Net10.csproj': ['net10.0'] };

    expect(familyHasBlockedMember([a], versionsByPackageId, flagsByPackageId, projectFrameworks)).toBe(false);
  });
});

describe('splitFamilyMembers (#107)', () => {
  it('groups members by the exact framework set their own projects declare', () => {
    const a = familyMember({ packageId: 'Example.Extensions.Http', projects: ['/p/A.csproj'] });
    const b = familyMember({ packageId: 'Example.Extensions.Json', projects: ['/p/B.csproj'] });
    const projectFrameworks = { '/p/A.csproj': ['net9.0'], '/p/B.csproj': ['net10.0'] };

    const groups = splitFamilyMembers([a, b], projectFrameworks);
    expect(groups).toEqual([
      { frameworks: ['net9.0'], members: [a] },
      { frameworks: ['net10.0'], members: [b] },
    ]);
  });

  it('keeps members with the same framework set in one group', () => {
    const a = familyMember({ packageId: 'Example.Extensions.Http', projects: ['/p/A.csproj'] });
    const b = familyMember({ packageId: 'Example.Extensions.Json', projects: ['/p/B.csproj'] });
    const projectFrameworks = { '/p/A.csproj': ['net8.0'], '/p/B.csproj': ['net8.0'] };

    expect(splitFamilyMembers([a, b], projectFrameworks)).toEqual([
      { frameworks: ['net8.0'], members: [a, b] },
    ]);
  });

  it('keys a member spanning several projects by all of their frameworks together, sorted', () => {
    const a = familyMember({ packageId: 'Example.Extensions.Http', projects: ['/p/Net10.csproj', '/p/Net9.csproj'] });
    const projectFrameworks = { '/p/Net9.csproj': ['net9.0'], '/p/Net10.csproj': ['net10.0'] };

    expect(splitFamilyMembers([a], projectFrameworks)).toEqual([
      { frameworks: ['net10.0', 'net9.0'], members: [a] },
    ]);
  });
});

describe('compatibleFamilyVersions (#107)', () => {
  const flags = (byVersion: Record<string, string | undefined>): Record<string, VersionFlag> =>
    Object.fromEntries(Object.entries(byVersion).map(([v, tfm]) =>
      [v, { declaredDependencies: tfm ? [{ targetFramework: tfm, dependencies: [] }] : undefined }]));

  it('intersects every member\'s own compatible list once all have answered', () => {
    const a = familyMember({ packageId: 'Example.Extensions.Http', projects: ['/p/A.csproj'] });
    const b = familyMember({ packageId: 'Example.Extensions.Json', projects: ['/p/B.csproj'] });
    const versionsByPackageId = {
      'example.extensions.http': ['9.1.0', '9.0.0'],
      'example.extensions.json': ['9.0.0', '8.0.0'],
    };
    const flagsByPackageId = {
      'example.extensions.http': flags({ '9.1.0': 'net8.0', '9.0.0': 'net8.0' }),
      'example.extensions.json': flags({ '9.0.0': 'net8.0', '8.0.0': 'net8.0' }),
    };
    const projectFrameworks = { '/p/A.csproj': ['net8.0'], '/p/B.csproj': ['net8.0'] };

    expect(compatibleFamilyVersions([a, b], versionsByPackageId, flagsByPackageId, projectFrameworks))
      .toEqual(['9.0.0']);
  });

  it('falls back to the union of what has loaded so far while a member is still pending (raw list empty because it hasn\'t answered yet)', () => {
    const a = familyMember({ packageId: 'Example.Extensions.Http', projects: ['/p/A.csproj'] });
    const b = familyMember({ packageId: 'Example.Extensions.Json', projects: ['/p/B.csproj'] });
    const versionsByPackageId = { 'example.extensions.http': ['9.1.0'] }; // b: no entry at all yet
    const flagsByPackageId = {};
    const projectFrameworks = { '/p/A.csproj': ['net8.0'], '/p/B.csproj': ['net8.0'] };

    expect(compatibleFamilyVersions([a, b], versionsByPackageId, flagsByPackageId, projectFrameworks))
      .toEqual(['9.1.0']);
  });

  it('reports nothing shared — not the union — when a member has answered with nothing compatible at all', () => {
    // The exact split-group repro: a family split by splitFamilyMembers can
    // land a blocked member together with others on the same framework
    // signature (net10.0 here). B's raw list is non-empty — it has
    // answered — but every version it ever released only ever declared
    // classic .NET Framework, which a net10.0 project cannot take at all.
    // Falling through to the union of C's own versions would propose
    // exactly the version B cannot take, the one outcome splitting the
    // family exists to prevent.
    const b = familyMember({ packageId: 'Example.Extensions.Json', projects: ['/p/Net10.csproj'] });
    const c = familyMember({ packageId: 'Example.Extensions.Http', projects: ['/p/Net10.csproj'] });
    const versionsByPackageId = {
      'example.extensions.json': ['9.0.0', '8.0.0'], // answered, but net472 is not net10.0-compatible
      'example.extensions.http': ['10.0.12', '10.0.0'],
    };
    const flagsByPackageId = {
      'example.extensions.json': flags({ '9.0.0': 'net472', '8.0.0': 'net472' }),
      'example.extensions.http': flags({ '10.0.12': 'net10.0', '10.0.0': 'net10.0' }),
    };
    const projectFrameworks = { '/p/Net10.csproj': ['net10.0'] };

    expect(compatibleFamilyVersions([b, c], versionsByPackageId, flagsByPackageId, projectFrameworks))
      .toEqual([]);
  });
});

describe('computeEntangledCluster', () => {
  function input(over: Partial<EntangledClusterInput>): EntangledClusterInput {
    return {
      currentVersions: new Map(),
      floors: new Map(),
      depsGraph: new Map(),
      batchPackageIds: new Set(),
      ...over,
    };
  }

  it('is empty with no floor violations (the common case)', () => {
    const cluster = computeEntangledCluster(input({
      currentVersions: new Map([['pkg.a', '1.0.0']]),
      floors: new Map([['pkg.a', '1.0.0']]),
      batchPackageIds: new Set(['pkg.a']),
    }));
    expect(cluster.size).toBe(0);
  });

  it('is empty for a lone floor violation with no batch-mate to land with', () => {
    // toVersion isn't modeled here — this is the pre-batch state; a lone
    // violator either resolves once its own bump lands, or doesn't, and no
    // clustering changes that.
    const cluster = computeEntangledCluster(input({
      currentVersions: new Map([['pkg.a', '1.0.0']]),
      floors: new Map([['pkg.a', '2.0.0']]),
      batchPackageIds: new Set(['pkg.a']),
    }));
    expect(cluster.size).toBe(0);
  });

  it('#38: unions two unrelated floor violations plus a graph neighbour into one cluster', () => {
    // Real shape from the issue #38 trace: OpenTelemetry.Extensions.Hosting and
    // Swashbuckle.AspNetCore.SwaggerGen each violate an independent
    // ProjectReference floor (different package families, no edge between
    // them) — both still need to land in the same no-restore pass. OpenTelemetry
    // itself isn't floor-violating, but Extensions.Hosting depends on it, and a
    // downgrade there (rolled back by an earlier, unrelated failure) blocks the
    // whole cluster from resolving too.
    const cluster = computeEntangledCluster({
      currentVersions: new Map([
        ['opentelemetry.extensions.hosting', '1.15.3'],
        ['opentelemetry', '1.15.3'],
        ['swashbuckle.aspnetcore.swaggergen', '10.1.7'],
        ['swashbuckle.aspnetcore.redoc', '10.1.7'],
      ]),
      floors: new Map([
        ['opentelemetry.extensions.hosting', '1.18.0'],
        ['swashbuckle.aspnetcore.swaggergen', '10.2.3'],
      ]),
      depsGraph: new Map([
        ['opentelemetry.extensions.hosting', ['OpenTelemetry']],
      ]),
      batchPackageIds: new Set([
        'opentelemetry.extensions.hosting',
        'opentelemetry',
        'swashbuckle.aspnetcore.swaggergen',
        'swashbuckle.aspnetcore.redoc',
      ]),
    });
    expect(cluster).toEqual(new Set([
      'opentelemetry.extensions.hosting',
      'opentelemetry',
      'swashbuckle.aspnetcore.swaggergen',
    ]));
    expect(cluster.has('swashbuckle.aspnetcore.redoc')).toBe(false);
  });

  it('does not expand to a graph neighbour outside this batch', () => {
    const cluster = computeEntangledCluster({
      currentVersions: new Map([['pkg.a', '1.0.0']]),
      floors: new Map([['pkg.a', '2.0.0']]),
      depsGraph: new Map([['pkg.a', ['Pkg.B']]]),
      batchPackageIds: new Set(['pkg.a']), // Pkg.B is not part of this batch
    });
    expect(cluster.size).toBe(0);
  });

  it('ignores a package with no current version (not actually referenced yet)', () => {
    const cluster = computeEntangledCluster(input({
      floors: new Map([['pkg.a', '2.0.0']]),
      batchPackageIds: new Set(['pkg.a']),
    }));
    expect(cluster.size).toBe(0);
  });
});

describe('formatBatchUpdateError', () => {
  it('returns null when nothing failed', () => {
    expect(formatBatchUpdateError([
      { packageId: 'A', status: 'ok' },
    ])).toBeNull();
  });

  it('ignores cancelled items so Stop is not treated as a failure banner', () => {
    expect(formatBatchUpdateError([
      { packageId: 'A', status: 'ok' },
      { packageId: 'B', status: 'cancelled', error: 'Stopped' },
      { packageId: 'C', status: 'cancelled' },
    ])).toBeNull();
  });

  it('puts the CLI dump after the title so the banner spoiler has a body', () => {
    const text = formatBatchUpdateError([
      { packageId: 'A', status: 'ok' },
      { packageId: 'B', status: 'error', error: 'App:\nerror NU1605: downgrade' },
    ]);
    expect(text).toBe(
      'Batch update of B failed\n\nB\nApp:\nerror NU1605: downgrade',
    );
  });

  it('summarises several failures and the keep-mode rollback hint', () => {
    const text = formatBatchUpdateError([
      { packageId: 'A', status: 'error', error: 'fail A' },
      { packageId: 'B', status: 'timeout' },
    ], true);
    expect(text).toContain('Batch update finished with 2 error(s).');
    expect(text).toContain('Use Rollback');
    expect(text).toContain('Operation timed out');
  });
});
