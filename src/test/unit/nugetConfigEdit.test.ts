import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  extractApiKeyUrls,
  extractCredentialUsernames,
  mergePackageSourceCredentials,
  patchNuGetConfigFile,
  setApiKeyEntry,
  setClearTextApiKeyEntry,
  setPackageSourceCredentials,
  setPackageSourceConnectionFlags,
  setPackageSourceDisabled,
  setPackageSourceMappingPatterns,
  addPackageSource,
  removePackageSourceEntry,
  findPackageSourceLine,
  replaceAuditSources,
  removeAuditSource,
  upsertAuditSource,
  writeSourceApiKey,
} from '../../nugetConfigEdit';
import { extractPackageSourceMapping, extractSources } from '../../nugetConfigChainResolver';

const BASE = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
    <add key="nexus" value="https://nexus.example/index.json" />
  </packageSources>
</configuration>`;

describe('setPackageSourceDisabled', () => {
  it('adds disabledPackageSources and can re-enable', () => {
    const off = setPackageSourceDisabled(BASE, 'nexus', true);
    expect(off).toContain('<disabledPackageSources>');
    expect(off).toMatch(/<add key="nexus" value="true"/);
    const on = setPackageSourceDisabled(off, 'nexus', false);
    expect(on).toMatch(/<add key="nexus" value="false"/);
    expect(on).toContain('nuget.org');
  });

  it('does not mistake a same-key <add> inside a comment for the real entry (#85)', () => {
    // Editing a key that only exists inside a comment must never silently
    // mutate the commented-out copy in place — it has to create a real,
    // active entry instead, leaving the comment's own text untouched.
    const withComment = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
    <add key="nexus" value="https://nexus.example/index.json" />
  </packageSources>
  <disabledPackageSources>
    <!-- disable a source with <add key="nexus" value="false" /> -->
  </disabledPackageSources>
</configuration>`;
    const next = setPackageSourceDisabled(withComment, 'nexus', true);
    expect(next).toContain('<!-- disable a source with <add key="nexus" value="false" /> -->');
    expect(next.match(/<add key="nexus" value="true"/gi)).toHaveLength(1);
  });

  it('does not accumulate blank lines around the add when toggling enable', () => {
    let xml = BASE;
    for (let i = 0; i < 6; i++) {
      xml = setPackageSourceDisabled(xml, 'nexus', i % 2 === 0);
    }
    expect(xml).toMatch(
      // indentation this assertion is about.
      /<disabledPackageSources>\n {4}<add key="nexus" value="false" \/>\n {2}<\/disabledPackageSources>/,
    );
    expect(xml).not.toMatch(/<disabledPackageSources>\s*\n\s*\n/);
  });
});

