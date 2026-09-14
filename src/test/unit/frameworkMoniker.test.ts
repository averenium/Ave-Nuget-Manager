import { frameworkKey, sameFramework } from '../../frameworkMoniker';

/**
 * Every long form below is one the catalog actually states: older packages were
 * published with it and the registration entries still carry it, so a details
 * panel that compared the spellings as text would report "declares nothing for
 * net472" about a package whose whole dependency list is for net472.
 */
describe('frameworkKey', () => {
  it('shortens .NET Framework, which drops the dots', () => {
    expect(frameworkKey('.NETFramework4.7.2')).toBe('net472');
    expect(frameworkKey('.NETFramework4.5')).toBe('net45');
  });

  it('shortens .NET Standard, which keeps them', () => {
    expect(frameworkKey('.NETStandard2.0')).toBe('netstandard2.0');
  });

  it('keeps .NET Core under its own name and moves .NET 5 and later to net', () => {
    // The family name stayed `.NETCoreApp` after the rename; the version is the
    // only thing that says whether the short moniker is `netcoreapp` or `net`.
    expect(frameworkKey('.NETCoreApp3.1')).toBe('netcoreapp3.1');
    expect(frameworkKey('.NETCoreApp10.0')).toBe('net10.0');
    expect(frameworkKey('.NETCoreApp5.0')).toBe('net5.0');
  });

  it('leaves a moniker that is already short alone, but for its casing', () => {
    expect(frameworkKey('net10.0')).toBe('net10.0');
    expect(frameworkKey('NetStandard2.1')).toBe('netstandard2.1');
    expect(frameworkKey('net472')).toBe('net472');
  });

  it('keeps the platform, which is part of which framework this is', () => {
    expect(frameworkKey('.NETCoreApp8.0-windows10.0.19041')).toBe('net8.0-windows10.0.19041');
    expect(frameworkKey('net8.0-android')).toBe('net8.0-android');
    expect(frameworkKey('.NETFramework4.0,Profile=Client')).toBe('net40-client');
  });

  it('says nothing about an empty moniker, which is the group that applies to all', () => {
    expect(frameworkKey(undefined)).toBe('');
    expect(frameworkKey('  ')).toBe('');
  });
});

describe('sameFramework', () => {
  it('matches across the two spellings', () => {
    expect(sameFramework('net472', '.NETFramework4.7.2')).toBe(true);
    expect(sameFramework('netstandard2.0', '.NETStandard2.0')).toBe(true);
  });

  it('does not match different frameworks, however close they read', () => {
    expect(sameFramework('net10.0', 'net472')).toBe(false);
    expect(sameFramework('net8.0', 'net8.0-windows')).toBe(false);
    // Whether one satisfies the other is restore's question, not this one.
    expect(sameFramework('net10.0', 'netstandard2.0')).toBe(false);
  });

  it('never matches on an absent moniker', () => {
    expect(sameFramework(undefined, undefined)).toBe(false);
    expect(sameFramework('', 'net10.0')).toBe(false);
  });
});
