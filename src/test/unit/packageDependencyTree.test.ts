import {
  packageSupportedFrameworks,
  resolvePackageDependencyTree,
  supportedFrameworksFromFiles,
} from '../../packageDependencyTree';

function assets(overrides: {
  targets: Record<string, Record<string, unknown>>;
  libraries?: Record<string, { files?: string[] }>;
}) {
  return overrides;
}

describe('resolvePackageDependencyTree', () => {
  it('builds direct dependency rows with declared range + resolved version and classifies them', () => {
    const json = assets({
      targets: {
        'net10.0': {
          'Microsoft.AspNetCore.OpenApi/10.0.11': {
            type: 'package',
            dependencies: { 'Microsoft.OpenApi': '[2.7.5, 3.0.0)', 'RabbitMQ.Client': '6.8.1', Dapper: '2.1.79' },
            compile: { 'lib/net10.0/Microsoft.AspNetCore.OpenApi.dll': {} },
          },
          'Microsoft.OpenApi/3.10.2': { type: 'package' },
          'RabbitMQ.Client/7.2.2': { type: 'package' },
          'Dapper/2.1.79': { type: 'package' },
        },
      },
    });

    const info = resolvePackageDependencyTree(json, 'Microsoft.AspNetCore.OpenApi', '10.0.11', 'net10.0');
    expect(info?.selectedAsset).toBe('net10.0');
    expect(info?.rows).toEqual([
      { id: 'Microsoft.OpenApi', resolvedVersion: '3.10.2', declaredRange: '[2.7.5, 3.0.0)', status: 'outside-range', showDeclared: true, children: [] },
      { id: 'RabbitMQ.Client', resolvedVersion: '7.2.2', declaredRange: '6.8.1', status: 'major-lifted', showDeclared: true, children: [] },
      { id: 'Dapper', resolvedVersion: '2.1.79', declaredRange: '2.1.79', status: 'ok', showDeclared: false, children: [] },
    ]);
  });

  it('nests a dependency\'s own dependencies (RabbitMQ.Client pulling in a transitive lib)', () => {
    const json = assets({
      targets: {
        'net10.0': {
          'EasyNetQ/7.8.0': {
            type: 'package',
            dependencies: { 'RabbitMQ.Client': '6.8.1' },
          },
          'RabbitMQ.Client/7.2.2': {
            type: 'package',
            dependencies: { 'Microsoft.Extensions.Logging.Abstractions': '8.0.0' },
          },
          'Microsoft.Extensions.Logging.Abstractions/10.0.11': { type: 'package' },
        },
      },
    });

    const info = resolvePackageDependencyTree(json, 'EasyNetQ', '7.8.0', 'net10.0');
    expect(info?.rows).toHaveLength(1);
    expect(info?.rows[0]).toMatchObject({ id: 'RabbitMQ.Client', status: 'major-lifted' });
    expect(info?.rows[0].children).toEqual([
      {
        id: 'Microsoft.Extensions.Logging.Abstractions',
        resolvedVersion: '10.0.11',
        declaredRange: '8.0.0',
        status: 'major-lifted',
        showDeclared: true,
        children: [],
      },
    ]);
  });

  it('stops at a cycle instead of recursing forever', () => {
    const json = assets({
      targets: {
        'net10.0': {
          'A/1.0.0': { type: 'package', dependencies: { B: '1.0.0' } },
          'B/1.0.0': { type: 'package', dependencies: { A: '1.0.0' } },
        },
      },
    });
    const info = resolvePackageDependencyTree(json, 'A', '1.0.0', 'net10.0');
    expect(info?.rows).toHaveLength(1);
    expect(info?.rows[0].id).toBe('B');
    // B's dependency back to A is the package the panel is already about, so it
    // is dropped rather than shown as a dependency of its own dependency.
    expect(info?.rows[0].children).toEqual([]);
  });

  it('lists a package shared by several parents once, at its shallowest position', () => {
    const json = assets({
      targets: {
        'net10.0': {
          'Microsoft.CodeAnalysis.CSharp.Workspaces/5.0.0': {
            type: 'package',
            dependencies: {
              'Microsoft.CodeAnalysis.CSharp': '5.0.0',
              'Microsoft.CodeAnalysis.Common': '5.0.0',
            },
          },
          'Microsoft.CodeAnalysis.CSharp/5.0.0': {
            type: 'package',
            dependencies: {
              'Microsoft.CodeAnalysis.Common': '5.0.0',
              'Microsoft.CodeAnalysis.Analyzers': '3.11.0',
            },
          },
          'Microsoft.CodeAnalysis.Common/5.0.0': {
            type: 'package',
            dependencies: { 'Microsoft.CodeAnalysis.Analyzers': '3.11.0' },
          },
          'Microsoft.CodeAnalysis.Analyzers/3.11.0': { type: 'package' },
        },
      },
    });

    const info = resolvePackageDependencyTree(
      json, 'Microsoft.CodeAnalysis.CSharp.Workspaces', '5.0.0', 'net10.0',
    );

    const ids: string[] = [];
    const walk = (rows: typeof info extends undefined ? never : NonNullable<typeof info>['rows']) => {
      for (const r of rows) {
        ids.push(r.id);
        walk(r.children);
      }
    };
    walk(info!.rows);

    expect(ids).toEqual([
      'Microsoft.CodeAnalysis.CSharp',
      'Microsoft.CodeAnalysis.Analyzers',
      'Microsoft.CodeAnalysis.Common',
    ]);
    // Analyzers is reached first through CSharp, so that is where it is listed;
    // Common is a direct dependency and keeps its top-level place even though
    // CSharp also depends on it.
    expect(info?.rows.map((r) => r.id)).toEqual([
      'Microsoft.CodeAnalysis.CSharp',
      'Microsoft.CodeAnalysis.Common',
    ]);
  });

  it('returns undefined for a missing framework or a package not resolved there', () => {
    const json = assets({ targets: { 'net10.0': { 'A/1.0.0': { type: 'package' } } } });
    expect(resolvePackageDependencyTree(json, 'A', '1.0.0', 'net8.0')).toBeUndefined();
    expect(resolvePackageDependencyTree(json, 'DoesNotExist', '1.0.0', 'net10.0')).toBeUndefined();
  });

  it('returns undefined when the caller\'s resolvedVersion is stale (guards against a version mismatch)', () => {
    const json = assets({ targets: { 'net10.0': { 'A/2.0.0': { type: 'package' } } } });
    expect(resolvePackageDependencyTree(json, 'A', '1.0.0', 'net10.0')).toBeUndefined();
  });

  it('marks a dependency with no resolved library entry (e.g. a project reference) without expanding it', () => {
    const json = assets({
      targets: {
        'net10.0': {
          'A/1.0.0': { type: 'package', dependencies: { 'Some.Project': '1.0.0' } },
        },
      },
    });
    const info = resolvePackageDependencyTree(json, 'A', '1.0.0', 'net10.0');
    expect(info?.rows).toEqual([
      { id: 'Some.Project', resolvedVersion: undefined, declaredRange: '1.0.0', status: 'ok', showDeclared: false, children: [] },
    ]);
  });
});

