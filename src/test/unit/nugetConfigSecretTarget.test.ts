import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  extractApiKeyUrls,
  extractCredentialUsernames,
  setPackageSourceCredentials,
} from '../../nugetConfigEdit';
import {
  EMPTY_NUGET_CONFIG,
  ensureNuGetConfigFile,
  planSecretWrite,
  writeSourceSecrets,
} from '../../nugetConfigSecretTarget';

const REPO = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="nexus" value="https://nexus.example/index.json" />
  </packageSources>
</configuration>`;

describe('planSecretWrite', () => {
  it('writes workspace sources to the user config and strips the repo file', () => {
    expect(planSecretWrite('/ws/nuget.config', '/users/me/NuGet/NuGet.Config')).toEqual({
      targetPath: '/users/me/NuGet/NuGet.Config',
      stripPath: '/ws/nuget.config',
    });
  });

  it('writes in place when the declared file is already the user config', () => {
    const user = '/users/me/NuGet/NuGet.Config';
    expect(planSecretWrite(user, user)).toEqual({ targetPath: user });
  });
});

describe('writeSourceSecrets', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ave-nuget-secrets-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('stores password in user config and removes it from the workspace file', async () => {
    const repo = path.join(dir, 'repo', 'nuget.config');
    const user = path.join(dir, 'user', 'NuGet.Config');
    await fs.mkdir(path.dirname(repo), { recursive: true });
    await fs.writeFile(repo, REPO, 'utf8');
    await ensureNuGetConfigFile(user);

    const result = await writeSourceSecrets({
      declaredFilePath: repo,
      userConfigPath: user,
      sourceName: 'nexus',
      sourceUrl: 'https://nexus.example/index.json',
      username: 'ci',
      password: 'hunter2',
    });

    expect(result).toEqual({ targetPath: user, strippedDeclared: true });
    const userXml = await fs.readFile(user, 'utf8');
    const repoXml = await fs.readFile(repo, 'utf8');
    expect(extractCredentialUsernames(userXml)).toEqual({ nexus: 'ci' });
    expect(userXml).toContain('hunter2');
    expect(repoXml).not.toContain('hunter2');
    expect(repoXml).not.toContain('packageSourceCredentials');
    expect(repoXml).toContain('https://nexus.example/index.json');
  });

  it('copies an existing workspace password when only the username is saved', async () => {
    const repo = path.join(dir, 'repo', 'nuget.config');
    const user = path.join(dir, 'user', 'NuGet.Config');
    await fs.mkdir(path.dirname(repo), { recursive: true });
    const withPass = setPackageSourceCredentials(REPO, 'nexus', {
      username: 'old',
      password: 'hunter2',
    });
    await fs.writeFile(repo, withPass, 'utf8');
    await fs.mkdir(path.dirname(user), { recursive: true });
    await fs.writeFile(user, EMPTY_NUGET_CONFIG, 'utf8');

    await writeSourceSecrets({
      declaredFilePath: repo,
      userConfigPath: user,
      sourceName: 'nexus',
      sourceUrl: 'https://nexus.example/index.json',
      username: 'ci',
    });

    const userXml = await fs.readFile(user, 'utf8');
    const repoXml = await fs.readFile(repo, 'utf8');
    expect(extractCredentialUsernames(userXml).nexus).toBe('ci');
    expect(userXml).toContain('hunter2');
    expect(repoXml).not.toContain('hunter2');
  });

  it('stores an API key in user config and strips it from the workspace file', async () => {
    const repo = path.join(dir, 'repo', 'nuget.config');
    const user = path.join(dir, 'user', 'NuGet.Config');
    const url = 'https://nexus.example/index.json';
    await fs.mkdir(path.dirname(repo), { recursive: true });
    await fs.writeFile(repo, REPO, 'utf8');
    await ensureNuGetConfigFile(user);

    await writeSourceSecrets({
      declaredFilePath: repo,
      userConfigPath: user,
      sourceName: 'nexus',
      sourceUrl: url,
      apiKey: 'oy2-secret',
    });

    const userXml = await fs.readFile(user, 'utf8');
    const repoXml = await fs.readFile(repo, 'utf8');
    expect(extractApiKeyUrls(userXml)).toEqual([url]);
    expect(repoXml).not.toContain('oy2-secret');
    expect(extractApiKeyUrls(repoXml)).toEqual([]);
    if (process.platform === 'win32') {
      expect(userXml).not.toContain('oy2-secret');
    } else {
      expect(userXml).toContain('oy2-secret');
    }
  });
});
