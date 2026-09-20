/**
 * Reusing a tunnelled connection across the requests of one walk (#116).
 *
 * On the direct path the global agent pools connections; on the proxied path
 * `nugetHttpJson.ts` builds its own socket per request through `createConnection`,
 * so every single one paid for its own `CONNECT` plus TLS handshake — the most
 * expensive possible shape on the slowest possible network. A socket is offered
 * back here once its response has been fully drained and the server did not
 * ask for the connection to close; the next request for the same proxy-and-target
 * pair takes it instead of opening a new one.
 *
 * A real `http.Agent` would do this natively, but the editor's proxy-support
 * patch replaces an `agent` handed to the request — measured, and the whole
 * reason this transport carries its own connection via `createConnection`
 * instead (`docs/http-backend-plan.md`, §6a). This is that same mechanism's
 * counterpart for reuse: a pool this module owns rather than one built into
 * a socket-producing object the patch could still reach.
 *
 * Kept as a small stack per key rather than a single slot: the per-origin
 * concurrency gate (`nugetHttpConcurrency.ts`) already bounds how many
 * requests to one target run at once, so at most that many sockets are ever
 * open for a key, and any of them sitting idle is fair game for the next
 * request.
 */

import type { TLSSocket } from 'tls';

export interface TunnelPool {
  /** An idle, still-open socket for this key, or nothing. */
  acquire(key: string): TLSSocket | undefined;
  /** Offers a socket back — kept only if it is still open and writable. */
  release(key: string, socket: TLSSocket): void;
  /** Destroys and drops every pooled socket — used when routing or credentials change. */
  clear(): void;
}

export function createTunnelPool(): TunnelPool {
  const idle = new Map<string, TLSSocket[]>();
  // A socket is wired for `forget` once, ever — not once per release. `close`
  // and `error` are terminal: a socket handed out and returned dozens of
  // times over one enrich walk stayed the same live socket the whole way, so
  // a fresh `once` pair on every release just sat there never firing, and by
  // the eleventh release Node's own per-event listener cap printed a
  // `MaxListenersExceededWarning` that looked like a leak.
  const wired = new WeakSet<TLSSocket>();

  const forget = (key: string, socket: TLSSocket): void => {
    const list = idle.get(key);
    if (!list) return;
    const at = list.indexOf(socket);
    if (at >= 0) list.splice(at, 1);
  };

  return {
    acquire(key) {
      const list = idle.get(key);
      // A socket the far end closed while idle is skipped rather than
      // handed out — the listeners below remove it from the list on that
      // event, but a acquire arriving in the same tick must not race them.
      while (list && list.length > 0) {
        const socket = list.pop();
        if (socket && !socket.destroyed && socket.writable) return socket;
      }
      return undefined;
    },
    release(key, socket) {
      if (socket.destroyed || !socket.writable) return;
      const list = idle.get(key) ?? [];
      list.push(socket);
      idle.set(key, list);
      if (!wired.has(socket)) {
        wired.add(socket);
        socket.once('close', () => forget(key, socket));
        socket.once('error', () => forget(key, socket));
      }
    },
    clear() {
      for (const list of idle.values()) {
        for (const socket of list.splice(0)) socket.destroy();
      }
      idle.clear();
    },
  };
}
