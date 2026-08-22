import * as fs from 'fs/promises';
import { NuGetConfigChainResolver, extractAuditSources, extractSources, parseNuGetConfig, uniqueEnabledAuditSources } from '../../nugetConfigChainResolver';

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
      if (d === '/project/src/App') return ['nuget.config', 'App.csproj'] as any;
      return [] as any;
    });

    const xml = NUGET_CONFIG_XML([{ key: 'nuget.org', value: 'https://api.nuget.org/v3/index.json' }]);
    mockReadFile.mockResolvedValue(xml as any);

    const chain = await resolver.resolve('/project/src/App');

    const configs = chain.filter((c) => !c.parseError);
    expect(configs.length).toBeGreaterThanOrEqual(1);
    expect(configs[0].filePath).toBe('/project/src/App/nuget.config');
    expect(configs[0].sources).toHaveLength(1);
    expect(configs[0].sources[0].name).toBe('nuget.org');
    expect(configs[0].sources[0].enabled).toBe(true);
  });

  // ── Multiple configs (Property 16: chain order) ───────────────────────────

  it('returns configs in nearest-first order (Property 16/18)', async () => {
    mockReaddir.mockImplementation(async (dir) => {
      const d = dir as string;
      if (d === '/a/b/c' || d === '/a/b' || d === '/a') return ['nuget.config'] as any;
      return [] as any;
    });

    mockReadFile.mockImplementation(async (filePath) => {
      const fp = filePath as string;
      if (fp.startsWith('/a/b/c')) return NUGET_CONFIG_XML([{ key: 'local', value: 'http://local' }]) as any;
      if (fp.startsWith('/a/b/')) return NUGET_CONFIG_XML([{ key: 'staging', value: 'http://staging' }]) as any;
      return NUGET_CONFIG_XML([{ key: 'global', value: 'http://global' }]) as any;
    });

    const chain = await resolver.resolve('/a/b/c');

    // First entry should be from /a/b/c (nearest)
    const validChain = chain.filter((c) => !c.parseError);
    expect(validChain[0].filePath).toBe('/a/b/c/nuget.config');
    expect(validChain[0].sources[0].name).toBe('local');

    // No duplicates
    const filePaths = chain.map((c) => c.filePath);
    expect(new Set(filePaths).size).toBe(filePaths.length);
  });

  // ── Disabled sources ──────────────────────────────────────────────────────

  it('marks disabled sources as enabled=false', async () => {
    mockReaddir.mockImplementation(async (dir) => {
      const d = dir as string;
      if (d === '/proj') return ['nuget.config'] as any;
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
    const config = chain.find((c) => c.filePath === '/proj/nuget.config');
    expect(config).toBeDefined();
    expect(config!.sources.find((s) => s.name === 'nuget.org')?.enabled).toBe(true);
    expect(config!.sources.find((s) => s.name === 'private')?.enabled).toBe(false);
  });

  // ── parseError on unreadable file ─────────────────────────────────────────

  it('sets parseError when file cannot be read', async () => {
    mockReaddir.mockImplementation(async (dir) => {
      const d = dir as string;
      if (d === '/proj') return ['nuget.config'] as any;
      return [] as any;
    });
    mockReadFile.mockRejectedValue(new Error('Permission denied'));

    const chain = await resolver.resolve('/proj');
    const config = chain.find((c) => c.filePath === '/proj/nuget.config');
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
});
