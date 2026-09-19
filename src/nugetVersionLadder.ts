/**
 * "Which versions of this package exist" over HTTP (#27).
 *
 * Today that answer costs a CLI process per config file, and the CLI gets it
 * from the metadata resource — measured at 353 KB for a package whose plain
 * version list is 1 KB. The ladder asks the cheapest resource that can answer
 * and climbs only when it cannot:
 *
 * 1. package content — a predictable path, present wherever v3 is;
 * 2. metadata — expensive, but carries everything else too;
 * 3. autocomplete in its "versions of this id" mode — opportunistic, since
 *    several servers do not offer it and one advertises it while returning
 *    nothing;
 * 4. the CLI, exactly as today — reached by answering `undefined` here.
 *
 * Three rules the shape of this file follows from:
 *
 * - **The first rung carries no labels.** Its answer is one array of strings:
 *   no vulnerabilities, no deprecation, no dates. This module answers "which
 *   versions exist" and nothing else; labels come from elsewhere.
 * - **Search is never a rung.** Its per-version entries carry only a number, a
 *   download count and a link, its labels describe the newest version alone,
 *   and one kind of feed searches only what it has already cached.
 * - **A rung that cannot answer must not be mistaken for an empty answer.** A
 *   404 counts as "not on this feed" only once that resource has proved itself
 *   on some earlier request; until then it is treated as no answer, and the
 *   CLI decides. Reporting "no such package" from a broken guess would be
 *   worse than the process launch it saves.
 */

import { getConfig } from './config';
import { compareSemVer, isPrerelease } from './semver';
import {
  parseRegistrationIndex,
  parseRegistrationPageEntries,
  type CatalogVersionEntry,
  type RegistrationPage,
} from './nugetRegistration';
import {
  normalizeSourceKey,
  type JsonFetcher,
  type ProbeTarget,
  type ProbedBaseType,
  type SourceCapabilityStore,
} from './nugetSourceCapabilities';
import { SILENT_HTTP_LOG, type HttpLogSink } from './nugetHttpLog';

export type VersionLadderRung = 'content' | 'metadata' | 'autocomplete';

export interface SourceVersions {
  /** The source as configured, so the caller can tie the answer to its name. */
  sourceUrl: string;
  /** Versions as the feed published them, newest first. */
  versions: string[];
  /** Which rung answered. Empty versions with a rung means "not on this feed". */
  rung: VersionLadderRung;
}

export interface VersionQuery {
  packageId: string;
  /**
   * One version the caller is after. The metadata resource is paged and every
   * page states the range it covers, so naming a version turns a walk over
   * every page into a single fetch — which for a long-lived package is the
   * difference between one document and a dozen.
   */
  version?: string;
  /**
   * The caller wants the newest version and nothing else, so only the page that
   * can hold it is read.
   *
   * This is a **separate flag on purpose**, never inferred from `version` being
   * absent. Three callers share this walk and only one of them wants a single
   * version: the version list and the enrich answer both name no version and
   * need every page. Reading "no version named" as "the newest will do" would
   * quietly cut a package's history down to its most recent page for those two
   * — and it would not fall back to the CLI, because a short answer still looks
   * like a successful one.
   */
  newestOnly?: boolean;
  /**
   * Pre-releases are excluded unless asked for, which is what the CLI does
   * without `--prerelease`. Leaving them in by default would put a release
   * candidate at the top of a picker that never showed one before.
   */
  includePrerelease?: boolean;
}

/**
 * One rung either answers, states the package is absent, says nothing, or says
 * "not here, but I have never proved myself".
 *
 * That last one exists because a 404 from a resource that has not yet answered
 * correctly could be the resource rather than the package. One such answer
 * proves nothing — but when *every* advertised rung says it, two independent
 * resources agree, and the package is absent. Without this rule a feed whose
 * cheap resource is never exercised — because every real lookup goes through
 * metadata — pays two or three requests for every id that does not exist.
 */
