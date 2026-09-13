/**
 * The one place this feature opens a connection (#27).
 *
 * Everything above it — the capability store, the version ladder, the
 * registration reader — takes a fetcher as a parameter and is therefore
 * testable without a server. Keeping the network behind a single function also
 * keeps its rules in one place:
 *
 * - **A status is data, not an exception.** The layers above distinguish 404
 *   from 401 from 503, so a transport that threw on all of them would collapse
 *   three different verdicts into one. Only a failure with no response at all
 *   throws — and the callers read that as "says nothing", never as "broken".
 * - **Only http and https, only JSON.** A source can be a local folder or a
 *   UNC path, and a captive portal answers HTML with status 200; both are
 *   refused here rather than parsed into nonsense upstream.
 * - **No credential handling.** Nothing here reads a password, a token, or a
 *   session; an `authorization` header, when one is passed in, was built by the
 *   layer that owns the configuration. A feed needing a sign-in method this
 *   cannot express answers 401, and the work falls back to the CLI, which has
 *   the credential providers.
 * - **A ceiling on the body, enforced while reading.** A feed that streams an
 *   endless response must not be able to exhaust the editor's memory, so the
 *   body is read in chunks and abandoned the moment it passes the ceiling. A
 *   declared length is only a hint — a chunked response declares none — so the
 *   count that matters is of bytes actually received.
 *
 * **Why the platform's own `fetch` is not used.** It cannot be routed through a
 * proxy: it ignores an `agent`, and the dispatcher that would accept one is not
 * importable without adding a dependency — measured, with a local proxy seeing
 * no request at all. A proxy declared in `nuget.config` is something this
 * extension has to honour itself, so the transport is built on the modules that
 * can carry one. Three consequences of that choice are handled here rather than
 * by the platform: redirects are followed explicitly, compressed answers are
 * decompressed explicitly — the registration resource is served gzipped — and
 * the connection itself is chosen explicitly.
 */

import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import * as zlib from 'zlib';
import type { IncomingMessage } from 'http';
import { tunnelledTlsSocket } from './nugetProxyConnect';
import type { ResolvedRoute } from './nugetProxy';

const DEFAULT_TIMEOUT_MS = 8_000;
/** Registration documents reach hundreds of kilobytes; nothing legitimate is near this. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Enough for a feed that moves its resources; more than this is a loop. */
const MAX_REDIRECTS = 5;

export interface HttpJsonResult {
  status: number;
  json?: unknown;
  /** Bytes of body actually read, after any decompression. */
  bytes?: number;
  /** Validators the server offered, for asking "has this changed?" next time. */
  etag?: string;
  lastModified?: string;
  /** `Retry-After`, verbatim, when the server asked for a pause. */
  retryAfter?: string;
  /** The start of the body as text, for explaining an answer that surprised us. */
  preview?: string;
}

export interface JsonFetchOptions {
  timeoutMs?: number;
  /**
   * How this address is to be reached. Consulted per address, because the
   * answer depends on it: one feed may be excluded from a proxy that another
   * feed must go through.
   */
  route?: (url: string) => ResolvedRoute;
  /**
   * How much of the answer to keep on the result. A small slice is kept always:
   * the bodies worth reading are the ones that went wrong — a proxy error page,
   * a portal's HTML, a document of the wrong shape — and those are kilobytes. A
   * trace asks for a large one, because that is what a trace is for.
   */
  previewBytes?: number;
}

/** Enough to recognise an error page or a document of the wrong shape. */
export const DEFAULT_PREVIEW_BYTES = 2 * 1024;

/** A proxy was declared that this cannot execute; the work belongs to the CLI. */
export class ProxyUnsupportedError extends Error {
  constructor(readonly declared: string) {
    super(`Declared proxy cannot be used by the HTTP catalog: ${declared}`);
    this.name = 'ProxyUnsupportedError';
  }
}

/** True for an address this module is willing to call. */
export function isFetchableUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * A fetcher bound to a policy for how much of each answer to keep, and to a way
 * of deciding how each address is reached. The extension gives it a preview
 * size that grows while a trace is recording, so full bodies are a switch the
 * user throws rather than a cost everyone pays.
 */
export function createJsonFetcher(
  previewBytes: () => number,
  route?: (url: string) => ResolvedRoute,
): (url: string, signal?: AbortSignal, headers?: Record<string, string>) => Promise<HttpJsonResult> {
  return (url, signal, headers) =>
    fetchJsonStatus(url, signal, headers, { previewBytes: previewBytes(), route });
}

