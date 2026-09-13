/**
 * Searching a feed over HTTP, and knowing when not to search at all (#27).
 *
 * Search is the one catalog operation where feeds differ in *what they can
 * see*, not merely in what they encode. A repository that fronts an upstream
 * answers a search from what it has already cached: the same query that finds
 * thousands of packages upstream finds a handful through the front. So a query
 * that names a package exactly must not be left to search alone — the exact
 * lookup down the version ladder is the only thing that finds a package nobody
 * has pulled through that feed yet.
 *
 * Two more behaviours the parser here is built around:
 *
 * - **The match count cannot be trusted.** It is mandatory in the protocol and
 *   was observed permanently zero on a conformant-looking server with a
 *   non-empty result set. Paging and emptiness are decided by the records
 *   actually received, never by that number.
 * - **Two parameters are not optional in practice.** Without the SemVer level
 *   the answer silently omits SemVer 2.0.0 packages, and without the
 *   pre-release flag it omits pre-releases. Both are always sent.
 */

import { getConfig } from './config';
import type {
  JsonFetcher,
  ProbeTarget,
  SourceCapabilityStore,
} from './nugetSourceCapabilities';
import { SILENT_HTTP_LOG, type HttpLogSink } from './nugetHttpLog';
import { excerpt } from './nugetVersionLadder';

export interface SearchHit {
  id: string;
  latestVersion: string;
  description?: string;
}

export interface SearchRequest {
  query: string;
  prerelease?: boolean;
  take?: number;
}

/** What the CLI asks for when it is given no count of its own. */
const DEFAULT_TAKE = 20;

/**
 * True when the query could be a package identifier — no whitespace, and only
 * the characters an id may contain.
 *
 * Deliberately generous: a one-word query is a valid id too, and the exact
 * lookup it triggers costs a single small request that answers 404 when there
 * is no such package. Paying that occasionally is worth never missing a package
 * on a feed whose search sees only what it has already cached.
 */
export function looksLikePackageId(query: string): boolean {
  const trimmed = query.trim();
  return trimmed.length >= 2 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed);
}

export function searchUrl(base: string, request: SearchRequest): string {
  const params: Record<string, string> = {
    q: request.query.trim(),
    skip: '0',
    take: String(request.take ?? DEFAULT_TAKE),
    prerelease: String(request.prerelease === true),
    semVerLevel: '2.0.0',
  };
  try {
    const url = new URL(base);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  } catch {
    const query = new URLSearchParams(params).toString();
    return base.includes('?') ? `${base}&${query}` : `${base}?${query}`;
  }
}

/**
 * The records of one search response. `undefined` means the document was not a
 * search response at all; an empty array means the server answered and found
 * nothing, which is an answer.
 */
export function parseSearchResponse(json: unknown): SearchHit[] | undefined {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return undefined;

  const hits: SearchHit[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { id?: unknown; version?: unknown; description?: unknown; versions?: unknown };
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id) continue;

    let latestVersion = typeof row.version === 'string' ? row.version.trim() : '';
    if (!latestVersion && Array.isArray(row.versions)) {
      // Some servers state the version only inside the per-version list; the
      // last entry there is the newest one they published.
      const last = row.versions[row.versions.length - 1] as { version?: unknown } | undefined;
      if (typeof last?.version === 'string') latestVersion = last.version.trim();
    }
    if (!latestVersion) continue;

    hits.push({
      id,
      latestVersion,
      description: typeof row.description === 'string' && row.description.trim()
        ? row.description.trim()
        : undefined,
    });
  }
  return hits;
}

export interface SearchOptions {
  isEnabled?: () => boolean;
  log?: HttpLogSink;
}

export class PackageSearch {
  /** The experimental flag; while it is off nothing here opens a connection. */
  private readonly _isEnabled: () => boolean;
  private readonly _log: HttpLogSink;

  constructor(
    private readonly _capabilities: SourceCapabilityStore,
    private readonly _fetchJson: JsonFetcher,
    options: SearchOptions = {},
  ) {
    this._isEnabled = options.isEnabled ?? (() => getConfig().experimentalHttpCatalog);
    this._log = options.log ?? SILENT_HTTP_LOG;
  }

  /** True when this source publishes a search resource worth trying. */
  hasSearch(target: ProbeTarget): boolean {
    return this._capabilities.resourceUrls(target.url, 'SearchQueryService').length > 0;
  }

  /**
   * Searches one source. `undefined` means it could not answer and the caller
   * must decide what to do about that; an empty array means it answered and
   * found nothing.
   */
  async searchSource(
    target: ProbeTarget,
    request: SearchRequest,
    signal?: AbortSignal,
  ): Promise<SearchHit[] | undefined> {
    if (!this._isEnabled()) return undefined;
    if (!request.query.trim()) return [];

    const capabilities = await this._capabilities.ensure(target, signal);
    if (capabilities.index !== 'ok') return undefined;

    for (const base of this._capabilities.resourceUrls(target.url, 'SearchQueryService')) {
      let response;
      try {
        response = await this._fetchJson(searchUrl(base, request), signal);
      } catch {
        return undefined;
      }
      if (response.status !== 200) continue;

      const hits = parseSearchResponse(response.json);
      if (!hits) {
        this._log.note(
          `search resource at ${base} answered in an unexpected shape — not used for an hour`,
          excerpt(response.preview),
        );
        this._capabilities.markBroken(target.url, 'SearchQueryService', base);
        continue;
      }
      this._capabilities.markProved(target.url, 'SearchQueryService', base);
      this._log.note(
        `search "${request.query.trim()}"`,
        `${hits.length} hit(s) · ${target.name ?? target.url}`,
      );
      return hits;
    }
    return undefined;
  }
}
