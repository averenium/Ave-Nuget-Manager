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

/**
 * Measured on the project's own lab Nexus (Sonatype Nexus 3.76.0): its
 * generated registration rewrites every modern moniker into the
 * `.NETFramework` family before it ever reaches the catalog reader —
 * `net9.0` arrives as `.NETFramework9.0`, and `net10.0` as
 * `.NETFramework1.0.0` because Nexus reads `net10` as the packed .NET
 * Framework 1.0 and keeps the trailing `.0` (#123).
 */
describe('frameworkKey — repairing a dotless modern moniker (#123)', () => {
  it('reads a modern framework a feed wrote as .NET Framework', () => {
    expect(frameworkKey('.NETFramework9.0')).toBe('net9.0');
    expect(frameworkKey('.NETFramework8.0')).toBe('net8.0');
  });

  it('reads .NET 10, which that feed writes as .NET Framework 1.0.0', () => {
    expect(frameworkKey('.NETFramework1.0.0')).toBe('net10.0');
  });

  it('reads the dotless short form too, whatever wrote it', () => {
    expect(frameworkKey('net90')).toBe('net9.0');
    expect(frameworkKey('net100')).toBe('net10.0');
    expect(frameworkKey('net50')).toBe('net5.0');
  });

  it('keeps the platform on a repaired moniker', () => {
    expect(frameworkKey('net90-windows')).toBe('net9.0-windows');
    expect(frameworkKey('.NETFramework9.0-windows')).toBe('net9.0-windows');
  });

  it('leaves every .NET Framework version that shipped where it is', () => {
    expect(frameworkKey('.NETFramework1.0')).toBe('net10');
    expect(frameworkKey('.NETFramework1.1')).toBe('net11');
    expect(frameworkKey('.NETFramework3.5')).toBe('net35');
    expect(frameworkKey('.NETFramework4.0.3')).toBe('net403');
    expect(frameworkKey('.NETFramework4.7.2')).toBe('net472');
    expect(frameworkKey('.NETFramework4.8.1')).toBe('net481');
  });

  it('keeps a profile on a real .NET Framework moniker', () => {
    expect(frameworkKey('.NETFramework4.0,Profile=Client')).toBe('net40-client');
  });

  it('leaves the other families alone', () => {
    expect(frameworkKey('.NETStandard2.0')).toBe('netstandard2.0');
    expect(frameworkKey('.NETCoreApp3.1')).toBe('netcoreapp3.1');
    expect(frameworkKey('.NETPortable0.0-Profile259')).toBe('.netportable0.0-profile259');
  });

  it('does not collapse two repaired monikers onto one key', () => {
    expect(frameworkKey('.NETFramework9.0')).not.toBe(frameworkKey('.NETFramework8.0'));
  });
});

describe('frameworkLabel — repairing a dotless modern moniker (#123)', () => {
  it('shows the repaired spelling, not one that exists nowhere', () => {
    expect(frameworkLabel('.NETFramework9.0')).toBe('net9.0');
    expect(frameworkLabel('.NETFramework1.0.0')).toBe('net10.0');
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
