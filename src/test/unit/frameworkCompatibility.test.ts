import {
  defaultGroupFor,
  frameworkAccepts,
  highestCompatibleVersion,
  isVersionCompatible,
  selectCompatibleGroup,
  unsatisfiedFrameworks,
} from '../../frameworkCompatibility';

describe('frameworkAccepts', () => {
  it('lets modern .NET take an older modern .NET, .NET Core and .NET Standard', () => {
    // The case that started this: a package declaring net8.0 and netstandard2.0
    // supports a net10.0 project perfectly well.
    expect(frameworkAccepts('net10.0', 'net8.0')).toBe(true);
    expect(frameworkAccepts('net10.0', 'netstandard2.0')).toBe(true);
    expect(frameworkAccepts('net10.0', 'netstandard2.1')).toBe(true);
    expect(frameworkAccepts('net10.0', 'netcoreapp3.1')).toBe(true);
  });

  it('reads the catalog spelling as readily as the short one', () => {
    expect(frameworkAccepts('net10.0', '.NETStandard2.0')).toBe(true);
    expect(frameworkAccepts('net10.0', '.NETCoreApp8.0')).toBe(true);
  });

  it('refuses a group newer than the project', () => {
    expect(frameworkAccepts('net8.0', 'net10.0')).toBe(false);
    expect(frameworkAccepts('netstandard2.0', 'netstandard2.1')).toBe(false);
  });

  it('refuses .NET Framework to a modern project and the reverse', () => {
    expect(frameworkAccepts('net10.0', 'net472')).toBe(false);
    expect(frameworkAccepts('net472', 'net8.0')).toBe(false);
  });

  it('gives .NET Framework .NET Standard 2.0, and only from 4.6.1', () => {
    expect(frameworkAccepts('net472', 'netstandard2.0')).toBe(true);
    expect(frameworkAccepts('net461', 'netstandard2.0')).toBe(true);
    expect(frameworkAccepts('net45', 'netstandard2.0')).toBe(false);
    expect(frameworkAccepts('net472', 'netstandard2.1')).toBe(false);
  });

  it('keeps a platform group to its own platform', () => {
    // A platform target is the plain framework plus extras, so the traffic only
    // runs one way.
    expect(frameworkAccepts('net10.0', 'net8.0-windows')).toBe(false);
    expect(frameworkAccepts('net10.0-windows', 'net8.0')).toBe(true);
    expect(frameworkAccepts('net10.0-windows', 'net8.0-windows')).toBe(true);
    expect(frameworkAccepts('net10.0-windows', 'net8.0-android')).toBe(false);
  });

  it('gives an unrecognised moniker nothing but itself', () => {
    // Conservative on purpose: an unusual package falls back to "the feed
    // declares groups for X only" rather than to a wrong pick.
    expect(frameworkAccepts('net10.0', 'portable-net45+win8')).toBe(false);
    expect(frameworkAccepts('portable-net45+win8', 'portable-net45+win8')).toBe(true);
  });
});

describe('selectCompatibleGroup', () => {
  const group = (targetFramework?: string) => ({ targetFramework });

  it('picks the nearest compatible group, which is the one restore would take', () => {
    expect(selectCompatibleGroup(
      [group('netstandard2.0'), group('net8.0')], 'net10.0',
    )).toEqual(group('net8.0'));
  });

  it('prefers the project own family over a newer portable one', () => {
    // netstandard2.1 is later than netstandard2.0 but says less about a modern
    // project than a net6.0 group does.
    expect(selectCompatibleGroup(
      [group('netstandard2.1'), group('net6.0')], 'net10.0',
    )).toEqual(group('net6.0'));
  });

  it('takes the highest compatible version within a family', () => {
    expect(selectCompatibleGroup(
      [group('net6.0'), group('net8.0'), group('net12.0')], 'net10.0',
    )).toEqual(group('net8.0'));
  });

  it('prefers the matching platform', () => {
    expect(selectCompatibleGroup(
      [group('net8.0'), group('net8.0-windows')], 'net10.0-windows',
    )).toEqual(group('net8.0-windows'));
  });

  it('falls back to the group that names no framework, but never before a named one', () => {
    expect(selectCompatibleGroup([group('net472'), group(undefined)], 'net10.0'))
      .toEqual(group(undefined));
    expect(selectCompatibleGroup([group('net8.0'), group(undefined)], 'net10.0'))
      .toEqual(group('net8.0'));
  });

  it('finds nothing when the feed declares nothing this project can use', () => {
    expect(selectCompatibleGroup([group('net472'), group('net48')], 'net10.0')).toBeUndefined();
  });
});

