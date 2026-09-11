import {
  frameworkPinsFor,
  narrowingSplitsReference,
  frameworkRowsFor,
  frameworkScopedPins,
  latestInLine,
  needsFrameworkRows,
  pinsCrossedBy,
  sameMajorLine,
  tfmBadgeWidth,
  pinGroupKey,
  pinsDiverge,
} from '../../frameworkPins';
import type { InstalledPackage } from '../../types';

/** The shape `dotnet list --format json` produces for the demo/multi-tfm fixture. */
const pkg = (
  id: string,
  projectPath: string,
  resolvedVersion: string,
  framework?: string,
): InstalledPackage => ({
  id,
  requestedVersion: resolvedVersion,
  resolvedVersion,
  projectPath,
  framework,
});

const CORE = 'D:/s/src/Example.MultiTarget.Core/Example.MultiTarget.Core.csproj';
const APP = 'D:/s/src/Example.MultiTarget.App/Example.MultiTarget.App.csproj';

/** The (package, project) key `frameworkScopedPins` reports pins under. */
const SEP = String.fromCharCode(0);
const pair = (id: string, projectPath: string) =>
  [id.toLowerCase(), projectPath.toLowerCase()].join(SEP);

describe('frameworkScopedPins', () => {
  it('finds the id one project pins to two different versions', () => {
    const pins = frameworkScopedPins([
      pkg('Microsoft.Extensions.Http', CORE, '9.0.0', 'net9.0'),
      pkg('Microsoft.Extensions.Http', CORE, '10.0.0', 'net10.0'),
    ]);
    expect([...pins]).toEqual([pair('Microsoft.Extensions.Http', CORE)]);
  });

  it('leaves an unconditional reference alone, however many frameworks list it', () => {
    // Newtonsoft.Json in the fixture: one PackageReference, reported once per TFM.
    expect(frameworkScopedPins([
      pkg('Newtonsoft.Json', CORE, '13.0.1', 'net9.0'),
      pkg('Newtonsoft.Json', CORE, '13.0.1', 'net10.0'),
    ]).size).toBe(0);
  });

  it('does not confuse two projects disagreeing with one project pinning per framework', () => {
    expect(frameworkScopedPins([
      pkg('Serilog', CORE, '3.1.0', 'net10.0'),
      pkg('Serilog', APP, '4.0.0', 'net10.0'),
    ]).size).toBe(0);
  });

  it('ignores entries that carry no framework', () => {
    expect(frameworkScopedPins([
      pkg('Serilog', CORE, '3.1.0'),
      pkg('Serilog', CORE, '4.0.0'),
    ]).size).toBe(0);
  });

  it('records each project that pins it, not the id once', () => {
    const pins = frameworkScopedPins([
      pkg('A', CORE, '9.0.0', 'net9.0'),
      pkg('A', CORE, '10.0.0', 'net10.0'),
      pkg('A', APP, '8.0.0', 'net8.0'),
      pkg('A', APP, '10.0.0', 'net10.0'),
    ]);
    expect(pins.size).toBe(2);
  });

  it('leaves a project alone when only its neighbour pins the id per framework', () => {
    // The regression this shape exists to prevent: B references the id
    // ordinarily, and A's conditional groups must not change what B is offered.
    const pins = frameworkScopedPins([
      pkg('A', CORE, '9.0.0', 'net9.0'),
      pkg('A', CORE, '10.0.0', 'net10.0'),
      pkg('A', APP, '9.0.0', 'net9.0'),
    ]);
    expect([...pins]).toEqual([pair('A', CORE)]);
  });
});

