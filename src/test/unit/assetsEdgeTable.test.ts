import { dependentsOf, findLibrary, findTarget, parseEdgeTable } from '../../assetsEdgeTable';
import { parseAssetsDependencies, parseAssetsFloors } from '../../packageGraph';
import { resolvePackageDependencyTree } from '../../packageDependencyTree';
import { classifyDependencyRow } from '../../packageVersionRanges';
import { compareSemVer } from '../../semver';
import type { DependencyRow } from '../../types';

/**
 * The three readers `project.assets.json` had before the edge table (#109),
 * copied as they were. The table replaced them, and "the derived shapes match
 * what the parsers return today" is only a claim while the old code is still
 * here to be compared with.
 */
interface LegacyLib { type?: string; dependencies?: Record<string, string>; compile?: Record<string, unknown>; runtime?: Record<string, unknown> }
const legacyIdOf = (k: string): string | null => { const s = k.lastIndexOf('/'); return s <= 0 ? null : k.slice(0, s); };
const legacyVersionOf = (k: string): string | undefined => { const s = k.lastIndexOf('/'); return s >= 0 ? k.slice(s + 1) : undefined; };

function legacyDependencies(json: unknown): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (!json || typeof json !== 'object') return result;
  const targets = (json as { targets?: Record<string, Record<string, unknown>> }).targets;
  if (!targets || typeof targets !== 'object') return result;
  for (const tfm of Object.values(targets)) {
    if (!tfm || typeof tfm !== 'object') continue;
    for (const [libKey, lib] of Object.entries(tfm)) {
      if (!lib || typeof lib !== 'object') continue;
      const rec = lib as LegacyLib;
      if (rec.type && rec.type !== 'package') continue;
      const id = legacyIdOf(libKey);
      if (!id) continue;
      const deps = Object.keys(rec.dependencies ?? {});
      if (deps.length === 0) continue;
      const key = id.toLowerCase();
      result.set(key, [...new Set([...(result.get(key) ?? []), ...deps])]);
    }
  }
  return result;
}

function legacyFloors(json: unknown): Map<string, string> {
  const result = new Map<string, string>();
  if (!json || typeof json !== 'object') return result;
  const targets = (json as { targets?: Record<string, Record<string, unknown>> }).targets;
  if (!targets || typeof targets !== 'object') return result;
  for (const tfm of Object.values(targets)) {
    if (!tfm || typeof tfm !== 'object') continue;
    for (const lib of Object.values(tfm)) {
      if (!lib || typeof lib !== 'object') continue;
      const rec = lib as LegacyLib;
      if (rec.type !== 'project') continue;
      for (const [depId, depVersion] of Object.entries(rec.dependencies ?? {})) {
        if (!depVersion) continue;
        const key = depId.toLowerCase();
        const existing = result.get(key);
        if (!existing || compareSemVer(depVersion, existing) > 0) result.set(key, depVersion);
      }
    }
  }
  return result;
}

