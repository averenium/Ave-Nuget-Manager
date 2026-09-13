import {
  basicAuthHeader,
  credentialForSource,
  credentialsFromConfigXml,
  mayAuthenticate,
} from '../../nugetSourceCredentials';
import { authorizingFetcher, CredentialRegistry } from '../../nugetHttpAuth';
import { encryptNuGetConfigPassword } from '../../nugetConfigDpapi';
import type { HttpJsonResponse } from '../../nugetSourceCapabilities';

const config = (inner: string) => `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="corp" value="https://feed.example/v3/index.json" />
  </packageSources>
  <packageSourceCredentials>
${inner}
  </packageSourceCredentials>
</configuration>`;

describe('credentialsFromConfigXml', () => {
  it('reads a username and a password given in the clear', () => {
    const found = credentialsFromConfigXml(config(`
    <corp>
      <add key="Username" value="build-agent" />
      <add key="ClearTextPassword" value="s3cret" />
    </corp>`));

    expect(found).toEqual({ corp: { username: 'build-agent', password: 's3cret', encrypted: false } });
  });

  it('keeps an encrypted password encrypted at this stage', () => {
    const found = credentialsFromConfigXml(config(`
    <corp>
      <add key="Username" value="build-agent" />
      <add key="Password" value="AQAAANCMnd8BFdERjHoAwE" />
    </corp>`));

    expect(found.corp).toEqual({ username: 'build-agent', password: 'AQAAANCMnd8BFdERjHoAwE', encrypted: true });
  });

  it('prefers the readable password when a file carries both', () => {
    const found = credentialsFromConfigXml(config(`
    <corp>
      <add key="Username" value="u" />
      <add key="Password" value="blob" />
      <add key="ClearTextPassword" value="plain" />
    </corp>`));

    expect(found.corp).toMatchObject({ password: 'plain', encrypted: false });
  });

  it('decodes a source name that had to be escaped as an element name', () => {
    // A source called "my feed" is written as `my_x0020_feed` in this section.
    const found = credentialsFromConfigXml(config(`
    <my_x0020_feed>
      <add key="Username" value="u" />
      <add key="ClearTextPassword" value="p" />
    </my_x0020_feed>`));

    expect(Object.keys(found)).toEqual(['my feed']);
    expect(credentialForSource(found, 'my feed')?.username).toBe('u');
  });

  it('ignores a block with no username and one that is commented out', () => {
    const found = credentialsFromConfigXml(config(`
    <nouser>
      <add key="ClearTextPassword" value="p" />
    </nouser>
    <!--
    <old>
      <add key="Username" value="u" />
      <add key="ClearTextPassword" value="p" />
    </old>
    -->`));

    expect(found).toEqual({});
  });

  it('unescapes what XML had to escape in the value', () => {
    const found = credentialsFromConfigXml(config(`
    <corp>
      <add key="Username" value="dom&amp;ain\\u" />
      <add key="ClearTextPassword" value="a&lt;b&gt;c" />
    </corp>`));

    expect(found.corp).toMatchObject({ username: 'dom&ain\\u', password: 'a<b>c' });
  });

  it('finds a credential whatever case the source name was written in', () => {
    const found = credentialsFromConfigXml(config(`
    <CORP>
      <add key="Username" value="u" />
      <add key="ClearTextPassword" value="p" />
    </CORP>`));

    expect(credentialForSource(found, 'corp')?.username).toBe('u');
  });
});

