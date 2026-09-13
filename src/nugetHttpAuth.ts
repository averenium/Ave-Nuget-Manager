/**
 * Attaching a credential to a request, and to nothing else (#27).
 *
 * Every HTTP consumer — the capability probe, the version ladder, search, the
 * vulnerability database — takes a plain fetcher and knows nothing about
 * authentication. That is deliberate: a credential rule spread across four
 * modules is a rule with four chances to be wrong. Instead the fetcher itself
 * is wrapped once, and it decides.
 *
 * Whatever headers the wrapper above passed in travel on unchanged; only the
 * `authorization` entry is added. The decision to add it is by **exact
 * origin**. Elsewhere a sibling host of the same
 * domain counts as the same feed, because reading a public document from it is
 * harmless; a password is not, so here the host, the port and the scheme must
 * all match what was configured. A resource that a feed publishes on another
 * host therefore gets an anonymous request — which is what it would have got
 * before this existed.
 */

import { originOf } from './nugetServiceIndex';
import type { HttpFetcher } from './nugetSourceCapabilities';
import { basicAuthHeader, mayAuthenticate, type SourceCredential } from './nugetSourceCredentials';

/** Kept as a name for what this module produces; the shape is the shared one. */
export type AuthorizedFetcher = HttpFetcher;

interface RegisteredCredential {
  credential: SourceCredential;
  allowInsecureConnections?: boolean;
  /** Built on first use and kept for the session, so decryption happens once. */
  header?: string;
  resolved?: boolean;
}

/**
 * What is known about which origin needs which credential. Filled in while the
 * configuration is read, and consulted only by the fetcher below.
 */
export class CredentialRegistry {
  private readonly _byOrigin = new Map<string, RegisteredCredential>();

  remember(
    sourceUrl: string,
    credential: SourceCredential,
    allowInsecureConnections?: boolean,
  ): void {
    const origin = originOf(sourceUrl);
    if (!origin) return;
    this._byOrigin.set(origin, { credential, allowInsecureConnections });
  }

  /** Drops what is held — used when the configuration changes under us. */
  clear(): void {
    this._byOrigin.clear();
  }

  /** The header for this address, or nothing when it must go out anonymous. */
  async headerFor(url: string): Promise<string | undefined> {
    const origin = originOf(url);
    if (!origin) return undefined;
    const entry = this._byOrigin.get(origin);
    if (!entry) return undefined;
    if (!mayAuthenticate(url, entry.allowInsecureConnections)) return undefined;

    if (!entry.resolved) {
      entry.header = await basicAuthHeader(entry.credential);
      entry.resolved = true;
    }
    return entry.header;
  }
}

/**
 * A fetcher that adds the credential for the origin it is calling, when there
 * is one. Everything else about the request is unchanged, so a source needing
 * no credential behaves exactly as before.
 */
export function authorizingFetcher(
  fetchJson: AuthorizedFetcher,
  registry: CredentialRegistry,
): AuthorizedFetcher {
  return async (url, signal, headers) => {
    const header = await registry.headerFor(url);
    // The headers passed in belong to whoever wrapped this — the cache asking
    // whether its copy is still current, for one. Building a fresh object here
    // silently dropped them, and a dropped validator is a full download.
    return fetchJson(url, signal, header ? { ...headers, authorization: header } : headers);
  };
}
