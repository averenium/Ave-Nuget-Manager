import type { InstalledPackage } from '../../types';
import {
  collectFamilyGroups,
  collectOtherItems,
  collectUpdatableItems,
  familyItemsAtVersion,
  formatBatchUpdateError,
  intersectVersions,
  preserveInstalledEnrichment,
} from '../../batchUpdates';

function pkg(
  id: string,
  version: string,
  latest?: string,
  projectPath = '/p/App.csproj',
  dependencies?: string[],
): InstalledPackage {
  return {
    id,
    requestedVersion: version,
    resolvedVersion: version,
    projectPath,
    latestVersion: latest,
    dependencies,
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