describe('supportedFrameworksFromFiles', () => {
  it('extracts the lib/<tfm>/ folder names deduped, newest first rather than in file order', () => {
    const files = [
      '.nupkg.metadata', 'dapper.nuspec',
      'lib/net461/Dapper.dll', 'lib/net461/Dapper.xml',
      'lib/net5.0/Dapper.dll',
      'lib/netstandard2.0/Dapper.dll',
    ];
    expect(supportedFrameworksFromFiles(files)).toEqual(['net5.0', 'netstandard2.0', 'net461']);
  });

  it('returns an empty array when there is nothing to find', () => {
    expect(supportedFrameworksFromFiles(undefined)).toEqual([]);
    expect(supportedFrameworksFromFiles([])).toEqual([]);
  });
});

describe('packageSupportedFrameworks', () => {
  it('reads the framework list from libraries[id/version].files, case-insensitively on id', () => {
    const json = assets({
      targets: {},
      libraries: { 'Dapper/2.0.123': { files: ['lib/net461/Dapper.dll', 'lib/net5.0/Dapper.dll'] } },
    });
    expect(packageSupportedFrameworks(json, 'dapper', '2.0.123')).toEqual(['net5.0', 'net461']);
  });

  it('returns an empty array when the library entry is missing', () => {
    const json = assets({ targets: {}, libraries: {} });
    expect(packageSupportedFrameworks(json, 'Dapper', '2.0.123')).toEqual([]);
  });
});
