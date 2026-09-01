import {
  parseAssetsDependencies,
  parseAssetsFloors,
  reachableAmong,
  sortPackagesByDependencies,
  immediateListedDependencies,
  listedDependencyTree,
} from '../../packageGraph';

describe('parseAssetsDependencies', () => {
  it('reads package dependency ids from targets and skips project references', () => {
    const graph = parseAssetsDependencies({
      targets: {
        'net8.0': {
          'Microsoft.Extensions.Http/10.0.0': {
            type: 'package',
            dependencies: {
              'Microsoft.Extensions.Logging.Abstractions': '10.0.0',
              'Microsoft.Extensions.Configuration.Abstractions': '10.0.0',
            },
          },
          'AVE.ElectricityBot.TelegramScraper/1.0.0': {
            type: 'project',
            dependencies: { 'Microsoft.Extensions.Http': '10.0.0' },
          },
        },
        'net9.0': {
          'Microsoft.Extensions.Http/10.0.0': {
            type: 'package',
            dependencies: {
              'Microsoft.Extensions.Diagnostics': '10.0.0',
            },
          },
        },
      },
    });

    expect(graph.get('microsoft.extensions.http')?.sort()).toEqual([
      'Microsoft.Extensions.Configuration.Abstractions',
      'Microsoft.Extensions.Diagnostics',
      'Microsoft.Extensions.Logging.Abstractions',
    ]);
    expect(graph.has('ave.electricitybot.telegramscraper')).toBe(false);
  });
});

describe('parseAssetsFloors', () => {
  it('reads version floors from type:"project" entries (#38: sibling ProjectReference floor)', () => {
    const floors = parseAssetsFloors({
      targets: {
        'net10.0': {
          'DDAS.EcaAuthorization.OpenTelemetry/1.0.0': {
            type: 'project',
            dependencies: { 'OpenTelemetry.Extensions.Hosting': '1.18.0' },
          },
          'OpenTelemetry.Extensions.Hosting/1.15.3': {
            type: 'package',
            dependencies: { OpenTelemetry: '1.15.3' },
          },
        },
      },
    });
    expect(floors.get('opentelemetry.extensions.hosting')).toBe('1.18.0');
    expect(floors.has('opentelemetry')).toBe(false);
  });

  it('takes the highest floor across TFMs', () => {
    const floors = parseAssetsFloors({
      targets: {
        'net8.0': {
          'Ref/1.0.0': { type: 'project', dependencies: { 'Pkg.A': '1.0.0' } },
        },
        'net9.0': {
          'Ref/1.0.0': { type: 'project', dependencies: { 'Pkg.A': '2.0.0' } },
        },
      },
    });
    expect(floors.get('pkg.a')).toBe('2.0.0');
  });

  it('returns an empty map when there are no project references', () => {
    expect(parseAssetsFloors({ targets: { 'net8.0': {} } }).size).toBe(0);
    expect(parseAssetsFloors(null).size).toBe(0);
    expect(parseAssetsFloors({}).size).toBe(0);
  });
});

