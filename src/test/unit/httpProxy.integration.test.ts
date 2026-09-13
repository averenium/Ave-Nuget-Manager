import * as http from 'http';
import * as net from 'net';
import type { AddressInfo } from 'net';
import { fetchJsonStatus, ProxyUnsupportedError } from '../../nugetHttpJson';
import { ProxyRegistry } from '../../nugetProxyRegistry';
import { proxyFromConfigXml } from '../../nugetProxy';

/**
 * A real proxy, a real origin, real sockets.
 *
 * The decision module is tested on its own; what only a live pair can show is
 * that the request actually goes where it was sent — the measurement that
 * started this work found an agent being silently replaced, which no unit test
 * could have caught.
 */
let proxy: http.Server;
let origin: http.Server;
let proxyUrl: string;
let originUrl: string;
const seen = { connect: [] as string[], absolute: [] as string[], auth: [] as (string | undefined)[] };
let requireProxyAuth = false;
/** The answer a proxy gives when a tunnel is open; built without escapes. */
const CRLF = String.fromCharCode(13, 10);
const CONNECT_OK = `HTTP/1.1 200 Connection Established${CRLF}${CRLF}`;
/**
 * A socket upgraded by CONNECT is detached from the server, so closing the
 * server does not close it — and a TLS handshake that never completes would
 * hold the test process open.
 */
const tunnels: Array<{ destroy(): void }> = [];

beforeAll(async () => {
  proxy = http.createServer((req, res) => {
    seen.absolute.push(req.url ?? '');
    seen.auth.push(req.headers['proxy-authorization'] as string | undefined);
    // An absolute-URI request: fetch it for the client, plainly.
    const target = new URL(req.url ?? '');
    const upstream = http.request(
      { host: target.hostname, port: target.port, path: target.pathname + target.search },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    upstream.end();
  });
  proxy.on('connect', (req, clientSocket, head) => {
    seen.connect.push(req.url ?? '');
    seen.auth.push(req.headers['proxy-authorization'] as string | undefined);
    if (requireProxyAuth && !req.headers['proxy-authorization']) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      clientSocket.end();
      return;
    }
    tunnels.push(clientSocket);
    const [host, port] = (req.url ?? '').split(':');
    const upstream = net.connect(Number(port), host, () => {
      tunnels.push(upstream);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
  });

  origin = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ reached: 'origin' }));
  });

  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  originUrl = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
});

afterEach(() => {
  for (const socket of tunnels.splice(0)) socket.destroy();
});

afterAll(async () => {
  proxy.closeAllConnections?.();
  origin.closeAllConnections?.();
  await new Promise<void>((r) => proxy.close(() => r()));
  await new Promise<void>((r) => origin.close(() => r()));
});

beforeEach(() => {
  seen.connect = [];
  seen.absolute = [];
  seen.auth = [];
  requireProxyAuth = false;
});

const config = (inner: string) => `<?xml version="1.0" encoding="utf-8"?>
<configuration><config>
${inner}
</config></configuration>`;

async function registryFor(inner: string): Promise<ProxyRegistry> {
  const registry = new ProxyRegistry();
  const layer = proxyFromConfigXml(config(inner));
  if (layer) await registry.remember(originUrl, layer);
  return registry;
}

describe('an http feed behind a proxy', () => {
  it('goes through the proxy, named by absolute URI', async () => {
    const registry = await registryFor(`<add key="http_proxy" value="${proxyUrl}" />`);

    const result = await fetchJsonStatus(`${originUrl}/v3/index.json`, undefined, undefined, {
      route: (url) => registry.routeFor(url),
    });

    expect(result.json).toEqual({ reached: 'origin' });
    expect(seen.absolute).toEqual([`${originUrl}/v3/index.json`]);
  });

  it('carries the proxy credential to the proxy, not to the feed', async () => {
    const registry = await registryFor(`
      <add key="http_proxy" value="${proxyUrl}" />
      <add key="http_proxy.user" value="agent" />
      <add key="http_proxy.clearTextPassword" value="s3cret" />`);

    await fetchJsonStatus(`${originUrl}/v3/index.json`, undefined, undefined, {
      route: (url) => registry.routeFor(url),
    });

    expect(seen.auth[0]).toBe(`Basic ${Buffer.from('agent:s3cret').toString('base64')}`);
  });

  it('goes direct when the same layer excludes this host', async () => {
    const registry = await registryFor(`
      <add key="http_proxy" value="${proxyUrl}" />
      <add key="no_proxy" value="127.0.0.1" />`);

    const result = await fetchJsonStatus(`${originUrl}/v3/index.json`, undefined, undefined, {
      route: (url) => registry.routeFor(url),
    });

    expect(result.json).toEqual({ reached: 'origin' });
    expect(seen.absolute).toEqual([]);
    expect(seen.connect).toEqual([]);
  });

  it('refuses a proxy it cannot speak to, rather than slipping past it', async () => {
    // The one outcome that is never acceptable is a silent direct request where
    // a proxy was declared.
    const registry = await registryFor('<add key="http_proxy" value="socks5://proxy.corp:1080" />');

    await expect(fetchJsonStatus(`${originUrl}/v3/index.json`, undefined, undefined, {
      route: (url) => registry.routeFor(url),
    })).rejects.toBeInstanceOf(ProxyUnsupportedError);
    expect(seen.absolute).toEqual([]);
  });

  it('is unaffected when no layer claims the address', async () => {
    const registry = new ProxyRegistry();

    const result = await fetchJsonStatus(`${originUrl}/v3/index.json`, undefined, undefined, {
      route: (url) => registry.routeFor(url),
    });

    expect(result.json).toEqual({ reached: 'origin' });
    expect(seen.absolute).toEqual([]);
  });
});