describe('auditSources XML', () => {
  const withAudit = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
  <auditSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </auditSources>
  <disabledPackageSources>
    <add key="nexus" value="true" />
  </disabledPackageSources>
</configuration>`;

  it('replaceAuditSources with clear does not write disabledPackageSources for the audit key', () => {
    const next = replaceAuditSources(withAudit, [], true);
    expect(next).toMatch(/<auditSources>\s*<clear \/>\s*<\/auditSources>/);
    expect(next).not.toMatch(/<disabledPackageSources>[\s\S]*nuget\.org/i);
    expect(next).toMatch(/<packageSources>[\s\S]*nuget\.org/);
    expect(next).toMatch(/<add key="nexus" value="true"/);
  });

  it('removeAuditSource leaves disabledPackageSources unchanged', () => {
    const next = removeAuditSource(withAudit, 'nuget.org');
    expect(next).not.toMatch(/<auditSources>/);
    expect(next).toMatch(/<add key="nexus" value="true"/);
    expect(next).not.toMatch(/<disabledPackageSources>[\s\S]*nuget\.org/i);
  });

  it('removeAuditSource matches a non-self-closing add', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <auditSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json"></add>
    <add key="corp" value="https://corp.example/index.json" />
  </auditSources>
</configuration>`;
    const next = removeAuditSource(xml, 'nuget.org');
    expect(next).not.toMatch(/nuget\.org/);
    expect(next).toMatch(/<add key="corp"/);
  });

  it('removeAuditSource matches a key with XML special characters', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <auditSources>
    <add key="Contoso &amp; Co" value="https://contoso.example/index.json" />
    <add key="corp" value="https://corp.example/index.json" />
  </auditSources>
</configuration>`;
    const next = removeAuditSource(xml, 'Contoso & Co');
    expect(next).not.toMatch(/Contoso/);
    expect(next).toMatch(/<add key="corp"/);
  });

  it('upsertAuditSource does not add disabledPackageSources', () => {
    const next = upsertAuditSource(BASE, 'nuget.org', 'https://api.nuget.org/v3/index.json');
    expect(next).toMatch(/<auditSources>[\s\S]*nuget\.org/);
    expect(next).not.toContain('<disabledPackageSources>');
  });
});

describe('credentials', () => {
  it('reads a username and password declared with single-quoted attributes (#85)', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="nexus" value="https://nexus.example/index.json" />
  </packageSources>
  <packageSourceCredentials>
    <nexus>
      <add key='Username' value='ci' />
      <add key='ClearTextPassword' value='hunter2' />
    </nexus>
  </packageSourceCredentials>
</configuration>`;
    expect(extractCredentialUsernames(xml)).toEqual({ nexus: 'ci' });
  });

  it('writes username and ClearTextPassword, never required in extract usernames as password', () => {
    const xml = setPackageSourceCredentials(BASE, 'nexus', {
      username: 'ci',
      password: 'hunter2',
    });
    expect(extractCredentialUsernames(xml)).toEqual({ nexus: 'ci' });
    expect(xml).toContain('ClearTextPassword');
    expect(JSON.stringify(extractCredentialUsernames(xml))).not.toContain('hunter2');
  });

  it('keeps the existing password when only the username changes', () => {
    const withPass = setPackageSourceCredentials(BASE, 'nexus', {
      username: 'old',
      password: 'hunter2',
    });
    const merged = mergePackageSourceCredentials(withPass, 'nexus', { username: 'new' });
    expect(extractCredentialUsernames(merged).nexus).toBe('new');
    expect(merged).toContain('hunter2');
  });

  it('keeps a single-quoted stored password when only the username changes (#85)', () => {
    const withPass = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="nexus" value="https://nexus.example/index.json" />
  </packageSources>
  <packageSourceCredentials>
    <nexus>
      <add key='Username' value='old' />
      <add key='ClearTextPassword' value='hunter2' />
    </nexus>
  </packageSourceCredentials>
</configuration>`;
    const merged = mergePackageSourceCredentials(withPass, 'nexus', { username: 'new' });
    expect(extractCredentialUsernames(merged).nexus).toBe('new');
    expect(merged).toContain('hunter2');
  });

  it('clears the credentials block', () => {
    const withPass = setPackageSourceCredentials(BASE, 'nexus', {
      username: 'ci',
      password: 'hunter2',
    });
    const cleared = mergePackageSourceCredentials(withPass, 'nexus', { username: '', clear: true });
    expect(cleared).not.toContain('packageSourceCredentials');
    expect(cleared).not.toContain('hunter2');
  });

  it('writes and reads credentials for a source name with a space', () => {
    const xml = setPackageSourceCredentials(BASE, 'My Feed', {
      username: 'ci',
      password: 'hunter2',
    });
    expect(xml).toContain('<My_x0020_Feed>');
    expect(xml).toContain('</My_x0020_Feed>');
    expect(xml).not.toContain('<My Feed>');
    expect(extractCredentialUsernames(xml)).toEqual({ 'My Feed': 'ci' });
    const merged = mergePackageSourceCredentials(xml, 'My Feed', { username: 'new' });
    expect(extractCredentialUsernames(merged)).toEqual({ 'My Feed': 'new' });
    expect(merged).toContain('hunter2');
    const cleared = mergePackageSourceCredentials(merged, 'My Feed', { username: '', clear: true });
    expect(cleared).not.toContain('My_x0020_Feed');
    expect(cleared).not.toContain('hunter2');
  });

  it('writes Password when encrypted is set, and keeps the blob on username-only merge', () => {
    const xml = setPackageSourceCredentials(BASE, 'nexus', {
      username: 'ci',
      password: 'AQID-blob',
      encrypted: true,
    });
    expect(xml).toContain('key="Password"');
    expect(xml).not.toContain('ClearTextPassword');
    expect(xml).toContain('AQID-blob');
    const merged = mergePackageSourceCredentials(xml, 'nexus', { username: 'new' });
    expect(extractCredentialUsernames(merged).nexus).toBe('new');
    expect(merged).toContain('key="Password"');
    expect(merged).toContain('AQID-blob');
    expect(merged).not.toContain('ClearTextPassword');
  });

  it('copies password from fallback xml when the target file has none', () => {
    const from = setPackageSourceCredentials(BASE, 'nexus', {
      username: 'old',
      password: 'hunter2',
    });
    const merged = mergePackageSourceCredentials(BASE, 'nexus', {
      username: 'ci',
      passwordFallbackXml: from,
    });
    expect(extractCredentialUsernames(merged).nexus).toBe('ci');
    expect(merged).toContain('hunter2');
    expect(JSON.stringify(extractCredentialUsernames(merged))).not.toContain('hunter2');
  });

  it('reads a source\'s username past a comment mentioning its own element name (#85)', () => {
    // Same swallow-through shape as the packageSourceMapping repro, but for
    // packageSourceCredentials' dynamic per-source element name.
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
    <add key="nexus" value="https://nexus.example/index.json" />
  </packageSources>
  <packageSourceCredentials>
    <!-- one <nexus> element per source with saved credentials -->
    <nexus>
      <add key="Username" value="ci" />
      <add key="ClearTextPassword" value="hunter2" />
    </nexus>
  </packageSourceCredentials>
</configuration>`;
    expect(extractCredentialUsernames(xml)).toEqual({ nexus: 'ci' });
  });

  it('replaces (not duplicates) a source\'s credentials past a comment mentioning its own element name (#85)', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
    <add key="nexus" value="https://nexus.example/index.json" />
  </packageSources>
  <packageSourceCredentials>
    <!-- one <nexus> element per source with saved credentials -->
    <nexus>
      <add key="Username" value="old" />
      <add key="ClearTextPassword" value="hunter2" />
    </nexus>
  </packageSourceCredentials>
</configuration>`;
    const next = setPackageSourceCredentials(xml, 'nexus', { username: 'new', password: 'new-pass' });
    expect(next.match(/<nexus>/gi)).toHaveLength(1);
    expect(extractCredentialUsernames(next)).toEqual({ nexus: 'new' });
  });
});

describe('apikeys', () => {
  it('stores the URL key and can remove it', () => {
    const url = 'https://nexus.example/index.json';
    const xml = setApiKeyEntry(BASE, url, 'secret-key');
    expect(extractApiKeyUrls(xml)).toEqual([url]);
    expect(extractApiKeyUrls(xml).join()).not.toContain('secret-key');
    const gone = setApiKeyEntry(xml, url, null);
    expect(extractApiKeyUrls(gone)).toEqual([]);
    expect(gone).not.toContain('secret-key');
  });

  it('stores clearTextApiKeys URLs without putting the secret in extractApiKeyUrls', () => {
    const url = 'https://nexus.example/index.json';
    const xml = setClearTextApiKeyEntry(BASE, url, 'oy2-secret');
    expect(xml).toMatch(/<clearTextApiKeys>/);
    expect(xml).not.toMatch(/<apikeys>/);
    expect(extractApiKeyUrls(xml)).toEqual([url]);
    expect(JSON.stringify(extractApiKeyUrls(xml))).not.toContain('oy2-secret');
    const gone = setClearTextApiKeyEntry(xml, url, null);
    expect(gone).not.toContain('clearTextApiKeys');
    expect(gone).not.toContain('oy2-secret');
  });
});

describe('findPackageSourceLine', () => {
  it('returns the packageSources add line for a source name', () => {
    const xml = `<?xml version="1.0"?>
<configuration>
  <packageSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
    <add key="nexus" value="https://nexus.example/index.json" />
  </packageSources>
</configuration>`;
    expect(findPackageSourceLine(xml, 'nexus')).toBe(4);
    expect(findPackageSourceLine(xml, 'missing')).toBeUndefined();
  });
});

describe('writeSourceApiKey', () => {
  it('stores a Windows DPAPI blob, not a raw GUID', async () => {
    if (process.platform !== 'win32') return;
    const guid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const tmp = path.join(os.tmpdir(), `ave-nuget-apikey-${Date.now()}.config`);
    await fs.writeFile(tmp, BASE, 'utf8');
    try {
      await writeSourceApiKey(tmp, 'https://nexus.example/index.json', guid);
      const xml = await fs.readFile(tmp, 'utf8');
      expect(xml).not.toContain(guid);
      expect(xml).toMatch(/<apikeys>/);
      expect(xml).not.toMatch(/<clearTextApiKeys>/);
      const value = /<add key="https:\/\/nexus\.example\/index\.json" value="([^"]+)"/.exec(xml)?.[1];
      expect(value).toBeTruthy();
      expect(value).toMatch(/^[A-Za-z0-9+/]+=*$/);
      expect(value!.length).toBeGreaterThan(20);
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
    }
  });

  it('stores clearTextApiKeys on non-Windows, not apikeys', async () => {
    if (process.platform === 'win32') return;
    const key = 'oy2-nonwin-secret';
    const tmp = path.join(os.tmpdir(), `ave-nuget-apikey-${Date.now()}.config`);
    await fs.writeFile(tmp, BASE, 'utf8');
    try {
      await writeSourceApiKey(tmp, 'https://nexus.example/index.json', key);
      const xml = await fs.readFile(tmp, 'utf8');
      expect(xml).toMatch(/<clearTextApiKeys>/);
      expect(xml).not.toMatch(/<apikeys>/);
      expect(xml).toContain(key);
      expect(extractApiKeyUrls(xml)).toEqual(['https://nexus.example/index.json']);
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
    }
  });
});

describe('setPackageSourceConnectionFlags', () => {
  it('writes allowInsecureConnections and disableTLSCertificateValidation, then clears them', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="nexus" value="http://nexus.example/index.json" protocolVersion="3" />
  </packageSources>
</configuration>`;
    const on = setPackageSourceConnectionFlags(xml, 'nexus', {
      allowInsecureConnections: true,
      disableTlsCertificateValidation: true,
    });
    expect(on).toMatch(/<add key="nexus" value="http:\/\/nexus.example\/index.json" protocolVersion="3" allowInsecureConnections="true" disableTLSCertificateValidation="true" \/>/);
    const off = setPackageSourceConnectionFlags(on, 'nexus', {
      allowInsecureConnections: false,
      disableTlsCertificateValidation: false,
    });
    expect(off).toContain('protocolVersion="3"');
    expect(off).not.toMatch(/allowInsecureConnections/);
    expect(off).not.toMatch(/disableTLSCertificateValidation/);
  });

  it('updates auditSources and does not touch other keys', () => {
    const xml = `<?xml version="1.0"?>
<configuration>
  <packageSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
  <auditSources>
    <add key="nexus-group" value="http://localhost/index.json" />
  </auditSources>
</configuration>`;
    const next = setPackageSourceConnectionFlags(xml, 'nexus-group', {
      allowInsecureConnections: true,
      disableTlsCertificateValidation: false,
    });
    expect(next).toMatch(/<add key="nexus-group" value="http:\/\/localhost\/index.json" allowInsecureConnections="true" \/>/);
    expect(next).not.toMatch(/nuget.org[^>]*allowInsecureConnections/);
  });

  it('is not fooled by a same-key <add> inside a comment, nor by a comment mentioning the section tag (#85)', () => {
    const xml = `<?xml version="1.0"?>
<configuration>
  <!-- <packageSources> lists all sources -->
  <packageSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
    <!-- old entry, was <add key="nexus" value="http://old.example/index.json" /> -->
    <add key="nexus" value="http://nexus.example/index.json" />
  </packageSources>
</configuration>`;
    const next = setPackageSourceConnectionFlags(xml, 'nexus', { allowInsecureConnections: true });
    expect(next).toContain('<!-- old entry, was <add key="nexus" value="http://old.example/index.json" /> -->');
    expect(next).toMatch(/<add key="nexus" value="http:\/\/nexus.example\/index.json" allowInsecureConnections="true" \/>/);
    expect(next).not.toMatch(/nuget\.org[^>]*allowInsecureConnections/);
  });
});

