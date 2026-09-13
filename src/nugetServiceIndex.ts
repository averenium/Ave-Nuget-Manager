/**
 * Reading a v3 service index without knowing which server produced it (#27).
 *
 * Every difference observed across real feeds reduces to what the index says
 * and what the server then answers — never to a vendor name. This module holds
 * the first half of that: parsing the index, choosing a resource, and deciding
 * whether a resource's URL may be called at all. It performs no I/O, so every
 * rule below is testable against a shape rather than against a product.
 *
 * Three rules drive the whole file, each from a measured failure:
 *
 * - A resource is found by its **base type**, never by an exact `@type` string.
 *   Some feeds publish `RegistrationsBaseUrl/3.6.0` with no unversioned entry;
 *   others publish the unversioned entry and nothing above `3.0.0-rc`. Matching
 *   the literal string finds nothing on one side or the other.
 * - Walking down the preference list **skips gaps**: a feed can offer `3.6.0`
 *   and not `3.4.0`, so stopping at the first missing rank abandons a resource
 *   that works.
 * - Unknown types and unknown suffixes are **kept, not rejected**. The protocol
 *   requires ignoring what the client does not understand, and that is also how
 *   servers ship extensions without breaking clients.
 */

/** One entry of the service index, split into the parts selection needs. */
export interface ServiceIndexResource {
  /** `@type` up to the first `/` — `RegistrationsBaseUrl`, `SearchQueryService`, … */
  baseType: string;
  /** The part after the first `/`, or `undefined` for an unversioned entry. */
  suffix?: string;
  /** `@id` exactly as published. */
  url: string;
}

/**
 * Preference order per base type, best first, taken from the protocol's own
 * versioning tables. A suffix that is not listed here is still usable — it
 * simply ranks after every known one, which is what keeps an unrecognised
 * future revision from disabling a resource.
 *
 * Registration is the one place where the choice changes the *content* of the
 * answer and not just its encoding: below `3.6.0` the hive excludes SemVer 2.0.0
 * packages, and a client cannot tell an excluded version from a version that
 * does not exist. Hence `3.6.0` first, always.
 */
const SUFFIX_PREFERENCE: Record<string, readonly (string | undefined)[]> = {
  RegistrationsBaseUrl: ['3.6.0', 'Versioned', '3.4.0', undefined, '3.0.0-rc', '3.0.0-beta'],
  SearchQueryService: ['3.5.0', undefined, '3.0.0-rc', '3.0.0-beta'],
  SearchAutocompleteService: ['3.5.0', undefined, '3.0.0-rc', '3.0.0-beta'],
  PackageBaseAddress: ['3.0.0'],
  VulnerabilityInfo: ['6.7.0'],
};

/** Splits one `@type` into its base and suffix. */
function splitType(type: string): { baseType: string; suffix?: string } {
  const slash = type.indexOf('/');
  if (slash < 0) return { baseType: type };
  return { baseType: type.slice(0, slash), suffix: type.slice(slash + 1) };
}

/**
 * Every resource the index declares. Entries without a usable `@type` or `@id`
 * are dropped; everything else is kept, including types this build has never
 * heard of.
 */
export function parseServiceIndex(json: unknown): ServiceIndexResource[] {
  const root = json as { resources?: unknown } | null;
  const list = root && Array.isArray(root.resources) ? root.resources : [];
  const out: ServiceIndexResource[] = [];
  for (const item of list) {
    const row = item as { '@type'?: unknown; '@id'?: unknown };
    const type = typeof row?.['@type'] === 'string' ? row['@type'].trim() : '';
    const url = typeof row?.['@id'] === 'string' ? row['@id'].trim() : '';
    if (!type || !url) continue;
    out.push({ ...splitType(type), url });
  }
  return out;
}

/**
 * Candidate URLs for one base type, best first.
 *
 * Several `@id` values can share a `@type` — a feed may publish two regional
 * endpoints of the same service — so this returns a list rather than one URL.
 * Those are failover targets: try the next only when the previous one fails,
 * never treat the extras as duplicates to discard.
 *
 * Duplicate URLs are collapsed, since the same address reached through two
 * suffixes is one endpoint and retrying it proves nothing.
 */
export function selectResources(
  resources: readonly ServiceIndexResource[],
  baseType: string,
): string[] {
  const matching = resources.filter((r) => r.baseType === baseType);
  if (matching.length === 0) return [];

  const preference = SUFFIX_PREFERENCE[baseType] ?? [];
  const rankOf = (suffix?: string): number => {
    const known = preference.indexOf(suffix);
    // Unknown suffixes rank after every known one, in a stable order, so an
    // unfamiliar revision is a last resort rather than a disqualification.
    return known >= 0 ? known : preference.length;
  };

  const ordered = [...matching].sort((a, b) => rankOf(a.suffix) - rankOf(b.suffix));
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const r of ordered) {
    const key = r.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(r.url);
  }
  return urls;
}

/** What may be done with a resource URL, given the source it was read from. */
export type OriginVerdict =
  /** Same origin as the configured source — call it as published. */
  | { kind: 'same'; url: string }
  /**
   * A different origin, but the path shape says it is the same feed behind a
   * reverse proxy. Call the configured origin with the published path; fall
   * back to the published URL only if that fails.
   */
  | { kind: 'rewritten'; url: string; original: string }
  /**
   * A different service altogether. A feed can relay an upstream index and
   * leave some entries pointing at that upstream, so following this would
   * reach a host the user never configured — on a closed network it hangs, and
   * on a monitored one it is unexplained egress.
   */
  | { kind: 'foreign'; url: string };

