import type { NuGetConfigFile, PackageSource } from '../../types';
import { buildSourcesSnapshot, feedKind, normalizeSourceUrl } from '../../sourcesSnapshot';

function src(
  name: string,
  url: string,
  file: string,
  enabled = true,
): PackageSource {
  return { name, url, enabled, configFilePath: file };
}

function file(partial: Partial<NuGetConfigFile> & { filePath: string }): NuGetConfigFile {
  return { sources: [], auditSources: [], ...partial };
}

const NUGET = 'https://api.nuget.org/v3/index.json';
const NEXUS = 'https://nexus.example/repository/nuget/index.json';

describe('feedKind / normalizeSourceUrl', () => {
  it('classifies nuget.org, data.nuget.org, HTTP and local', () => {
    expect(feedKind(NUGET)).toBe('nuget.org');
    expect(feedKind('https://data.nuget.org/v3/index.json')).toBe('data.nuget.org');
    expect(feedKind(NEXUS)).toBe('http');
    expect(feedKind('D:\\\\packages')).toBe('local');
  });

  it('normalizes trailing slash and host case', () => {
    expect(normalizeSourceUrl('https://API.NuGet.ORG/v3/index.json/')).toBe(
      'https://api.nuget.org/v3/index.json',
    );
  });

  it('expands %VAR% before normalizing', () => {
    const prev = process.env.HOST;
    process.env.HOST = 'api.nuget.org';
    try {
      expect(normalizeSourceUrl('https://%HOST%/v3/index.json/')).toBe(
        'https://api.nuget.org/v3/index.json',
      );
    } finally {
      if (prev === undefined) delete process.env.HOST;
      else process.env.HOST = prev;
    }
  });

  it('classifies data.nuget.org after expanding %VAR%', () => {
    const prev = process.env.HOST;
    process.env.HOST = 'data.nuget.org';
    try {
      expect(feedKind('https://%HOST%/v3/index.json')).toBe('data.nuget.org');
    } finally {
      if (prev === undefined) delete process.env.HOST;
      else process.env.HOST = prev;
    }
  });
});