describe('pinGroupKey', () => {
  const scoped = new Set([pair('Microsoft.Extensions.Http', CORE)]);

  it('gives a framework-pinned id one bucket per framework', () => {
    expect(pinGroupKey(pkg('Microsoft.Extensions.Http', CORE, '9.0.0', 'net9.0'), scoped))
      .toBe('microsoft.extensions.http\u0000net9.0');
    expect(pinGroupKey(pkg('Microsoft.Extensions.Http', CORE, '10.0.0', 'net10.0'), scoped))
      .toBe('microsoft.extensions.http\u0000net10.0');
  });

  it('keeps every other id on the id alone, so nothing else regroups', () => {
    expect(pinGroupKey(pkg('Newtonsoft.Json', CORE, '13.0.1', 'net9.0'), scoped))
      .toBe('newtonsoft.json');
  });

  it('keeps another project on the id alone even for a pinned id', () => {
    expect(pinGroupKey(pkg('Microsoft.Extensions.Http', APP, '9.0.0', 'net9.0'), scoped))
      .toBe('microsoft.extensions.http');
  });

  it('falls back to the id when the entry has no framework', () => {
    expect(pinGroupKey(pkg('Microsoft.Extensions.Http', CORE, '9.0.0'), scoped))
      .toBe('microsoft.extensions.http');
  });
});

describe('frameworkPinsFor', () => {
  const installed = [
    pkg('Microsoft.Extensions.Http', CORE, '10.0.0', 'net10.0'),
    pkg('Microsoft.Extensions.Http', CORE, '9.0.0', 'net9.0'),
    pkg('Microsoft.Extensions.Http', APP, '10.0.0', 'net10.0'),
    pkg('Newtonsoft.Json', CORE, '13.0.1', 'net9.0'),
  ];

  it('returns one pin per framework of that project, newest first', () => {
    expect(frameworkPinsFor(installed, 'Microsoft.Extensions.Http', CORE)).toEqual([
      { framework: 'net10.0', resolvedVersion: '10.0.0', requestedVersion: '10.0.0' },
      { framework: 'net9.0', resolvedVersion: '9.0.0', requestedVersion: '9.0.0' },
    ]);
  });

  it('matches the id case-insensitively and the path the way the rest of the app does', () => {
    expect(frameworkPinsFor(installed, 'microsoft.extensions.http', CORE.toUpperCase()))
      .toHaveLength(2);
  });

  it('does not reach into another project', () => {
    expect(frameworkPinsFor(installed, 'Microsoft.Extensions.Http', APP)).toEqual([
      { framework: 'net10.0', resolvedVersion: '10.0.0', requestedVersion: '10.0.0' },
    ]);
  });
});

describe('pinsDiverge', () => {
  it('is true only when the versions actually differ', () => {
    expect(pinsDiverge([
      { framework: 'net9.0', resolvedVersion: '9.0.0' },
      { framework: 'net10.0', resolvedVersion: '10.0.0' },
    ])).toBe(true);
  });

  it('is false for two frameworks sharing one reference', () => {
    expect(pinsDiverge([
      { framework: 'net9.0', resolvedVersion: '13.0.1' },
      { framework: 'net10.0', resolvedVersion: '13.0.1' },
    ])).toBe(false);
  });

  it('is false for a single-target project', () => {
    expect(pinsDiverge([{ framework: 'net10.0', resolvedVersion: '10.0.0' }])).toBe(false);
  });
});

describe('latestInLine', () => {
  // The versions the fixture's packages actually have on nuget.org.
  const versions = ['10.0.12', '10.0.9', '10.0.0', '9.0.20', '9.0.10', '9.0.0', '8.0.3', '8.0.0'];

  it('keeps a net9.0 pin inside 9.x instead of jumping to 10.0.12', () => {
    expect(latestInLine('9.0.0', versions)).toBe('9.0.20');
  });

  it('advances a 10.x pin inside 10.x', () => {
    expect(latestInLine('10.0.0', versions)).toBe('10.0.12');
  });

  it('says nothing when the line has nothing newer', () => {
    expect(latestInLine('10.0.12', versions)).toBeUndefined();
    expect(latestInLine('8.0.3', versions)).toBeUndefined();
  });

  it('ignores a lower version inside the line', () => {
    expect(latestInLine('9.0.10', versions)).toBe('9.0.20');
  });

  it('compares numerically, so 9.0.9 does not outrank 9.0.20', () => {
    expect(latestInLine('9.0.0', ['9.0.9', '9.0.20'])).toBe('9.0.20');
  });

  it('gives up on a version with no numeric major', () => {
    expect(latestInLine('not-a-version', versions)).toBeUndefined();
  });
});