/**
 * Fetches JSON and reports the status instead of throwing on it. Throws only
 * when no response arrived: a timeout, an aborted request, a DNS or TLS
 * failure. Callers treat that as a moment, not a verdict.
 */
export async function fetchJsonStatus(
  url: string,
  signal?: AbortSignal,
  headers?: Record<string, string>,
  options: JsonFetchOptions = {},
): Promise<HttpJsonResult> {
  if (!isFetchableUrl(url)) return { status: 0 };

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => timeout.abort();
  if (signal) {
    if (signal.aborted) timeout.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const response = await send(url, headers, timeout, options.route, 0);
    const status = response.message.statusCode ?? 0;
    const header = (name: string): string | undefined => {
      const value = response.message.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };

    // "Nothing changed" is an answer, and the caller holds the document it
    // refers to; it carries no body by definition.
    if (status === 304) {
      response.message.resume();
      return { status: 304 };
    }
    if (status >= 400) {
      response.message.resume();
      return { status, retryAfter: header('retry-after') };
    }

    // A declared length past the ceiling is refused before a byte is read; the
    // streaming count below is what actually enforces it.
    const length = Number(header('content-length') ?? '0');
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      response.message.destroy();
      return { status };
    }

    const read = await readCapped(response.message);
    if (!read) return { status };

    const preview = read.text.slice(0, options.previewBytes ?? DEFAULT_PREVIEW_BYTES);
    const validators = { etag: header('etag'), lastModified: header('last-modified') };
    try {
      return {
        status,
        json: JSON.parse(read.text) as unknown,
        bytes: read.bytes,
        preview,
        ...validators,
      };
    } catch {
      // A 200 carrying HTML is a portal or an error page, not an answer. The
      // shape check upstream would reject it anyway; refusing it here keeps the
      // parse failure from looking like a malformed feed — but the text is kept,
      // because that is precisely the body somebody will want to read.
      return { status, bytes: read.bytes, preview };
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

interface Delivered {
  message: IncomingMessage;
}

/** One request, following redirects itself because these modules do not. */
async function send(
  url: string,
  headers: Record<string, string> | undefined,
  timeout: AbortController,
  route: ((url: string) => ResolvedRoute) | undefined,
  hop: number,
): Promise<Delivered> {
  const target = new URL(url);
  const message = await once(target, headers, timeout, route);
  const status = message.statusCode ?? 0;
  const location = message.headers.location;

  if (status >= 300 && status < 400 && location) {
    message.resume();
    if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects');
    const next = new URL(location, target);
    if (!isFetchableUrl(next.toString())) throw new Error('Redirect to an unsupported address');
    // A credential belongs to the origin it was configured for. A feed that
    // redirects elsewhere — to a CDN, most often — gets an anonymous request;
    // carrying the header across would hand it to a host nobody authorised.
    const carried = next.origin === target.origin ? headers : withoutAuthorization(headers);
    return send(next.toString(), carried, timeout, route, hop + 1);
  }
  return { message };
}

function withoutAuthorization(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return headers;
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'authorization') continue;
    kept[name] = value;
  }
  return kept;
}

