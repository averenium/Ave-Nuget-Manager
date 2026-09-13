import * as http from 'http';
import type { AddressInfo } from 'net';
import { fetchJsonStatus } from '../../nugetHttpJson';
import { authorizingFetcher, CredentialRegistry } from '../../nugetHttpAuth';
import { httpLogSink, loggingFetcher } from '../../nugetHttpLog';
import { SourceCapabilityStore } from '../../nugetSourceCapabilities';
import { VersionLadder } from '../../nugetVersionLadder';
import type { CliLogEntry } from '../../logger';

/**
 * A real server, a real socket and the real transport — the one thing mocks
 * cannot show is whether the header actually arrives, and whether a feed that
 * refuses anonymous callers starts working once it does.
 *
 * It answers like a private feed: 401 without the credential, and the v3
 * documents with it.
 */
const USER = 'build-agent';
const PASSWORD = 'p@ss word';
const EXPECTED = `Basic ${Buffer.from(`${USER}:${PASSWORD}`, 'utf8').toString('base64')}`;

let server: http.Server;
let origin: string;
let anonymousHits = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.headers.authorization !== EXPECTED) {
      anonymousHits += 1;
      res.writeHead(401, { 'www-authenticate': 'Basic realm="feed"' });
      res.end();
      return;
    }
    const url = req.url ?? '';
    const body = url.startsWith('/v3/index.json')
      ? JSON.stringify({
          resources: [{ '@type': 'PackageBaseAddress/3.0.0', '@id': `${origin}/v3/flat/` }],
        })
      : url.startsWith('/v3/flat/example.core/index.json')
        ? JSON.stringify({ versions: ['1.0.0', '2.0.0', '2.1.0-rc.1'] })
        : undefined;
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  // The platform fetch keeps sockets alive for reuse, so the listener alone
  // closing would leave the test worker waiting on them.
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => { anonymousHits = 0; });

function stack(registry: CredentialRegistry) {
  const rows: CliLogEntry[] = [];
  const log = httpLogSink({ logCliOperation: (entry) => { rows.push(entry); } });
  const fetcher = authorizingFetcher(loggingFetcher(fetchJsonStatus, log), registry);
  const capabilities = new SourceCapabilityStore(fetcher, undefined, Date.now, () => true);
  return {
    rows,
    capabilities,
    ladder: new VersionLadder(capabilities, fetcher, { isEnabled: () => true, log }),
  };
}

const credential = { username: USER, password: PASSWORD, encrypted: false };

describe('a private feed over the real transport', () => {
  it('is unusable without a credential, and the source is marked as needing one', async () => {
    const { capabilities } = stack(new CredentialRegistry());

    const record = await capabilities.ensure({ url: `${origin}/v3/index.json` });

    expect(record.index).toBe('unauthorized');
    expect(anonymousHits).toBeGreaterThan(0);
  });

  it('answers once the credential travels with the request', async () => {
    const registry = new CredentialRegistry();
    // A plain connection carries a password only where the source declared it
    // acceptable, which is the same switch NuGet requires for an http feed.
    registry.remember(`${origin}/v3/index.json`, credential, true);
    const { ladder } = stack(registry);

    const listing = await ladder.versionsFromSource(
      { url: `${origin}/v3/index.json`, name: 'private-feed' },
      { packageId: 'Example.Core', includePrerelease: true },
    );

    expect(listing).toEqual({
      sourceUrl: `${origin}/v3/index.json`,
      versions: ['2.1.0-rc.1', '2.0.0', '1.0.0'],
      rung: 'content',
    });
    expect(anonymousHits).toBe(0);
  });

  it('withholds the password from a plain connection nobody declared acceptable', async () => {
    const registry = new CredentialRegistry();
    registry.remember(`${origin}/v3/index.json`, credential);
    const { capabilities } = stack(registry);

    expect((await capabilities.ensure({ url: `${origin}/v3/index.json` })).index).toBe('unauthorized');
  });

  it('puts every request on the log, saying which carried a credential', async () => {
    const registry = new CredentialRegistry();
    registry.remember(`${origin}/v3/index.json`, credential, true);
    const { ladder, rows } = stack(registry);

    await ladder.versionsFromSource(
      { url: `${origin}/v3/index.json`, name: 'private-feed' },
      { packageId: 'Example.Core' },
    );

    const requests = rows.filter((r) => r.command.startsWith('GET '));
    expect(requests.map((r) => r.command)).toEqual([
      `GET ${origin}/v3/index.json`,
      `GET ${origin}/v3/flat/example.core/index.json`,
    ]);
    expect(requests.every((r) => r.args.includes('authenticated'))).toBe(true);
    expect(requests.every((r) => r.kind === 'http')).toBe(true);
    // The rung that answered is on the log beside the requests it made.
    expect(rows.some((r) => r.command.includes('from content resource'))).toBe(true);
    // Nothing anywhere in the log resembles the credential.
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
    expect(JSON.stringify(rows)).not.toContain(EXPECTED);
  });
});