describe('a proxy that accepts the tunnel and then says nothing', () => {
  /** Accepts CONNECT, answers 200, and never speaks again. */
  let silent: http.Server;
  let silentUrl: string;
  const held: Array<{ destroy(): void }> = [];

  beforeAll(async () => {
    silent = http.createServer();
    silent.on('connect', (_req, clientSocket) => {
      clientSocket.write(CONNECT_OK);
      held.push(clientSocket);
    });
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    silentUrl = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const socket of held.splice(0)) socket.destroy();
    silent.closeAllConnections?.();
    await new Promise<void>((r) => silent.close(() => r()));
  });

  it('gives up instead of waiting forever', async () => {
    // The handshake happens before the request exists, so the signal the
    // request would have carried cannot reach it. Without its own way out this
    // never finishes: no answer, and no fallback to the CLI either.
    const { tunnelledTlsSocket } = await import('../../nugetProxyConnect');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    const started = Date.now();
    await expect(tunnelledTlsSocket({
      proxy: new URL(silentUrl),
      host: 'api.example',
      port: 443,
      signal: controller.signal,
    })).rejects.toBeDefined();

    expect(Date.now() - started).toBeLessThan(3_000);
  }, 10_000);

  it('refuses at once when the caller has already cancelled', async () => {
    const { tunnelledTlsSocket } = await import('../../nugetProxyConnect');
    const controller = new AbortController();
    controller.abort();

    await expect(tunnelledTlsSocket({
      proxy: new URL(silentUrl),
      host: 'api.example',
      port: 443,
      signal: controller.signal,
    })).rejects.toBeDefined();
  }, 10_000);
});

describe('a tunnelled target', () => {
  /** The CONNECT is what matters here; TLS above it needs a certificate. */
  async function openTunnel(authorization?: string): Promise<unknown> {
    const { tunnelledTlsSocket } = await import('../../nugetProxyConnect');
    const target = new URL(originUrl);
    const attempt = tunnelledTlsSocket({
      proxy: new URL(proxyUrl),
      host: target.hostname,
      port: Number(target.port),
      authorization,
    }).then(() => 'tunnel opened', (err: unknown) => err);
    // A plain server never completes a TLS handshake, so the tunnel is judged
    // by what the proxy saw rather than by what came back through it.
    return Promise.race([attempt, new Promise((r) => setTimeout(() => r('still open'), 300))]);
  }

  it('opens a CONNECT tunnel and authenticates to the proxy on it', async () => {
    requireProxyAuth = true;
    const registry = await registryFor(`
      <add key="http_proxy" value="${proxyUrl}" />
      <add key="http_proxy.user" value="agent" />
      <add key="http_proxy.clearTextPassword" value="s3cret" />`);
    const route = registry.routeFor(`${originUrl}/v3/index.json`) as { authorization?: string };

    await openTunnel(route.authorization);

    expect(seen.connect).toEqual([`127.0.0.1:${new URL(originUrl).port}`]);
    expect(seen.auth[0]).toBe(`Basic ${Buffer.from('agent:s3cret').toString('base64')}`);
  });

  it('reports a proxy that demands credentials as exactly that', async () => {
    requireProxyAuth = true;
    const { ProxyRefusedError } = await import('../../nugetProxyConnect');

    const failure = await openTunnel(undefined);

    expect(failure).toBeInstanceOf(ProxyRefusedError);
    expect((failure as { status: number }).status).toBe(407);
  });
});
