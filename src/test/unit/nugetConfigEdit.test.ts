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
  findPackageSourceLine,
  replaceAuditSources,
  removeAuditSource,
  upsertAuditSource,
  writeSourceApiKey,
} from '../../nugetConfigEdit';

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

  it('does not accumulate blank lines around the add when toggling enable', () => {
    let xml = BASE;
    for (let i = 0; i < 6; i++) {
      xml = setPackageSourceDisabled(xml, 'nexus', i % 2 === 0);
    }
    expect(xml).toMatch(
      /<disabledPackageSources>\n    <add key="nexus" value="false" \/>\n  <\/disabledPackageSources>/,
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

  it('upsertAuditSource does not add disabledPackageSources', () => {
    const next = upsertAuditSource(BASE, 'nuget.org', 'https://api.nuget.org/v3/index.json');
    expect(next).toMatch(/<auditSources>[\s\S]*nuget\.org/);
    expect(next).not.toContain('<disabledPackageSources>');
  });
});

describe('credentials', () => {
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