/**
 * The lab Nexus's own registration output (#123): three groups a package
 * really declares for net8.0/net9.0/net10.0, rewritten by the feed into
 * `.NETFramework` monikers `frameworkKey` now repairs. `NEXUS4` is the
 * commoner shape, with a `.NETStandard2.0` group alongside.
 */
describe('frameworkAccepts / selectCompatibleGroup / defaultGroupFor — Nexus-mangled monikers (#123)', () => {
  const group = (targetFramework?: string) => ({ targetFramework });
  const NEXUS3 = ['.NETFramework1.0.0', '.NETFramework9.0', '.NETFramework8.0'];
  const NEXUS4 = ['.NETFramework1.0.0', '.NETStandard2.0', '.NETFramework9.0', '.NETFramework8.0'];

  it('a net10.0 project takes the group written as .NET Framework 1.0.0', () => {
    expect(frameworkAccepts('net10.0', '.NETFramework1.0.0')).toBe(true);
  });

  it('and the older modern groups beside it', () => {
    expect(frameworkAccepts('net10.0', '.NETFramework9.0')).toBe(true);
    expect(frameworkAccepts('net10.0', '.NETFramework8.0')).toBe(true);
  });

  it('a .NET Framework project is no longer handed .NET 10\'s dependencies', () => {
    expect(selectCompatibleGroup(NEXUS3.map(group), 'net472')).toBeUndefined();
  });

  it('and with a netstandard group it gets that one', () => {
    expect(selectCompatibleGroup(NEXUS4.map(group), 'net472')).toEqual(group('.NETStandard2.0'));
  });

  it('the repair does not widen the wrong way', () => {
    expect(frameworkAccepts('net472', '.NETFramework9.0')).toBe(false);
  });

  it('nor cost .NET Framework the group it really had', () => {
    expect(frameworkAccepts('net472', '.NETStandard2.0')).toBe(true);
  });

  it('picks the group restore would pick, per project framework', () => {
    expect(selectCompatibleGroup(NEXUS3.map(group), 'net10.0')).toEqual(group('.NETFramework1.0.0'));
    expect(selectCompatibleGroup(NEXUS3.map(group), 'net9.0')).toEqual(group('.NETFramework9.0'));
    expect(selectCompatibleGroup(NEXUS3.map(group), 'net8.0')).toEqual(group('.NETFramework8.0'));
  });

  it('a real group is not shadowed by the fallback one', () => {
    expect(selectCompatibleGroup(NEXUS4.map(group), 'net10.0')).toEqual(group('.NETFramework1.0.0'));
  });

  it('with no project framework the newest is .NET 10', () => {
    expect(defaultGroupFor(NEXUS3.map(group), undefined)).toEqual(group('.NETFramework1.0.0'));
    expect(defaultGroupFor(NEXUS4.map(group), undefined)).toEqual(group('.NETFramework1.0.0'));
  });
});