type Target = Record<string, LegacyLib>;
const findKey = (t: Target, id: string) => Object.keys(t).find((k) => legacyIdOf(k)?.toLowerCase() === id.toLowerCase());
const selected = (lib: LegacyLib) => {
  const path = Object.keys(lib.compile ?? {})[0] ?? Object.keys(lib.runtime ?? {})[0];
  return path ? /^lib\/([^/]+)\//.exec(path)?.[1] : undefined;
};
function makeRow(t: Target, depId: string, range: string): { row: DependencyRow; lib?: LegacyLib } {
  const key = findKey(t, depId);
  const lib = key ? t[key] : undefined;
  const resolvedVersion = key ? legacyVersionOf(key) : undefined;
  if (!resolvedVersion) return { row: { id: depId, resolvedVersion, declaredRange: range, status: 'ok', showDeclared: false, children: [] } };
  const { status, showDeclared } = classifyDependencyRow(range, resolvedVersion);
  return { row: { id: depId, resolvedVersion, declaredRange: range, status, showDeclared, children: [] }, lib };
}
function legacyTree(json: unknown, packageId: string, resolvedVersion: string, framework: string) {
  const target = (json as { targets?: Record<string, Target> }).targets?.[framework];
  if (!target) return undefined;
  const key = findKey(target, packageId);
  if (!key) return undefined;
  if (legacyVersionOf(key) !== resolvedVersion) return undefined;
  const lib = target[key];
  const seen = new Set<string>([packageId.toLowerCase()]);
  const roots: DependencyRow[] = [];
  let frontier: Array<{ row: DependencyRow; lib?: LegacyLib }> = [];
  for (const [depId, range] of Object.entries(lib.dependencies ?? {})) {
    if (seen.has(depId.toLowerCase())) continue;
    seen.add(depId.toLowerCase());
    const p = makeRow(target, depId, range);
    roots.push(p.row);
    frontier.push(p);
  }
  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const { row, lib: l } of frontier) {
      for (const [childId, childRange] of Object.entries(l?.dependencies ?? {})) {
        if (seen.has(childId.toLowerCase())) continue;
        seen.add(childId.toLowerCase());
        const p = makeRow(target, childId, childRange);
        row.children.push(p.row);
        next.push(p);
      }
    }
    frontier = next;
  }
  return { framework, selectedAsset: selected(lib), rows: roots };
}

const legacy = { dependencies: legacyDependencies, floors: legacyFloors, tree: legacyTree };

/** A restore graph with everything the readers have to tell apart. */
const ASSETS = {
  version: 3,
  targets: {
    'net10.0': {
      'Example.Shop.Domain/1.0.0': { type: 'project', dependencies: { 'Example.Core': '2.0.0', 'example.messaging.transport': '7.0.0' } },
      'Example.Messaging.Bus/7.8.0': {
        type: 'package',
        dependencies: { 'Example.Messaging.Transport': '6.8.1', 'Example.Core': '[2.0.0, 3.0.0)' },
        compile: { 'lib/net8.0/Example.Messaging.Bus.dll': {} },
      },
      'Example.Messaging.Transport/7.2.2': {
        type: 'package',
        dependencies: { 'Example.Logging': '8.0.0' },
        runtime: { 'lib/netstandard2.0/Example.Messaging.Transport.dll': {} },
      },
      'Example.Core/3.1.0': { type: 'package', dependencies: { 'Example.Logging': '8.0.0' } },
      'Example.Logging/10.0.1': { type: 'package' },
      'Example.Analyzers/1.0.0': { dependencies: { 'Example.Core': '1.0.0' } },
      'Example.Empty/1.0.0': { type: '', dependencies: { 'Example.Logging': '1.0.0' } },
    },
    'net8.0': {
      'Example.Messaging.Bus/7.8.0': { type: 'package', dependencies: { 'Example.Messaging.Transport': '6.8.1' } },
      'Example.Messaging.Transport/6.8.1': { type: 'package', dependencies: { 'Example.Logging': '8.0.0', 'Example.Missing': '1.0.0' } },
      'Example.Logging/8.0.0': { type: 'package' },
      'Example.Shop.Domain/1.0.0': { type: 'project', dependencies: { 'Example.Core': '2.5.0' } },
    },
    'broken': null,
    'netstandard2.0': { 'no-version-slash': { type: 'package' }, '/1.0.0': { type: 'package' } },
  },
  libraries: {},
};

