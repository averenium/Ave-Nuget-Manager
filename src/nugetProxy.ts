/**
 * Which proxy applies to a request, and why that one (#27).
 *
 * No I/O here: this decides, and the transport executes. The order was settled
 * deliberately and must not be reversed —
 *
 * 1. the `no_proxy` of whichever layer supplied the proxy → direct;
 * 2. `http_proxy` / `https_proxy` from `<config>` in `nuget.config` — authoritative;
 * 3. the `HTTP_PROXY` / `HTTPS_PROXY` environment variables;
 * 4. the editor's own setting, which this module never sees: it is the layer
 *    that applies when nothing above claims the request, and it is applied by
 *    the editor itself;
 * 5. direct.
 *
 * The reason the configuration outranks the editor is that this feature
 * reproduces what `dotnet --configfile <path>` would do, and the editor knows
 * nothing about a proxy declared in a file.
 *
 * **`no_proxy` is read in pairs, not unioned.** The exclusions of a layer apply
 * to the proxy of that same layer. Unioning them across layers could produce a
 * direct request where the configuration required a proxy, and quietly
 * bypassing a declared proxy is the one outcome that is never acceptable.
 */

import { expandNuGetConfigValue } from './nugetConfigEnv';
import { unescapeXml } from './nugetSourceCredentials';
import { extractSection, maskXmlComments } from './nugetConfigXmlSections';

/** One layer's answer: a proxy, its exclusions, and where it came from. */
export interface ProxyLayer {
  /**
   * The proxy for https targets, which every feed address is in practice.
   * Absent when this layer declares no proxy at all.
   */
  url?: string;
  /**
   * The proxy for plain-http targets, when the layer names a different one.
   * The convention is one variable per scheme, and the CLI follows it; they are
   * usually set to the same address, which is why the difference is easy to
   * miss and worth keeping anyway.
   */
  plainUrl?: string;
  /** Exclusions belonging to *this* layer's proxy. */
  noProxy?: string;
  user?: string;
  password?: string;
  /** Whether the password is a DPAPI blob rather than plain text. */
  encryptedPassword?: boolean;
  origin: 'config' | 'environment';
}

export type ProxyDecision =
  /** Go through this proxy. */
  | { kind: 'proxy'; url: URL; layer: ProxyLayer }
  /** Go straight out, and do not let a lower layer proxy it. */
  | { kind: 'direct'; reason: 'excluded' }
  /** No layer here claims the request; whatever the editor does is fine. */
  | { kind: 'unclaimed' }
  /**
   * A proxy was declared that this cannot execute — a scheme other than http,
   * or an address that will not parse. The work falls back to the CLI, never to
   * a direct connection: a declared proxy must not be bypassed in silence.
   */
  | { kind: 'unsupported'; declared: string; layer: ProxyLayer };

