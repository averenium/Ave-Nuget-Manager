import * as http from 'http';
import * as zlib from 'zlib';
import type { AddressInfo } from 'net';
import { fetchJsonStatus, isFetchableUrl } from '../../nugetHttpJson';

/**
 * A real server on a real socket.
 *
 * These used to run against a stubbed `fetch`; the transport now speaks the
 * http modules directly, so that a proxy can be carried, and a stub would no
 * longer prove that a redirect is followed, a gzipped body is unpacked, or a
 * header actually leaves the process.
 */
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let server: http.Server;
let origin: string;
let handler: Handler = (_req, res) => { res.writeHead(404); res.end(); };
let received: http.IncomingMessage[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    received.push(req);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => { received = []; });

const json = (body: unknown, headers: Record<string, string> = {}): Handler => (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

describe('isFetchableUrl', () => {
  it('accepts the two protocols a feed can speak and refuses the rest', () => {
    expect(isFetchableUrl('https://feed.example/v3/index.json')).toBe(true);
    expect(isFetchableUrl('http://feed.example/v3/index.json')).toBe(true);
    expect(isFetchableUrl('D:\\packages')).toBe(false);
    expect(isFetchableUrl('\\\\server\\share')).toBe(false);
    expect(isFetchableUrl('file:///packages/index.json')).toBe(false);
  });
});

describe('fetchJsonStatus', () => {
  it('returns the parsed body with its status', async () => {
    handler = json({ versions: ['1.0.0'] });

    const result = await fetchJsonStatus(`${origin}/v3/index.json`);

    expect(result).toMatchObject({ status: 200, json: { versions: ['1.0.0'] }, bytes: 22 });
  });

  it('reports a refusal as a status rather than an exception', async () => {
    handler = (_req, res) => { res.writeHead(401); res.end(); };

    expect(await fetchJsonStatus(`${origin}/v3/index.json`)).toEqual({ status: 401, retryAfter: undefined });
  });

  it('carries the pause a busy server asked for', async () => {
    handler = (_req, res) => { res.writeHead(429, { 'retry-after': '7' }); res.end(); };

    expect((await fetchJsonStatus(`${origin}/v3/index.json`)).retryAfter).toBe('7');
  });

  it('reports "nothing changed" without a body', async () => {
    handler = (_req, res) => { res.writeHead(304); res.end(); };

    expect(await fetchJsonStatus(`${origin}/v3/index.json`)).toEqual({ status: 304 });
  });

  it('unpacks a compressed answer, which the registration resource always is', async () => {
    // The platform's fetch did this invisibly; these modules hand over exactly
    // the bytes that arrived, so the transport has to undo it itself.
    const body = JSON.stringify({ items: [{ lower: '1.0.0' }] });
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync(Buffer.from(body, 'utf8')));
    };

    const result = await fetchJsonStatus(`${origin}/v3/reg/a/index.json`);

    expect(result.json).toEqual({ items: [{ lower: '1.0.0' }] });
    expect(result.bytes).toBe(Buffer.byteLength(body));
    expect(received[0].headers['accept-encoding']).toContain('gzip');
  });

  it('follows a redirect, which these modules do not do on their own', async () => {
    handler = (req, res) => {
      if (req.url === '/v3/index.json') {
        res.writeHead(302, { location: `${origin}/v3/moved.json` });
        res.end();
        return;
      }
      json({ moved: true })(req, res);
    };

    expect((await fetchJsonStatus(`${origin}/v3/index.json`)).json).toEqual({ moved: true });
    expect(received).toHaveLength(2);
  });

  it('gives up rather than circle a redirect loop', async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: `${origin}/v3/again.json` });
      res.end();
    };

    await expect(fetchJsonStatus(`${origin}/v3/index.json`)).rejects.toThrow('Too many redirects');
  });

  it('does not carry a credential across a redirect to another host', async () => {
    // The header was built for one origin; a feed redirecting to a CDN must not
    // receive it.
    const elsewhere = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ authorization: req.headers.authorization ?? null }));
    });
    await new Promise<void>((resolve) => elsewhere.listen(0, '127.0.0.1', resolve));
    const other = `http://localhost:${(elsewhere.address() as AddressInfo).port}`;
    handler = (_req, res) => { res.writeHead(302, { location: `${other}/v3/index.json` }); res.end(); };

    try {
      const result = await fetchJsonStatus(`${origin}/v3/index.json`, undefined, { authorization: 'Basic dTpw' });
      expect(result.json).toEqual({ authorization: null });
    } finally {
      elsewhere.closeAllConnections?.();
      await new Promise<void>((resolve) => elsewhere.close(() => resolve()));
    }
  });

  it('keeps the credential on a redirect that stays on the same host', async () => {
    handler = (req, res) => {
      if (req.url === '/v3/index.json') {
        res.writeHead(307, { location: `${origin}/v3/elsewhere.json` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ authorization: req.headers.authorization ?? null }));
    };

    const result = await fetchJsonStatus(`${origin}/v3/index.json`, undefined, { authorization: 'Basic dTpw' });

    expect(result.json).toEqual({ authorization: 'Basic dTpw' });
  });

  it('reports an answer that is not JSON as a status with no document', async () => {
    // A captive portal answers 200 with a login page; parsing that as a feed
    // would look like a malformed server rather than a missing answer. The text
    // is kept, because this is exactly the body somebody will want to read when
    // the resource is condemned.
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>Sign in</body></html>');
    };

    const result = await fetchJsonStatus(`${origin}/v3/index.json`);

    expect(result.json).toBeUndefined();
    expect(result.status).toBe(200);
    expect(result.preview).toBe('<html><body>Sign in</body></html>');
  });

  it('refuses a body large enough to matter, by its declared length', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(64 * 1024 * 1024) });
      res.end('{}');
    };

    expect(await fetchJsonStatus(`${origin}/v3/index.json`)).toEqual({ status: 200 });
  });

  it('abandons a response that keeps coming and declares no length', async () => {
    // The declared-length check cannot see this one; only counting what
    // actually arrives stops it, and it must stop before memory does.
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const chunk = Buffer.alloc(256 * 1024);
      const pump = (): void => {
        while (res.write(chunk)) { /* until the socket pushes back */ }
      };
      res.on('drain', pump);
      pump();
    };

    expect(await fetchJsonStatus(`${origin}/v3/index.json`)).toEqual({ status: 200 });
  }, 30_000);

  it('counts bytes rather than characters, across chunk boundaries', async () => {
    const body = JSON.stringify({ text: 'ділянка'.repeat(300) });
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const bytes = Buffer.from(body, 'utf8');
      // Split inside a multi-byte character on purpose.
      for (let at = 0; at < bytes.length; at += 17) res.write(bytes.subarray(at, at + 17));
      res.end();
    };

    const result = await fetchJsonStatus(`${origin}/v3/index.json`);

    expect(result.bytes).toBe(Buffer.byteLength(body));
    expect(result.json).toEqual({ text: 'ділянка'.repeat(300) });
  });

  it('never calls an address it is unwilling to fetch', async () => {
    expect(await fetchJsonStatus('D:\\packages')).toEqual({ status: 0 });
    expect(received).toEqual([]);
  });

  it('sends no credentials unless the caller handed it a header', async () => {
    handler = json({});

    await fetchJsonStatus(`${origin}/v3/index.json`);

    expect(received[0].headers.authorization).toBeUndefined();
  });

  it('sends the header the caller built, and nothing it invented itself', async () => {
    handler = json({});

    await fetchJsonStatus(`${origin}/v3/index.json`, undefined, { authorization: 'Basic dTpw' });

    expect(received[0].headers.authorization).toBe('Basic dTpw');
    expect(received[0].headers.accept).toBe('application/json');
  });

  it('keeps only as much of the body as it was asked to', async () => {
    handler = json({ text: 'x'.repeat(5000) });

    const small = await fetchJsonStatus(`${origin}/a.json`, undefined, undefined, { previewBytes: 64 });
    const large = await fetchJsonStatus(`${origin}/a.json`, undefined, undefined, { previewBytes: 4096 });

    expect(small.preview).toHaveLength(64);
    expect(large.preview).toHaveLength(4096);
  });

  it('lets a failure with no response at all through to the caller', async () => {
    await expect(fetchJsonStatus('http://127.0.0.1:1/v3/index.json')).rejects.toBeDefined();
  });

  it('stops waiting once the caller cancels', async () => {
    handler = () => { /* answer nothing at all */ };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    await expect(fetchJsonStatus(`${origin}/v3/index.json`, controller.signal)).rejects.toBeDefined();
  });

  it('stops waiting on its own timeout', async () => {
    handler = () => { /* answer nothing at all */ };

    await expect(fetchJsonStatus(`${origin}/v3/index.json`, undefined, undefined, { timeoutMs: 30 }))
      .rejects.toBeDefined();
  });
});