/**
 * Path segments the protocol itself puts in nearly every feed address. A prefix
 * made only of these identifies no particular feed, so it cannot be evidence of
 * a proxy: `/v3` is shared by every v3 server in existence, and matching on it
 * would redirect a genuinely foreign address onto the configured host.
 */
const CONVENTIONAL_SEGMENTS = new Set(['v2', 'v3', 'api', 'index.json']);

/** True when a path prefix is specific enough to identify one feed. */
function identifiesOneFeed(path: string): boolean {
  return path
    .split('/')
    .some((segment) => segment.length > 0 && !CONVENTIONAL_SEGMENTS.has(segment.toLowerCase()));
}

/**
 * Suffixes under which each label belongs to a different owner, so two hosts
 * sharing them share nothing. A short, deliberately incomplete list: the aim is
 * to avoid the obvious false equivalences, not to reimplement the public suffix
 * list. It errs towards treating hosts as *different*, which only ever costs a
 * resource, never safety.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  // Registry suffixes, where the label above them is the registrable name.
  'co.uk', 'org.uk', 'ac.uk', 'co.jp', 'com.au', 'net.au', 'com.br',
  'co.nz', 'co.za', 'com.cn', 'com.tr',
  // Shared hosting, where every name under the suffix is a different tenant.
  // Without these a feed hosted on a platform could point the client at a
  // neighbour and have it read as "the same feed, another host".
  'github.io', 'gitlab.io', 'blob.core.windows.net', 'web.core.windows.net',
  'azurewebsites.net', 'cloudapp.azure.com', 'azureedge.net', 'azurefd.net',
  'amazonaws.com', 's3.amazonaws.com', 'cloudfront.net', 'herokuapp.com',
  'appspot.com', 'run.app', 'pages.dev', 'workers.dev', 'netlify.app',
  'vercel.app', 'fly.dev', 'onrender.com',
]);

/**
 * The registrable part of a host — what one party controls.
 *
 * A feed legitimately spreads its resources across hostnames: the measured
 * public feed answers the package content from one host and search from
 * another, both under the one domain. Treating those as foreign disables search
 * on the most common source there is, which is how this rule was found.
 */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');

  // Longest known suffix wins, so a platform spelled with four labels is
  // recognised as readily as a two-label registry suffix.
  for (let take = Math.min(labels.length - 1, 5); take >= 2; take--) {
    if (MULTI_LABEL_SUFFIXES.has(labels.slice(-take).join('.'))) {
      return labels.slice(-(take + 1)).join('.');
    }
  }
  return labels.slice(-2).join('.');
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** The scheme, host and port of an address, or nothing when it is not one. */
export function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Classifies one resource URL against the source it came from.
 *
 * `knownOrigins` are the origins the user has configured — every enabled
 * package source plus every audit source. A foreign origin that appears there
 * is treated as `same`: the vulnerability database in particular is nearly
 * always a different host from the package source, and refusing it would break
 * an ordinary corporate setup.
 */
export function classifyOrigin(
  resourceUrl: string,
  sourceUrl: string,
  knownOrigins: readonly string[] = [],
): OriginVerdict {
  const resource = originOf(resourceUrl);
  const source = originOf(sourceUrl);
  if (!resource || !source) return { kind: 'foreign', url: resourceUrl };
  if (resource === source) return { kind: 'same', url: resourceUrl };

  const allowed = new Set(knownOrigins.map((o) => originOf(o) ?? o.toLowerCase()));
  if (allowed.has(resource)) return { kind: 'same', url: resourceUrl };

  // A sibling host of the same domain is the feed itself, spread across
  // hostnames. A host outside it belongs to somebody else and stays foreign
  // unless the user configured it — a repository relaying an upstream index can
  // leave entries aimed at that upstream, and following those would leave the
  // network the user chose.
  const resourceHost = hostOf(resourceUrl);
  const sourceHost = hostOf(sourceUrl);
  if (resourceHost && sourceHost && registrableDomain(resourceHost) === registrableDomain(sourceHost)) {
    return { kind: 'same', url: resourceUrl };
  }

  // The path prefix of the source reappearing in the resource URL is what marks
  // a reverse proxy: the server knows the path it serves but advertises the
  // wrong host for it. The prefix has to identify this feed for that to mean
  // anything — a prefix of protocol conventions alone matches every feed there
  // is, and rewriting on it would silently retarget another service.
  const sourcePath = new URL(sourceUrl).pathname.replace(/\/index\.json$/i, '').replace(/\/+$/, '');
  const resourcePath = new URL(resourceUrl).pathname;
  if (identifiesOneFeed(sourcePath) && resourcePath.toLowerCase().startsWith(sourcePath.toLowerCase())) {
    // The query belongs to the address, not to the host: a search resource
    // published with parameters loses its meaning without them.
    const published = new URL(resourceUrl);
    return {
      kind: 'rewritten',
      url: `${source}${resourcePath}${published.search}${published.hash}`,
      original: resourceUrl,
    };
  }
  return { kind: 'foreign', url: resourceUrl };
}
