import * as net from 'net';
import * as tls from 'tls';
import type { AddressInfo } from 'net';
import { tunnelledTlsSocket } from '../../nugetProxyConnect';

/**
 * The assumption the certificate question rests on.
 *
 * A corporate network with a proxy nearly always also intercepts TLS with a
 * certificate of its own, which lives in the machine's store and not in the
 * roots bundled with Node. The editor adds those roots by replacing the
 * exported `tls.createSecureContext`, and the extension relies on that instead
 * of reading the system store itself — which would mean platform-specific code
 * in a place that has none.
 *
 * That reliance is sound only while `tls.connect` actually consults the
 * *exported* factory rather than an internal reference to it. Nothing in the
 * documentation promises that, so it is pinned here: if a future runtime stops
 * consulting it, this fails, and the certificate question is open again rather
 * than silently answered wrong.
 *
 * The handshake itself is expected to fail — the server below speaks no TLS.
 * What matters happens before that: the context is built, and the factory that
 * builds it is the one a host can replace.
 */
let plain: net.Server;
let port: number;

beforeAll(async () => {
  // Answers nothing at all; a handshake against it cannot succeed, which is
  // precisely why it makes the measurement cheap.
  plain = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
  port = (plain.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => plain.close(() => resolve()));
});

/**
 * Replaces the exported factory the way a host patch does, and counts calls.
 *
 * The module object comes from `require` on purpose: a namespace import is not
 * writable, and patching a copy of it would prove nothing while looking like it
 * had — the failure mode this whole test exists to rule out.
 */
function watchSecureContext(): { calls: () => number; restore: () => void } {
  const moduleObject = require('tls') as { createSecureContext: typeof tls.createSecureContext };
  const original = moduleObject.createSecureContext;
  let calls = 0;
  moduleObject.createSecureContext = function patched(options?: tls.SecureContextOptions) {
    calls += 1;
    return original.call(moduleObject, options);
  } as typeof tls.createSecureContext;
  return {
    calls: () => calls,
    restore: () => { moduleObject.createSecureContext = original; },
  };
}

describe('what the editor patches reaches our TLS', () => {
  it('a direct connection is built through the exported factory', async () => {
    const watch = watchSecureContext();
    try {
      await new Promise<void>((resolve) => {
        const socket = tls.connect({ host: '127.0.0.1', port, servername: 'feed.example' }, () => {
          socket.destroy();
          resolve();
        });
        socket.on('error', () => { socket.destroy(); resolve(); });
        socket.on('close', () => resolve());
      });

      expect(watch.calls()).toBeGreaterThan(0);
    } finally {
      watch.restore();
    }
  });

  it('a tunnelled connection is built the same way', async () => {
    // The tunnel is where an intercepted network would bite hardest: a proxy in
    // front and a certificate of its own behind it.
    const opened: net.Socket[] = [];
    const proxy = net.createServer((socket) => {
      opened.push(socket);
      socket.once('data', () => {
        socket.write(`HTTP/1.1 200 Connection Established${String.fromCharCode(13, 10).repeat(2)}`);
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyPort = (proxy.address() as AddressInfo).port;

    const watch = watchSecureContext();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    try {
      await tunnelledTlsSocket({
        proxy: new URL(`http://127.0.0.1:${proxyPort}`),
        host: 'feed.example',
        port: 443,
        signal: controller.signal,
      }).catch(() => undefined);

      expect(watch.calls()).toBeGreaterThan(0);
    } finally {
      watch.restore();
      // A socket upgraded by CONNECT is detached from the server, so closing the
      // server alone would leave the test process holding it open.
      for (const socket of opened) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  }, 10_000);
});
