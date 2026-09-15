/**
 * How the publication date of a version is worded (#114).
 *
 * A package nobody has published to in four years is otherwise
 * indistinguishable from one released last week, and the difference is already
 * downloaded: the registration entry states a date per version, and the version
 * walk has those pages in hand. So this costs no request.
 *
 * It began as a line of its own under the version field, carrying the date, the
 * newest version and its age, the position in the version list and the feed
 * name. That line was cut back to the date alone, which moved into the
 * attribute column: the rest either repeated what was already on screen — the
 * picker holds the version list, the package row names the feed — or cost a
 * line to say something nobody was deciding on. Picking the newest version,
 * which is what the panel opens on, still answers the staleness question,
 * because that version's date is the answer.
 *
 * Both functions say nothing rather than something wrong: a feed that states no
 * date, or states one that cannot be read, leaves the row out entirely.
 */

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
