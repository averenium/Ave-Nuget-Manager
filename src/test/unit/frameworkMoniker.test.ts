import { frameworkKey, frameworkLabel } from '../../frameworkMoniker';

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

  it('reads the form project.assets.json writes, where the version follows a comma', () => {
    // Losing the version here collapsed every .NETFramework target onto one
    // key, which would have called 4.6.1 and 4.8 the same framework.
    expect(frameworkKey('.NETFramework,Version=v4.7.2')).toBe('net472');
    expect(frameworkKey('.NETFramework,Version=v4.6.1')).toBe('net461');
    expect(frameworkKey('.NETCoreApp,Version=v8.0')).toBe('net8.0');
    expect(frameworkKey('.NETStandard,Version=v2.0')).toBe('netstandard2.0');
    expect(frameworkKey('.NETFramework,Version=v4.6.1'))
      .not.toBe(frameworkKey('.NETFramework,Version=v4.8'));
  });

  it('keeps a moniker it has no short form for distinct from every other', () => {
    // A guessed short form would claim two frameworks are one.
    expect(frameworkKey('.NETPortable0.0-Profile259')).toBe('.netportable0.0-profile259');
    expect(frameworkKey('.NETPortable0.0-Profile259'))
      .not.toBe(frameworkKey('.NETPortable0.0-Profile111'));
  });
});

describe('frameworkLabel', () => {
  it('shows the short form where there is one', () => {
    expect(frameworkLabel('.NETFramework,Version=v4.7.2')).toBe('net472');
    expect(frameworkLabel('.NETStandard2.0')).toBe('netstandard2.0');
  });

  it('leaves a moniker with no short form exactly as the feed wrote it', () => {
    // Half-converting it produces a spelling that exists nowhere, and these go
    // into badges the design says are spelled as the project file spells them.
    expect(frameworkLabel('.NETPortable0.0-Profile259')).toBe('.NETPortable0.0-Profile259');
  });

  it('says nothing about an empty moniker', () => {
    expect(frameworkLabel(undefined)).toBe('');
  });
});