describe('frameworkRowsFor', () => {
  const installed = [
    pkg('Serilog', CORE, '3.1.0', 'net8.0'),
    pkg('Serilog', CORE, '4.0.0', 'net10.0'),
  ];

  it('lists a framework the package is missing from, so it can be added there', () => {
    // The reported case: pinned in net8.0 and net10.0 while the project also
    // targets net9.0, which had no row and therefore no way to be referenced.
    expect(frameworkRowsFor(installed, 'Serilog', CORE, ['net8.0', 'net9.0', 'net10.0'])).toEqual([
      { framework: 'net10.0', resolvedVersion: '4.0.0' },
      { framework: 'net9.0', resolvedVersion: undefined },
      { framework: 'net8.0', resolvedVersion: '3.1.0' },
    ]);
  });

  it('orders the rows newest first, as monikers rather than as text', () => {
    // Alphabetically this is net10.0, net48, net6.0, netstandard2.0 — every one
    // of them in the wrong place.
    expect(frameworkRowsFor(installed, 'Serilog', CORE,
      ['net48', 'netstandard2.0', 'net6.0', 'net10.0']).map((r) => r.framework))
      .toEqual(['net10.0', 'net6.0', 'netstandard2.0', 'net48']);
  });

  it('falls back to the frameworks the package itself is under when the project set is unknown', () => {
    expect(frameworkRowsFor(installed, 'Serilog', CORE, undefined).map((r) => r.framework))
      .toEqual(['net10.0', 'net8.0']);
  });

  it('says nothing for a project that does not have the package', () => {
    expect(frameworkRowsFor(installed, 'Serilog', APP, undefined)).toEqual([]);
  });
});

describe('needsFrameworkRows', () => {
  it('splits when the versions differ', () => {
    expect(needsFrameworkRows([
      { framework: 'net9.0', resolvedVersion: '9.0.0' },
      { framework: 'net10.0', resolvedVersion: '10.0.0' },
    ])).toBe(true);
  });

  it('splits when one framework has no reference and another does', () => {
    expect(needsFrameworkRows([
      { framework: 'net9.0', resolvedVersion: undefined },
      { framework: 'net10.0', resolvedVersion: '10.0.0' },
    ])).toBe(true);
  });

  it('keeps the single row when every framework agrees', () => {
    expect(needsFrameworkRows([
      { framework: 'net9.0', resolvedVersion: '13.0.1' },
      { framework: 'net10.0', resolvedVersion: '13.0.1' },
    ])).toBe(false);
  });

  it('keeps the single row for a single-target project', () => {
    expect(needsFrameworkRows([{ framework: 'net10.0', resolvedVersion: '10.0.0' }])).toBe(false);
  });
});

describe('sameMajorLine', () => {
  it('is true inside one line and false across it', () => {
    expect(sameMajorLine('9.0.0', '9.0.20')).toBe(true);
    expect(sameMajorLine('9.0.0', '10.0.12')).toBe(false);
  });

  it('treats a version with no numeric major as being in nobody line', () => {
    expect(sameMajorLine('preview', '1.0.0')).toBe(false);
  });
});

describe('pinsCrossedBy', () => {
  const installed = [
    pkg('Serilog', CORE, '3.1.0', 'net8.0'),
    pkg('Serilog', CORE, '4.4.0', 'net10.0'),
    pkg('Serilog', APP, '3.1.0', 'net8.0'),
  ];

  it('names the pinned framework a version would take out of its line', () => {
    expect(pinsCrossedBy(installed, 'Serilog', [CORE], '4.4.0'))
      .toEqual([{ framework: 'net8.0', version: '3.1.0' }]);
  });

  it('counts a downgrade out of a line too, not only a jump forward', () => {
    // 3.1.1 is fine for the net8.0 pin and leaves the net10.0 one behind.
    expect(pinsCrossedBy(installed, 'Serilog', [CORE], '3.1.1'))
      .toEqual([{ framework: 'net10.0', version: '4.4.0' }]);
  });

  it('says nothing when the version stays inside every line', () => {
    const oneLine = [
      pkg('Serilog', CORE, '3.1.0', 'net8.0'),
      pkg('Serilog', CORE, '3.0.0', 'net10.0'),
    ];
    expect(pinsCrossedBy(oneLine, 'Serilog', [CORE], '3.1.1')).toEqual([]);
  });

  it('ignores a project that does not pin per framework', () => {
    // APP holds one ordinary reference, so no line of its own to leave.
    expect(pinsCrossedBy(installed, 'Serilog', [APP], '4.4.0')).toEqual([]);
  });

  it('ignores a project that was not selected', () => {
    expect(pinsCrossedBy(installed, 'Serilog', [], '4.4.0')).toEqual([]);
  });
});

