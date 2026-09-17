import { declaredOptions, defaultGroupFor } from '../../webview/utils/declaredGroups';
import type { DeclaredDependencyGroup } from '../../types';

const GROUPS: DeclaredDependencyGroup[] = [
  { targetFramework: '.NETStandard2.0', dependencies: [{ id: 'Example.Core' }] },
  { targetFramework: '.NETCoreApp10.0', dependencies: [{ id: 'System.Text.Json' }] },
];

describe('defaultGroupFor', () => {
  it('takes the group restore would take when the project framework is known', () => {
    expect(defaultGroupFor(GROUPS, 'net10.0')?.dependencies[0].id).toBe('System.Text.Json');
  });

  /**
   * `projectFrameworks` is empty until `dotnet list` answers, and stays empty if
   * it failed — which is the state the panel exists to survive, since the list
   * fills from the feed whether or not restore works. The section used to render
   * "no group for undefined" there, over a note claiming there were no assets
   * for a framework it could not name.
   */
  it('opens on the newest declared group when there is no project framework to name', () => {
    expect(defaultGroupFor(GROUPS, undefined)?.dependencies[0].id).toBe('System.Text.Json');
    expect(defaultGroupFor(GROUPS, '')?.dependencies[0].id).toBe('System.Text.Json');
  });

  it('prefers the group that names no framework, which applies to all of them', () => {
    const withCatchAll = [...GROUPS, { dependencies: [{ id: 'Example.Shared' }] }];
    expect(defaultGroupFor(withCatchAll, undefined)?.dependencies[0].id).toBe('Example.Shared');
  });

  it('finds nothing only when a known framework can take nothing the feed declares', () => {
    // netstandard2.0 needs 4.6.1, and this is 4.5.
    expect(defaultGroupFor(GROUPS, 'net45')).toBeUndefined();
  });
});

describe('declaredOptions', () => {
  it('offers the declared frameworks newest first, spelled as a project file spells them', () => {
    expect(declaredOptions(GROUPS)).toEqual([
      { key: 'net10.0', label: 'net10.0' },
      { key: 'netstandard2.0', label: 'netstandard2.0' },
    ]);
  });

  it('offers the group that names no framework, which can be the default', () => {
    // A default nobody can choose again is a trap: moving off it is one-way.
    const withCatchAll = [...GROUPS, { dependencies: [{ id: 'Example.Shared' }] }];
    expect(declaredOptions(withCatchAll)).toContainEqual({ key: '', label: 'any framework' });
  });

  it('leaves a moniker with no short form exactly as the feed wrote it', () => {
    // These go into badges, which the design says are spelled the way the
    // project file spells them — and a half-converted moniker is spelled the way
    // nothing spells it.
    expect(declaredOptions([{ targetFramework: '.NETPortable0.0-Profile259', dependencies: [] }]))
      .toEqual([{ key: '.netportable0.0-profile259', label: '.NETPortable0.0-Profile259' }]);
  });

  it('lists one option per framework however many groups spell it', () => {
    expect(declaredOptions([
      { targetFramework: '.NETStandard2.0', dependencies: [] },
      { targetFramework: 'netstandard2.0', dependencies: [] },
    ])).toEqual([{ key: 'netstandard2.0', label: 'netstandard2.0' }]);
  });

  // A Nexus-hosted feed rewrites net8.0/net9.0/net10.0 into `.NETFramework`
  // monikers `frameworkKey`/`frameworkLabel` now repair (#123) — see
  // frameworkMoniker.test.ts for the rule itself.
  it('names the frameworks the package really declares, not the ones a feed mangled them into', () => {
    expect(declaredOptions([
      { targetFramework: '.NETFramework1.0.0', dependencies: [] },
      { targetFramework: '.NETFramework9.0', dependencies: [] },
      { targetFramework: '.NETFramework8.0', dependencies: [] },
    ])).toEqual([
      { key: 'net10.0', label: 'net10.0' },
      { key: 'net9.0', label: 'net9.0' },
      { key: 'net8.0', label: 'net8.0' },
    ]);
  });

  it('offers one entry, not two, when a feed mixes both spellings of the same framework', () => {
    expect(declaredOptions([
      { targetFramework: '.NETFramework9.0', dependencies: [] },
      { targetFramework: 'net9.0', dependencies: [] },
    ])).toEqual([{ key: 'net9.0', label: 'net9.0' }]);
  });
});
