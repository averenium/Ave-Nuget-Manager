import {
  chooseProxy,
  isExcluded,
  proxyAuthHeader,
  proxyFromConfigXml,
  proxyFromEnvironment,
  type ProxyLayer,
} from '../../nugetProxy';

const config = (inner: string) => `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <config>
${inner}
  </config>
</configuration>`;

describe('proxyFromConfigXml', () => {
  it('reads the proxy the configuration declares', () => {
    const layer = proxyFromConfigXml(config(`
    <add key="http_proxy" value="http://proxy.corp:3128" />
    <add key="http_proxy.user" value="build-agent" />
    <add key="http_proxy.password" value="AQAAANCM" />
    <add key="no_proxy" value="localhost,.corp" />`));

    expect(layer).toEqual({
      url: 'http://proxy.corp:3128',
      // The one declaration serves both schemes when only `http_proxy` is given.
      plainUrl: 'http://proxy.corp:3128',
      noProxy: 'localhost,.corp',
      user: 'build-agent',
      password: 'AQAAANCM',
      encryptedPassword: true,
      origin: 'config',
    });
  });

  it('prefers the https entry when a file carries both', () => {
    const layer = proxyFromConfigXml(config(`
    <add key="http_proxy" value="http://plain.corp:3128" />
    <add key="https_proxy" value="http://secure.corp:3128" />`));

    expect(layer?.url).toBe('http://secure.corp:3128');
  });

  it('expands an environment reference the way the rest of the file does', () => {
    process.env.AVE_TEST_PROXY = 'http://from-env:3128';
    try {
      const layer = proxyFromConfigXml(config('    <add key="http_proxy" value="%AVE_TEST_PROXY%" />'));
      expect(layer?.url).toBe('http://from-env:3128');
    } finally {
      delete process.env.AVE_TEST_PROXY;
    }
  });

  it('unescapes what XML had to escape, as the credentials reader does', () => {
    // A proxy password with an ampersand is ordinary, and getting it wrong ends
    // in a 407 and a silent fallback to the CLI — the very situation this
    // feature exists to avoid.
    const layer = proxyFromConfigXml(config(`
    <add key="http_proxy" value="http://proxy.corp:3128/?a=1&amp;b=2" />
    <add key="http_proxy.user" value="corp&amp;domain\agent" />
    <add key="http_proxy.clearTextPassword" value="p&amp;ss&lt;word&gt;" />`));

    expect(layer?.url).toBe('http://proxy.corp:3128/?a=1&b=2');
    expect(layer?.user).toBe('corp&domain\agent');
    expect(layer?.password).toBe('p&ss<word>');
  });

  it('says nothing for a file that declares neither a proxy nor exclusions', () => {
    expect(proxyFromConfigXml(config('    <add key="globalPackagesFolder" value="D:\\\\packages" />')))
      .toBeUndefined();
    expect(proxyFromConfigXml('<configuration />')).toBeUndefined();
  });

  it('ignores a commented-out declaration', () => {
    expect(proxyFromConfigXml(config(`
    <!-- <add key="http_proxy" value="http://old.corp:3128" /> -->`))).toBeUndefined();
  });
});

describe('proxyFromEnvironment', () => {
  it('reads the usual variables, either case', () => {
    expect(proxyFromEnvironment({ HTTPS_PROXY: 'http://a:3128', NO_PROXY: 'localhost' }))
      .toEqual({ url: 'http://a:3128', noProxy: 'localhost', origin: 'environment' });
    expect(proxyFromEnvironment({ http_proxy: 'http://b:3128' })?.url).toBe('http://b:3128');
  });

  it('prefers the secure variable, since every feed address is https', () => {
    expect(proxyFromEnvironment({ HTTP_PROXY: 'http://plain:3128', HTTPS_PROXY: 'http://secure:3128' })?.url)
      .toBe('http://secure:3128');
  });

  it('keeps the plain-http proxy apart from the secure one', () => {
    const layer = proxyFromEnvironment({ HTTPS_PROXY: 'http://secure:3128', HTTP_PROXY: 'http://plain:3128' });

    expect(layer?.url).toBe('http://secure:3128');
    expect(layer?.plainUrl).toBe('http://plain:3128');
  });

  it('says nothing when the environment declares nothing', () => {
    expect(proxyFromEnvironment({})).toBeUndefined();
  });
});