describe('sortPackagesByDependencies', () => {
  it('puts required packages before the package that depends on them', () => {
    const order = sortPackagesByDependencies(
      ['Microsoft.Extensions.Http', 'Microsoft.Extensions.Logging.Abstractions'],
      new Map([
        ['microsoft.extensions.http', ['Microsoft.Extensions.Logging.Abstractions']],
      ]),
    );
    expect(order).toEqual([
      'Microsoft.Extensions.Logging.Abstractions',
      'Microsoft.Extensions.Http',
    ]);
  });

  it('orders a chain Core → Relational → SqlServer', () => {
    const order = sortPackagesByDependencies(
      [
        'Microsoft.EntityFrameworkCore.SqlServer',
        'Microsoft.EntityFrameworkCore',
        'Microsoft.EntityFrameworkCore.Relational',
      ],
      new Map([
        ['microsoft.entityframeworkcore.sqlserver', ['Microsoft.EntityFrameworkCore.Relational']],
        ['microsoft.entityframeworkcore.relational', ['Microsoft.EntityFrameworkCore']],
      ]),
    );
    expect(order).toEqual([
      'Microsoft.EntityFrameworkCore',
      'Microsoft.EntityFrameworkCore.Relational',
      'Microsoft.EntityFrameworkCore.SqlServer',
    ]);
  });

  it('ignores dependencies that are not in the group and keeps a stable name order', () => {
    const order = sortPackagesByDependencies(
      ['Zed', 'Alpha'],
      new Map([['zed', ['NotInGroup']]]),
    );
    expect(order).toEqual(['Alpha', 'Zed']);
  });

  it('appends a cycle in name order after the acyclic prefix', () => {
    const order = sortPackagesByDependencies(
      ['A', 'B', 'Base'],
      new Map([
        ['a', ['B']],
        ['b', ['A']],
      ]),
    );
    expect(order[0]).toBe('Base');
    expect(order.slice(1).sort()).toEqual(['A', 'B']);
  });

  it('ranks by dependency depth so a shared dep does not bury sibling subtrees', () => {
    const order = sortPackagesByDependencies(
      [
        'Microsoft.EntityFrameworkCore.Cosmos',
        'Microsoft.EntityFrameworkCore',
        'Microsoft.Extensions.Http',
        'Microsoft.Extensions.Logging.Abstractions',
        'Microsoft.Extensions.Options.ConfigurationExtensions',
        'Microsoft.Extensions.Configuration.Binder',
      ],
      new Map([
        ['microsoft.entityframeworkcore', ['Microsoft.Extensions.Logging.Abstractions']],
        ['microsoft.entityframeworkcore.cosmos', ['Microsoft.EntityFrameworkCore']],
        ['microsoft.extensions.http', ['Microsoft.Extensions.Logging.Abstractions']],
        ['microsoft.extensions.options.configurationextensions', [
          'Microsoft.Extensions.Configuration.Binder',
        ]],
      ]),
    );
    expect(order).toEqual([
      'Microsoft.Extensions.Configuration.Binder',
      'Microsoft.Extensions.Logging.Abstractions',
      'Microsoft.EntityFrameworkCore',
      'Microsoft.Extensions.Http',
      'Microsoft.Extensions.Options.ConfigurationExtensions',
      'Microsoft.EntityFrameworkCore.Cosmos',
    ]);
  });
});

describe('reachableAmong', () => {
  it('walks through packages that are not in the set', () => {
    const graph = new Map<string, string[]>([
      ['microsoft.extensions.http', ['Microsoft.Extensions.Logging']],
      ['microsoft.extensions.logging', ['Microsoft.Extensions.Logging.Abstractions']],
    ]);
    const among = new Set([
      'microsoft.extensions.http',
      'microsoft.extensions.logging.abstractions',
    ]);
    expect(reachableAmong(graph, 'Microsoft.Extensions.Http', among)).toEqual([
      'Microsoft.Extensions.Logging.Abstractions',
    ]);
  });
});

describe('listedDependencyTree', () => {
  it('nests immediate listed children from the reachable stamp', () => {
    const depsById = new Map<string, string[]>([
      ['microsoft.extensions.http', [
        'Microsoft.Extensions.Logging',
        'Microsoft.Extensions.Logging.Abstractions',
      ]],
      ['microsoft.extensions.logging', ['Microsoft.Extensions.Logging.Abstractions']],
      ['microsoft.extensions.logging.abstractions', []],
    ]);
    expect(immediateListedDependencies('Microsoft.Extensions.Http', depsById)).toEqual([
      'Microsoft.Extensions.Logging',
    ]);
    expect(listedDependencyTree('Microsoft.Extensions.Http', depsById)).toEqual([
      {
        id: 'Microsoft.Extensions.Logging',
        children: [{ id: 'Microsoft.Extensions.Logging.Abstractions', children: [] }],
      },
    ]);
  });

  it('stops a cycle at the ancestor instead of looping', () => {
    const depsById = new Map<string, string[]>([
      ['a', ['B']],
      ['b', ['A']],
    ]);
    expect(listedDependencyTree('A', depsById)).toEqual([
      { id: 'B', children: [] },
    ]);
  });
});
