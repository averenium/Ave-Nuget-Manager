/**
 * License display resolution for the Info panel's attribute column (#86
 * design pass, "Licences"). `<license type="expression">` is an SPDX
 * string — sometimes compound (`MIT AND Apache-2.0`) — `type="file"` names
 * a file bundled in the package with nothing to link to, and a bare
 * `licenseUrl` (no `<license>` element at all) is the last resort, except
 * for NuGet's own deprecated-field placeholder, which links to a page
 * explaining that the field is deprecated rather than to any actual license.
 */

import type { PackageLicense } from './types';

export type LicenseDisplay =
  | { kind: 'expression'; ids: string[]; operators: Array<'AND' | 'OR'>; fullExpression: string }
  | { kind: 'file'; fileName: string }
  | { kind: 'url'; url: string }
  | { kind: 'none' };

/** Splits a (possibly compound) SPDX expression into its identifiers and the `AND`/`OR` operators between them — legally meaningful (`AND` = both apply, `OR` = choose), so kept rather than flattened into one string. */
export function splitSpdxExpression(expression: string): { ids: string[]; operators: Array<'AND' | 'OR'> } {
  const stripped = expression.trim().replace(/^\((.*)\)$/, '$1').trim();
  const tokens = stripped.split(/\s+(AND|OR)\s+/i);
  const ids: string[] = [];
  const operators: Array<'AND' | 'OR'> = [];
  tokens.forEach((tok, i) => {
    if (i % 2 === 1) operators.push(tok.toUpperCase() as 'AND' | 'OR');
    else if (tok.trim()) ids.push(tok.trim());
  });
  return { ids, operators };
}

export function spdxBadgeUrl(spdxId: string): string {
  return `https://licenses.nuget.org/${encodeURIComponent(spdxId)}`;
}

/** NuGet's own placeholder for "a real `<license>` element is present, this field is deprecated" — filtered by exact value, not by domain, so a genuine aka.ms-hosted license page (if one ever existed) wouldn't be swept up with it. */
function isDeprecatedLicenseUrlPlaceholder(url: string): boolean {
  try {
    const u = new URL(url);
    return u.host.toLowerCase() === 'aka.ms' && u.pathname.toLowerCase() === '/deprecatelicenseurl';
  } catch {
    return false;
  }
}

export function resolveLicenseDisplay(
  license: PackageLicense | undefined,
  licenseUrl: string | undefined,
): LicenseDisplay {
  if (license?.type === 'expression') {
    const { ids, operators } = splitSpdxExpression(license.value);
    return { kind: 'expression', ids, operators, fullExpression: license.value };
  }
  if (license?.type === 'file') {
    return { kind: 'file', fileName: license.value };
  }
  if (licenseUrl && !isDeprecatedLicenseUrlPlaceholder(licenseUrl)) {
    return { kind: 'url', url: licenseUrl };
  }
  return { kind: 'none' };
}

/**
 * A licence change worth telling the user about, between the version installed
 * and the version selected (#89).
 *
 * The whole difficulty is telling a real change from metadata simply arriving.
 * `<license>` replaced `licenseUrl` in 2019, so a package old enough predates
 * it entirely: measured on `Newtonsoft.Json`, 63 versions state no expression
 * and the 21 newest state `MIT`. Reading that as "the licence changed to MIT"
 * would fire on nearly every long-lived package and teach the user to ignore
 * the row within a week.
 *
 * Nor can `licenseUrl` help: on the public feed it embeds the version
 * (`…/SixLabors.ImageSharp/3.1.5/license`), so comparing URLs reports a change
 * on every single bump.
 */
export interface LicenseChange {
  /** What the installed version declares. */
  from: LicenseSide;
  /** What the selected version declares. */
  to: LicenseSide;
  /**
   * The selected version's licence is a file the package carries, which this
   * tool cannot name or read — the user has to open it. This is the
   * `SixLabors.ImageSharp` 2.x → 3.x shape, where an SPDX expression gave way
   * to a split licence that is commercial for some uses.
   */
  unnamed: boolean;
}

