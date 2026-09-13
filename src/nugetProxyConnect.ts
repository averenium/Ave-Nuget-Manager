/**
 * Reaching a target through a proxy, on the only path the editor leaves open (#27).
 *
 * Measured inside the extension host: with `http.proxySupport` at its default,
 * VS Code's patch **replaces an agent** handed to `https.request` — the same
 * agent tunnels correctly in plain Node and is discarded here. What the patch
 * does not touch is a connection given at the options level, so that is how a
 * proxy is carried: the socket is built here and handed over as
 * `createConnection` with `agent: false`.
 *
 * Two shapes, both from built-in modules:
 *
 * - an **https** target needs a tunnel — `CONNECT host:443` to the proxy, then
 *   TLS over the socket that comes back;
 * - an **http** target needs no tunnel at all — the request goes to the proxy
 *   with an absolute URI, which the transport handles by addressing the proxy.
 *
 * `Proxy-Authorization` travels on the `CONNECT` itself, never on the request
 * inside the tunnel: it authenticates the client to the proxy, and the feed has
 * no business seeing it.
 *
 * **Certificates are not read here.** An intercepted network presents a root
 * that lives in the machine's store rather than in the bundle Node ships, and
 * the editor supplies those roots by replacing the exported
 * `tls.createSecureContext`. Measured: `tls.connect` consults that exported
 * factory, so the roots reach this tunnel as well — which is why there is no
 * platform-specific certificate code anywhere in this feature. The assumption
 * is pinned by `tlsTrustReachesUs.test.ts`, so a runtime that stops consulting
 * it fails a test instead of failing a user.
 */

import * as http from 'http';
import * as net from 'net';
import * as tls from 'tls';

/** True for an address written as a number rather than a name. */
function isIpLiteral(host: string): boolean {
  return net.isIP(host) !== 0;
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

/** A proxy that answered `CONNECT` with something other than success. */
export class ProxyRefusedError extends Error {
  constructor(readonly status: number, proxy: string) {
    super(`Proxy ${proxy} refused the tunnel with status ${status}`);
    this.name = 'ProxyRefusedError';
  }
}

export interface TunnelRequest {
  proxy: URL;
  host: string;
  port: number;
  /** Built by the caller from the layer's credentials; never read here. */
  authorization?: string;
  signal?: AbortSignal;
}

/**
 * A socket that already reaches `host:port` through the proxy, with TLS on top.
 *
 * The 407 is deliberately surfaced as a status rather than a generic failure:
 * it means the proxy wants credentials, which is a different situation from a
 * proxy that is down, and the layers above treat the two differently.
 */
export function tunnelledTlsSocket(request: TunnelRequest): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const connect = http.request({
      host: request.proxy.hostname,
      port: Number(request.proxy.port || 80),
      method: 'CONNECT',
      path: `${request.host}:${request.port}`,
      signal: request.signal,
      headers: {
        host: `${request.host}:${request.port}`,
        ...(request.authorization ? { 'proxy-authorization': request.authorization } : {}),
      },
    });

    connect.on('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new ProxyRefusedError(response.statusCode ?? 0, request.proxy.host));
        return;
      }
      // SNI names a host, and an address is not a name: Node refuses an IP
      // literal here outright, so a feed addressed by IP would otherwise fail
      // at the very moment the tunnel had succeeded.
      const secured = tls.connect({
        socket,
        ...(isIpLiteral(request.host) ? {} : { servername: request.host }),
      });
      if (head?.length) socket.unshift(head);

      // The handshake needs its own way out. Everything else in a request is
      // governed by the signal the caller passed, but this happens *before* the
      // request exists — a proxy that accepts the tunnel and then says nothing
      // would leave the caller waiting with nothing to cancel, and no fallback
      // to the CLI would ever happen.
      const giveUp = (reason: Error): void => {
        request.signal?.removeEventListener('abort', onAbort);
        secured.destroy();
        socket.destroy();
        reject(reason);
      };
      const onAbort = (): void => giveUp(abortError());
      if (request.signal) {
        if (request.signal.aborted) { giveUp(abortError()); return; }
        request.signal.addEventListener('abort', onAbort, { once: true });
      }

      secured.once('error', giveUp);
      secured.once('secureConnect', () => {
        request.signal?.removeEventListener('abort', onAbort);
        secured.removeListener('error', giveUp);
        resolve(secured);
      });
    });

    // A proxy that answers the CONNECT with a body instead of a tunnel is a
    // proxy that is not going to work; the caller falls back to the CLI.
    connect.on('response', (response) => {
      response.resume();
      reject(new ProxyRefusedError(response.statusCode ?? 0, request.proxy.host));
    });
    connect.on('error', reject);
    connect.end();
  });
}

