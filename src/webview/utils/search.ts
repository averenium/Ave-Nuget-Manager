/**
 * Filter and rank package lists by a search query.
 * All operations are case-insensitive.
 */

// ─── Abbreviation expansions ──────────────────────────────────────────────────

/**
 * Known abbreviation → canonical fragment mappings.
 * When the query matches an abbreviation key, we also try matching against
 * the expanded form.
 */
const ABBREVIATIONS: Record<string, string[]> = {
  ef: ['entityframework', 'entity.framework'],
  aspnet: ['aspnetcore', 'asp.net'],
  mvc: ['mvc', 'aspnetcore.mvc'],
  di: ['dependencyinjection', 'dependency.injection'],
  ioc: ['dependencyinjection'],
};

/** Returns the canonical expanded tokens for a query (includes the original). */
function expandQuery(query: string): string[] {
  const q = query.toLowerCase();
  const expanded = ABBREVIATIONS[q] ?? [];
  return [q, ...expanded];
}

// ─── Relevance scoring ────────────────────────────────────────────────────────

/**
 * Relevance score for sorting Available results (lower = more relevant).
 *
 * 0  — exact match
 * 1  — id starts with query  (e.g. "logging" → "Logging.Abstractions")
 * 2  — last segment starts with query  (e.g. "logging" → "Microsoft.Extensions.Logging")
 * 3  — well-known namespace + query segment:
 *        Microsoft.<query>, Microsoft.AspNetCore.<query>, Microsoft.Extensions.<query>
 *        Microsoft.EntityFrameworkCore.<query>
 * 4  — abbreviation exact last-segment match  (ef → EntityFramework*)
 * 5  — any segment starts with query
 * 6  — id contains query anywhere
 * 7  — abbreviation expansion matches anywhere
 * 8  — fallback
 */
export function relevanceScore(id: string, query: string): number {
  const idL = id.toLowerCase();
  const tokens = expandQuery(query);
  const qL = tokens[0];
  const expanded = tokens.slice(1);

  const segments = idL.split('.');
  const lastSeg = segments[segments.length - 1];

  // 0 — exact
  if (idL === qL) return 0;

  // 1 — well-known namespace + query as first segment after prefix
  //     Microsoft.<query>, Microsoft.Extensions.<query>, Microsoft.AspNetCore.<query>, etc.
  if (isWellKnownNamespaceMatch(idL, segments, qL)) return 1;

  // 2 — id starts with query  (e.g. "Logging.Abstractions")
  if (idL.startsWith(qL)) return 2;

  // 3 — last segment starts with query  (e.g. "NLog.Logging")
  if (lastSeg.startsWith(qL)) return 3;

  // 4 — abbreviation: last segment matches an expansion  (ef → EntityFramework*)
  if (expanded.some((e) => lastSeg.startsWith(e) || lastSeg === e)) return 4;

  // 5 — any segment starts with query
  if (segments.some((seg) => seg.startsWith(qL))) return 5;

  // 6 — id contains query
  if (idL.includes(qL)) return 6;

  // 7 — any expansion matches
  if (expanded.some((e) => idL.includes(e))) return 7;

  return 8;
}

/**
 * Returns true when the id follows a pattern like:
 *   Microsoft.<query>.*
 *   Microsoft.AspNetCore.<query>.*
 *   Microsoft.Extensions.<query>.*
 *   Microsoft.EntityFrameworkCore.<query>.*
 *   Npgsql.EntityFrameworkCore.<query>.*
 *   etc.
 *
 * These are scored at 3 — below "last segment starts with query" (2)
 * but above arbitrary segment matches (5).
 */
function isWellKnownNamespaceMatch(
  idL: string,
  segments: string[],
  qL: string,
): boolean {
  const WELL_KNOWN_PREFIXES = [
    'microsoft',
    'microsoft.aspnetcore',
    'microsoft.aspnet',
    'microsoft.extensions',
    'microsoft.entityframeworkcore',
    'npgsql.entityframeworkcore',
    'pomelo.entityframeworkcore',
    'entityframework',
  ];

  for (const prefix of WELL_KNOWN_PREFIXES) {
    if (!idL.startsWith(prefix + '.')) continue;
    // The part after the prefix
    const rest = idL.slice(prefix.length + 1); // e.g. "logging.abstractions"
    const restSegments = rest.split('.');
    // The first segment of the rest starts with the query
    if (restSegments[0]?.startsWith(qL)) return true;
  }
  return false;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compare two SemVer strings. Returns:
 *  > 0 if a > b (a is newer)
 *  = 0 if equal
 *  < 0 if a < b (a is older)
 */
export function compareSemVer(a: string, b: string): number {
  const pa = parseSemVer(a);
  const pb = parseSemVer(b);
  for (let i = 0; i < 4; i++) {
    const diff = (pa[i] as number) - (pb[i] as number);
    if (diff !== 0) return diff;
  }
  // Pre-release: no suffix (stable) > has suffix (pre-release)
  if (pa[4] === pb[4]) return 0;
  if (pa[4] === '') return 1;   // a is stable, b is pre-release → a > b
  if (pb[4] === '') return -1;
  return pa[4] < pb[4] ? -1 : 1;
}

function parseSemVer(v: string): [number, number, number, number, string] {
  const m = v.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:[.\-](.*))?$/);
  if (!m) return [0, 0, 0, 0, v];
  return [
    parseInt(m[1] ?? '0', 10),
    parseInt(m[2] ?? '0', 10),
    parseInt(m[3] ?? '0', 10),
    parseInt(m[4] ?? '0', 10),
    m[5] ?? '',
  ];
}
export function matchesQuery(id: string, query: string): boolean {
  if (!query || query.length < 2) return true;
  const idL = id.toLowerCase();
  const tokens = expandQuery(query);
  // Match original OR any expansion
  return tokens.some((t) => idL.includes(t));
}

/**
 * Sort packages by relevance to the query.
 * Items with equal score are sorted alphabetically.
 */
export function sortByRelevance<T extends { id: string }>(
  packages: T[],
  query: string,
): T[] {
  if (!query || query.length < 2) return packages;
  return [...packages].sort((a, b) => {
    const diff = relevanceScore(a.id, query) - relevanceScore(b.id, query);
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });
}