describe('buildSourcesSnapshot', () => {
  const relativePath = (p: string) => p.replace(/^\/ws\//, '');
  const isGlobalPath = (p: string) => /\/NuGet\.Config$/i.test(p) && p.startsWith('/users/');

  it('lists effective sources with ON/OFF and credentials flag, no secrets', () => {
    const repo = file({
      filePath: '/ws/nuget.config',
      sources: [src('nuget.org', NUGET, '/ws/nuget.config'), src('nexus', NEXUS, '/ws/nuget.config', false)],
      credentialKeys: ['nexus'],
      disabledPackageSources: [{ name: 'nexus', disabled: true }],
    });
    const snap = buildSourcesSnapshot({
      scopeChain: [repo],
      projectChains: [{ projectName: 'App', chain: [repo] }],
      workspaceConfigs: [repo],
      relativePath,
      isGlobalPath,
      compareAuditToProjects: false,
    });
    expect(snap.effectivePackageSources.map((s) => ({
      name: s.name, enabled: s.enabled, kind: s.kind, hasCredentials: s.hasCredentials, hasApiKey: s.hasApiKey,
    }))).toEqual([
      { name: 'nuget.org', enabled: true, kind: 'nuget.org', hasCredentials: false, hasApiKey: false },
      { name: 'nexus', enabled: false, kind: 'http', hasCredentials: true, hasApiKey: false },
    ]);
    expect(JSON.stringify(snap)).not.toMatch(/password|hunter/i);
  });

  it('flags credentials from the global config on a workspace-declared source', () => {
    const repo = file({
      filePath: '/ws/nuget.config',
      sources: [src('nexus', NEXUS, '/ws/nuget.config')],
    });
    const global = file({
      filePath: '/users/me/NuGet/NuGet.Config',
      credentialKeys: ['nexus'],
      credentialUsernames: { nexus: 'ci' },
    });
    const snap = buildSourcesSnapshot({
      scopeChain: [repo, global],
      projectChains: [{ projectName: 'App', chain: [repo, global] }],
      workspaceConfigs: [repo],
      relativePath,
      isGlobalPath,
      compareAuditToProjects: false,
    });
    expect(snap.effectivePackageSources).toEqual([
      expect.objectContaining({
        name: 'nexus',
        hasCredentials: true,
        username: 'ci',
        configFilePath: '/ws/nuget.config',
      }),
    ]);
  });

  it('copies allowInsecureConnections and disableTLSCertificateValidation onto effective rows', () => {
    const repo = file({
      filePath: '/ws/nuget.config',
      sources: [{
        name: 'nexus-group',
        url: 'http://localhost:8081/index.json',
        enabled: true,
        configFilePath: '/ws/nuget.config',
        allowInsecureConnections: true,
        disableTlsCertificateValidation: true,
      }],
    });
    const snap = buildSourcesSnapshot({
      scopeChain: [repo],
      projectChains: [{ projectName: 'App', chain: [repo] }],
      workspaceConfigs: [repo],
      relativePath,
      isGlobalPath,
      compareAuditToProjects: false,
    });
    expect(snap.effectivePackageSources[0]).toEqual(expect.objectContaining({
      name: 'nexus-group',
      allowInsecureConnections: true,
      disableTlsCertificateValidation: true,
    }));
  });

  it('sets protocolVersion 2 on non-json HTTP feeds and 3 on index.json', () => {
    const repo = file({
      filePath: '/ws/nuget.config',
      sources: [
        src('nuget.org', NUGET, '/ws/nuget.config'),
        src('tfs', 'https://tfs.example/nuget', '/ws/nuget.config'),
        {
          name: 'forced-v2',
          url: NEXUS,
          enabled: true,
          configFilePath: '/ws/nuget.config',
          protocolVersion: '2',
        },
      ],
    });
    const snap = buildSourcesSnapshot({
      scopeChain: [repo],
      projectChains: [{ projectName: 'App', chain: [repo] }],
      workspaceConfigs: [repo],
      relativePath,
      isGlobalPath,
      compareAuditToProjects: false,
    });
    expect(snap.effectivePackageSources.find((s) => s.name === 'nuget.org')?.protocolVersion).toBe('3');
    expect(snap.effectivePackageSources.find((s) => s.name === 'tfs')?.protocolVersion).toBe('2');
    expect(snap.effectivePackageSources.find((s) => s.name === 'forced-v2')?.protocolVersion).toBe('2');
  });

  it('does not warn when repo and Global share nuget.org at the same URL', () => {
    const repo = file({
      filePath: '/ws/nuget.config',
      sources: [src('nuget.org', NUGET, '/ws/nuget.config')],
    });
    const global = file({
      filePath: '/users/me/NuGet/NuGet.Config',
      sources: [src('nuget.org', NUGET, '/users/me/NuGet/NuGet.Config')],
    });
    const snap = buildSourcesSnapshot({
      scopeChain: [repo, global],
      projectChains: [{ projectName: 'App', chain: [repo, global] }],
      workspaceConfigs: [repo],
      relativePath,
      isGlobalPath,
      compareAuditToProjects: false,
    });
    expect(snap.conflicts).toEqual([]);
    expect(snap.chain[1].packageChanges.some((c) => c.kind === 'overridden')).toBe(true);
    expect(snap.chain[1].isGlobal).toBe(true);
    expect(snap.chain[1].displayPath).toBe('NuGet.Config');
  });

  it('keeps nuget.config basename casing from filePath when relativePath differs', () => {
    const repo = file({
      filePath: '/ws/docker/nexus/sample/nuget.config',
      sources: [src('nexus', NEXUS, '/ws/docker/nexus/sample/nuget.config')],
    });
    const snap = buildSourcesSnapshot({
      scopeChain: [repo],
      projectChains: [{ projectName: 'App', chain: [repo] }],
      workspaceConfigs: [repo],
      relativePath: () => 'docker/nexus/sample/NuGet.Config',
      isGlobalPath,
      compareAuditToProjects: false,
    });
    expect(snap.chain[0].displayPath).toBe('docker/nexus/sample/nuget.config');
  });

  it('warns when the same key maps to different URLs', () => {
    const nested = file({
      filePath: '/ws/src/Foo/nuget.config',
      sources: [src('nuget.org', NEXUS, '/ws/src/Foo/nuget.config')],
    });
    const repo = file({
      filePath: '/ws/nuget.config',
      sources: [src('nuget.org', NUGET, '/ws/nuget.config')],
    });
    const snap = buildSourcesSnapshot({
      scopeChain: [repo],
      projectChains: [{ projectName: 'Foo', chain: [nested, repo] }],
      workspaceConfigs: [nested, repo],
      relativePath,
      isGlobalPath,
      compareAuditToProjects: true,
    });
    expect(snap.conflicts.some((c) => c.kind === 'same-key-different-url')).toBe(true);
    expect(snap.extraConfigs.find((e) => e.filePath === nested.filePath)?.role).toBe('applies');
    expect(snap.extraConfigs.find((e) => e.filePath === nested.filePath)?.packageSources).toEqual([
      expect.objectContaining({ name: 'nuget.org', url: NEXUS }),
    ]);
    expect(snap.conflicts.some((c) => c.kind === 'off-chain-applies')).toBe(true);
  });

  it('does not treat %FEED% and the expanded URL as different feeds', () => {
    const prev = process.env.FEED;
    process.env.FEED = NEXUS;
    try {
      const nested = file({
        filePath: '/ws/src/Foo/nuget.config',
        sources: [src('nexus', '%FEED%', '/ws/src/Foo/nuget.config')],
      });
      const repo = file({
        filePath: '/ws/nuget.config',
        sources: [src('nexus', NEXUS, '/ws/nuget.config')],
      });
      const snap = buildSourcesSnapshot({
        scopeChain: [repo],
        projectChains: [{ projectName: 'Foo', chain: [nested, repo] }],
        workspaceConfigs: [nested, repo],
        relativePath,
        isGlobalPath,
        compareAuditToProjects: false,
      });
      expect(snap.conflicts.some((c) => c.kind === 'same-key-different-url')).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.FEED;
      else process.env.FEED = prev;
    }
  });

  it('warns when the effective set has two keys for the same non-nuget.org URL', () => {
    const repo = file({
      filePath: '/ws/nuget.config',
      sources: [
        src('nexus', NEXUS, '/ws/nuget.config'),
        src('Nexus-group', NEXUS, '/ws/nuget.config'),
      ],
    });
    const snap = buildSourcesSnapshot({
      scopeChain: [repo],
      projectChains: [{ projectName: 'App', chain: [repo] }],
      workspaceConfigs: [repo],
      relativePath,
      isGlobalPath,
      compareAuditToProjects: false,
    });
    expect(snap.conflicts.some((c) => c.kind === 'same-url-different-keys')).toBe(true);
  });

  it('warns when nested <clear /> drops a non-nuget.org parent feed', () => {
    const nested = file({
      filePath: '/ws/src/Foo/nuget.config',
      sources: [src('nexus', NEXUS, '/ws/src/Foo/nuget.config')],
      packageSourcesCleared: true,
    });
    const repo = file({
      filePath: '/ws/nuget.config',
      sources: [src('contoso', 'https://pkgs.contoso.example/index.json', '/ws/nuget.config')],
    });
    const snap = buildSourcesSnapshot({
      scopeChain: [nested, repo],
      projectChains: [{ projectName: 'Foo', chain: [nested, repo] }],
      workspaceConfigs: [nested, repo],
      relativePath,
      isGlobalPath,
      compareAuditToProjects: false,
    });
    expect(snap.conflicts.some((c) => c.kind === 'clear-drops-parent')).toBe(true);
    expect(snap.effectivePackageSources.map((s) => s.name)).toEqual(['nexus']);
  });

  it('does not warn when <clear /> only drops nuget.org', () => {
    const nested = file({
      filePath: '/ws/src/Foo/nuget.config',
      sources: [src('nexus', NEXUS, '/ws/src/Foo/nuget.config')],
      packageSourcesCleared: true,
    });
    const global = file({
      filePath: '/users/me/NuGet/NuGet.Config',
      sources: [src('nuget.org', NUGET, '/users/me/NuGet/NuGet.Config')],
    });
    const snap = buildSourcesSnapshot({
      scopeChain: [nested, global],
      projectChains: [{ projectName: 'Foo', chain: [nested, global] }],
      workspaceConfigs: [nested],
      relativePath,
      isGlobalPath: (p) => p.includes('NuGet.Config'),
      compareAuditToProjects: false,
    });
    expect(snap.conflicts.some((c) => c.kind === 'clear-drops-parent')).toBe(false);
  });

  it('warns when a nested project clears audit sources the solution still sees', () => {
    const nested = file({
      filePath: '/ws/src/Foo/nuget.config',
      auditSources: [],
      auditSourcesCleared: true,
    });
    const repo = file({
      filePath: '/ws/nuget.config',
      sources: [src('nuget.org', NUGET, '/ws/nuget.config')],
      auditSources: [src('nuget.org', NUGET, '/ws/nuget.config')],
    });
    const snap = buildSourcesSnapshot({
      scopeChain: [repo],
      projectChains: [{ projectName: 'Foo', chain: [nested, repo] }],
      workspaceConfigs: [nested, repo],
      relativePath,
      isGlobalPath,
      compareAuditToProjects: true,
    });
    expect(snap.conflicts.some((c) => c.kind === 'audit-mismatch')).toBe(true);
  });

  it('keeps farther audit feeds visible as disabled after nearer <clear />', () => {
    const nearer = file({
      filePath: '/ws/nuget.config',
      sources: [src('nexus', NEXUS, '/ws/nuget.config')],
      auditSources: [],
      auditSourcesCleared: true,
    });
    const farther = file({
      filePath: '/users/me/NuGet/NuGet.Config',
      sources: [src('nuget.org', NUGET, '/users/me/NuGet/NuGet.Config')],
      auditSources: [src('nuget.org', NUGET, '/users/me/NuGet/NuGet.Config')],
    });
    const snap = buildSourcesSnapshot({
      scopeChain: [nearer, farther],
      projectChains: [{ projectName: 'App', chain: [nearer, farther] }],
      workspaceConfigs: [nearer],
      relativePath,
      isGlobalPath,
      compareAuditToProjects: false,
    });
    expect(snap.effectiveAuditSources).toEqual([
      expect.objectContaining({ name: 'nuget.org', enabled: false, url: NUGET }),
    ]);
    expect(snap.effectivePackageSources.find((s) => s.name === 'nuget.org')?.enabled).toBe(true);
  });

  it('does not emit audit none for files that never defined auditSources', () => {
    const repo = file({
      filePath: '/ws/nuget.config',
      sources: [src('nuget.org', NUGET, '/ws/nuget.config')],
    });
    const global = file({
      filePath: '/users/me/NuGet/NuGet.Config',
      sources: [src('nuget.org', NUGET, '/users/me/NuGet/NuGet.Config')],
    });
    const snap = buildSourcesSnapshot({
      scopeChain: [repo, global],
      projectChains: [{ projectName: 'App', chain: [repo, global] }],
      workspaceConfigs: [repo],
      relativePath,
      isGlobalPath,
      compareAuditToProjects: false,
    });
    expect(snap.chain.every((c) => c.auditChanges.length === 0)).toBe(true);
  });

  it('records replaced vs added vs overridden in the chain', () => {
    const nested = file({
      filePath: '/ws/src/Foo/nuget.config',
      sources: [src('nuget.org', NEXUS, '/ws/src/Foo/nuget.config')],
    });
    const repo = file({
      filePath: '/ws/nuget.config',
      sources: [
        src('nuget.org', NUGET, '/ws/nuget.config'),
        src('local', 'D:\\pkgs', '/ws/nuget.config'),
      ],
    });
    const snap = buildSourcesSnapshot({
      scopeChain: [nested, repo],
      projectChains: [{ projectName: 'Foo', chain: [nested, repo] }],
      workspaceConfigs: [nested, repo],
      relativePath,
      isGlobalPath,
      compareAuditToProjects: false,
    });
    expect(snap.chain[0].packageChanges).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'replaced', name: 'nuget.org' })]),
    );
    expect(snap.chain[1].packageChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'overridden', name: 'nuget.org' }),
        expect.objectContaining({ kind: 'added', name: 'local' }),
      ]),
    );
  });

  it('marks unused workspace nuget.config as dead', () => {
    const repo = file({
      filePath: '/ws/nuget.config',
      sources: [src('nuget.org', NUGET, '/ws/nuget.config')],
    });
    const sample = file({
      filePath: '/ws/docs/sample/nuget.config',
      sources: [src('orphan', NEXUS, '/ws/docs/sample/nuget.config')],
    });
    const snap = buildSourcesSnapshot({
      scopeChain: [repo],
      projectChains: [{ projectName: 'App', chain: [repo] }],
      workspaceConfigs: [repo, sample],
      relativePath,
      isGlobalPath,
      compareAuditToProjects: false,
    });
    expect(snap.extraConfigs.find((e) => e.filePath === sample.filePath)?.role).toBe('dead');
    expect(snap.conflicts.some((c) => c.kind === 'off-chain-applies')).toBe(false);
  });

  it('applies a nearer disable onto a parent-declared source', () => {
    const repo = file({
      filePath: '/ws/nuget.config',
      sources: [],
      disabledPackageSources: [{ name: 'nuget.org', disabled: true }],
    });
    const global = file({
      filePath: '/users/me/NuGet/NuGet.Config',
      sources: [src('nuget.org', NUGET, '/users/me/NuGet/NuGet.Config')],
    });
    const snap = buildSourcesSnapshot({
      scopeChain: [repo, global],
      projectChains: [{ projectName: 'App', chain: [repo, global] }],
      workspaceConfigs: [repo],
      relativePath,
      isGlobalPath,
      compareAuditToProjects: false,
    });
    expect(snap.effectivePackageSources).toEqual([
      expect.objectContaining({ name: 'nuget.org', enabled: false }),
    ]);
    expect(snap.chain[0].packageChanges).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'disabled', name: 'nuget.org' })]),
    );
  });

  it('attaches mapping patterns and marks unmapped sources when mapping is on', () => {
    const repo = file({
      filePath: '/ws/nuget.config',
      sources: [
        src('nuget.org', NUGET, '/ws/nuget.config'),
        src('nexus', NEXUS, '/ws/nuget.config'),
      ],
      packageSourceMapping: [{ sourceName: 'nuget.org', patterns: ['*', 'Microsoft.*'] }],
    });
    const snap = buildSourcesSnapshot({
      scopeChain: [repo],
      projectChains: [{ projectName: 'App', chain: [repo] }],
      workspaceConfigs: [repo],
      relativePath,
      isGlobalPath,
      compareAuditToProjects: false,
    });
    expect(snap.packageSourceMapping).toEqual([
      { sourceName: 'nuget.org', patterns: ['*', 'Microsoft.*'] },
    ]);
    expect(snap.effectivePackageSources.find((s) => s.name === 'nuget.org')?.mappingPatterns).toEqual(['*', 'Microsoft.*']);
    expect(snap.effectivePackageSources.find((s) => s.name === 'nexus')?.mappingPatterns).toEqual([]);
  });

  it('labels machine-wide files and expands %VAR% on effective URLs', () => {
    const prev = process.env.FEED_HOST;
    process.env.FEED_HOST = 'nexus.example';
    try {
      const machine = file({
        filePath: '/Program Files (x86)/NuGet/Config/Microsoft.VisualStudio.Offline.config',
        isMachineWide: true,
        sources: [src('Offline', 'C:\\offline', '/Program Files (x86)/NuGet/Config/Microsoft.VisualStudio.Offline.config')],
      });
      const repo = file({
        filePath: '/ws/nuget.config',
        sources: [src('nexus', 'https://%FEED_HOST%/index.json', '/ws/nuget.config')],
        apiKeyUrls: ['https://%FEED_HOST%/index.json'],
      });
      const snap = buildSourcesSnapshot({
        scopeChain: [repo, machine],
        projectChains: [{ projectName: 'App', chain: [repo, machine] }],
        workspaceConfigs: [repo],
        relativePath,
        isGlobalPath,
        compareAuditToProjects: false,
      });
      expect(snap.chain[1].displayPath).toBe('Microsoft.VisualStudio.Offline.config');
      expect(snap.chain[1].isMachineWide).toBe(true);
      expect(snap.effectivePackageSources.find((s) => s.name === 'nexus')).toEqual(
        expect.objectContaining({
          url: 'https://nexus.example/index.json',
          urlRaw: 'https://%FEED_HOST%/index.json',
          kind: 'http',
          hasApiKey: true,
        }),
      );
      expect(snap.chain[0].packageSources.find((s) => s.name === 'nexus')).toEqual(
        expect.objectContaining({
          url: 'https://nexus.example/index.json',
          urlRaw: 'https://%FEED_HOST%/index.json',
          hasApiKey: true,
        }),
      );
    } finally {
      if (prev === undefined) delete process.env.FEED_HOST;
      else process.env.FEED_HOST = prev;
    }
  });

  it('passes extraConfigsTruncated through to the snapshot', () => {
    const repo = file({ filePath: '/ws/nuget.config' });
    const snap = buildSourcesSnapshot({
      scopeChain: [repo],
      projectChains: [{ projectName: 'App', chain: [repo] }],
      workspaceConfigs: [repo],
      relativePath,
      isGlobalPath,
      compareAuditToProjects: false,
      extraConfigsTruncated: true,
    });
    expect(snap.extraConfigsTruncated).toBe(true);
  });
});
