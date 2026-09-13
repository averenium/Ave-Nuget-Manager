/**
 * Reading a registration document into the one shape every rung produces (#27).
 *
 * This file performs no I/O: it turns whatever a server answered into catalog
 * entries, and nothing more. Every normalisation here exists because two
 * conformant servers — or the specification itself — encode the same fact two
 * ways:
 *
 * - `severity` is a string in registration and a number in search and in the
 *   vulnerability database. Same scale, three encodings.
 * - Deprecation reasons are a closed set compared case-insensitively; unknown
 *   values are ignored, and an entry whose reasons are all unknown still means
 *   `Other` rather than nothing.
 * - `listed` is optional, and a package hidden from the feed is conventionally
 *   published at the sentinel year 1900. Where the field is missing, that date
 *   is the only statement available.
 * - `tags` arrive as an array from some servers and as one space-separated
 *   string from others.
 *
 * Everything except the version itself is optional, on purpose: measured field
 * counts for the very same document ranged from 16 to 22 across servers, and
 * the missing ones were different each time. A missing field means the feed did
 * not say — never that the answer is "no".
 */

export interface CatalogDependency {
  id: string;
  /** Declared range, exactly as written — brackets included. */
  range?: string;
}

export interface CatalogDependencyGroup {
  /** Absent on the group that applies to every framework. */
  targetFramework?: string;
  dependencies: CatalogDependency[];
}

/** 0 low, 1 moderate, 2 high, 3 critical — the one scale, whatever the encoding. */
export type CatalogSeverity = 0 | 1 | 2 | 3;

export interface CatalogVulnerability {
  advisoryUrl?: string;
  severity?: CatalogSeverity;
}

export type DeprecationReason = 'Legacy' | 'CriticalBugs' | 'Other';

export interface CatalogDeprecation {
  message?: string;
  reasons: DeprecationReason[];
  alternatePackage?: { id: string; range?: string };
}

/** One version of one package, as much of it as the feed was willing to state. */
export interface CatalogVersionEntry {
  version: string;
  listed?: boolean;
  published?: string;
  authors?: string;
  description?: string;
  summary?: string;
  title?: string;
  tags?: string[];
  projectUrl?: string;
  iconUrl?: string;
  licenseUrl?: string;
  licenseExpression?: string;
  dependencyGroups?: CatalogDependencyGroup[];
  deprecation?: CatalogDeprecation;
  vulnerabilities?: CatalogVulnerability[];
  /** Address of the package itself, when the feed publishes one. */
  packageContent?: string;
}

/** A registration page, either inlined in the index or reachable by address. */
export interface RegistrationPage {
  /** The address the document gave. Page and leaf URLs are never constructed. */
  url?: string;
  /** Lowest version on this page, when the server stated it. */
  lower?: string;
  /** Highest version on this page, when the server stated it. */
  upper?: string;
  /** Entries already present in the index; absent when the page must be fetched. */
  entries?: CatalogVersionEntry[];
}

const DEPRECATION_REASONS: Record<string, DeprecationReason> = {
  legacy: 'Legacy',
  criticalbugs: 'CriticalBugs',
  other: 'Other',
};

/**
 * A package hidden from its feed is published at this sentinel instead of
 * carrying a flag, and some servers state nothing else about listing.
 */
const UNLISTED_SENTINEL_YEAR = 1900;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function tagList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const tags = value.map((t) => text(t)).filter((t): t is string => !!t);
    return tags.length > 0 ? tags : undefined;
  }
  const single = text(value);
  if (!single) return undefined;
  const split = single.split(/[\s,]+/).filter(Boolean);
  return split.length > 0 ? split : undefined;
}

/** Accepts the number, the numeric string, and nothing else. */
export function normalizeSeverity(value: unknown): CatalogSeverity | undefined {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 3) return undefined;
  return numeric as CatalogSeverity;
}

