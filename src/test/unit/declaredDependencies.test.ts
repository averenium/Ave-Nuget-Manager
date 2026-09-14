import { selectCompatibleGroup } from '../../frameworkCompatibility';
import type { DeclaredDependencyGroup } from '../../types';

/**
 * The group-picking the declared-dependencies section runs on (#114), through
 * the same function the component calls: the component is a rendering of this
 * decision, and the repository has no React harness to render it through.
 */
const groupFor = (
  groups: DeclaredDependencyGroup[],
  target: string | undefined,
): DeclaredDependencyGroup | undefined => selectCompatibleGroup(groups, target);

const GROUPS: DeclaredDependencyGroup[] = [
  { targetFramework: '.NETStandard2.0', dependencies: [{ id: 'Example.Core', range: '[3.1.0, 4.0.0)' }] },
  { targetFramework: '.NETCoreApp10.0', dependencies: [{ id: 'System.Text.Json', range: '>= 8.0.4' }] },
];

describe('picking the declared dependency group', () => {
  it('matches the project framework across the two spellings', () => {
    // The project says `net10.0`; the catalog entry says `.NETCoreApp10.0`.
    expect(groupFor(GROUPS, 'net10.0')?.dependencies[0].id).toBe('System.Text.Json');
    expect(groupFor(GROUPS, 'netstandard2.0')?.dependencies[0].id).toBe('Example.Core');
  });

  it('finds no group for a framework nothing the feed named can serve', () => {
    // Which is the finding the section reports, carefully: a package can still
    // ship assets for a framework it declares no dependencies for. A .NET
    // Framework project cannot take either of these — netstandard2.0 needs
    // 4.6.1 and this is 4.5.
    expect(groupFor(GROUPS, 'net45')).toBeUndefined();
  });

  it('takes a compatible group rather than demanding the project own framework', () => {
    // The reported bug: both groups serve net10.0, and the section said the
    // feed declared nothing for it.
    expect(groupFor(GROUPS, 'net10.0')?.dependencies[0].id).toBe('System.Text.Json');
    expect(groupFor([GROUPS[0]], 'net10.0')?.dependencies[0].id).toBe('Example.Core');
    expect(groupFor(GROUPS, 'net472')?.dependencies[0].id).toBe('Example.Core');
  });

  it('falls back to the group that names no framework, which applies to all', () => {
    const withCatchAll = [...GROUPS, { dependencies: [{ id: 'Example.Shared' }] }];
    expect(groupFor(withCatchAll, 'net45')?.dependencies[0].id).toBe('Example.Shared');
    // The framework's own group still wins over it.
    expect(groupFor(withCatchAll, 'net10.0')?.dependencies[0].id).toBe('System.Text.Json');
  });

  it('distinguishes a group declared empty from no group at all', () => {
    // "needs nothing here" and "says nothing about here" are different facts,
    // so the empty group has to survive as a group.
    const withEmpty: DeclaredDependencyGroup[] = [{ targetFramework: 'net10.0', dependencies: [] }];
    expect(groupFor(withEmpty, 'net10.0')).toEqual({ targetFramework: 'net10.0', dependencies: [] });
    expect(groupFor(withEmpty, 'net472')).toBeUndefined();
  });
});