describe('isVersionCompatible', () => {
  const group = (targetFramework?: string) => ({ targetFramework });

  it('rejects a version that only declares a newer framework (#107 repro)', () => {
    // Example.Extensions.OpenApi 10.0.12 ships lib/net10.0 only; a net8.0
    // project cannot use it, even though restore lets the write through.
    expect(isVersionCompatible([group('net10.0')], ['net8.0'])).toBe(false);
  });

  it('accepts a version whose group the project framework can take', () => {
    expect(isVersionCompatible([group('net8.0'), group('netstandard2.0')], ['net10.0'])).toBe(true);
  });

  it('accepts when no groups were stated at all — silence is not "no"', () => {
    expect(isVersionCompatible(undefined, ['net8.0'])).toBe(true);
    expect(isVersionCompatible([], ['net8.0'])).toBe(true);
  });

  it('accepts when the project frameworks are unknown — nothing to judge against', () => {
    expect(isVersionCompatible([group('net10.0')], [])).toBe(true);
  });

  it('accepts a catch-all group with no named framework', () => {
    expect(isVersionCompatible([group(undefined)], ['net8.0'])).toBe(true);
  });

  it('requires every one of several project frameworks to be satisfied, not just one', () => {
    // The same version installs into every one of these frameworks at once —
    // several TFMs of one multi-targeted project sharing an unconditional
    // reference, or several different projects a Groups family member spans.
    // A group that only net9.0 accepts leaves net8.0 without a compatible
    // asset, exactly as it would if net8.0 were asked about alone.
    expect(isVersionCompatible([group('net9.0')], ['net8.0', 'net9.0'])).toBe(false);
  });

  it('accepts several project frameworks at once when one group covers all of them', () => {
    // net9.0 can take a net8.0-declared group as readily as net8.0 itself can.
    expect(isVersionCompatible([group('net8.0')], ['net8.0', 'net9.0'])).toBe(true);
  });
});

describe('unsatisfiedFrameworks', () => {
  const group = (targetFramework?: string) => ({ targetFramework });

  it('names only the framework that actually fails, not every one asked about', () => {
    // A version that ships net10.0 only works fine for a net10.0 project —
    // naming it alongside net9.0 in "can't install for" would be wrong (#107).
    expect(unsatisfiedFrameworks([group('net10.0')], ['net9.0', 'net10.0'])).toEqual(['net9.0']);
  });

  it('names every framework that fails when more than one does', () => {
    expect(unsatisfiedFrameworks([group('net10.0')], ['net8.0', 'net9.0'])).toEqual(['net8.0', 'net9.0']);
  });

  it('reports nothing when every framework is satisfied', () => {
    expect(unsatisfiedFrameworks([group('net8.0')], ['net8.0', 'net9.0'])).toEqual([]);
  });

  it('reports nothing when the feed said nothing about frameworks at all', () => {
    expect(unsatisfiedFrameworks(undefined, ['net8.0'])).toEqual([]);
    expect(unsatisfiedFrameworks([], ['net8.0'])).toEqual([]);
  });
});

describe('highestCompatibleVersion', () => {
  const groupsByVersion = (byVersion: Record<string, string | undefined>) =>
    (v: string) => (byVersion[v] !== undefined ? [{ targetFramework: byVersion[v] }] : undefined);

  it('skips newer incompatible versions and picks the highest one that works (#107)', () => {
    const groups = groupsByVersion({
      '10.0.12': 'net10.0',
      '10.0.0': 'net10.0',
      '9.1.0': 'net8.0',
      '9.0.3': 'net8.0',
      '8.0.11': 'net8.0',
    });
    expect(highestCompatibleVersion(['10.0.12', '10.0.0', '9.1.0', '9.0.3', '8.0.11'], groups, ['net8.0']))
      .toBe('9.1.0');
  });

  it('returns undefined when nothing compatible is newer, rather than falling back to the raw latest', () => {
    const groups = groupsByVersion({ '10.0.12': 'net10.0', '8.0.11': 'net8.0' });
    expect(highestCompatibleVersion(['10.0.12', '8.0.11'], groups, ['net8.0'])).toBe('8.0.11');
    expect(highestCompatibleVersion(['10.0.12'], groups, ['net8.0'])).toBeUndefined();
  });
});