/**
 * One side of the comparison, with somewhere to read it (#89).
 *
 * Naming a licence and not letting the reader open it is the worst of both:
 * the row says an obligation may have changed and then leaves them to find the
 * text themselves. An SPDX identifier always has an address —
 * `licenses.nuget.org` renders every one of them — so those are linked from the
 * identifier alone. A `type="file"` licence has no address of its own, since it
 * is a file inside the package; `licenseUrl` is the only thing that ever points
 * at it, which is why it is carried here even though the *comparison* must
 * never read that field (see above).
 */
export interface LicenseSide {
  /** The licence as text — an SPDX expression, or the file name. */
  text: string;
  /** `type="file"`: bundled in the package, and not a name this tool can resolve. */
  file: boolean;
  /** Where it can be read on the web, when there is anywhere to read it. */
  url?: string;
  /**
   * The licence file itself, inside the extracted package. Only the installed
   * version has one — it is the side that is on disk — and it beats any URL,
   * since it is the exact text this project is bound by rather than the feed's
   * rendering of it.
   */
  filePath?: string;
}

/**
 * One package in a batch whose licence the update would move (#89).
 *
 * The Problems row lives in the details panel, so it only ever reaches someone
 * who opened the package — and the scenario this is argued from is "update all",
 * which opens nothing. `collectUpdatableItems` targets the feed's newest version
 * for an ordinary reference, so a batch crosses majors for most packages, which
 * is exactly where a licence moves.
 */
export interface BatchLicenseFinding {
  packageId: string;
  fromVersion: string;
  toVersion: string;
  change: LicenseChange;
}

/** Same licence, allowing for spacing and casing that carry no meaning. */
function sameExpression(a: string, b: string): boolean {
  const flat = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return flat(a) === flat(b);
}

/**
 * Bounds on the analysis below (#89). Nothing published needs an expression
 * this large, and a pathological one must not cost a decision: past the cap the
 * answer is "changed", which is the conservative direction. The alternative cap
 * matters most — `AND` multiplies the alternatives of its two sides, so nested
 * disjunctions grow the normal form faster than the term count suggests.
 */
const MAX_ATOMS = 12;
const MAX_DEPTH = 4;
const MAX_ALTERNATIVES = 64;

/**
 * An expression as a set of alternatives, each a set of atoms that must all be
 * satisfied together — disjunctive normal form. `undefined` when the expression
 * cannot be read within the bounds above.
 *
 * Atoms are opaque: the identifier as written, normalised only for case and
 * whitespace. A `WITH` exception and a trailing `+` stay part of the atom rather
 * than being understood, so `GPL-3.0-only` and `GPL-3.0-only WITH
 * Classpath-exception-2.0` are simply different licences here. An exception
 * usually relaxes the terms, but knowing that means reading the licence text,
 * which is exactly what this comparison refuses to do.
 */