type RungOutcome =
  | { kind: 'versions'; versions: string[] }
  | { kind: 'absent' }
  | { kind: 'unproven-miss' }
  | { kind: 'inconclusive' }
  /**
   * The address answered, but not with the document this resource should serve.
   * Carries the start of what it did answer: this outcome removes a resource
   * for an hour, and "why did the feed drop out" is unanswerable without it.
   */
  | { kind: 'malformed'; preview?: string };

const INCONCLUSIVE: RungOutcome = { kind: 'inconclusive' };
const ABSENT: RungOutcome = { kind: 'absent' };
const UNPROVEN_MISS: RungOutcome = { kind: 'unproven-miss' };

/**
 * A registration document is paged, and a package with a long history has many
 * pages. Past this count the ladder stops rather than issuing an unbounded
 * number of requests: a truncated version list would be a wrong answer, so it
 * gives none and lets the CLI answer.
 */
const MAX_REGISTRATION_PAGES = 64;

/** Ids are lowercased by invariant rules for every predictable path. */
function lowerId(packageId: string): string {
  return packageId.trim().toLowerCase();
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function withQuery(base: string, params: Record<string, string>): string {
  try {
    const url = new URL(base);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  } catch {
    const query = new URLSearchParams(params).toString();
    return base.includes('?') ? `${base}&${query}` : `${base}?${query}`;
  }
}

function sortDescending(versions: Iterable<string>): string[] {
  return [...new Set(versions)].sort((a, b) => compareSemVer(b, a));
}

/**
 * Whether a page can hold a version, by the bounds the server stated.
 *
 * Both bounds are mandatory in the protocol and were present on every server
 * measured — but a page missing them is included rather than skipped, since an
 * unstated range is unknown, not empty.
 */
function pageMayHold(page: { lower?: string; upper?: string }, version: string): boolean {
  if (!page.lower || !page.upper) return true;
  // Bounds are normalised and carry no build metadata, while the version asked
  // for may carry both; comparing the parsed forms is what makes them meet.
  const wanted = version.split('+')[0];
  return compareSemVer(wanted, page.lower) >= 0 && compareSemVer(wanted, page.upper) <= 0;
}

/** One line of what a body looked like — enough to recognise it, no more. */
export function excerpt(preview: string | undefined, max = 400): string {
  if (!preview) return 'no body';
  const flat = preview.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * What makes two catalog walks the same walk.
 *
 * The scope has to be part of it. A walk for one named version reads the single
 * page that covers it, and a walk for the whole history reads every page; they
 * ask the same resource about the same package and return different things, so
 * sharing one answer between them would hand somebody a catalog that is not the
 * one they asked for.
 */
function walkKey(target: ProbeTarget, query: VersionQuery): string {
  // JSON rather than a joined string: no separator can then collide with a
  // character that is legal inside a URL or a package id.
  return JSON.stringify([
    normalizeSourceKey(target.url),
    lowerId(query.packageId),
    query.includePrerelease === true ? 'pre' : 'rel',
    query.version?.trim() ?? '',
    query.newestOnly ? 'newest' : 'all',
  ]);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) continue;
    out.push(item.trim());
  }
  return out;
}

export interface LadderOptions {
  isEnabled?: () => boolean;
  log?: HttpLogSink;
}

export class VersionLadder {
  /**
   * Documents already turned into entries, keyed by the parsed document itself.
   *
   * The response cache hands back the very same object on a hit, so identity is
   * a sound key and needs no expiry — when the cache forgets the document, this
   * forgets it too. Without it, three consumers asking about one package
   * rebuilt several hundred entries of fifteen fields each, three times, from
   * bytes that were parsed only once.
   */
  private readonly _pages = new WeakMap<object, RegistrationPage[]>();

  /**
   * Catalog walks in flight, by what makes a walk the same walk. Selecting a
   * package asks for its version list and its details in the same tick, and
   * both walk this document; without this the second one repeats the first.
   */
  private readonly _walks = new Map<string, Promise<CatalogVersionEntry[] | undefined>>();
  private readonly _entries = new WeakMap<object, CatalogVersionEntry[]>();

