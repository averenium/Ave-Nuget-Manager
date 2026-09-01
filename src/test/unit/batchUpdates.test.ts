import type { InstalledPackage } from '../../types';
import {
  collectFamilyGroups,
  collectOtherItems,
  collectUpdatableItems,
  computeEntangledCluster,
  familyItemsAtVersion,
  formatBatchUpdateError,
  intersectVersions,
  preserveInstalledEnrichment,
  type EntangledClusterInput,
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