function toDnf(expression: string): Array<Set<string>> | undefined {
  const tokens = expression.trim().match(/\(|\)|[^\s()]+/g);
  if (!tokens || tokens.length === 0) return undefined;
  let i = 0;
  let atoms = 0;
  let failed = false;

  const fail = (): undefined => {
    failed = true;
    return undefined;
  };

  const parseExpr = (depth: number): Array<Set<string>> | undefined => {
    if (depth > MAX_DEPTH) return fail();
    let alternatives = parseAnd(depth);
    if (!alternatives) return undefined;
    while (!failed && tokens[i]?.toUpperCase() === 'OR') {
      i += 1;
      const right = parseAnd(depth);
      if (!right) return undefined;
      alternatives = alternatives.concat(right);
      if (alternatives.length > MAX_ALTERNATIVES) return fail();
    }
    return alternatives;
  };

  const parseAnd = (depth: number): Array<Set<string>> | undefined => {
    let alternatives = parsePrimary(depth);
    if (!alternatives) return undefined;
    while (!failed && tokens[i]?.toUpperCase() === 'AND') {
      i += 1;
      const right = parsePrimary(depth);
      if (!right) return undefined;
      // Every alternative of one side has to be met alongside every alternative
      // of the other, so the product is the new set of ways to comply.
      const product: Array<Set<string>> = [];
      for (const left of alternatives) {
        for (const other of right) product.push(new Set([...left, ...other]));
      }
      if (product.length > MAX_ALTERNATIVES) return fail();
      alternatives = product;
    }
    return alternatives;
  };

  const parsePrimary = (depth: number): Array<Set<string>> | undefined => {
    const token = tokens[i];
    if (token === undefined) return fail();
    if (token === '(') {
      i += 1;
      const inner = parseExpr(depth + 1);
      if (!inner) return undefined;
      if (tokens[i] !== ')') return fail();
      i += 1;
      return inner;
    }
    if (token === ')' || token.toUpperCase() === 'AND' || token.toUpperCase() === 'OR') return fail();
    i += 1;
    let atom = token.toLowerCase();
    // `WITH` binds tighter than either operator and names an exception to the
    // licence beside it, so the pair is one atom and never two.
    while (tokens[i]?.toUpperCase() === 'WITH' && tokens[i + 1] !== undefined) {
      const exception = tokens[i + 1];
      if (exception === '(' || exception === ')') return fail();
      atom = `${atom} with ${exception.toLowerCase()}`;
      i += 2;
    }
    atoms += 1;
    if (atoms > MAX_ATOMS) return fail();
    return [new Set([atom])];
  };

  const result = parseExpr(0);
  if (!result || failed || i !== tokens.length) return undefined;
  return result;
}

/**
 * Whether the selected expression still offers everything the installed one did
 * (#89).
 *
 * `MIT` becoming `MIT OR Apache-2.0` and `MIT` becoming `MIT AND Apache-2.0` are
 * opposite events: the first hands the consumer a second way to comply and takes
 * nothing away, the second adds obligations. A rule that reports both identically
 * spends its credibility on the harmless one, and the row stops being read.
 *
 * The test is structural. Every way of complying with the installed expression
 * must still be available — that is, each of its alternatives must have an
 * alternative in the selected expression demanding no more than it does. When
 * that holds, whatever the consumer is complying with today remains on offer.
 *
 * It also settles a false positive that flattened string equality has:
 * `MIT OR Apache-2.0` and `Apache-2.0 OR MIT` are one licence written two ways.
 */
export function takesNothingAway(installedExpr: string, selectedExpr: string): boolean {
  const installed = toDnf(installedExpr);
  const selected = toDnf(selectedExpr);
  if (!installed || !selected) return false;
  return installed.every((was) =>
    selected.some((now) => [...now].every((atom) => was.has(atom))));
}

/**
 * A file licence whose file name states the identifier the other side declares
 * (#89).
 *
 * `Microsoft.NET.Test.Sdk` moves from `<license type="file">LICENSE_MIT.txt` to
 * `<license type="expression">MIT` — the same licence, reported as a change
 * because one side is a file and a file is a name this tool cannot resolve. It
 * is a change on paper and nothing at all in fact, and a row that fires on it
 * spends the credibility the real cases need.
 *
 * The inference is deliberately narrow: the identifier has to appear in the file
 * name as a whole word — bounded on both sides by something that is not a letter
 * or a digit. `LICENSE_MIT.txt` and `LICENSE-Apache-2.0` match; `licence.txt`
 * does not, so `EasyNetQ`'s move stays reported, which is right, because nothing
 * about that name says what is in it; and `MITigation.txt` does not match `MIT`,
 * because a licence identifier is not a substring anyone may find. A compound
 * expression never matches: one file cannot be evidence of two licences.
 *
 * This is a reading of a file name, which is weaker evidence than anything else
 * here uses. It is confined to suppressing a row, never to raising one.
 */