  /** The experimental flag; while it is off the ladder makes no request. */
  private readonly _isEnabled: () => boolean;
  /** Where the chosen rung is reported; the requests log themselves. */
  private readonly _log: HttpLogSink;

  constructor(
    private readonly _capabilities: SourceCapabilityStore,
    private readonly _fetchJson: JsonFetcher,
    options: LadderOptions = {},
  ) {
    this._isEnabled = options.isEnabled ?? (() => getConfig().experimentalHttpCatalog);
    this._log = options.log ?? SILENT_HTTP_LOG;
  }

  /**
   * Versions from one source, or `undefined` when no rung could answer — which
   * is the signal to fall back to the CLI for this source.
   */
  async versionsFromSource(
    target: ProbeTarget,
    query: VersionQuery,
    signal?: AbortSignal,
  ): Promise<SourceVersions | undefined> {
    if (!this._isEnabled()) return undefined;
    if (!query.packageId.trim()) return undefined;

    const capabilities = await this._capabilities.ensure(target, signal);
    if (capabilities.index !== 'ok') return undefined;

    const rungs: Array<[VersionLadderRung, (t: ProbeTarget, q: VersionQuery, s?: AbortSignal) => Promise<RungOutcome>]> = [
      ['content', (t, q, s) => this._fromContent(t, q, s)],
      ['metadata', (t, q, s) => this._fromRegistration(t, q, s)],
      ['autocomplete', (t, q, s) => this._fromAutocomplete(t, q, s)],
    ];

    let misses = 0;
    for (const [rung, run] of rungs) {
      const outcome = await run(target, query, signal);
      if (outcome.kind === 'unproven-miss') {
        misses += 1;
        // Two advertised resources independently saying "not here" settles it,
        // without either of them having had to prove itself on a real package.
        if (misses < 2) continue;
        this._log.note(`${query.packageId} is not on this feed`, target.name ?? target.url);
        return { sourceUrl: target.url, versions: [], rung };
      }
      // A malformed answer is handled where the address is condemned; by the
      // time it reaches here the walk has already moved on.
      if (outcome.kind === 'inconclusive' || outcome.kind === 'malformed') continue;
      const versions = outcome.kind === 'absent'
        ? []
        : outcome.versions.filter((v) => query.includePrerelease === true || !isPrerelease(v));
      const sorted = sortDescending(versions);
      this._log.note(
        sorted.length === 0
          ? `${query.packageId} is not on this feed`
          : `versions of ${query.packageId} from ${rung} resource`,
        sorted.length === 0
          ? (target.name ?? target.url)
          : `${sorted.length} version(s) · ${target.name ?? target.url}`,
      );
      return { sourceUrl: target.url, versions: sorted, rung };
    }
    this._log.note(
      `no HTTP rung answered for ${query.packageId}`,
      `falling back to the CLI · ${target.name ?? target.url}`,
    );
    return undefined;
  }

  /**
   * The cheapest rung: one array of version strings under a predictable path.
   * It is also the only one present on every v3 feed measured, which is why it
   * goes first even though it carries nothing else.
   */
  private async _fromContent(
    target: ProbeTarget,
    query: VersionQuery,
    signal?: AbortSignal,
  ): Promise<RungOutcome> {
    return this._walk(target, 'PackageBaseAddress', signal, async (base, proven) => {
      const url = joinUrl(base, `${lowerId(query.packageId)}/index.json`);
      const response = await this._fetchJson(url, signal);
      if (response.status === 404 || response.status === 410) {
        // Only a resource that has already answered correctly may declare a
        // package missing on its own; otherwise this 404 might be the resource
        // itself, and it takes a second rung agreeing to settle it.
        return proven ? ABSENT : UNPROVEN_MISS;
      }
      if (response.status !== 200) return INCONCLUSIVE;
      const versions = stringArray((response.json as { versions?: unknown } | null)?.versions);
      if (!versions) return { kind: 'malformed', preview: response.preview };
      return { kind: 'versions', versions };
    });
  }

