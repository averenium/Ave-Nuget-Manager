import {
  groupsTargetVersion,
  isCodeAnalysisPackage,
  isOverRoslynCap,
  maxVersionAtOrBelow,
  needsRoslynUpgradeConfirm,
  parseCscNumericVersion,
  parseDotnetVersion,
  parseListSdks,
  withoutOverRoslynCap,
} from '../../roslynSdkCap';
import { resolveSdkRoot } from '../../roslynSdkProbe';
import * as path from 'path';

const cap = { sdkVersion: '10.0.301', compilerVersion: '5.6.0' };

describe('isCodeAnalysisPackage', () => {
  it('matches Microsoft.CodeAnalysis and sub-ids', () => {
    expect(isCodeAnalysisPackage('Microsoft.CodeAnalysis.CSharp')).toBe(true);
    expect(isCodeAnalysisPackage('microsoft.codeanalysis')).toBe(true);
    expect(isCodeAnalysisPackage('Microsoft.Extensions.Logging')).toBe(false);
    expect(isCodeAnalysisPackage('Newtonsoft.Json')).toBe(false);
  });
});

describe('parseCscNumericVersion', () => {
  it('takes the numeric SemVer from csc -version', () => {
    expect(parseCscNumericVersion('5.6.0-2.26270.133 (N.N.N)\n')).toBe('5.6.0');
    expect(parseCscNumericVersion('Microsoft (R) Visual C# Compiler version 5.6.0-2.26270.133')).toBe('5.6.0');
  });
});

describe('parseListSdks / resolveSdkRoot', () => {
  it('parses list-sdks and joins directory + version', () => {
    const sdks = parseListSdks(
      '8.0.408 [C:\\Program Files\\dotnet\\sdk]\n10.0.301 [C:\\Program Files\\dotnet\\sdk]\n',
    );
    expect(sdks).toEqual([
      { version: '8.0.408', directory: 'C:\\Program Files\\dotnet\\sdk' },
      { version: '10.0.301', directory: 'C:\\Program Files\\dotnet\\sdk' },
    ]);
    expect(parseDotnetVersion('10.0.301\n')).toBe('10.0.301');
    expect(resolveSdkRoot('10.0.301', sdks)).toBe(
      path.join('C:\\Program Files\\dotnet\\sdk', '10.0.301'),
    );
    expect(resolveSdkRoot('9.0.100', sdks)).toBeUndefined();
  });
});

describe('maxVersionAtOrBelow', () => {
  it('picks the newest version that is not above the cap', () => {
    expect(maxVersionAtOrBelow(['5.9.0', '5.6.0', '5.5.0', '5.6.0-preview.1'], '5.6.0')).toBe('5.6.0');
    expect(maxVersionAtOrBelow(['5.9.0'], '5.6.0')).toBeUndefined();
  });
});

describe('groupsTargetVersion', () => {
  it('leaves non-CodeAnalysis latest unchanged', () => {
    expect(groupsTargetVersion('Newtonsoft.Json', '13.0.3', ['13.0.3'], cap)).toBe('13.0.3');
    expect(groupsTargetVersion('Newtonsoft.Json', '13.0.3', ['13.0.3'], null)).toBe('13.0.3');
  });

  it('caps CodeAnalysis to enrich versions at or below csc', () => {
    expect(groupsTargetVersion(
      'Microsoft.CodeAnalysis.CSharp',
      '5.9.0',
      ['5.9.0', '5.6.0', '5.5.0'],
      cap,
    )).toBe('5.6.0');
  });

  it('omits CodeAnalysis when csc failed or versions are missing', () => {
    expect(groupsTargetVersion('Microsoft.CodeAnalysis.CSharp', '5.9.0', ['5.9.0'], null)).toBeUndefined();
    expect(groupsTargetVersion('Microsoft.CodeAnalysis.CSharp', '5.9.0', [], cap)).toBeUndefined();
  });

  it('does not cap when the probe result is omitted', () => {
    expect(groupsTargetVersion('Microsoft.CodeAnalysis.CSharp', '5.9.0', ['5.9.0'], undefined)).toBe('5.9.0');
  });
});

describe('needsRoslynUpgradeConfirm', () => {
  it('is only for an installed upgrade above the compiler', () => {
    expect(needsRoslynUpgradeConfirm({
      packageId: 'Microsoft.CodeAnalysis.CSharp',
      chosenVersion: '5.9.0',
      installedVersions: ['5.6.0'],
      cap,
    })).toBe(true);
    expect(needsRoslynUpgradeConfirm({
      packageId: 'Microsoft.CodeAnalysis.CSharp',
      chosenVersion: '5.9.0',
      installedVersions: [],
      cap,
    })).toBe(false);
    expect(needsRoslynUpgradeConfirm({
      packageId: 'Microsoft.CodeAnalysis.CSharp',
      chosenVersion: '5.6.0',
      installedVersions: ['5.6.0'],
      cap,
    })).toBe(false);
    expect(needsRoslynUpgradeConfirm({
      packageId: 'Microsoft.CodeAnalysis.CSharp',
      chosenVersion: '5.5.0',
      installedVersions: ['5.6.0'],
      cap,
    })).toBe(false);
    expect(needsRoslynUpgradeConfirm({
      packageId: 'Newtonsoft.Json',
      chosenVersion: '13.0.3',
      installedVersions: ['13.0.1'],
      cap,
    })).toBe(false);
  });
});

describe('withoutOverRoslynCap', () => {
  it('drops CodeAnalysis targets above the cap, and all of them when csc failed', () => {
    const items = [
      { packageId: 'Newtonsoft.Json', toVersion: '13.0.3' },
      { packageId: 'Microsoft.CodeAnalysis.CSharp', toVersion: '5.9.0' },
      { packageId: 'Microsoft.CodeAnalysis.CSharp', toVersion: '5.6.0' },
    ];
    expect(withoutOverRoslynCap(items, cap).map((i) => i.toVersion)).toEqual(['13.0.3', '5.6.0']);
    expect(withoutOverRoslynCap(items, null).map((i) => i.packageId)).toEqual(['Newtonsoft.Json']);
    expect(isOverRoslynCap('Microsoft.CodeAnalysis.CSharp', '5.9.0', cap)).toBe(true);
  });
});