function attribute(section: string, key: string): string | undefined {
  const match = new RegExp(
    `<add\\s+key\\s*=\\s*["']${key}["']\\s+value\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    'i',
  ).exec(section);
  const raw = match?.[1] ?? match?.[2];
  // The same unescaping the credentials reader does on the same kind of
  // attribute. A proxy password with an ampersand is ordinary, and without this
  // it would reach the proxy wrong — answering 407 and falling back to the CLI,
  // which is exactly the situation this feature exists to avoid.
  return raw === undefined ? undefined : unescapeXml(raw).trim();
}

/**
 * The proxy a `nuget.config` declares, read from the same `<config>` section
 * the CLI reads. Values may reference environment variables, as everywhere else
 * in this file format.
 */
export function proxyFromConfigXml(xml: string): ProxyLayer | undefined {
  const section = maskXmlComments(extractSection(xml, 'config'));
  if (!section) return undefined;

  const secure = attribute(section, 'https_proxy');
  const plain = attribute(section, 'http_proxy');
  const url = secure ?? plain;
  const noProxy = attribute(section, 'no_proxy');
  if (!url && !noProxy) return undefined;

  const encrypted = attribute(section, 'http_proxy.password');
  const clear = attribute(section, 'http_proxy.clearTextPassword');
  return {
    url: url ? expandNuGetConfigValue(url).trim() : undefined,
    plainUrl: plain ? expandNuGetConfigValue(plain).trim() : undefined,
    noProxy: noProxy ? expandNuGetConfigValue(noProxy).trim() : undefined,
    user: attribute(section, 'http_proxy.user'),
    password: clear ?? encrypted,
    encryptedPassword: clear === undefined && encrypted !== undefined,
    origin: 'config',
  };
}

/** The proxy the environment declares, by the usual variable names. */
export function proxyFromEnvironment(env: NodeJS.ProcessEnv = process.env): ProxyLayer | undefined {
  const secure = env.HTTPS_PROXY ?? env.https_proxy;
  const plain = env.HTTP_PROXY ?? env.http_proxy;
  const noProxy = env.NO_PROXY ?? env.no_proxy;
  if (!secure && !plain && !noProxy) return undefined;
  // One variable per scheme, as the convention has it: a target decides which
  // of them applies, rather than the secure one standing in for both.
  return {
    url: (secure ?? plain)?.trim(),
    plainUrl: plain?.trim(),
    noProxy: noProxy?.trim(),
    origin: 'environment',
  };
}

/**
 * Whether a host is excluded by a `no_proxy` list.
 *
 * The syntax is not standardised anywhere, so this follows what the tools
 * agree on: a comma or space separated list; `*` excludes everything; an entry
 * may carry a port; a leading dot, or a bare domain, matches that domain and
 * anything under it.
 *
 * **A CIDR range is not matched**, and is treated as a name that never equals a
 * host — the same as `curl` and the same as what the tools agree on. An
 * internal feed addressed by IP is therefore excluded by writing that address,
 * not the block it belongs to. Should NuGet itself turn out to read ranges, this
 * is where that goes.
 */
export function isExcluded(target: URL, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const host = target.hostname.toLowerCase();
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');

  for (const raw of noProxy.split(/[,\s]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;

    const [pattern, wantedPort] = entry.startsWith('[')
      ? [entry, '']               // a bracketed IPv6 literal carries no port here
      : splitHostPort(entry);
    if (wantedPort && wantedPort !== port) continue;

    const bare = pattern.replace(/^\*?\./, '');
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

function splitHostPort(entry: string): [string, string] {
  const colon = entry.lastIndexOf(':');
  if (colon <= 0) return [entry, ''];
  const maybePort = entry.slice(colon + 1);
  return /^\d+$/.test(maybePort) ? [entry.slice(0, colon), maybePort] : [entry, ''];
}

/**
 * The decision for one address, given the layers in priority order.
 *
 * The first layer that names a proxy decides — including deciding to go direct,
 * when its own exclusions cover the address. A layer that names only exclusions
 * does not claim the request.
 */
export function chooseProxy(targetUrl: string, layers: readonly ProxyLayer[]): ProxyDecision {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return { kind: 'unclaimed' };
  }

  for (const layer of layers) {
    // A plain-http target takes the plain-http proxy when the layer names one.
    const declared = target.protocol === 'http:' ? layer.plainUrl ?? layer.url : layer.url;
    if (!declared) continue;
    if (isExcluded(target, layer.noProxy)) return { kind: 'direct', reason: 'excluded' };

    let parsed: URL;
    try {
      parsed = new URL(declared);
    } catch {
      return { kind: 'unsupported', declared, layer };
    }
    // Only a proxy this transport can speak to. A SOCKS proxy is a different
    // protocol, not a variation of this one.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { kind: 'unsupported', declared, layer };
    }
    return { kind: 'proxy', url: parsed, layer };
  }
  return { kind: 'unclaimed' };
}

/**
 * What the transport is told, once a decision has been made and any credential
 * for the proxy has been prepared. The transport does no deciding and holds no
 * secret: it is handed an address and, when there is one, a finished header.
 */
export type ResolvedRoute =
  | { kind: 'proxy'; url: URL; authorization?: string }
  | { kind: 'direct' }
  | { kind: 'unclaimed' }
  | { kind: 'unsupported'; declared: string };

/** `Proxy-Authorization`, when the layer carries credentials for the proxy. */
export function proxyAuthHeader(layer: ProxyLayer, password?: string): string | undefined {
  const user = layer.user ? expandNuGetConfigValue(layer.user).trim() : '';
  const secret = password ?? (layer.password ? expandNuGetConfigValue(layer.password) : '');
  if (!user && !secret) return undefined;
  return `Basic ${Buffer.from(`${user}:${secret}`, 'utf8').toString('base64')}`;
}