describe('tfmBadgeWidth', () => {
  it('puts every plain net TFM on one step, so they line up with each other', () => {
    const widths = ['net6.0', 'net8.0', 'net9.0', 'net10.0'].map(tfmBadgeWidth);
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBe('4.6em');
  });

  it('gives netstandard2.0 its own step instead of widening the short ones', () => {
    expect(tfmBadgeWidth('netstandard2.0')).toBe('7.6em');
    expect(tfmBadgeWidth('net10.0')).toBe('4.6em');
  });

  it('leaves a name too long for either step at its own width', () => {
    expect(tfmBadgeWidth('net8.0-windows10.0.19041.0')).toBeUndefined();
  });

  it('says nothing for an empty name', () => {
    expect(tfmBadgeWidth('')).toBeUndefined();
  });
});

describe('narrowingSplitsReference', () => {
  const TFMS = ['net9.0', 'net10.0'];

  it('says so when both frameworks report the same version', () => {
    // One unconditional PackageReference reads this way through dotnet list,
    // and narrowing it means rebuilding it into a group per framework.
    const installed = [
      pkg('Newtonsoft.Json', CORE, '13.0.1', 'net9.0'),
      pkg('Newtonsoft.Json', CORE, '13.0.1', 'net10.0'),
    ];
    expect(narrowingSplitsReference(installed, 'Newtonsoft.Json', CORE, TFMS)).toBe(true);
  });

  it('says nothing when the frameworks disagree', () => {
    // The conditional groups are already there; the write goes into one.
    const installed = [
      pkg('Microsoft.Extensions.Http', CORE, '9.0.0', 'net9.0'),
      pkg('Microsoft.Extensions.Http', CORE, '10.0.0', 'net10.0'),
    ];
    expect(narrowingSplitsReference(installed, 'Microsoft.Extensions.Http', CORE, TFMS)).toBe(false);
  });

  it('says nothing when one framework has no reference at all', () => {
    // A partial reference is a conditional one by construction.
    const installed = [pkg('Serilog', CORE, '4.4.0', 'net10.0')];
    expect(narrowingSplitsReference(installed, 'Serilog', CORE, TFMS)).toBe(false);
  });

  it('says nothing for a package the project does not have', () => {
    // Nothing to split: the install creates the conditional group itself.
    const installed = [pkg('Serilog', APP, '4.4.0', 'net10.0')];
    expect(narrowingSplitsReference(installed, 'Serilog', CORE, TFMS)).toBe(false);
  });

  it('reads the project from the pins when its frameworks are unknown', () => {
    const installed = [
      pkg('Newtonsoft.Json', CORE, '13.0.1', 'net9.0'),
      pkg('Newtonsoft.Json', CORE, '13.0.1', 'net10.0'),
    ];
    expect(narrowingSplitsReference(installed, 'Newtonsoft.Json', CORE, undefined)).toBe(true);
  });

  it('keeps one project out of the answer for another', () => {
    const installed = [
      pkg('Newtonsoft.Json', CORE, '13.0.1', 'net9.0'),
      pkg('Newtonsoft.Json', CORE, '13.0.1', 'net10.0'),
      pkg('Newtonsoft.Json', APP, '13.0.1', 'net10.0'),
      pkg('Newtonsoft.Json', APP, '12.0.3', 'net9.0'),
    ];
    expect(narrowingSplitsReference(installed, 'Newtonsoft.Json', APP, TFMS)).toBe(false);
  });
});