  /**
   * The metadata resource. Expensive — it carries every per-version field —
   * but it is the one rung that exists on feeds whose content resource is
   * missing or blocked.
   */
  private async _fromRegistration(
    target: ProbeTarget,
    query: VersionQuery,
    signal?: AbortSignal,
  ): Promise<RungOutcome> {
    const entries = await this._catalogEntries(target, query, signal);
    if (entries.kind !== 'entries') return entries;
    return { kind: 'versions', versions: entries.entries.map((e) => e.version) };
  }

  /**
   * The full per-version catalog from the metadata resource: the same walk the
   * version rung makes, keeping everything the leaves carry instead of only the
   * numbers. This is the only resource that states deprecation and
   * vulnerabilities *per version* — in search those describe the newest version
   * alone — so any label shown against a specific version comes from here.
   */
  async catalogFromSource(
    target: ProbeTarget,
    query: VersionQuery,
    signal?: AbortSignal,
  ): Promise<CatalogVersionEntry[] | undefined> {
    if (!this._isEnabled()) return undefined;
    if (!query.packageId.trim()) return undefined;

    // Selecting a package asks for its version list and its details in the same
    // tick, and both walk this document. The response cache already keeps that
    // from being two downloads, but the walk itself ran twice: two index reads,
    // two page loops, two sets of log rows. Sharing it here makes the second
    // caller wait on the first instead of repeating it.
    const key = walkKey(target, query);
    const running = this._walks.get(key);
    if (running) return running;

    const walk = this._catalogWalk(target, query, signal).finally(() => this._walks.delete(key));
    this._walks.set(key, walk);
    return walk;
  }

  private async _catalogWalk(
    target: ProbeTarget,
    query: VersionQuery,
    signal?: AbortSignal,
  ): Promise<CatalogVersionEntry[] | undefined> {
    const capabilities = await this._capabilities.ensure(target, signal);
    if (capabilities.index !== 'ok') return undefined;

    const outcome = await this._catalogEntries(target, query, signal);
    if (outcome.kind === 'absent') return [];
    if (outcome.kind !== 'entries') return undefined;
    return outcome.entries.filter(
      (e) => query.includePrerelease === true || !isPrerelease(e.version),
    );
  }

  private async _catalogEntries(
    target: ProbeTarget,
    query: VersionQuery,
    signal?: AbortSignal,
  ): Promise<RungOutcome | { kind: 'entries'; entries: CatalogVersionEntry[] }> {
    let collected: CatalogVersionEntry[] = [];
    const outcome = await this._walk(target, 'RegistrationsBaseUrl', signal, async (base, proven) => {
      const url = joinUrl(base, `${lowerId(query.packageId)}/index.json`);
      const response = await this._fetchJson(url, signal);
      if (response.status === 404 || response.status === 410) return proven ? ABSENT : UNPROVEN_MISS;
      if (response.status !== 200) return INCONCLUSIVE;

      const pages = this._indexPages(response.json);
      if (!pages) return { kind: 'malformed', preview: response.preview };
      // A truncated version list is a wrong answer, so past this many pages the
      // rung declines and the CLI answers instead.
      if (pages.length > MAX_REGISTRATION_PAGES) return INCONCLUSIVE;

      const entries: CatalogVersionEntry[] = [];
      const wanted = query.version?.trim();
      // Pages are published in ascending version order, so the newest version a
      // package has is on the last of them. Asked for that alone, the rest of
      // the history is a download nobody reads: measured at 1 MB across four
      // pages where the last one, at 169 KB, held the answer.
      const chosen = query.newestOnly && !wanted ? pages.slice(-1) : pages;
      for (const page of chosen) {
        // A page whose stated range cannot hold the wanted version has nothing
        // to contribute, and skipping it skips a request.
        if (wanted && !pageMayHold(page, wanted)) continue;
        if (page.entries) {
          entries.push(...page.entries);
          continue;
        }
        // Page and leaf addresses are deliberately unpredictable; the address
        // in the document is the only legitimate way to a page.
        if (!page.url) continue;
        const pageResponse = await this._fetchJson(page.url, signal);
        if (pageResponse.status !== 200) return INCONCLUSIVE;
        const pageEntries = this._pageEntries(pageResponse.json);
        if (!pageEntries) return INCONCLUSIVE;
        entries.push(...pageEntries);
      }
      // With no version named, an empty catalog means the document was not one.
      // With a version named it means no page covers it, which is an answer
      // about the package rather than a verdict on the resource.
      if (entries.length === 0) {
        return wanted ? { kind: 'versions', versions: [] } : { kind: 'malformed', preview: response.preview };
      }
      collected = entries;
      return { kind: 'versions', versions: entries.map((e) => e.version) };
    });

    if (outcome.kind === 'versions') return { kind: 'entries', entries: collected };
    return outcome;
  }