function fileNamesLicense(fileName: string, expression: string): boolean {
  const { ids } = splitSpdxExpression(expression);
  if (ids.length !== 1) return false;
  const name = fileName.trim().toLowerCase().replace(/\.(txt|md|html?|rtf)$/, '');
  const id = ids[0].toLowerCase();
  // Hyphens and dots are both separators in file names and parts of identifiers
  // (`Apache-2.0`), so the boundary cannot be a split — it is the absence of an
  // adjoining letter or digit on either side.
  const alphanumeric = /[a-z0-9]/;
  for (let at = name.indexOf(id); at !== -1; at = name.indexOf(id, at + 1)) {
    const before = at > 0 ? name[at - 1] : '';
    const after = name[at + id.length] ?? '';
    if (!alphanumeric.test(before) && !alphanumeric.test(after)) return true;
  }
  return false;
}

/**
 * One side of the comparison, and where to read it.
 *
 * A single SPDX identifier is linked from the identifier itself. A compound
 * expression is not: `MIT AND Apache-2.0` is two documents and one link would
 * have to choose between them, so the panel that can render each identifier as
 * its own badge does that, and this text stays text. A file licence is linked
 * only if the feed states a page for it — on a private feed it usually does not.
 */
function sideOf(
  license: PackageLicense,
  licenseUrl: string | undefined,
  filePath?: string,
): LicenseSide {
  if (license.type === 'file') {
    const url = licenseUrl && !isDeprecatedLicenseUrlPlaceholder(licenseUrl) ? licenseUrl : undefined;
    return { text: license.value, file: true, url, filePath };
  }
  const { ids } = splitSpdxExpression(license.value);
  return {
    text: license.value,
    file: false,
    url: ids.length === 1 ? spdxBadgeUrl(ids[0]) : undefined,
  };
}

/**
 * What to say about the selected version's licence, or nothing when there is
 * nothing to say.
 *
 * Silence is the answer in four situations, and each is deliberate:
 *
 * - **the installed version declares nothing** — there is no "before" to have
 *   changed from, and this is the metadata-arrival case above;
 * - **the selected version declares nothing** — its licence is unknown, and a
 *   warning would be a guess rather than a finding;
 * - **both are files** — neither can be named, so no claim about a difference
 *   between them can be made honestly, even when the file names differ;
 * - **the file names the other side's licence** — `LICENSE_MIT.txt` against
 *   `MIT` is the same licence written two ways; see `fileNamesLicense`;
 * - **the selected expression takes nothing away** — see `takesNothingAway`.
 *   Problems is where consequences go, and nothing the consumer does today
 *   stops being allowed. The licence is not hidden either way: the attribute
 *   column shows the selected version's own expression, which is where a
 *   reader looks for it.
 */
export function licenseChange(
  installed: PackageLicense | undefined,
  selected: PackageLicense | undefined,
  /**
   * Each version's own `licenseUrl`, used only to give a file licence somewhere
   * to be read. It is never compared: on the public feed it embeds the version,
   * so comparing URLs would report a change on every bump.
   */
  urls?: { installed?: string; selected?: string },
  /** The installed version's licence file on disk, when it has one. */
  installedFilePath?: string,
): LicenseChange | undefined {
  if (!installed || !selected) return undefined;
  if (installed.type === 'file' && selected.type === 'file') return undefined;
  if (installed.type === 'file' && fileNamesLicense(installed.value, selected.value)) return undefined;
  if (selected.type === 'file' && fileNamesLicense(selected.value, installed.value)) return undefined;
  if (installed.type === 'expression' && selected.type === 'expression') {
    // The cheap check first, so an expression too large to analyse is still
    // silent when it did not change at all.
    if (sameExpression(installed.value, selected.value)) return undefined;
    if (takesNothingAway(installed.value, selected.value)) return undefined;
  }
  return {
    from: sideOf(installed, urls?.installed, installedFilePath),
    to: sideOf(selected, urls?.selected),
    unnamed: selected.type === 'file',
  };
}
