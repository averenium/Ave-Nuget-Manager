import { defaultGroupFor, frameworkAccepts, selectCompatibleGroup } from '../../frameworkCompatibility';

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