describe('isExcluded', () => {
  const target = (url: string) => new URL(url);

  it('matches a domain and everything under it', () => {
    expect(isExcluded(target('https://feed.corp/v3/index.json'), '.corp')).toBe(true);
    expect(isExcluded(target('https://feed.corp/v3/index.json'), 'corp')).toBe(true);
    expect(isExcluded(target('https://nuget.org/v3/index.json'), '.corp')).toBe(false);
  });

  it('matches a host outright and honours a port when one is given', () => {
    expect(isExcluded(target('https://feed.corp/a'), 'feed.corp')).toBe(true);
    expect(isExcluded(target('https://feed.corp:8443/a'), 'feed.corp:8443')).toBe(true);
    expect(isExcluded(target('https://feed.corp/a'), 'feed.corp:8443')).toBe(false);
  });

  it('reads the implied port of the scheme', () => {
    expect(isExcluded(target('https://feed.corp/a'), 'feed.corp:443')).toBe(true);
    expect(isExcluded(target('http://feed.corp/a'), 'feed.corp:80')).toBe(true);
  });

  it('accepts the star that excludes everything', () => {
    expect(isExcluded(target('https://anything.example/a'), '*')).toBe(true);
  });

  it('takes a list separated by commas or spaces', () => {
    expect(isExcluded(target('https://feed.corp/a'), 'localhost, .corp , 127.0.0.1')).toBe(true);
    expect(isExcluded(target('https://feed.corp/a'), 'localhost 127.0.0.1')).toBe(false);
  });

  it('excludes nothing when the list is absent or empty', () => {
    expect(isExcluded(target('https://feed.corp/a'), undefined)).toBe(false);
    expect(isExcluded(target('https://feed.corp/a'), '   ')).toBe(false);
  });
});

describe('chooseProxy', () => {
  const fromConfig: ProxyLayer = { url: 'http://config-proxy:3128', origin: 'config' };
  const fromEnv: ProxyLayer = { url: 'http://env-proxy:3128', origin: 'environment' };

  it('lets the configuration outrank the environment', () => {
    const decision = chooseProxy('https://feed.corp/v3/index.json', [fromConfig, fromEnv]);

    expect(decision).toMatchObject({ kind: 'proxy', layer: { origin: 'config' } });
    expect((decision as { url: URL }).url.host).toBe('config-proxy:3128');
  });

  it('goes direct when the layer that has the proxy excludes this address', () => {
    // And it stops there: a lower layer must not proxy what a higher one
    // excluded.
    const decision = chooseProxy('https://feed.corp/v3/index.json', [
      { ...fromConfig, noProxy: '.corp' },
      fromEnv,
    ]);

    expect(decision).toEqual({ kind: 'direct', reason: 'excluded' });
  });

  it('does not let one layer exclusions silence another layer proxy', () => {
    // The exclusions belong to the proxy of their own layer; a layer that
    // declares only exclusions claims nothing.
    const decision = chooseProxy('https://feed.corp/v3/index.json', [
      { noProxy: '.corp', origin: 'config' },
      fromEnv,
    ]);

    expect(decision).toMatchObject({ kind: 'proxy', layer: { origin: 'environment' } });
  });

  it('leaves the request unclaimed when no layer names a proxy', () => {
    expect(chooseProxy('https://feed.corp/a', [])).toEqual({ kind: 'unclaimed' });
    expect(chooseProxy('https://feed.corp/a', [{ noProxy: 'other', origin: 'config' }]))
      .toEqual({ kind: 'unclaimed' });
  });

  it('refuses a proxy it cannot speak to, rather than going direct past it', () => {
    // Bypassing a declared proxy in silence is the one outcome never allowed;
    // the caller falls back to the CLI instead.
    expect(chooseProxy('https://feed.corp/a', [{ url: 'socks5://proxy.corp:1080', origin: 'config' }]))
      .toMatchObject({ kind: 'unsupported', declared: 'socks5://proxy.corp:1080' });
    expect(chooseProxy('https://feed.corp/a', [{ url: 'not a url', origin: 'config' }]))
      .toMatchObject({ kind: 'unsupported' });
  });

  it('takes the plain-http proxy for a plain-http target', () => {
    // One variable per scheme is the convention, and the CLI follows it.
    const layers = [{ url: 'http://secure:3128', plainUrl: 'http://plain:3128', origin: 'config' as const }];

    expect((chooseProxy('https://feed.corp/a', layers) as { url: URL }).url.host).toBe('secure:3128');
    expect((chooseProxy('http://feed.corp/a', layers) as { url: URL }).url.host).toBe('plain:3128');
  });

  it('falls back to the one proxy a layer names, whatever the scheme', () => {
    const layers = [{ url: 'http://only:3128', origin: 'config' as const }];

    expect((chooseProxy('http://feed.corp/a', layers) as { url: URL }).url.host).toBe('only:3128');
  });

  it('claims nothing for an address it cannot read', () => {
    expect(chooseProxy('not a url', [fromConfig])).toEqual({ kind: 'unclaimed' });
  });
});

describe('proxyAuthHeader', () => {
  it('builds the header from the layer credentials', () => {
    const header = proxyAuthHeader({ url: 'http://p:3128', user: 'u', password: 'p', origin: 'config' });

    expect(header).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('takes a password recovered elsewhere, for the encrypted form', () => {
    const header = proxyAuthHeader(
      { url: 'http://p:3128', user: 'u', password: 'AQAAANCM', encryptedPassword: true, origin: 'config' },
      'decrypted',
    );

    expect(Buffer.from(header!.slice('Basic '.length), 'base64').toString()).toBe('u:decrypted');
  });

  it('gives nothing when the proxy needs no credentials', () => {
    expect(proxyAuthHeader({ url: 'http://p:3128', origin: 'config' })).toBeUndefined();
  });
});
