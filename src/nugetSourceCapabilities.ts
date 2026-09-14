/**
 * What one source can actually do, and remembering it (#27).
 *
 * The service index states an *intention*; a resource counts as usable only
 * after it has answered a real request in the expected shape. So a capability
 * has more than two states, and the difference between them decides behaviour:
 *
 * - `unknown` — never asked. Ask.
 * - `advertised` — the index lists it, nothing has been called yet. Try it.
 * - `ready` — it answered in the expected shape. Use it first.
 * - `unavailable` — asked, and it does not work. Skip it; do not re-probe on
 *   every panel refresh, which is the whole point of storing this.
 * - `unauthorized` — credentials are missing, which is neither broken nor
 *   usable. Retried sooner than a plain failure, so that fixing credentials
 *   does not require reloading the window.
 * - `proxy-auth` — the proxy in front of the feed wants credentials of its own.
 *   The feed said nothing at all here, so this is a verdict about the hop, not
 *   about the source; it expires soonest, because the proxy may start accepting
 *   the next moment and nothing about the feed has been learned.
 *
 * A transient failure — timeout, 429, 5xx, a dropped connection — records
 * nothing at all. Writing "does not work" on a network hiccup would disable a
 * working feed until the cache expired.
 *
 * The store performs the index request only; proving a resource is the job of
 * whoever calls it, through {@link SourceCapabilityStore.markProved} and
 * {@link SourceCapabilityStore.markBroken}. That keeps the proof tied to a real
 * request the extension needed anyway, instead of a request made to ask.
 */

import { getConfig } from './config';
import { classifyOrigin, parseServiceIndex, selectResources } from './nugetServiceIndex';
import { effectiveProtocolVersion } from './nugetProtocol';
import { saysNothingAboutResource } from './nugetHttpStatus';

/** Resource types the catalog ladder can use. Others are parsed but not stored. */
export const PROBED_BASE_TYPES = [
  'PackageBaseAddress',
  'RegistrationsBaseUrl',
  'SearchQueryService',
  'SearchAutocompleteService',
  'VulnerabilityInfo',
] as const;

export type ProbedBaseType = typeof PROBED_BASE_TYPES[number];

export type CapabilityStatus =
  | 'unknown'
  | 'advertised'
  | 'ready'
  | 'unavailable'
  | 'unauthorized';

export interface ResourceCapability {
  status: CapabilityStatus;
  /** Candidate addresses, best first. Extras are failover targets, not spares. */
  urls: string[];
}

/** Everything known about one source. Serialisable as-is. */
export interface SourceCapabilities {
  /** Normalized key this record is stored under. */
  source: string;
  /** When the verdict below was reached. */
  probedAt: number;
  /** Verdict on the index itself; without it no resource can be known. */
  index: 'unknown' | 'ok' | 'unavailable' | 'unauthorized' | 'proxy-auth';
  resources: Partial<Record<ProbedBaseType, ResourceCapability>>;
}

export interface ProbeTarget {
  /** The source address as configured. */
  url: string;
  /** The name the configuration gave this source, when the caller knows it. */
  name?: string;
  /** Explicit `protocolVersion` from nuget.config, when the source carries one. */
  protocolVersion?: '2' | '3';
  /**
   * Origins the user has configured elsewhere — other package sources and audit
   * sources. A resource on one of those is legitimate even though it is not the
   * origin of this source; the vulnerability database almost always is one.
   */
  knownOrigins?: readonly string[];
}

/** A response reduced to what the verdict depends on. */
export interface HttpJsonResponse {
  /** HTTP status, or 0 when no response arrived at all. */
  status: number;
  json?: unknown;
  /** Body size, when the transport measured it — shown in the log. */
  bytes?: number;
  /** Validators the server offered, used to ask whether a held copy is current. */
  etag?: string;
  lastModified?: string;
  /** `Retry-After`, as the server wrote it, when it asked for a pause. */
  retryAfter?: string;
  /** The start of the body as text — what an answer that surprised us looked like. */
  preview?: string;
  /**
   * The body in full, present only when the caller asked for it. Everything in
   * this feature reads JSON; a package's `.nuspec` is XML, and it is the only
   * place a file licence is named (#89). Kept off by default so a registration
   * document of half a megabyte is not held twice.
   */
  text?: string;
}

