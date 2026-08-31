import { planEffectiveAuditToggle } from '../../auditSourceToggle';
import type { NuGetConfigFile, PackageSource } from '../../types';

const NUGET = 'https://api.nuget.org/v3/index.json';
const CORP = 'https://corp.example/v3/index.json';
const USER = '/users/me/NuGet/NuGet.Config';
const REPO = '/ws/nuget.config';
const MACHINE = '/etc/opt/NuGet/Config/NuGet.Config';

function src(name: string, url: string, file: string): PackageSource {
  return { name, url, enabled: true, configFilePath: file };
}

function file(partial: Partial<NuGetConfigFile> & { filePath: string }): NuGetConfigFile {
  return { sources: [], auditSources: [], ...partial };
}

describe('planEffectiveAuditToggle', () => {
  it('disabling a machine-only audit feed writes clear to user config, not the repo file', () => {
    const chain = [
      file({ filePath: REPO, auditSources: [] }),
      file({ filePath: USER, auditSources: [] }),
      file({
        filePath: MACHINE,
        isMachineWide: true,
        auditSources: [src('nuget.org', NUGET, MACHINE)],
      }),
    ];
    expect(planEffectiveAuditToggle({
      chain,
      name: 'nuget.org',
      enabled: false,
      userConfigPath: USER,
    })).toEqual([
      { op: 'replace', filePath: USER, sources: [], clear: true },
    ]);
  });

  it('disabling a key in a repo file that already has clear only removes that add', () => {
    const chain = [
      file({
        filePath: REPO,
        auditSourcesCleared: true,
        auditSources: [
          src('nuget.org', NUGET, REPO),
          src('corp', CORP, REPO),
        ],
      }),
      file({ filePath: USER, auditSources: [src('old', NUGET, USER)] }),
    ];
    expect(planEffectiveAuditToggle({
      chain,
      name: 'nuget.org',
      enabled: false,
      userConfigPath: USER,
    })).toEqual([
      { op: 'remove', filePath: REPO, name: 'nuget.org' },
    ]);
  });

  it('disabling a repo add that does not clear still inherited machine feed flattens remaining onto user config', () => {
    const chain = [
      file({
        filePath: REPO,
        auditSources: [src('nuget.org', NUGET, REPO)],
      }),
      file({ filePath: USER, auditSources: [] }),
      file({
        filePath: MACHINE,
        isMachineWide: true,
        auditSources: [src('nuget.org', NUGET, MACHINE), src('corp', CORP, MACHINE)],
      }),
    ];
    expect(planEffectiveAuditToggle({
      chain,
      name: 'nuget.org',
      enabled: false,
      userConfigPath: USER,
    })).toEqual([
      { op: 'remove', filePath: REPO, name: 'nuget.org' },
      { op: 'replace', filePath: USER, sources: [{ name: 'corp', url: CORP }], clear: true },
    ]);
  });

  it('enabling a feed hidden by a nearer clear upserts that file only', () => {
    const chain = [
      file({
        filePath: REPO,
        auditSourcesCleared: true,
        auditSources: [src('corp', CORP, REPO)],
      }),
      file({
        filePath: USER,
        auditSources: [src('nuget.org', NUGET, USER)],
      }),
    ];
    expect(planEffectiveAuditToggle({
      chain,
      name: 'nuget.org',
      enabled: true,
      url: NUGET,
      userConfigPath: USER,
    })).toEqual([
      { op: 'upsert', filePath: REPO, name: 'nuget.org', url: NUGET },
    ]);
  });

  it('enabling an inherited machine feed with no repo audit section writes user config', () => {
    const chain = [
      file({ filePath: REPO, auditSources: [] }),
      file({ filePath: USER, auditSources: [] }),
      file({
        filePath: MACHINE,
        isMachineWide: true,
        auditSources: [src('nuget.org', NUGET, MACHINE)],
      }),
    ];
    expect(planEffectiveAuditToggle({
      chain,
      name: 'nuget.org',
      enabled: true,
      url: NUGET,
      userConfigPath: USER,
    })).toEqual([
      { op: 'upsert', filePath: USER, name: 'nuget.org', url: NUGET },
    ]);
  });
});