  /**
   * Autocomplete answers the same question in its second mode, but it is
   * opportunistic: some feeds do not offer it, and one advertises it while
   * returning an empty list for everything. An empty answer therefore proves
   * nothing and is treated as no answer at all.
   */
  private async _fromAutocomplete(
    target: ProbeTarget,
    query: VersionQuery,
    signal?: AbortSignal,
  ): Promise<RungOutcome> {
    return this._walk(target, 'SearchAutocompleteService', signal, async (base) => {
      const url = withQuery(base, {
        id: query.packageId.trim(),
        prerelease: 'true',
        semVerLevel: '2.0.0',
      });
      const response = await this._fetchJson(url, signal);
      if (response.status !== 200) return INCONCLUSIVE;
      const data = stringArray((response.json as { data?: unknown } | null)?.data);
      if (!data) return { kind: 'malformed', preview: response.preview };
      if (data.length === 0) return INCONCLUSIVE;
      return { kind: 'versions', versions: data };
    });
  }

  /** The index document as pages, built once per document. */
  private _indexPages(json: unknown): RegistrationPage[] | undefined {
    if (!json || typeof json !== 'object') return parseRegistrationIndex(json);
    const held = this._pages.get(json as object);
    if (held) return held;
    const parsed = parseRegistrationIndex(json);
    if (parsed) this._pages.set(json as object, parsed);
    return parsed;
  }

  /** One page document as entries, built once per document. */
  private _pageEntries(json: unknown): CatalogVersionEntry[] | undefined {
    if (!json || typeof json !== 'object') return parseRegistrationPageEntries(json);
    const held = this._entries.get(json as object);
    if (held) return held;
    const parsed = parseRegistrationPageEntries(json);
    if (parsed) this._entries.set(json as object, parsed);
    return parsed;
  }

  /**
   * Runs one rung against each candidate address of its resource until one
   * answers, and records what was learned. An address whose answer had the
   * wrong shape is condemned and the next is tried; an address that answered
   * correctly is remembered as proven, which is what later lets a 404 mean
   * "not on this feed".
   */
  private async _walk(
    target: ProbeTarget,
    baseType: ProbedBaseType,
    signal: AbortSignal | undefined,
    attempt: (base: string, proven: boolean) => Promise<RungOutcome>,
  ): Promise<RungOutcome> {
    const capability = this._capabilities.get(target.url)?.resources[baseType];
    const urls = this._capabilities.resourceUrls(target.url, baseType);
    const proven = capability?.status === 'ready';

    for (const base of urls) {
      let outcome: RungOutcome;
      try {
        outcome = await attempt(base, proven);
      } catch {
        // A dropped connection says nothing about the resource.
        return INCONCLUSIVE;
      }
      if (outcome.kind === 'malformed') {
        // Condemning an address is the one decision here with an hour-long
        // consequence, and until now it left nothing behind but a successful
        // looking row. What the address actually answered goes on the log.
        this._log.note(
          `${baseType} at ${base} answered in an unexpected shape — not used for an hour`,
          excerpt(outcome.preview),
        );
        this._capabilities.markBroken(target.url, baseType, base);
        continue;
      }
      if (outcome.kind === 'versions') this._capabilities.markProved(target.url, baseType, base);
      return outcome;
    }
    return INCONCLUSIVE;
  }
}