describe('setPackageSourceMappingPatterns', () => {
  const MAPPING_BASE = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
    <add key="nexus" value="https://nexus.example/index.json" />
  </packageSources>
</configuration>`;

  it('adds a new packageSourceMapping section with one <package> per pattern', () => {
    const next = setPackageSourceMappingPatterns(MAPPING_BASE, 'nexus', ['Contoso.*', 'Fabrikam.*']);
    const { mappings, cleared } = extractPackageSourceMapping(next);
    expect(cleared).toBe(false);
    expect(mappings).toEqual([{ sourceName: 'nexus', patterns: ['Contoso.*', 'Fabrikam.*'] }]);
  });

  it('updates only the targeted source, leaving other sources and <clear/> alone', () => {
    const withClear = `<?xml version="1.0"?>
<configuration>
  <packageSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
    <add key="nexus" value="https://nexus.example/index.json" />
  </packageSources>
  <packageSourceMapping>
    <clear />
    <packageSource key="nuget.org">
      <package pattern="Newtonsoft.*" />
    </packageSource>
    <packageSource key="nexus">
      <package pattern="Old.*" />
    </packageSource>
  </packageSourceMapping>
</configuration>`;
    const next = setPackageSourceMappingPatterns(withClear, 'nexus', ['Contoso.*']);
    const { mappings, cleared } = extractPackageSourceMapping(next);
    expect(cleared).toBe(true);
    expect(mappings).toEqual(expect.arrayContaining([
      { sourceName: 'nuget.org', patterns: ['Newtonsoft.*'] },
      { sourceName: 'nexus', patterns: ['Contoso.*'] },
    ]));
    expect(mappings).toHaveLength(2);
  });

  it('removes just that source\'s block when patterns is empty, keeping the section for others', () => {
    const xml = setPackageSourceMappingPatterns(MAPPING_BASE, 'nexus', ['Contoso.*']);
    const withTwo = setPackageSourceMappingPatterns(xml, 'nuget.org', ['Newtonsoft.*']);
    const next = setPackageSourceMappingPatterns(withTwo, 'nexus', []);
    const { mappings } = extractPackageSourceMapping(next);
    expect(mappings).toEqual([{ sourceName: 'nuget.org', patterns: ['Newtonsoft.*'] }]);
  });

  it('removes the whole packageSourceMapping section once the last source is cleared (no <clear/>)', () => {
    const xml = setPackageSourceMappingPatterns(MAPPING_BASE, 'nexus', ['Contoso.*']);
    const next = setPackageSourceMappingPatterns(xml, 'nexus', []);
    expect(next).not.toContain('packageSourceMapping');
  });

  it('is case-insensitive on the source key and de-duplicates patterns', () => {
    const next = setPackageSourceMappingPatterns(MAPPING_BASE, 'NEXUS', ['A.*', 'A.*', ' B.* ']);
    const { mappings } = extractPackageSourceMapping(next);
    expect(mappings).toEqual([{ sourceName: 'NEXUS', patterns: ['A.*', 'B.*'] }]);
  });

  it('replaces the existing block instead of duplicating it when a preceding comment contains bare tag-like text (#85)', () => {
    // Exact repro from #85: re-saving "N"'s patterns used to leave the real
    // block untouched (its key was never seen because a fake match, born
    // from the comment's own `<packageSource>` mention, swallowed through
    // to its closing tag) and unconditionally append a second `key="N"`
    // block — which NuGet then rejects on restore as a duplicate key.
    const xml = `<?xml version="1.0"?>
<configuration>
  <packageSources>
    <add key="N" value="https://one.example/index.json" />
  </packageSources>
  <packageSourceMapping>
    <!-- key value for <packageSource> should match key values from <packageSources> element -->
    <packageSource key="N">
      <package pattern="*" />
    </packageSource>
  </packageSourceMapping>
</configuration>`;
    const next = setPackageSourceMappingPatterns(xml, 'N', ['D.*']);
    expect(next.match(/<packageSource\b/gi)).toHaveLength(1);
    expect(extractPackageSourceMapping(next).mappings).toEqual([{ sourceName: 'N', patterns: ['D.*'] }]);
  });

  it('replaces the old block for a source name with XML special characters, not duplicates it', () => {
    // key="Contoso &amp; Co" on disk is the source named "Contoso & Co" — a
    // regex built from the raw (unescaped) name would never match this and
    // would leave the stale block behind instead of replacing it.
    const withSpecial = `<?xml version="1.0"?>
<configuration>
  <packageSources>
    <add key="Contoso &amp; Co" value="https://contoso.example/index.json" />
  </packageSources>
  <packageSourceMapping>
    <packageSource key="Contoso &amp; Co">
      <package pattern="Old.*" />
    </packageSource>
  </packageSourceMapping>
</configuration>`;
    const next = setPackageSourceMappingPatterns(withSpecial, 'Contoso & Co', ['New.*']);
    const { mappings } = extractPackageSourceMapping(next);
    expect(mappings).toEqual([{ sourceName: 'Contoso & Co', patterns: ['New.*'] }]);
    expect(next.match(/<packageSource\b/gi)).toHaveLength(1);
  });
});

describe('addPackageSource', () => {
  const NO_SOURCES = `<?xml version="1.0"?>
<configuration>
  <config>
    <add key="globalPackagesFolder" value="C:\\packages" />
  </config>
</configuration>`;

  it('creates the packageSources section when missing', () => {
    const next = addPackageSource(NO_SOURCES, 'contoso', 'https://contoso.example/index.json');
    const sources = extractSources(next, '/nuget.config');
    expect(sources).toEqual([
      expect.objectContaining({ name: 'contoso', url: 'https://contoso.example/index.json' }),
    ]);
  });

  it('updates an existing source in place when the key already exists', () => {
    const next = addPackageSource(BASE, 'nexus', 'https://nexus.example/v2/index.json');
    const sources = extractSources(next, '/nuget.config');
    expect(sources).toHaveLength(2);
    expect(sources.find((s) => s.name === 'nexus')?.url).toBe('https://nexus.example/v2/index.json');
    expect(sources.find((s) => s.name === 'nuget.org')?.url).toBe('https://api.nuget.org/v3/index.json');
  });

  it('writes an explicit protocolVersion when given', () => {
    const next = addPackageSource(BASE, 'legacy', 'https://legacy.example/nuget', { protocolVersion: '2' });
    const sources = extractSources(next, '/nuget.config');
    expect(sources.find((s) => s.name === 'legacy')?.protocolVersion).toBe('2');
  });

  it('omits protocolVersion entirely when not given', () => {
    const next = addPackageSource(BASE, 'modern', 'https://modern.example/index.json');
    const sources = extractSources(next, '/nuget.config');
    expect(sources.find((s) => s.name === 'modern')?.protocolVersion).toBeUndefined();
  });

  it('clears a stale protocolVersion on an update-in-place re-submit without it', () => {
    const withV2 = addPackageSource(BASE, 'legacy', 'https://legacy.example/nuget', { protocolVersion: '2' });
    const next = addPackageSource(withV2, 'legacy', 'https://legacy.example/nuget');
    const sources = extractSources(next, '/nuget.config');
    expect(sources.find((s) => s.name === 'legacy')?.protocolVersion).toBeUndefined();
  });
});

describe('removePackageSourceEntry', () => {
  it('drops just the named source, keeping siblings', () => {
    const next = removePackageSourceEntry(BASE, 'nexus');
    const sources = extractSources(next, '/nuget.config');
    expect(sources.map((s) => s.name)).toEqual(['nuget.org']);
  });

  it('is a no-op for a name that is not declared', () => {
    const next = removePackageSourceEntry(BASE, 'does-not-exist');
    expect(extractSources(next, '/nuget.config')).toHaveLength(2);
  });

  it('does not delete a comment containing a same-key <add> in place of the real entry (#85)', () => {
    const withComment = `<?xml version="1.0"?>
<configuration>
  <packageSources>
    <!-- kept for reference: <add key="nexus" value="https://old.example/index.json" /> -->
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
    <add key="nexus" value="https://nexus.example/index.json" />
  </packageSources>
</configuration>`;
    const next = removePackageSourceEntry(withComment, 'nexus');
    expect(next).toContain('<!-- kept for reference: <add key="nexus" value="https://old.example/index.json" /> -->');
    expect(extractSources(next, '/nuget.config').map((s) => s.name)).toEqual(['nuget.org']);
  });

  it('removes the whole packageSources section once the last source is gone (no <clear/>)', () => {
    const oneSource = `<?xml version="1.0"?>
<configuration>
  <packageSources>
    <add key="nexus" value="https://nexus.example/index.json" />
  </packageSources>
</configuration>`;
    const next = removePackageSourceEntry(oneSource, 'nexus');
    expect(next).not.toContain('packageSources');
  });

  it('keeps the section (and its <clear/>) when the last <add> is removed but <clear/> remains', () => {
    const withClear = `<?xml version="1.0"?>
<configuration>
  <packageSources>
    <clear />
    <add key="nexus" value="https://nexus.example/index.json" />
  </packageSources>
</configuration>`;
    const next = removePackageSourceEntry(withClear, 'nexus');
    expect(next).toContain('<packageSources>');
    expect(next).toContain('<clear');
    expect(extractSources(next, '/nuget.config')).toHaveLength(0);
  });

  it('matches a source name with XML special characters correctly', () => {
    const withSpecial = `<?xml version="1.0"?>
<configuration>
  <packageSources>
    <add key="Contoso &amp; Co" value="https://contoso.example/index.json" />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
</configuration>`;
    const next = removePackageSourceEntry(withSpecial, 'Contoso & Co');
    const sources = extractSources(next, '/nuget.config');
    expect(sources.map((s) => s.name)).toEqual(['nuget.org']);
  });
});

describe('add key/value order', () => {
  it('updates an add when value comes before key and extra attributes exist', () => {
    const xml = `<?xml version="1.0"?>
<configuration>
  <auditSources>
    <add protocolVersion="3" value="https://old.example/index.json" key="nexus" />
  </auditSources>
  <apikeys>
    <add value="old-secret" key="https://old.example/index.json" />
  </apikeys>
</configuration>`;
    const audit = upsertAuditSource(xml, 'nexus', 'https://new.example/index.json');
    expect(audit).toMatch(/<add protocolVersion="3" value="https:\/\/new\.example\/index\.json" key="nexus" \/>/);
    const keys = setApiKeyEntry(xml, 'https://old.example/index.json', 'new-secret');
    expect(keys).toContain('new-secret');
    expect(keys).not.toContain('old-secret');
    expect(extractApiKeyUrls(keys)).toEqual(['https://old.example/index.json']);
  });
});

describe('patchNuGetConfigFile', () => {
  afterEach(() => {
    (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments = [];
    (vscode.workspace.applyEdit as jest.Mock).mockReset();
    (vscode.workspace.applyEdit as jest.Mock).mockResolvedValue(true);
  });

  it('patches the dirty editor buffer instead of overwriting disk', async () => {
    const tmp = path.join(os.tmpdir(), `ave-nuget-dirty-${Date.now()}.config`);
    await fs.writeFile(tmp, BASE, 'utf8');
    const dirty = `${BASE.trimEnd()}\n  <!-- dirty -->\n`;
    let buffer = dirty;
    const doc = {
      fileName: tmp,
      isClosed: false,
      uri: vscode.Uri.file(tmp),
      getText: () => buffer,
      get lineCount() { return buffer.split(/\n/).length; },
      lineAt: (i: number) => {
        const line = buffer.split(/\n/)[i] ?? '';
        return { range: { end: new vscode.Position(i, line.length) } };
      },
      save: jest.fn(async () => {
        await fs.writeFile(tmp, buffer, 'utf8');
        return true;
      }),
    };
    (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments = [doc];
    (vscode.workspace.applyEdit as jest.Mock).mockImplementation(async (edit: { replacements: Array<{ newText: string }> }) => {
      const next = edit.replacements[0]?.newText;
      if (next !== undefined) buffer = next;
      return true;
    });

    await patchNuGetConfigFile(tmp, (xml) => setPackageSourceDisabled(xml, 'nexus', true));

    const onDisk = await fs.readFile(tmp, 'utf8');
    expect(onDisk).toContain('<!-- dirty -->');
    expect(onDisk).toContain('disabledPackageSources');
    expect(doc.save).toHaveBeenCalled();
    await fs.unlink(tmp).catch(() => undefined);
  });
});
