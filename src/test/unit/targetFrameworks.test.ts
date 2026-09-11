import {
  compareTargetFrameworks,
  parseTargetFramework,
  sortTargetFrameworksDesc,
} from '../../targetFrameworks';

describe('parseTargetFramework', () => {
  it('separates .NET 8 from .NET Framework 4.8, which text sorting cannot', () => {
    expect(parseTargetFramework('net8.0')).toMatchObject({ family: 0, version: [8, 0] });
    expect(parseTargetFramework('net48')).toMatchObject({ family: 3, version: [4, 8] });
  });

  it('unpacks .NET Framework digits one component each', () => {
    expect(parseTargetFramework('net472').version).toEqual([4, 7, 2]);
    expect(parseTargetFramework('net481').version).toEqual([4, 8, 1]);
    expect(parseTargetFramework('net20').version).toEqual([2, 0]);
  });

  it('splits the platform off a platform-specific moniker', () => {
    expect(parseTargetFramework('net9.0-windows10.0.19041')).toMatchObject({
      family: 0, version: [9, 0], platform: 'windows10.0.19041',
    });
    expect(parseTargetFramework('net40-client')).toMatchObject({ family: 3, platform: 'client' });
  });

  it('treats a dotted moniker below net5.0 as .NET Framework, not modern .NET', () => {
    expect(parseTargetFramework('net4.5').family).toBe(3);
    expect(parseTargetFramework('net5.0').family).toBe(0);
  });

  it('files netstandard and netcoreapp into their own families', () => {
    // netstandard ranks above netcoreapp: it is still what a library ships to
    // reach everything, while netcoreapp ended at 3.1 and nothing targets it.
    expect(parseTargetFramework('netstandard2.1')).toMatchObject({ family: 1, version: [2, 1] });
    expect(parseTargetFramework('netcoreapp3.1')).toMatchObject({ family: 2, version: [3, 1] });
  });

  it('puts anything it does not recognise last, without inventing a version', () => {
    for (const tfm of ['uap10.0', 'portable-net45+win8', 'xamarinios10', 'netcore50', 'win8', 'tizen40']) {
      expect(parseTargetFramework(tfm)).toMatchObject({ family: 4, version: [] });
    }
  });

  it('is case-insensitive — real packages ship lib/Net35 and lib/MonoAndroid', () => {
    expect(parseTargetFramework('Net35')).toMatchObject({ family: 3, version: [3, 5] });
    expect(parseTargetFramework('MonoAndroid10').family).toBe(4);
  });
});

describe('compareTargetFrameworks', () => {
  it('orders by number, not by text (net11.0 is newer than net9.0)', () => {
    expect(compareTargetFrameworks('net11.0', 'net9.0')).toBeLessThan(0);
  });

  it('puts the plain moniker before the platform-specific one of the same version', () => {
    expect(compareTargetFrameworks('net8.0', 'net8.0-windows')).toBeLessThan(0);
  });
});

describe('sortTargetFrameworksDesc', () => {
  it('orders a real Newtonsoft.Json-shaped list newest first', () => {
    expect(sortTargetFrameworksDesc([
      'net20', 'netstandard1.3', 'net45', 'netstandard2.0', 'net40', 'net35',
    ])).toEqual([
      'netstandard2.0', 'netstandard1.3', 'net45', 'net40', 'net35', 'net20',
    ]);
  });

  it('orders across every family at once', () => {
    expect(sortTargetFrameworksDesc([
      'net462', 'netstandard2.0', 'net8.0', 'netcoreapp3.1', 'net10.0', 'uap10.0', 'net48',
    ])).toEqual([
      'net10.0', 'net8.0', 'netstandard2.0', 'netcoreapp3.1', 'net48', 'net462', 'uap10.0',
    ]);
  });

  it('keeps platform variants grouped under their own version', () => {
    expect(sortTargetFrameworksDesc([
      'net9.0-windows10.0.19041', 'net6.0', 'net9.0', 'net6.0-android31.0', 'net9.0-ios18.0',
    ])).toEqual([
      'net9.0', 'net9.0-ios18.0', 'net9.0-windows10.0.19041', 'net6.0', 'net6.0-android31.0',
    ]);
  });

  it('does not mutate its input', () => {
    const input = ['net45', 'net8.0'];
    sortTargetFrameworksDesc(input);
    expect(input).toEqual(['net45', 'net8.0']);
  });
});