async function once(
  target: URL,
  headers: Record<string, string> | undefined,
  timeout: AbortController,
  route: ((url: string) => ResolvedRoute) | undefined,
): Promise<IncomingMessage> {
  const decision: ResolvedRoute = route?.(target.toString()) ?? { kind: 'unclaimed' };
  // A declared proxy that cannot be executed sends the work to the CLI. Going
  // direct instead would bypass it in silence, which is never acceptable.
  if (decision.kind === 'unsupported') throw new ProxyUnsupportedError(decision.declared);

  const connection = await connectionFor(target, decision, timeout);
  const transport = target.protocol === 'https:' ? https : http;

  return new Promise<IncomingMessage>((resolve, reject) => {
    const request = transport.request(
      {
        protocol: target.protocol,
        host: target.hostname,
        port: target.port || undefined,
        // An http target reached through a proxy is addressed by its absolute
        // URI; a tunnelled or direct one by its path, as usual.
        path: connection?.absoluteUri ? target.toString() : `${target.pathname}${target.search}`,
        method: 'GET',
        signal: timeout.signal,
        // Measured: the editor replaces an agent, and leaves a connection given
        // at this level alone. That is the whole reason a proxy is executable
        // here at all.
        //
        // No `agent` key at all, deliberately: `agent: false` makes Node build
        // an agent of its own, and an agent supplies its own connection — the
        // one given here is then quietly ignored and the request goes direct.
        ...(connection ? { createConnection: () => connection.socket } : {}),
        headers: {
          host: target.host,
          accept: 'application/json',
          // Asked for explicitly, and undone explicitly below: the registration
          // resource is served compressed, and unlike the platform's fetch
          // these modules hand over exactly the bytes that arrived.
          'accept-encoding': 'gzip, deflate, br',
          ...headers,
          // The proxy credential belongs to the hop, not to the feed. On a
          // tunnel it travelled on the CONNECT and must not be repeated inside.
          ...(connection?.absoluteUri && connection.authorization
            ? { 'proxy-authorization': connection.authorization }
            : {}),
        },
      } as http.RequestOptions,
      resolve,
    );
    request.on('error', reject);
    request.end();
  });
}

interface Connection {
  socket: net.Socket;
  /** True when the request must name the target by absolute URI. */
  absoluteUri: boolean;
  authorization?: string;
}

/**
 * The socket this request will travel on, or nothing at all.
 *
 * Nothing means "let whatever the host arranges apply" — which is how the
 * editor's own proxy setting stays the lower layer it is meant to be. Every
 * other case builds the connection here, **including a deliberate direct one**:
 * without it the editor would proxy a request that a higher layer excluded.
 */
async function connectionFor(
  target: URL,
  route: ResolvedRoute,
  timeout: AbortController,
): Promise<Connection | undefined> {
  if (route.kind === 'unclaimed') return undefined;

  if (route.kind === 'direct') {
    return { socket: directSocket(target, timeout.signal), absoluteUri: false };
  }
  // Refused before reaching here; the guard keeps that fact in the type.
  if (route.kind !== 'proxy') throw new ProxyUnsupportedError(route.declared);

  if (target.protocol === 'https:') {
    const socket = await tunnelledTlsSocket({
      proxy: route.url,
      host: target.hostname,
      port: Number(target.port || 443),
      authorization: route.authorization,
      signal: timeout.signal,
    });
    return { socket, absoluteUri: false, authorization: route.authorization };
  }

  // An http target needs no tunnel: the request goes to the proxy naming the
  // target in full.
  const socket = net.connect({
    host: route.url.hostname,
    port: Number(route.url.port || 80),
    signal: timeout.signal,
  });
  return { socket, absoluteUri: true, authorization: route.authorization };
}

/** A connection straight to the target, bypassing whatever the host would do. */
function directSocket(target: URL, signal?: AbortSignal): net.Socket {
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  const socket = net.connect({ host: target.hostname, port, signal });
  if (target.protocol !== 'https:') return socket;
  return tls.connect({ socket, servername: target.hostname });
}

/** The response body as text, decompressed if the server compressed it. */
function decoded(message: IncomingMessage): NodeJS.ReadableStream {
  const encoding = (message.headers['content-encoding'] ?? '').toString().toLowerCase().trim();
  if (encoding === 'gzip' || encoding === 'x-gzip') return message.pipe(zlib.createGunzip());
  if (encoding === 'deflate') return message.pipe(zlib.createInflate());
  if (encoding === 'br') return message.pipe(zlib.createBrotliDecompress());
  return message;
}

/**
 * The body, or nothing when it grows past the ceiling.
 *
 * Counting happens per chunk, in bytes, because that is the only number the
 * memory cares about: a declared length can be absent or untrue, and a string
 * length counts UTF-16 units rather than bytes. The count is of the bytes the
 * reader keeps, so a compressed answer is measured by what it became.
 */
async function readCapped(
  message: IncomingMessage,
): Promise<{ text: string; bytes: number } | undefined> {
  const stream = decoded(message);
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let bytes = 0;

  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      bytes += buffer.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        // Stop the transfer itself rather than merely stop keeping it.
        message.destroy();
        return undefined;
      }
      text += decoder.decode(buffer, { stream: true });
    }
    text += decoder.decode();
    return { text, bytes };
  } catch {
    // A truncated or corrupt body is no body; the status still stands.
    return undefined;
  }
}
