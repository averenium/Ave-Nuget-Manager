/**
 * What is known about proxies, and the answer for one address (#27).
 *
 * Symmetric to the credential registry, and for the same reason: the
 * configuration is read in one place — while a `nuget.config` is resolved —
 * and the transport is handed a decision it does not have to understand.
 *
 * The layers are consulted in the order that was settled deliberately: what the
 * configuration file said, then the environment, then nothing — which leaves
 * the request to the editor, the layer below this one. A proxy that cannot be
 * executed does not fall through to a direct connection; it answers
 * `unsupported`, and the work goes to the CLI.
 *
 * Any password for the proxy is turned into a header once, when the layer is
 * remembered, so that deciding a route stays synchronous and no secret is held
 * anywhere the transport can reach.
 */

import { decryptNuGetConfigPassword, supportsEncryptedNuGetPasswords } from './nugetConfigDpapi';
import {
  chooseProxy,
  proxyAuthHeader,
  proxyFromEnvironment,
  type ProxyLayer,
  type ResolvedRoute,
} from './nugetProxy';
import { originOf, registrableDomain } from './nugetServiceIndex';

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

interface PreparedLayer {
  layer: ProxyLayer;
  authorization?: string;
}

export class ProxyRegistry {
  /** Per configured source origin: what that source's configuration declared. */
  private readonly _byOrigin = new Map<string, PreparedLayer>();
  private _environment?: PreparedLayer;

  /**
   * Records what a configuration file declared for one source. Called while the
   * file is resolved, which is the only moment its text exists in this process.
   */
  async remember(sourceUrl: string, layer: ProxyLayer): Promise<void> {
    const origin = originOf(sourceUrl);
    if (!origin) return;
    this._byOrigin.set(origin, { layer, authorization: await prepare(layer) });
  }

  /** Drops what is held — used when the configuration changes. */
  clear(): void {
    this._byOrigin.clear();
    this._environment = undefined;
  }

  /**
   * How to reach this address.
   *
   * The configuration layer that applies is the one belonging to the address's
   * own origin: a proxy declared in the file that enabled a feed governs
   * requests to that feed, and to the resources it publishes on its own host.
   */
  routeFor(url: string): ResolvedRoute {
    const origin = originOf(url);
    const fromConfig = origin ? this._forOrigin(origin) : undefined;
    const fromEnvironment = this._environmentLayer();

    const layers = [fromConfig, fromEnvironment].filter((l): l is PreparedLayer => !!l);
    const decision = chooseProxy(url, layers.map((l) => l.layer));

    switch (decision.kind) {
      case 'proxy': {
        const prepared = layers.find((l) => l.layer === decision.layer);
        return { kind: 'proxy', url: decision.url, authorization: prepared?.authorization };
      }
      case 'direct':
        return { kind: 'direct' };
      case 'unsupported':
        return { kind: 'unsupported', declared: decision.declared };
      default:
        return { kind: 'unclaimed' };
    }
  }

  /**
   * The layer for an origin, or for a sibling host of the same feed.
   *
   * A feed publishes resources on neighbouring hosts — search on one, package
   * content on another — and the reading rules already treat those as the same
   * feed. A proxy that governs the feed governs them too; without this a
   * sibling host would quietly fall through to the environment or the editor,
   * which is a different answer for the same feed.
   */
  private _forOrigin(origin: string): PreparedLayer | undefined {
    const exact = this._byOrigin.get(origin);
    if (exact) return exact;

    const host = hostOf(origin);
    if (!host) return undefined;
    const domain = registrableDomain(host);
    for (const [known, prepared] of this._byOrigin) {
      const knownHost = hostOf(known);
      if (knownHost && registrableDomain(knownHost) === domain) return prepared;
    }
    return undefined;
  }

  /** Read once per session: the environment does not change under a window. */
  private _environmentLayer(): PreparedLayer | undefined {
    if (this._environment === undefined) {
      const layer = proxyFromEnvironment();
      // An environment proxy never carries a password of its own in this
      // format; credentials there live inside the URL, which is left as it is.
      this._environment = layer ? { layer } : { layer: { origin: 'environment' } };
    }
    return this._environment.layer.url || this._environment.layer.noProxy
      ? this._environment
      : undefined;
  }
}

/** The header for a proxy that wants credentials, built once and kept. */
async function prepare(layer: ProxyLayer): Promise<string | undefined> {
  if (!layer.user && !layer.password) return undefined;
  if (!layer.encryptedPassword) return proxyAuthHeader(layer);
  if (!supportsEncryptedNuGetPasswords()) return undefined;
  try {
    return proxyAuthHeader(layer, await decryptNuGetConfigPassword(layer.password ?? ''));
  } catch {
    // A password that cannot be recovered here means an anonymous CONNECT; the
    // proxy answers 407 and the work falls back to the CLI, which can decrypt it.
    return undefined;
  }
}
