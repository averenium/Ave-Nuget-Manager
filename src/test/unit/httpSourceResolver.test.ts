import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createConfigSourceResolver, resolveConfigSources } from '../../backend/httpSourceResolver';
import { CredentialRegistry } from '../../nugetHttpAuth';

const CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="corp" value="https://feed.example/v3/index.json" />
    <add key="local" value="D:\\packages" />
  </packageSources>
  <packageSourceCredentials>
    <corp>
      <add key="Username" value="build-agent" />
      <add key="ClearTextPassword" value="s3cret" />
    </corp>
  </packageSourceCredentials>
</configuration>`;

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ave-resolver-'));
  file = path.join(dir, 'nuget.config');
  await fs.writeFile(file, CONFIG, 'utf8');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('resolveConfigSources', () => {
  it('separates the feeds it can serve from the ones it cannot', async () => {
    const resolved = await resolveConfigSources(file);

    expect(resolved.targets).toEqual([{
      name: 'corp',
      url: 'https://feed.example/v3/index.json',
      protocolVersion: undefined,
      knownOrigins: ['https://feed.example/v3/index.json'],
    }]);
    expect(resolved.hasNonHttpSource).toBe(true);
  });

  it('registers the credential the file declares for a feed', async () => {
    const registry = new CredentialRegistry();

    await resolveConfigSources(file, registry);

    expect(await registry.headerFor('https://feed.example/v3/flat/a/index.json'))
      .toBe(`Basic ${Buffer.from('build-agent:s3cret').toString('base64')}`);
  });

  it('will not call a plain-connection feed the configuration never allowed', async () => {
    // NuGet refuses such a source outright; doing it over HTTP anyway would let
    // this feature reach a feed the CLI would not.
    await fs.writeFile(file, CONFIG.replace(
      '<add key="corp" value="https://feed.example/v3/index.json" />',
      '<add key="plain" value="http://feed.example/v3/index.json" />',
    ), 'utf8');

    const resolved = await resolveConfigSources(file);

    expect(resolved.targets).toEqual([]);
    expect(resolved.hasNonHttpSource).toBe(true);
  });

  it('calls one the configuration did allow', async () => {
    await fs.writeFile(file, CONFIG.replace(
      '<add key="corp" value="https://feed.example/v3/index.json" />',
      '<add key="plain" value="http://feed.example/v3/index.json" allowInsecureConnections="true" />',
    ), 'utf8');

    const resolved = await resolveConfigSources(file);

    expect(resolved.targets.map((t) => t.url)).toEqual(['http://feed.example/v3/index.json']);
  });

  it('answers for a file that does not exist instead of throwing', async () => {
    const resolved = await resolveConfigSources(path.join(dir, 'absent.config'));

    expect(resolved).toEqual({ targets: [], hasNonHttpSource: false });
  });
});

describe('createConfigSourceResolver', () => {
  /** A timestamp with no sub-millisecond part, so it can be restored exactly. */
  const FROZEN = new Date(2020, 0, 1, 12, 0, 0);

  it('does not read the file again while nothing about it has changed', async () => {
    // The rewrite below keeps the size and the timestamp, so nothing the
    // resolver looks at has changed; an answer still describing the old content
    // is what proves the file was not read a second time.
    await fs.utimes(file, FROZEN, FROZEN);
    const resolve = createConfigSourceResolver();
    expect((await resolve(file)).targets[0].url).toContain('feed.example');

    const before = (await fs.stat(file)).size;
    await fs.writeFile(file, CONFIG.replace('feed.example', 'feed.examplz'), 'utf8');
    await fs.utimes(file, FROZEN, FROZEN);
    expect((await fs.stat(file)).size).toBe(before);

    expect((await resolve(file)).targets[0].url).toContain('feed.example');
  });

  it('reads the file again once it has changed', async () => {
    const resolve = createConfigSourceResolver();
    await resolve(file);

    await fs.writeFile(file, CONFIG.replace('feed.example', 'a-different-host.example'), 'utf8');

    expect((await resolve(file)).targets[0].url).toContain('a-different-host.example');
  });

  it('keeps the credential registered after the registry was cleared', async () => {
    // The cached answer must not be the reason a private feed stops working.
    const registry = new CredentialRegistry();
    const resolve = createConfigSourceResolver(registry);
    await resolve(file);
    registry.clear();

    await resolve(file);

    expect(await registry.headerFor('https://feed.example/v3/index.json')).toBeDefined();
  });

  it('does not remember a file it could not read', async () => {
    const resolve = createConfigSourceResolver();
    const absent = path.join(dir, 'later.config');

    expect((await resolve(absent)).targets).toEqual([]);

    await fs.writeFile(absent, CONFIG, 'utf8');

    expect((await resolve(absent)).targets).toHaveLength(1);
  });
});