describe('basicAuthHeader', () => {
  it('builds the header the protocol expects', async () => {
    const header = await basicAuthHeader({ username: 'u', password: 'p', encrypted: false });

    expect(header).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('expands an environment reference the way the configuration does', async () => {
    process.env.AVE_TEST_TOKEN = 'from-env';
    try {
      const header = await basicAuthHeader({ username: 'u', password: '%AVE_TEST_TOKEN%', encrypted: false });

      expect(Buffer.from(header!.slice('Basic '.length), 'base64').toString()).toBe('u:from-env');
    } finally {
      delete process.env.AVE_TEST_TOKEN;
    }
  });

  it('gives nothing when there is nothing to send', async () => {
    expect(await basicAuthHeader({ username: '', password: '', encrypted: false })).toBeUndefined();
  });

  it('decrypts a stored password at the moment of use, on a machine that can', async () => {
    // The encrypted form is what `nuget.config` holds on Windows; elsewhere
    // NuGet only supports the clear form, and there the header is simply not
    // built, so the request goes out anonymous and the CLI takes the 401.
    const secret = 'p@ss word';
    if (process.platform !== 'win32') {
      expect(await basicAuthHeader({ username: 'u', password: 'blob', encrypted: true })).toBeUndefined();
      return;
    }
    const blob = await encryptNuGetConfigPassword(secret);

    const header = await basicAuthHeader({ username: 'u', password: blob, encrypted: true });

    expect(Buffer.from(header!.slice('Basic '.length), 'base64').toString()).toBe(`u:${secret}`);
    // Spawns the platform helper twice, like the round-trip test it borrows from.
  }, 30_000);

  it('sends nothing when a stored password cannot be recovered', async () => {
    expect(await basicAuthHeader({ username: 'u', password: 'not-a-real-blob', encrypted: true }))
      .toBeUndefined();
  });
});

describe('mayAuthenticate', () => {
  it('always allows a secure connection', () => {
    expect(mayAuthenticate('https://feed.example/v3/index.json')).toBe(true);
  });

  it('sends nothing over a plain connection unless the source declared it acceptable', () => {
    expect(mayAuthenticate('http://feed.example/v3/index.json')).toBe(false);
    expect(mayAuthenticate('http://feed.example/v3/index.json', true)).toBe(true);
  });

  it('refuses an address it cannot read', () => {
    expect(mayAuthenticate('not a url', true)).toBe(false);
  });
});

describe('CredentialRegistry', () => {
  function recordingFetcher() {
    const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
    const fetcher = async (url: string, _signal?: AbortSignal, headers?: Record<string, string>) => {
      seen.push({ url, headers });
      return { status: 200 } as HttpJsonResponse;
    };
    return { fetcher, seen };
  }

  const credential = { username: 'u', password: 'p', encrypted: false };
  const expected = `Basic ${Buffer.from('u:p').toString('base64')}`;

  it('attaches the credential to its own origin', async () => {
    const registry = new CredentialRegistry();
    registry.remember('https://feed.example/v3/index.json', credential);
    const { fetcher, seen } = recordingFetcher();

    await authorizingFetcher(fetcher, registry)('https://feed.example/v3/flat/a/index.json');

    expect(seen[0].headers).toEqual({ authorization: expected });
  });

  it('sends nothing to a sibling host of the same domain', async () => {
    // Reading a public document from a sibling host is fine; handing it a
    // password because it shares a domain is not.
    const registry = new CredentialRegistry();
    registry.remember('https://api.feed.example/v3/index.json', credential);
    const { fetcher, seen } = recordingFetcher();

    await authorizingFetcher(fetcher, registry)('https://search.feed.example/query?q=a');

    expect(seen[0].headers).toBeUndefined();
  });

  it('treats a different port or scheme as a different place', async () => {
    const registry = new CredentialRegistry();
    registry.remember('https://feed.example:8443/v3/index.json', credential);
    const { fetcher, seen } = recordingFetcher();

    await authorizingFetcher(fetcher, registry)('https://feed.example/v3/index.json');
    await authorizingFetcher(fetcher, registry)('https://feed.example:8443/v3/index.json');

    expect(seen[0].headers).toBeUndefined();
    expect(seen[1].headers).toEqual({ authorization: expected });
  });

  it('withholds a credential from a plain connection the source did not declare', async () => {
    const registry = new CredentialRegistry();
    registry.remember('http://feed.example/v3/index.json', credential);
    const { fetcher, seen } = recordingFetcher();

    await authorizingFetcher(fetcher, registry)('http://feed.example/v3/index.json');

    expect(seen[0].headers).toBeUndefined();
  });

  it('sends it over a plain connection the source did declare', async () => {
    const registry = new CredentialRegistry();
    registry.remember('http://feed.example/v3/index.json', credential, true);
    const { fetcher, seen } = recordingFetcher();

    await authorizingFetcher(fetcher, registry)('http://feed.example/v3/flat/a/index.json');

    expect(seen[0].headers).toEqual({ authorization: expected });
  });

  it('leaves an unconfigured origin anonymous', async () => {
    const registry = new CredentialRegistry();
    registry.remember('https://feed.example/v3/index.json', credential);
    const { fetcher, seen } = recordingFetcher();

    await authorizingFetcher(fetcher, registry)('https://elsewhere.example/v3/index.json');

    expect(seen[0].headers).toBeUndefined();
  });

  it('forgets everything when the configuration changes', async () => {
    const registry = new CredentialRegistry();
    registry.remember('https://feed.example/v3/index.json', credential);
    registry.clear();
    const { fetcher, seen } = recordingFetcher();

    await authorizingFetcher(fetcher, registry)('https://feed.example/v3/index.json');

    expect(seen[0].headers).toBeUndefined();
  });
});