export type JsonFetcher = (url: string, signal?: AbortSignal) => Promise<HttpJsonResponse>;

/**
 * The fetcher every wrapper in the chain takes and returns. Declared once: two
 * copies of this type drifted apart, and the layer that dropped the headers it
 * was handed type-checked cleanly against its own copy.
 */
export interface FetchIntent {
  /** Keep the body as text on the result; for a document that is not JSON. */
  wantText?: boolean;
}

export type HttpFetcher = (
  url: string,
  signal?: AbortSignal,
  headers?: Record<string, string>,
  intent?: FetchIntent,
) => Promise<HttpJsonResponse>;

export interface CapabilityStorage {
  read(): unknown;
  write(value: unknown): void | Promise<void>;
}

/** The shape of a VS Code memento, without importing the editor API here. */
export interface KeyValueStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

const STORAGE_KEY = 'averenium.nugetManager.sourceCapabilities';

/**
 * Machine-wide storage for the verdicts. Kept out of workspace state on
 * purpose: what a feed supports is a property of the feed, not of the folder
 * that happens to be open, and re-probing per workspace is the cost this whole
 * cache exists to avoid.
 */
export function capabilityStorage(state: KeyValueStore): CapabilityStorage {
  return {
    read: () => state.get<unknown>(STORAGE_KEY, undefined),
    write: (value) => { void state.update(STORAGE_KEY, value); },
  };
}

/**
 * A service index is near-static, so a working verdict is held for a day.
 * Negative verdicts expire far sooner: a feed that was down, or one the user
 * has just supplied credentials for, must come back without reloading the window.
 */
const READY_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 60 * 1000;
/**
 * A refusal by the proxy says nothing about the feed, and the proxy may accept
 * the very next request; holding that verdict for an hour would be holding an
 * opinion about the wrong thing.
 */
const PROXY_AUTH_TTL_MS = 5 * 60 * 1000;
/** After a transient failure, how long before the same source is probed again. */
const TRANSIENT_BACKOFF_MS = 30 * 1000;

const STORAGE_VERSION = 1;

/**
 * Cache key. Scheme and host are case-insensitive by definition; the path is
 * not, and two feeds differing only in path case are two feeds, so it is kept
 * as published, minus a trailing slash.
 */
