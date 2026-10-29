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
 * origin and source path**. Elsewhere a sibling host of the same
 * domain counts as the same feed, because reading a public document from it is
 * harmless; a password is not, so here the host, the port and the scheme must
 * all match what was configured. A resource that a feed publishes on another
 * host therefore gets an anonymous request — which is what it would have got
 * before this existed.
 *
 * The origin is not enough on its own (#133): a source is a URL, not a host,
 * and several sources routinely share one host, differing only in the path.
 * Keyed by origin alone, the last source read overwrote the others and its
 * credential went to all of them — and a repository that serves anonymous
 * readers answers `403` to a credential it does not recognise, so giving
 * credentials to one source took the rest of the host down. The path prefix of
 * the source therefore joins the key, the longest matching one wins, and an
 * address no configured source covers goes out anonymous.
 *
 * A source's address does not always say which resources are its own: Azure
 * Artifacts is configured by project and feed name but publishes every resource
 * under their GUIDs. What the source's own service index published therefore
 * counts as part of the source too (see `publishedResources`).
 */

import { originOf, pathIsUnder, sourceScopeOf } from './nugetServiceIndex';
import type { HttpFetcher } from './nugetSourceCapabilities';
import { basicAuthHeader, mayAuthenticate, type SourceCredential } from './nugetSourceCredentials';

/** Kept as a name for what this module produces; the shape is the shared one. */
export type AuthorizedFetcher = HttpFetcher;

/** How long a refusal is held before the source is asked again (#133). */
export const REFUSAL_HOLD_MS = 60_000;

function holdPhrase(): string {
  const seconds = Math.round(REFUSAL_HOLD_MS / 1000);
  if (seconds % 60 !== 0) return `${seconds} seconds`;
  const minutes = seconds / 60;
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/**
 * What the Log says when a source refuses the credential it was given (#133).
 * The two statuses mean different things and call for different action: a
 * `401` says the credential itself is wrong, a `403` says it is known but not
 * allowed to read here.
 */
export function refusalNote(sourceUrl: string, status: number): string {
  const held = `Not asking that source again for ${holdPhrase()}.`;
  return status === 401
    ? `The credential for ${sourceUrl} was not accepted (401) — check the user name and password. ${held}`
    : `The credential for ${sourceUrl} is not allowed to read it (403). ${held}`;
}

interface RegisteredCredential {
  /** The source as configured, for naming it in the Log. */
  sourceUrl: string;
  /** Where the source lives on its host — see `sourceScopeOf`. */
  path: string;
  credential: SourceCredential;
  allowInsecureConnections?: boolean;
  /** Set while a `401`/`403` is being held for this source (#133). */
  refused?: { status: number; until: number };
  /** Built on first use and kept for the session, so decryption happens once. */
  header?: string;
  resolved?: boolean;
}

/**
 * What is known about which origin needs which credential. Filled in while the
 * configuration is read, and consulted only by the fetcher below.
 */
export class CredentialRegistry {
  /** Several sources can share an origin, so each origin holds a list. */
  private readonly _byOrigin = new Map<string, RegisteredCredential[]>();
  private readonly _now: () => number;
  private readonly _onRefused?: (sourceUrl: string, status: number) => void;
  private readonly _published?: (sourceUrl: string) => readonly string[];

  constructor(options: {
    now?: () => number;
    /**
     * The addresses a source's own service index published, when it has been
     * read. A resource it names belongs to it wherever on the host it lies.
     * Asked afresh for each request rather than copied in, so what the registry
     * believes can never be older than what the capability store knows.
     */
    publishedResources?: (sourceUrl: string) => readonly string[];
    /** Told once per held refusal, naming the source (#133). */
    onRefused?: (sourceUrl: string, status: number) => void;
  } = {}) {
    this._now = options.now ?? Date.now;
    this._onRefused = options.onRefused;
    this._published = options.publishedResources;
  }

  remember(
    sourceUrl: string,
    credential: SourceCredential,
    allowInsecureConnections?: boolean,
  ): void {
    const scope = sourceScopeOf(sourceUrl);
    if (!scope) return;
    const list = this._byOrigin.get(scope.origin) ?? [];
    const index = list.findIndex((entry) => entry.path === scope.path);
    const entry: RegisteredCredential = {
      sourceUrl, path: scope.path, credential, allowInsecureConnections,
    };
    if (index < 0) {
      list.push(entry);
    } else if (sameCredential(list[index], entry)) {
      // Read again from a cached configuration: keep what was learned about it,
      // the decrypted header and a refusal still being held.
      return;
    } else {
      list[index] = entry;
    }
    this._byOrigin.set(scope.origin, list);
  }

  /** Drops what is held — used when the configuration changes under us. */
  clear(): void {
    this._byOrigin.clear();
  }

  /** The configured source whose address covers `url` — the longest prefix wins. */
  private _entryFor(url: string): RegisteredCredential | undefined {
    const origin = originOf(url);
    if (!origin) return undefined;
    let path: string;
    try {
      path = new URL(url).pathname.toLowerCase();
    } catch {
      return undefined;
    }
    // How closely each configured source claims this address: by its own path,
    // or by a resource its service index published. The closer claim wins, and
    // an address a source named outright wins a tie over one it merely lies
    // below.
    let best: { entry: RegisteredCredential; length: number; named: boolean } | undefined;
    for (const entry of this._byOrigin.get(origin) ?? []) {
      const claims: Array<{ length: number; named: boolean }> = [];
      if (pathIsUnder(path, entry.path)) claims.push({ length: entry.path.length, named: false });
      for (const published of this._published?.(entry.sourceUrl) ?? []) {
        const base = publishedScope(published, origin);
        if (base !== undefined && pathIsUnder(path, base)) claims.push({ length: base.length, named: true });
      }
      for (const claim of claims) {
        if (!best || claim.length > best.length || (claim.length === best.length && claim.named && !best.named)) {
          best = { entry, ...claim };
        }
      }
    }
    return best?.entry;
  }

  /**
   * The status this address's source refused with moments ago, while that
   * refusal is held (#133). A `401`/`403` is neither retried nor cached, so
   * without this every later question pays a round trip to be refused again.
   */
  refusalFor(url: string): number | undefined {
    const entry = this._entryFor(url);
    if (!entry?.refused) return undefined;
    if (this._now() >= entry.refused.until) {
      entry.refused = undefined;
      return undefined;
    }
    return entry.refused.status;
  }

  /** A request that carried this source's credential was refused. */
  noteRefusal(url: string, status: number): void {
    const entry = this._entryFor(url);
    if (!entry) return;
    const first = entry.refused === undefined || this._now() >= entry.refused.until;
    entry.refused = { status, until: this._now() + REFUSAL_HOLD_MS };
    if (first) this._onRefused?.(entry.sourceUrl, status);
  }

  /** The header for this address, or nothing when it must go out anonymous. */
  async headerFor(url: string): Promise<string | undefined> {
    const entry = this._entryFor(url);
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
  return async (url, signal, headers, intent) => {
    const held = registry.refusalFor(url);
    if (held !== undefined) {
      return { status: held, preview: 'Refused a moment ago; not asked again yet (#133)' };
    }
    const header = await registry.headerFor(url);
    // The headers passed in belong to whoever wrapped this — the cache asking
    // whether its copy is still current, for one. Building a fresh object here
    // silently dropped them, and a dropped validator is a full download.
    const response = await fetchJson(url, signal, header ? { ...headers, authorization: header } : headers, intent);
    // Only a request that carried a credential can say it was not accepted.
    if (header && (response.status === 401 || response.status === 403)) {
      registry.noteRefusal(url, response.status);
    }
    return response;
  };
}

function sameCredential(a: RegisteredCredential, b: RegisteredCredential): boolean {
  return a.credential.username === b.credential.username
    && a.credential.password === b.credential.password
    && a.credential.encrypted === b.credential.encrypted
    && a.allowInsecureConnections === b.allowInsecureConnections;
}

/** The path of a published resource address on `origin`, or nothing when it lies elsewhere. */
function publishedScope(published: string, origin: string): string | undefined {
  try {
    const parsed = new URL(published);
    if (parsed.origin.toLowerCase() !== origin) return undefined;
    return parsed.pathname.toLowerCase().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}
