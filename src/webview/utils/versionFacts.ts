/**
 * The facts line under the version field (#114).
 *
 * A package nobody has published to in four years is currently
 * indistinguishable from one released last week, and the difference is already
 * downloaded: the registration entry states a publication date per version, and
 * the version walk has those pages in hand. So this costs no request — it is
 * arithmetic over what the panel already holds.
 *
 * Every part is independently optional. A feed that states no dates, or the
 * catalog being off, leaves the line shorter or absent rather than printing
 * "unknown".
 */

export interface VersionFactsInput {
  /** The version the panel is describing. */
  version: string;
  /** Its publication date, ISO 8601, when the feed stated one. */
  published?: string;
  /** Every version the feed listed, newest first — the order the picker uses. */
  allVersions: string[];
  /** Publication dates by version, for as many as the feed stated. */
  publishedByVersion: Record<string, string | undefined>;
  /** The feed that answered. */
  sourceName?: string;
  /** Injected so the age is testable rather than a moving target. */
  now?: Date;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `2025-08-12T…` → `12 Aug 2025`. Undefined for anything unparsable, which a feed can always return. */
export function formatPublished(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * How long ago, in the coarsest unit that still says something: a reader
 * deciding whether a package is maintained wants "4 years", not "1,487 days".
 * Undefined for a date in the future, which is a feed being wrong rather than a
 * fact worth rendering.
 */
export function humanAge(iso: string | undefined, now: Date = new Date()): string | undefined {
  if (!iso) return undefined;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return undefined;
  const days = Math.floor((now.getTime() - then.getTime()) / MS_PER_DAY);
  if (days < 0) return undefined;
  if (days === 0) return 'today';
  if (days === 1) return '1 day';
  if (days < 45) return `${days} days`;
  const months = Math.round(days / 30.44);
  if (months < 18) return `${months} months`;
  const years = Math.floor(days / 365.25);
  return years === 1 ? '1 year' : `${years} years`;
}

/** `1` → `1st`, `2` → `2nd`, `13` → `13th`. */
export function ordinal(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/**
 * Where the version sits in its own history, as short as it can be said (#114).
 *
 * Deliberately not one of the parts below. It is the least of the facts here —
 * a count, where the others are dates and names — and spelled out in the flow it
 * was long enough to push the line the reader is actually following. It is
 * rendered to the side instead, small and out of the flow, so it can be glanced
 * at and cannot move anything. The full wording lives in the title attribute.
 */
export function versionPositionLabel(
  version: string,
  allVersions: string[],
): { short: string; full: string } | undefined {
  const index = allVersions.indexOf(version);
  const total = allVersions.length;
  if (index < 0 || total === 0) return undefined;
  const place = index === 0 ? 'newest' : ordinal(index + 1);
  return {
    short: `${place} of ${total}`,
    full: `${place} of ${total} ${total === 1 ? 'version' : 'versions'} the feed lists`,
  };
}

/**
 * The parts of the line, in order, already worded. Empty when the feed said
 * nothing that would fill any of them — the caller renders nothing at all
 * rather than an empty row.
 */
export function versionFactsParts(input: VersionFactsInput): string[] {
  const { version, published, allVersions, publishedByVersion, sourceName } = input;
  const now = input.now ?? new Date();
  const parts: string[] = [];

  const date = formatPublished(published);
  if (date) parts.push(`published ${date}`);

  const isNewest = allVersions.indexOf(version) === 0;

  // Looking at the newest version already answers "what is the newest"; the
  // question left is whether anything has happened since, which is the one this
  // line exists for.
  const newest = allVersions[0];
  const newestAge = humanAge(publishedByVersion[newest], now);
  if (isNewest) {
    if (newestAge && newestAge !== 'today') parts.push(`nothing published in ${newestAge}`);
  } else if (newest) {
    parts.push(newestAge ? `newest ${newest}, ${newestAge} ago` : `newest ${newest}`);
  }

  if (sourceName) parts.push(sourceName);
  return parts;
}
