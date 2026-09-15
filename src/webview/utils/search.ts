/**
 * Filter and rank package lists by a search query.
 * All operations are case-insensitive.
 */

import type { AvailablePackage } from '../../types';

export { compareSemVer } from '../../semver';

/**
 * What a query *means*, as opposed to what is in the box (#120).
 *
 * The box keeps the raw text — trimming it on every keystroke would delete a
 * trailing space the reader is still typing through, collapsing "entity
 * framework" into "entityframework" mid-word. Everything downstream reads the
 * normalised form instead: ends trimmed, internal whitespace runs collapsed to
 * one space so a multi-word query still matches, and a query that is only
 * whitespace normalises to empty rather than becoming "a space" that no
 * package id begins with.
 */
export function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ');
}

/**
 * Whether a search answer for `answerQuery` is still about what the search
 * box holds now (#121). The debounce that fires a search does not cancel the
 * one before it, so two answers can be in flight at once and need not land in
 * order — a slower, older one must not overwrite a newer one just because it
 * arrives later. Comparing the normalised text is enough to tell them apart;
 * nothing separate needs to be kept to track what was last asked, since the
 * box itself already is that record.
 */
export function answersCurrentQuery(answerQuery: string, boxQuery: string): boolean {
  return normalizeQuery(answerQuery) === normalizeQuery(boxQuery);
}

/**
 * What a `SEARCH_RESULTS` answer does to the Packages tab's search state
 * (#121), kept out of the reducer so it can be tested: the repository has no
 * React harness, and this is where a stale answer could go wrong — either by
 * overwriting a newer answer's results, or by stopping a spinner a still-
 * outstanding newer search is holding open.
 *
 * A stale answer changes nothing at all, `isSearching` included: whichever
 * answer actually matches the box will clear it on its own turn, so this
 * function must not clear it out from under a still-outstanding newer search,
 * and must not need to — anything already resolved (an empty answer for a box
 * that dropped below the search threshold, for instance) has already cleared
 * it by matching on its own turn.
 */
export function applySearchResults<T extends {
  searchQuery: string;
  isSearching: boolean;
  available: AvailablePackage[];
}>(state: T, answer: { query: string; packages: AvailablePackage[] }): T {
  if (!answersCurrentQuery(answer.query, state.searchQuery)) return state;
  return { ...state, available: answer.packages, isSearching: false };
}

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
  const tokens = expandQuery(normalizeQuery(query));
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

export function matchesQuery(id: string, query: string): boolean {
  const q = normalizeQuery(query);
  if (!q || q.length < 2) return true;
  const idL = id.toLowerCase();
  const tokens = expandQuery(q);
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
  options: { keepOrderOnTies?: boolean } = {},
): T[] {
  const q = normalizeQuery(query);
  if (!q || q.length < 2) return packages;
  return [...packages].sort((a, b) => {
    const diff = relevanceScore(a.id, q) - relevanceScore(b.id, q);
    if (diff !== 0) return diff;
    // A tie means this scoring cannot tell the two apart, and for search
    // results something else already could: the feed ranks by popularity, and
    // on one measured query the wanted package led the next by five times the
    // downloads. Every candidate there ended in `.ImageSharp`, so the score was
    // identical for all of them and the alphabet buried the obvious answer in
    // sixth place. `Array.prototype.sort` is stable, so returning 0 keeps the
    // order the feed gave. An installed list has no such order, and there the
    // alphabet is the only sensible tie-break.
    return options.keepOrderOnTies ? 0 : a.id.localeCompare(b.id);
  });
}
