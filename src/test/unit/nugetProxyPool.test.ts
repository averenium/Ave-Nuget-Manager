import { EventEmitter } from 'events';
import type { TLSSocket } from 'tls';
import { createTunnelPool } from '../../nugetProxyPool';

/** A socket stand-in with just enough shape for the pool: open, writable, an event emitter. */
function fakeSocket(): TLSSocket {
  const emitter = new EventEmitter() as unknown as TLSSocket & { destroyed: boolean; writable: boolean };
  emitter.destroyed = false;
  emitter.writable = true;
  (emitter as unknown as { destroy: () => void }).destroy = () => {
    emitter.destroyed = true;
    (emitter as unknown as EventEmitter).emit('close');
  };
  return emitter;
}

describe('createTunnelPool', () => {
  it('hands an idle socket back to the next acquire for the same key', () => {
    const pool = createTunnelPool();
    const socket = fakeSocket();

    pool.release('proxy=>feed.example:443', socket);

    expect(pool.acquire('proxy=>feed.example:443')).toBe(socket);
  });

  it('never returns a socket that has since closed', () => {
    const pool = createTunnelPool();
    const socket = fakeSocket();

    pool.release('a', socket);
    (socket as unknown as EventEmitter).emit('close');

    expect(pool.acquire('a')).toBeUndefined();
  });

  it('refuses a socket offered back after it was destroyed or stopped being writable', () => {
    const pool = createTunnelPool();
    const destroyed = fakeSocket();
    (destroyed as unknown as { destroyed: boolean }).destroyed = true;
    const notWritable = fakeSocket();
    (notWritable as unknown as { writable: boolean }).writable = false;

    pool.release('a', destroyed);
    pool.release('a', notWritable);

    expect(pool.acquire('a')).toBeUndefined();
  });

  it('destroys every pooled socket on clear and drops them from the pool', () => {
    const pool = createTunnelPool();
    const socket = fakeSocket();
    pool.release('a', socket);

    pool.clear();

    expect(socket.destroyed).toBe(true);
    expect(pool.acquire('a')).toBeUndefined();
  });

  it('wires close/error on a reused socket only once, however many times it is released (#116)', () => {
    const pool = createTunnelPool();
    const socket = fakeSocket();

    // An enrich walk over forty packages through one proxy connection acquires
    // and releases the same socket far more than the ten `once` listeners
    // Node warns about by default — a fresh pair on every release, rather than
    // once for the socket's whole pooled life, printed a
    // MaxListenersExceededWarning that looked like a leak even though nothing
    // was actually going wrong.
    for (let i = 0; i < 15; i += 1) {
      pool.release('a', socket);
      expect(pool.acquire('a')).toBe(socket);
    }
    pool.release('a', socket);

    const emitter = socket as unknown as EventEmitter;
    expect(emitter.listenerCount('close')).toBe(1);
    expect(emitter.listenerCount('error')).toBe(1);
  });
});