describe('the edge table (#109)', () => {
  it('reads each target framework apart, in the file\'s order', () => {
    const table = parseEdgeTable(ASSETS);
    expect(table.targets.map((t) => t.framework)).toEqual(['net10.0', 'net8.0', 'netstandard2.0']);
    const net8 = findTarget(table, 'net8.0')!;
    expect(findLibrary(net8, 'EXAMPLE.messaging.transport')).toMatchObject({
      id: 'Example.Messaging.Transport', version: '6.8.1', type: 'package',
      edges: [{ id: 'Example.Logging', range: '8.0.0' }, { id: 'Example.Missing', range: '1.0.0' }],
    });
  });

  it('survives input that is not an assets file', () => {
    expect(parseEdgeTable(null).targets).toEqual([]);
    expect(parseEdgeTable('x').targets).toEqual([]);
    expect(parseEdgeTable({ targets: 3 }).targets).toEqual([]);
  });

  it('derives the same id → dependencies map the old reader returned', () => {
    expect(parseAssetsDependencies(ASSETS)).toEqual(legacy.dependencies(ASSETS));
    expect([...parseAssetsDependencies(ASSETS).entries()]).toEqual([...legacy.dependencies(ASSETS).entries()]);
  });

  it('derives the same project floors the old reader returned', () => {
    expect(parseAssetsFloors(ASSETS)).toEqual(legacy.floors(ASSETS));
    expect(parseAssetsFloors(ASSETS).get('example.core')).toBe('2.5.0');
  });

  it('derives the same dependency tree the old reader returned, for every package under every framework', () => {
    let compared = 0;
    for (const target of parseEdgeTable(ASSETS).targets) {
      for (const lib of target.libraries) {
        const old = legacy.tree(ASSETS, lib.id, lib.version, target.framework);
        expect(resolvePackageDependencyTree(ASSETS, lib.id, lib.version, target.framework)).toEqual(old);
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThanOrEqual(10);
    // and the refusals: a framework with no target, a package it never restored, a stale version
    expect(resolvePackageDependencyTree(ASSETS, 'Example.Core', '3.1.0', 'net9.0')).toBeUndefined();
    expect(resolvePackageDependencyTree(ASSETS, 'Example.Nope', '1.0.0', 'net10.0')).toBeUndefined();
    expect(resolvePackageDependencyTree(ASSETS, 'Example.Core', '9.9.9', 'net10.0')).toBeUndefined();
  });
});

describe('the direct references (#109)', () => {
  const withGroups = {
    targets: { 'net10.0': { 'Example.Core/2.0.0': { type: 'package' } }, 'net8.0': { 'Example.Core/2.0.0': { type: 'package' } } },
    projectFileDependencyGroups: {
      'net10.0': ['Example.Core >= 2.0.0', 'example.Logging', 'Example.Pinned >= [1.0.0, 1.0.0]'],
      '.NETCoreApp,Version=v8.0': ['Example.Eight >= 1.0.0'],
    },
  };

  it('reads the packages a project references itself, per framework', () => {
    const table = parseEdgeTable(withGroups);
    expect([...findTarget(table, 'net10.0')!.directIds]).toEqual(['example.core', 'example.logging', 'example.pinned']);
  });

  it('matches a group written with the long moniker to its short framework', () => {
    expect([...findTarget(parseEdgeTable(withGroups), 'net8.0')!.directIds]).toEqual(['example.eight']);
  });

  it('is empty when the file carries no groups', () => {
    expect(findTarget(parseEdgeTable({ targets: { 'net10.0': {} } }), 'net10.0')!.directIds.size).toBe(0);
  });
});

describe('the reverse index (#109)', () => {
  const net10 = findTarget(parseEdgeTable(ASSETS), 'net10.0')!;

  it('lists who declares an edge to a package, with the range each declares', () => {
    expect(dependentsOf(net10, 'Example.Messaging.Transport').map((d) => [d.library.id, d.range])).toEqual([
      ['Example.Messaging.Bus', '6.8.1'],
    ]);
    expect(dependentsOf(net10, 'example.core').map((d) => [d.library.id, d.range])).toEqual([
      ['Example.Messaging.Bus', '[2.0.0, 3.0.0)'],
      ['Example.Analyzers', '1.0.0'],
    ]);
  });

  it('leaves project references out: they are not something a version can be proposed for', () => {
    expect(dependentsOf(net10, 'Example.Core').some((d) => d.library.id === 'Example.Shop.Domain')).toBe(false);
  });

  it('answers with nothing for a package nobody declares', () => {
    expect(dependentsOf(net10, 'Example.Shop.Domain')).toEqual([]);
  });
});
