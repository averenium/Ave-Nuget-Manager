import * as fs from 'fs/promises';
import { maskXmlComments } from './xmlComments';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PACKAGE_REFERENCE =
  /<PackageReference\b(?:[^>]*\/>|[^>]*>[\s\S]*?<\/PackageReference\s*>)/gi;

export interface PackageReferenceSpan {
  start: number;
  end: number;
  text: string;
}

/**
 * `Include=` declares a reference; `Update=` changes one an import already
 * declared elsewhere, such as an SDK's own props file (#124) — a plain
 * string comparison of the two would corrupt the file no less than the
 * `===` this codebase otherwise reserves for cases {@link versionsEqual}
 * would cover, so it stays a real union type rather than a bare `string`.
 */
export type PackageReferenceAttribute = 'Include' | 'Update';

export interface PackageReferenceSpanOptions {
  /** Which attribute to match. Omitted keeps the original `Include=`-only behaviour. */
  attribute?: PackageReferenceAttribute;
}

/**
 * Matching runs against a comment-masked copy of `xml` (see #85): the
 * non-self-closing alternative's lazy `[\s\S]*?` body capture would
 * otherwise let a comment mentioning `<PackageReference>` in its own text
 * swallow through to a real, distant `</PackageReference>` — and since
 * `upsertPackageReference`/`removePackageReferences` splice the file at
 * these spans directly, a bogus span means corrupting the real file on
 * save, not just a misread. Returned spans/text always come from the real,
 * unmasked `xml` — masking is only ever used to locate safe boundaries.
 */
export function findPackageReferenceSpans(
  xml: string,
  packageId: string,
  options?: PackageReferenceSpanOptions,
): PackageReferenceSpan[] {
  const spans: PackageReferenceSpan[] = [];
  const masked = maskXmlComments(xml);
  const re = new RegExp(PACKAGE_REFERENCE.source, PACKAGE_REFERENCE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const text = xml.slice(m.index, m.index + m[0].length);
    if (attributeMatches(text, packageId, options?.attribute)) {
      spans.push({ start: m.index, end: m.index + m[0].length, text });
    }
  }
  return spans;
}

/** Counts a reference under either attribute — the shape `duplicateLegacy` treats as needing a merge (#124). */
export function countPackageReferences(xml: string, packageId: string): number {
  return findAnyPackageReferenceSpans(xml, packageId).length;
}

function attributeMatches(el: string, packageId: string, attribute: PackageReferenceAttribute = 'Include'): boolean {
  return new RegExp(`\\b${attribute}\\s*=\\s*["']${escapeRegex(packageId)}["']`, 'i').test(el);
}

/**
 * Every span declaring `packageId`, `Include=` and `Update=` both — the
 * union either write path (#124) or a plain read has to consider, since a
 * project may state the reference with either attribute and the two must
 * never be conflated into one write.
 */
function findAnyPackageReferenceSpans(xml: string, packageId: string): PackageReferenceSpan[] {
  return [
    ...findPackageReferenceSpans(xml, packageId, { attribute: 'Include' }),
    ...findPackageReferenceSpans(xml, packageId, { attribute: 'Update' }),
  ].sort((a, b) => a.start - b.start);
}

function setVersionInElement(el: string, version: string): string {
  if (/\bVersion\s*=\s*["'][^"']*["']/i.test(el)) {
    return el.replace(/(\bVersion\s*=\s*["'])[^"']*(["'])/i, `$1${version}$2`);
  }
  if (/<Version\b/i.test(el)) {
    return el.replace(/(<Version\b[^>]*>)\s*[^<]*\s*(<\/Version\s*>)/i, `$1${version}$2`);
  }
  return el.replace(/(\s*)(\/>|>)/, ` Version="${version}"$1$2`);
}

function removeSpan(xml: string, start: number, end: number): string {
  let from = start;
  while (from > 0 && (xml[from - 1] === ' ' || xml[from - 1] === '\t')) from--;
  if (from > 0 && xml[from - 1] === '\n') from--;
  if (from > 0 && xml[from - 1] === '\r') from--;
  return xml.slice(0, from) + xml.slice(end);
}

export interface UpsertPackageReferenceOptions {
  /** Attribute a freshly-inserted item is written with, when nothing existing was found. Default `Include`. */
  attribute?: PackageReferenceAttribute;
}

/**
 * Keep one PackageReference for `packageId`, set its version, drop extras.
 * New id: always a new unconditioned ItemGroup (never append into a Condition group).
 *
 * Looks for an existing item under either attribute before inserting one —
 * an `Update=` item already governing the package must have its version set
 * in place, never be left beside a newly-inserted `Include=` one, which
 * NuGet reports as a duplicate reference (NU1504) and resolves to whichever
 * of the two it prefers, not the one just written (#124).
 */
export function upsertPackageReference(
  xml: string,
  packageId: string,
  version: string,
  options?: UpsertPackageReferenceOptions,
): string {
  const spans = findAnyPackageReferenceSpans(xml, packageId);
  if (spans.length === 0) return insertPackageReference(xml, packageId, version, options?.attribute);

  // An `Include=` item is the keeper whenever one exists, whatever its
  // position in the file — `readPackageVersionFromXml` prefers it the same
  // way, and it is the one `dotnet add` itself would edit. Deleting it in
  // favour of an `Update=` that merely overrides it would leave the file in
  // exactly the silently-inert state described in #124: nothing left for
  // that `Update=` to match once the real declaration is gone.
  const keeperIndex = spans.findIndex((s) => attributeMatches(s.text, packageId, 'Include'));
  const keeper = keeperIndex >= 0 ? spans[keeperIndex] : spans[0];

  const updated = setVersionInElement(keeper.text, version);
  let next = xml.slice(0, keeper.start) + updated + xml.slice(keeper.end);
  const delta = updated.length - keeper.text.length;
  // Right to left so an earlier removal never invalidates a later span's
  // offset. Only spans that sit after the keeper shift by `delta` — editing
  // it in place cannot move anything before it.
  for (let i = spans.length - 1; i >= 0; i--) {
    if (spans[i] === keeper) continue;
    const shift = spans[i].start > keeper.start ? delta : 0;
    next = removeSpan(next, spans[i].start + shift, spans[i].end + shift);
  }
  return next;
}

/** Drops every reference to `packageId`, `Include=` and `Update=` alike (#124). */
export function removePackageReferences(xml: string, packageId: string): string {
  const spans = findAnyPackageReferenceSpans(xml, packageId);
  let next = xml;
  for (let i = spans.length - 1; i >= 0; i--) {
    next = removeSpan(next, spans[i].start, spans[i].end);
  }
  return next;
}

function insertPackageReference(
  xml: string,
  packageId: string,
  version: string,
  attribute: PackageReferenceAttribute = 'Include',
): string {
  const nl = xml.includes('\r\n') ? '\r\n' : '\n';
  const el = `    <PackageReference ${attribute}="${packageId}" Version="${version}" />`;
  const block = `  <ItemGroup>${nl}${el}${nl}  </ItemGroup>${nl}`;
  const projectClose = xml.search(/<\/Project>/i);
  if (projectClose < 0) return xml + nl + block;
  return xml.slice(0, projectClose) + block + xml.slice(projectClose);
}

export async function writeProjectXml(projectPath: string, xml: string): Promise<void> {
  await fs.writeFile(projectPath, xml, 'utf8');
}