export function normalizeSourceKey(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

/** A proxy answering the tunnel with 407, as opposed to failing to answer. */
function isProxyRefusal(error: unknown): boolean {
  return (error as { name?: string; status?: number })?.name === 'ProxyRefusedError'
    && (error as { status?: number }).status === 407;
}

function unknownRecord(source: string, now: number): SourceCapabilities {
  return { source, probedAt: now, index: 'unknown', resources: {} };
}

function ttlFor(record: SourceCapabilities): number {
  if (record.index === 'ok') return READY_TTL_MS;
  if (record.index === 'proxy-auth') return PROXY_AUTH_TTL_MS;
  return NEGATIVE_TTL_MS;
}

export class SourceCapabilityStore {
  private readonly _memory = new Map<string, SourceCapabilities>();
  private readonly _inFlight = new Map<string, Promise<SourceCapabilities>>();
  private readonly _backoffUntil = new Map<string, number>();
  private _loaded = false;

  constructor(
    private readonly _fetchJson: JsonFetcher,
    private readonly _storage?: CapabilityStorage,
    private readonly _now: () => number = () => Date.now(),
    /**
     * The experimental flag, read through a function so toggling the setting
     * takes effect without rebuilding anything. While it is off this store
     * never opens a connection, which is what makes the feature switchable off
     * in the literal sense.
     */
    private readonly _isEnabled: () => boolean = () => getConfig().experimentalHttpCatalog,
  ) {}

  /** What is already known, without asking the network. */
  get(sourceUrl: string): SourceCapabilities | undefined {
    const key = normalizeSourceKey(sourceUrl);
    this._load();
    const record = this._memory.get(key);
    if (!record) return undefined;
    if (this._now() - record.probedAt > ttlFor(record)) {
      this._memory.delete(key);
      return undefined;
    }
    return record;
  }

  /**
   * Probes the source once, or returns the stored verdict. Concurrent callers
   * share a single request: a panel refresh asks about several things at once
   * and must not turn that into several index reads.
   */
  async ensure(target: ProbeTarget, signal?: AbortSignal): Promise<SourceCapabilities> {
    const key = normalizeSourceKey(target.url);
    if (!this._isEnabled()) return unknownRecord(key, this._now());

    const cached = this.get(target.url);
    if (cached) return cached;

    const backoff = this._backoffUntil.get(key) ?? 0;
    if (this._now() < backoff) return unknownRecord(key, this._now());

    const existing = this._inFlight.get(key);
    if (existing) return existing;

    const running = this._probe(key, target, signal).finally(() => this._inFlight.delete(key));
    this._inFlight.set(key, running);
    return running;
  }

  /** Candidate addresses for one resource, best first; empty when unusable. */
  resourceUrls(sourceUrl: string, baseType: ProbedBaseType): string[] {
    const capability = this.get(sourceUrl)?.resources[baseType];
    if (!capability) return [];
    if (capability.status === 'unavailable' || capability.status === 'unauthorized') return [];
    return capability.urls;
  }

  /**
   * Records that an address answered in the expected shape. This is the only
   * thing that turns an intention into a fact, and it moves the proven address
   * to the front so failover does not have to be rediscovered.
   */
  markProved(sourceUrl: string, baseType: ProbedBaseType, url: string): void {
    const record = this.get(sourceUrl);
    if (!record) return;
    const capability = record.resources[baseType];

    // A resource answering correctly is evidence the index is still current, so
    // the record ages from here. A failure, by contrast, must not extend the
    // life of everything else known about the source.
    record.probedAt = this._now();

    // After the first success this call has nothing new to say: the status is
    // already `ready` and the proven address is already first. Persisting
    // regardless turned one wave of fifty packages into fifty writes to the
    // editor's state store for a single source.
    if (capability?.status === 'ready' && capability.urls[0] === url) return;

    const rest = (capability?.urls ?? []).filter((u) => u !== url);
    record.resources[baseType] = { status: 'ready', urls: [url, ...rest] };
    this._persist();
  }

  /**
   * Records that an address did not work. Only that address is condemned: while
   * other candidates remain the resource is still worth trying, and it becomes
   * unavailable only when the last one is gone.
   */
  markBroken(sourceUrl: string, baseType: ProbedBaseType, url?: string): void {
    const record = this.get(sourceUrl);
    if (!record) return;
    const capability = record.resources[baseType];
    const remaining = url ? (capability?.urls ?? []).filter((u) => u !== url) : [];
    record.resources[baseType] = remaining.length > 0
      ? { status: 'advertised', urls: remaining }
      : { status: 'unavailable', urls: [] };
    this._persist();
  }

  /**
   * Drops every verdict. Called when the configuration changes: a source may
   * have been added, removed, re-addressed or given credentials, and any of
   * those makes what was learned about it stale. Re-probing costs one small
   * request per source, which is the right price for being wrong for a day.
   */
  forgetAll(): void {
    this._load();
    this._memory.clear();
    this._backoffUntil.clear();
    this._persist();
  }

  /** Drops what is known about a source — used when its configuration changes. */
  forget(sourceUrl: string): void {
    const key = normalizeSourceKey(sourceUrl);
    this._load();
    this._memory.delete(key);
    this._backoffUntil.delete(key);
    this._persist();
  }

  private async _probe(
    key: string,
    target: ProbeTarget,
    signal?: AbortSignal,
  ): Promise<SourceCapabilities> {
    // A v2 gallery has no service index to read. That verdict comes from the
    // configuration alone, so it costs no request.
    if (effectiveProtocolVersion(target.url, target.protocolVersion) !== '3') {
      return this._store({ source: key, probedAt: this._now(), index: 'unavailable', resources: {} });
    }

    let response: HttpJsonResponse;
    try {
      response = await this._fetchJson(target.url, signal);
    } catch (error) {
      // A proxy that demands credentials, and a proxy this build cannot speak
      // to, are verdicts rather than moments — the first about the hop, the
      // second about the configuration. Both send the work to the CLI, which
      // has what this lacks.
      if (isProxyRefusal(error)) {
        return this._store({ source: key, probedAt: this._now(), index: 'proxy-auth', resources: {} });
      }
      if ((error as Error)?.name === 'ProxyUnsupportedError') {
        return this._store({ source: key, probedAt: this._now(), index: 'unavailable', resources: {} });
      }
      this._backoffUntil.set(key, this._now() + TRANSIENT_BACKOFF_MS);
      return unknownRecord(key, this._now());
    }

    if (response.status === 401 || response.status === 403) {
      return this._store({ source: key, probedAt: this._now(), index: 'unauthorized', resources: {} });
    }
    if (saysNothingAboutResource(response.status)) {
      this._backoffUntil.set(key, this._now() + TRANSIENT_BACKOFF_MS);
      return unknownRecord(key, this._now());
    }

    const resources = parseServiceIndex(response.json);
    if (response.status >= 400 || resources.length === 0) {
      return this._store({ source: key, probedAt: this._now(), index: 'unavailable', resources: {} });
    }

    const record: SourceCapabilities = {
      source: key,
      probedAt: this._now(),
      index: 'ok',
      resources: {},
    };
    for (const baseType of PROBED_BASE_TYPES) {
      const urls: string[] = [];
      for (const published of selectResources(resources, baseType)) {
        const verdict = classifyOrigin(published, target.url, target.knownOrigins ?? []);
        // A foreign origin is dropped rather than called: the feed may be
        // relaying an upstream index, and following it reaches a host the user
        // never configured.
        if (verdict.kind === 'foreign') continue;
        if (!urls.includes(verdict.url)) urls.push(verdict.url);
        // A rewritten address keeps the published one behind it: the rewrite is
        // an inference about a proxy, and the original is the fallback if it is
        // wrong.
        if (verdict.kind === 'rewritten' && !urls.includes(verdict.original)) {
          urls.push(verdict.original);
        }
      }
      record.resources[baseType] = urls.length > 0
        ? { status: 'advertised', urls }
        : { status: 'unavailable', urls: [] };
    }
    return this._store(record);
  }

  private _store(record: SourceCapabilities): SourceCapabilities {
    this._load();
    this._memory.set(record.source, record);
    this._backoffUntil.delete(record.source);
    this._persist();
    return record;
  }

  private _load(): void {
    if (this._loaded) return;
    this._loaded = true;
    if (!this._storage) return;
    let raw: unknown;
    try {
      raw = this._storage.read();
    } catch {
      return;
    }
    const root = raw as { version?: unknown; entries?: unknown } | null;
    if (!root || typeof root !== 'object' || root.version !== STORAGE_VERSION) return;
    const entries = root.entries;
    if (!entries || typeof entries !== 'object') return;
    const now = this._now();
    for (const value of Object.values(entries as Record<string, unknown>)) {
      const record = value as SourceCapabilities | null;
      if (!record || typeof record.source !== 'string' || typeof record.probedAt !== 'number') continue;
      if (!record.resources || typeof record.resources !== 'object') continue;
      if (now - record.probedAt > ttlFor(record)) continue;
      this._memory.set(record.source, record);
    }
  }

  private _persist(): void {
    if (!this._storage) return;
    const entries: Record<string, SourceCapabilities> = {};
    for (const [key, record] of this._memory) entries[key] = record;
    try {
      void this._storage.write({ version: STORAGE_VERSION, entries });
    } catch {
      // A cache that cannot be written is still a working cache for this session.
    }
  }
}