function deprecation(value: unknown): CatalogDeprecation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as { message?: unknown; reasons?: unknown; alternatePackage?: unknown };
  const reasons: DeprecationReason[] = [];
  for (const raw of Array.isArray(row.reasons) ? row.reasons : []) {
    const known = typeof raw === 'string' ? DEPRECATION_REASONS[raw.trim().toLowerCase()] : undefined;
    if (known && !reasons.includes(known)) reasons.push(known);
  }
  // The set is closed, so an unrecognised reason is still a deprecation: the
  // package is deprecated for a reason this build does not name.
  if (reasons.length === 0) reasons.push('Other');

  const alternate = row.alternatePackage as { id?: unknown; range?: unknown } | undefined;
  const alternateId = text(alternate?.id);
  return {
    message: text(row.message),
    reasons,
    alternatePackage: alternateId ? { id: alternateId, range: text(alternate?.range) } : undefined,
  };
}

function vulnerabilities(value: unknown): CatalogVulnerability[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: CatalogVulnerability[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { advisoryUrl?: unknown; severity?: unknown };
    out.push({ advisoryUrl: text(row.advisoryUrl), severity: normalizeSeverity(row.severity) });
  }
  return out.length > 0 ? out : undefined;
}

function dependencyGroups(value: unknown): CatalogDependencyGroup[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const groups: CatalogDependencyGroup[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { targetFramework?: unknown; dependencies?: unknown };
    const dependencies: CatalogDependency[] = [];
    for (const dep of Array.isArray(row.dependencies) ? row.dependencies : []) {
      const depRow = dep as { id?: unknown; range?: unknown };
      const id = text(depRow?.id);
      if (!id) continue;
      dependencies.push({ id, range: text(depRow.range) });
    }
    // A group with no dependencies still says the package supports that
    // framework, which is the whole question behind TFM filtering.
    groups.push({ targetFramework: text(row.targetFramework), dependencies });
  }
  return groups.length > 0 ? groups : undefined;
}

function listedFrom(row: { listed?: unknown; published?: unknown }): boolean | undefined {
  if (typeof row.listed === 'boolean') return row.listed;
  const published = text(row.published);
  if (!published) return undefined;
  const year = new Date(published).getUTCFullYear();
  return Number.isNaN(year) ? undefined : year !== UNLISTED_SENTINEL_YEAR;
}

/** One `catalogEntry`, with the leaf's `packageContent` when it has one. */
export function parseCatalogEntry(leaf: unknown): CatalogVersionEntry | undefined {
  if (!leaf || typeof leaf !== 'object') return undefined;
  const outer = leaf as { catalogEntry?: unknown; packageContent?: unknown };
  const entry = outer.catalogEntry;
  if (!entry || typeof entry !== 'object') return undefined;
  const row = entry as Record<string, unknown>;
  const version = text(row.version);
  if (!version) return undefined;

  return {
    version,
    listed: listedFrom(row),
    published: text(row.published),
    authors: text(row.authors),
    description: text(row.description),
    summary: text(row.summary),
    title: text(row.title),
    tags: tagList(row.tags),
    projectUrl: text(row.projectUrl),
    iconUrl: text(row.iconUrl),
    licenseUrl: text(row.licenseUrl),
    licenseExpression: text(row.licenseExpression),
    dependencyGroups: dependencyGroups(row.dependencyGroups),
    deprecation: deprecation(row.deprecation),
    vulnerabilities: vulnerabilities(row.vulnerabilities),
    packageContent: text(outer.packageContent) ?? text(row.packageContent),
  };
}

/** Every entry of one page document, in the order the server listed them. */
export function parseRegistrationPageEntries(json: unknown): CatalogVersionEntry[] | undefined {
  const items = (json as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return undefined;
  const entries: CatalogVersionEntry[] = [];
  for (const leaf of items) {
    const entry = parseCatalogEntry(leaf);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * The pages of a registration index. Inlining is a property of the package and
 * not of the server — the same feed answers both ways depending on how long the
 * package history is — so a page carries either its entries or its address,
 * and the caller fetches only what it needs.
 *
 * `lower` and `upper` are mandatory per the specification and were present on
 * every server measured, which is what makes fetching one page instead of all
 * of them possible.
 */
export function parseRegistrationIndex(json: unknown): RegistrationPage[] | undefined {
  const items = (json as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return undefined;
  const pages: RegistrationPage[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { '@id'?: unknown; lower?: unknown; upper?: unknown; items?: unknown };
    const entries = Array.isArray(row.items) ? parseRegistrationPageEntries(row) : undefined;
    pages.push({
      url: text(row['@id']),
      lower: text(row.lower),
      upper: text(row.upper),
      entries,
    });
  }
  return pages;
}
