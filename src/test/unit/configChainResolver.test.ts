import * as fs from 'fs/promises';
import * as path from 'path';
import { NuGetConfigChainResolver, extractAuditSources, extractCredentialKeys, extractDisabledPackageSources, extractPackageSourceMapping, extractPackageSources, extractSources, getMachineWideNuGetConfigDir, mergedPackageSourceMapping, uniqueAuditSourcesWithSuppressed, uniqueDeclaredAuditSources, uniqueEnabledAuditSources, uniqueEnabledPackageSources, uniquePackageSources } from '../../nugetConfigChainResolver';

jest.mock('fs/promises');
const mockReaddir = fs.readdir as jest.MockedFunction<typeof fs.readdir>;
const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;

const NUGET_CONFIG_XML = (sources: Array<{ key: string; value: string }>, disabled: string[] = []) => `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    ${sources.map((s) => `<add key="${s.key}" value="${s.value}" />`).join('\n    ')}
  </packageSources>
  ${disabled.length > 0 ? `<disabledPackageSources>\n    ${disabled.map((k) => `<add key="${k}" value="true" />`).join('\n    ')}\n  </disabledPackageSources>` : ''}
</configuration>`;

function sameDir(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

describe('NuGetConfigChainResolver', () => {
  let resolver: NuGetConfigChainResolver;

  beforeEach(() => {
    resolver = new NuGetConfigChainResolver();
    mockReaddir.mockReset();
    mockReadFile.mockReset();
  });

  // ── No configs in chain ───────────────────────────────────────────────────

  it('returns empty array when no nuget.config exists anywhere', async () => {
    // All readdir calls return files without nuget.config
    mockReaddir.mockResolvedValue(['readme.md', 'src'] as any);

    const chain = await resolver.resolve('/project/src/App');
    // Chain may include global config dir attempts, but with no nuget.config found, empty
    expect(chain.filter((c) => c.sources.length > 0 || !c.parseError)).toHaveLength(0);
  });

  // ── Single config at project level ────────────────────────────────────────

  it('returns a single config when only project-level nuget.config exists', async () => {
    mockReaddir.mockImplementation(async (dir) => {
      const d = dir as string;
      if (sameDir(d, '/project/src/App')) return ['nuget.config', 'App.csproj'] as any;
      return [] as any;
    });

    const xml = NUGET_CONFIG_XML([{ key: 'nuget.org', value: 'https://api.nuget.org/v3/index.json' }]);
    mockReadFile.mockResolvedValue(xml as any);

    const chain = await resolver.resolve('/project/src/App');

    const configs = chain.filter((c) => !c.parseError);
    expect(configs.length).toBeGreaterThanOrEqual(1);
    expect(configs[0].filePath).toBe(path.join(path.resolve('/project/src/App'), 'nuget.config'));
    expect(configs[0].sources).toHaveLength(1);
    expect(configs[0].sources[0].name).toBe('nuget.org');
    expect(configs[0].sources[0].enabled).toBe(true);
  });

  // ── Multiple configs (Property 16: chain order) ───────────────────────────

  it('returns configs in nearest-first order (Property 16/18)', async () => {
    mockReaddir.mockImplementation(async (dir) => {
      const d = dir as string;
      if (sameDir(d, '/a/b/c') || sameDir(d, '/a/b') || sameDir(d, '/a')) return ['nuget.config'] as any;
      return [] as any;
    });

    mockReadFile.mockImplementation(async (filePath) => {
      const fp = (filePath as string).replace(/\\/g, '/');
      if (fp.includes('/a/b/c/')) return NUGET_CONFIG_XML([{ key: 'local', value: 'http://local' }]) as any;
      if (fp.includes('/a/b/')) return NUGET_CONFIG_XML([{ key: 'staging', value: 'http://staging' }]) as any;
      return NUGET_CONFIG_XML([{ key: 'global', value: 'http://global' }]) as any;
    });

    const chain = await resolver.resolve('/a/b/c');

    // First entry should be from /a/b/c (nearest)
    const validChain = chain.filter((c) => !c.parseError);
    expect(validChain[0].filePath).toBe(path.join(path.resolve('/a/b/c'), 'nuget.config'));
    expect(validChain[0].sources[0].name).toBe('local');

    // No duplicates
    const filePaths = chain.map((c) => c.filePath);
    expect(new Set(filePaths).size).toBe(filePaths.length);
  });

  // ── Disabled sources ──────────────────────────────────────────────────────

  it('marks disabled sources as enabled=false', async () => {
    mockReaddir.mockImplementation(async (dir) => {
      const d = dir as string;
      if (sameDir(d, '/proj')) return ['nuget.config'] as any;
      return [] as any;
    });

    const xml = NUGET_CONFIG_XML(
      [
        { key: 'nuget.org', value: 'https://api.nuget.org/v3/index.json' },
        { key: 'private', value: 'https://private.server/index.json' },
      ],
      ['private'],
    );
    mockReadFile.mockResolvedValue(xml as any);

    const chain = await resolver.resolve('/proj');
    const config = chain.find((c) => sameDir(path.dirname(c.filePath), '/proj'));
    expect(config).toBeDefined();
    expect(config!.sources.find((s) => s.name === 'nuget.org')?.enabled).toBe(true);
    expect(config!.sources.find((s) => s.name === 'private')?.enabled).toBe(false);
  });

  // ── parseError on unreadable file ─────────────────────────────────────────

  it('sets parseError when file cannot be read', async () => {
    mockReaddir.mockImplementation(async (dir) => {
      const d = dir as string;
      if (sameDir(d, '/proj')) return ['nuget.config'] as any;
      return [] as any;
    });
    mockReadFile.mockRejectedValue(new Error('Permission denied'));

    const chain = await resolver.resolve('/proj');
    const config = chain.find((c) => sameDir(path.dirname(c.filePath), '/proj'));
    expect(config).toBeDefined();
    expect(config!.parseError).toMatch(/Permission denied/);
    expect(config!.sources).toEqual([]);
  });
});

// ── extractSources ────────────────────────────────────────────────────────────

describe('extractSources', () => {
  it('extracts all sources from well-formed XML', () => {
    const xml = NUGET_CONFIG_XML([
      { key: 'nuget.org', value: 'https://api.nuget.org/v3/index.json' },
      { key: 'local', value: 'D:\\local\\packages' },
    ]);
    const sources = extractSources(xml, '/p/nuget.config');
    expect(sources).toHaveLength(2);
    expect(sources[0].name).toBe('nuget.org');
    expect(sources[0].url).toBe('https://api.nuget.org/v3/index.json');
    expect(sources[0].enabled).toBe(true);
    expect(sources[0].configFilePath).toBe('/p/nuget.config');
  });

  it('returns empty array when packageSources section is missing', () => {
    const xml = '<configuration></configuration>';
    expect(extractSources(xml, '/p/nuget.config')).toEqual([]);
  });

  it('correctly identifies disabled sources', () => {
    const xml = NUGET_CONFIG_XML(
      [{ key: 'myNexus', value: 'https://nexus/index.json' }],
      ['myNexus'],
    );
    const sources = extractSources(xml, '/p/nuget.config');
    expect(sources[0].enabled).toBe(false);
  });

  it('reads allowInsecureConnections and disableTLSCertificateValidation', () => {
    const xml = `<?xml version="1.0"?>
<configuration>
  <packageSources>
    <add key="nexus-group" value="http://localhost:8081/index.json" allowInsecureConnections="true" />
    <add disableTLSCertificateValidation="true" key="self-signed" value="https://nexus.local/index.json" />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" allowInsecureConnections="false" />
  </packageSources>
</configuration>`;
    const sources = extractSources(xml, '/p/nuget.config');
    expect(sources[0].allowInsecureConnections).toBe(true);
    expect(sources[0].disableTlsCertificateValidation).toBeUndefined();
    expect(sources[1].disableTlsCertificateValidation).toBe(true);
    expect(sources[1].allowInsecureConnections).toBeUndefined();
    expect(sources[2].allowInsecureConnections).toBeUndefined();
    expect(sources[2].disableTlsCertificateValidation).toBeUndefined();
  });
});

describe('extractAuditSources', () => {
  it('reads auditSources and clear', () => {
    const xml = `<?xml version="1.0"?>
<configuration>
  <auditSources>
    <clear />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </auditSources>
</configuration>`;
    expect(extractAuditSources(xml, '/p/nuget.config')).toEqual({
      auditSourcesCleared: true,
      auditSources: [expect.objectContaining({
        name: 'nuget.org',
        url: 'https://api.nuget.org/v3/index.json',
        enabled: true,
      })],
    });
  });

  it('honours disabledPackageSources for audit source keys', () => {
    const xml = `<?xml version="1.0"?>
<configuration>
  <auditSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </auditSources>
  <disabledPackageSources>
    <add key="nuget.org" value="true" />
  </disabledPackageSources>
</configuration>`;
    expect(extractAuditSources(xml, '/p/nuget.config').auditSources[0].enabled).toBe(false);
  });

  it('stops inheritance after a nearer clear', () => {
    const nearer = {
      filePath: '/p/nuget.config',
      sources: [],
      auditSources: [{ name: 'corp', url: 'https://data.nuget.org/v3/index.json', enabled: true, configFilePath: '/p/nuget.config' }],
      auditSourcesCleared: true,
    };
    const farther = {
      filePath: '/NuGet.Config',
      sources: [],
      auditSources: [{ name: 'old', url: 'https://old.example/index.json', enabled: true, configFilePath: '/NuGet.Config' }],
    };
    expect(uniqueEnabledAuditSources([nearer, farther]).map((s) => s.name)).toEqual(['corp']);
  });

  it('uniqueAuditSourcesWithSuppressed keeps farther audit feeds as disabled after nearer clear', () => {
    const nearer = {
      filePath: '/p/nuget.config',
      sources: [],
      auditSources: [{ name: 'corp', url: 'https://data.nuget.org/v3/index.json', enabled: true, configFilePath: '/p/nuget.config' }],
      auditSourcesCleared: true,
    };
    const farther = {
      filePath: '/NuGet.Config',
      sources: [],
      auditSources: [{ name: 'nuget.org', url: 'https://api.nuget.org/v3/index.json', enabled: true, configFilePath: '/NuGet.Config' }],
    };
    expect(uniqueAuditSourcesWithSuppressed([nearer, farther])).toEqual([
      expect.objectContaining({ name: 'corp', enabled: true }),
      expect.objectContaining({ name: 'nuget.org', enabled: false, url: 'https://api.nuget.org/v3/index.json' }),
    ]);
  });

  it('uniqueDeclaredAuditSources ignores disabledPackageSources', () => {
    const nearer = {
      filePath: '/p/nuget.config',
      sources: [],
      auditSources: [],
      disabledPackageSources: [{ name: 'nuget.org', disabled: true }],
    };
    const farther = {
      filePath: '/NuGet.Config',
      sources: [],
      auditSources: [{ name: 'nuget.org', url: 'https://api.nuget.org/v3/index.json', enabled: true, configFilePath: '/NuGet.Config' }],
    };
    expect(uniqueDeclaredAuditSources([nearer, farther])).toEqual([
      expect.objectContaining({ name: 'nuget.org', enabled: true }),
    ]);
    expect(uniqueEnabledAuditSources([nearer, farther])).toEqual([]);
  });
});

describe('extractPackageSources clear', () => {
  it('honours <clear /> inside packageSources', () => {
    const xml = `<?xml version="1.0"?>
<configuration>
  <packageSources>
    <clear />
    <add key="nexus" value="https://nexus.example/index.json" />
  </packageSources>
</configuration>`;
    expect(extractPackageSources(xml, '/p/nuget.config')).toEqual({
      packageSourcesCleared: true,
      sources: [expect.objectContaining({ name: 'nexus', url: 'https://nexus.example/index.json' })],
    });
  });

  it('reads protocolVersion 2 and 3 from packageSources add', () => {
    const xml = `<?xml version="1.0"?>
<configuration>
  <packageSources>
    <add key="v3" value="https://nexus.example/index.json" protocolVersion="3" />
    <add key="v2" value="https://tfs.example/nuget" protocolVersion="2" />
    <add key="implied" value="https://tfs.example/nuget" />
  </packageSources>
</configuration>`;
    const { sources } = extractPackageSources(xml, '/p/nuget.config');
    expect(sources.find((s) => s.name === 'v3')?.protocolVersion).toBe('3');
    expect(sources.find((s) => s.name === 'v2')?.protocolVersion).toBe('2');
    expect(sources.find((s) => s.name === 'implied')?.protocolVersion).toBeUndefined();
  });

  it('stops package-source inheritance after a nearer clear', () => {
    const nearer = {
      filePath: '/p/nuget.config',
      sources: [{ name: 'nexus', url: 'https://nexus.example/index.json', enabled: true, configFilePath: '/p/nuget.config' }],
      packageSourcesCleared: true,
    };
    const farther = {
      filePath: '/NuGet.Config',
      sources: [{ name: 'nuget.org', url: 'https://api.nuget.org/v3/index.json', enabled: true, configFilePath: '/NuGet.Config' }],
    };
    expect(uniqueEnabledPackageSources([nearer, farther]).map((s) => s.name)).toEqual(['nexus']);
  });
});

describe('disabledPackageSources chain merge', () => {
  it('lets a nearer file disable a source declared farther away', () => {
    const nearer = {
      filePath: '/p/nuget.config',
      sources: [],
      disabledPackageSources: [{ name: 'nuget.org', disabled: true }],
    };
    const farther = {
      filePath: '/NuGet.Config',
      sources: [{ name: 'nuget.org', url: 'https://api.nuget.org/v3/index.json', enabled: true, configFilePath: '/NuGet.Config' }],
    };
    expect(uniquePackageSources([nearer, farther])).toEqual([
      expect.objectContaining({ name: 'nuget.org', enabled: false }),
    ]);
    expect(uniqueEnabledPackageSources([nearer, farther])).toEqual([]);
  });

  it('re-enables after a nearer <clear /> in disabledPackageSources', () => {
    const nearer = {
      filePath: '/p/nuget.config',
      sources: [],
      disabledPackageSources: [],
      disabledPackageSourcesCleared: true,
    };
    const farther = {
      filePath: '/NuGet.Config',
      sources: [{ name: 'nuget.org', url: 'https://api.nuget.org/v3/index.json', enabled: false, configFilePath: '/NuGet.Config' }],
      disabledPackageSources: [{ name: 'nuget.org', disabled: true }],
    };
    expect(uniquePackageSources([nearer, farther])[0].enabled).toBe(true);
  });

  it('re-enables a parent disable with value="false"', () => {
    const nearer = {
      filePath: '/p/nuget.config',
      sources: [],
      disabledPackageSources: [{ name: 'nuget.org', disabled: false }],
    };
    const farther = {
      filePath: '/NuGet.Config',
      sources: [{ name: 'nuget.org', url: 'https://api.nuget.org/v3/index.json', enabled: false, configFilePath: '/NuGet.Config' }],
      disabledPackageSources: [{ name: 'nuget.org', disabled: true }],
    };
    expect(uniquePackageSources([nearer, farther])[0].enabled).toBe(true);
  });

  it('parses value="false" and <clear />', () => {
    const xml = `<?xml version="1.0"?>
<configuration>
  <disabledPackageSources>
    <clear />
    <add key="nuget.org" value="false" />
    <add key="nexus" value="true" />
  </disabledPackageSources>
</configuration>`;
    expect(extractDisabledPackageSources(xml)).toEqual({
      cleared: true,
      entries: [
        { name: 'nuget.org', disabled: false },
        { name: 'nexus', disabled: true },
      ],
    });
  });
});

describe('packageSourceMapping', () => {
  it('parses patterns per source', () => {
    const xml = `<?xml version="1.0"?>
<configuration>
  <packageSourceMapping>
    <packageSource key="nuget.org">
      <package pattern="*" />
    </packageSource>
    <packageSource key="nexus">
      <package pattern="Contoso.*" />
      <package pattern="Nexus.*" />
    </packageSource>
  </packageSourceMapping>
</configuration>`;
    expect(extractPackageSourceMapping(xml)).toEqual({
      cleared: false,
      mappings: [
        { sourceName: 'nuget.org', patterns: ['*'] },
        { sourceName: 'nexus', patterns: ['Contoso.*', 'Nexus.*'] },
      ],
    });
  });

  it('lets a nearer <clear /> replace parent mappings', () => {
    const nearer = {
      filePath: '/p/nuget.config',
      sources: [],
      packageSourceMappingCleared: true,
      packageSourceMapping: [{ sourceName: 'nexus', patterns: ['Contoso.*'] }],
    };
    const farther = {
      filePath: '/NuGet.Config',
      sources: [],
      packageSourceMapping: [{ sourceName: 'nuget.org', patterns: ['*'] }],
    };
    expect(mergedPackageSourceMapping([nearer, farther])).toEqual([
      { sourceName: 'nexus', patterns: ['Contoso.*'] },
    ]);
  });
});

describe('extractCredentialKeys', () => {
  it('returns source keys and never password values', () => {
    const xml = `<?xml version="1.0"?>
<configuration>
  <packageSourceCredentials>
    <nuget.org>
      <add key="Username" value="user" />
      <add key="ClearTextPassword" value="hunter2" />
    </nuget.org>
  </packageSourceCredentials>
</configuration>`;
    expect(extractCredentialKeys(xml)).toEqual(['nuget.org']);
    expect(extractCredentialKeys(xml).join(' ')).not.toMatch(/hunter2|Username|ClearTextPassword/i);
  });

  it('decodes XmlConvert spaces in credential element names', () => {
    const xml = `<?xml version="1.0"?>
<configuration>
  <packageSourceCredentials>
    <My_x0020_Feed>
      <add key="Username" value="ci" />
      <add key="ClearTextPassword" value="hunter2" />
    </My_x0020_Feed>
  </packageSourceCredentials>
</configuration>`;
    expect(extractCredentialKeys(xml)).toEqual(['My Feed']);
  });
});

describe('machine-wide configs', () => {
  const previous = process.env.NUGET_COMMON_APPLICATION_DATA;

  afterEach(() => {
    if (previous === undefined) delete process.env.NUGET_COMMON_APPLICATION_DATA;
    else process.env.NUGET_COMMON_APPLICATION_DATA = previous;
  });

  it('appends *.config from the computer-level directory after user/walk-up files', async () => {
    process.env.NUGET_COMMON_APPLICATION_DATA = '/machine-data';
    const machineDir = getMachineWideNuGetConfigDir();
    const resolver = new NuGetConfigChainResolver();
    mockReaddir.mockImplementation(async (dir) => {
      const d = dir as string;
      if (sameDir(d, '/proj')) return ['nuget.config'] as any;
      if (sameDir(d, machineDir)) return ['Microsoft.VisualStudio.Offline.config'] as any;
      return [] as any;
    });
    mockReadFile.mockImplementation(async (filePath) => {
      const fp = String(filePath).replace(/\\/g, '/');
      if (fp.toLowerCase().includes('offline')) {
        return NUGET_CONFIG_XML([{ key: 'Offline', value: 'C:\\offline\\packages' }]) as any;
      }
      return NUGET_CONFIG_XML([{ key: 'nexus', value: 'https://nexus.example/index.json' }]) as any;
    });

    const chain = await resolver.resolve('/proj');
    const names = chain.filter((c) => !c.parseError).map((c) => c.filePath.replace(/\\/g, '/'));
    expect(names[0]).toMatch(/\/proj[/\\]nuget.config$/i);
    expect(chain.some((c) => c.isMachineWide && c.sources.some((s) => s.name === 'Offline'))).toBe(true);
    expect(chain.findIndex((c) => c.isMachineWide)).toBeGreaterThan(0);
  });
});
