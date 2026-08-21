import * as fs from 'fs/promises';

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

export function findPackageReferenceSpans(xml: string, packageId: string): PackageReferenceSpan[] {
  const spans: PackageReferenceSpan[] = [];
  const re = new RegExp(PACKAGE_REFERENCE.source, PACKAGE_REFERENCE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (includeMatches(m[0], packageId)) {
      spans.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    }
  }
  return spans;
}

export function countPackageReferences(xml: string, packageId: string): number {
  return findPackageReferenceSpans(xml, packageId).length;
}

function includeMatches(el: string, packageId: string): boolean {
  return new RegExp(`\\bInclude\\s*=\\s*["']${escapeRegex(packageId)}["']`, 'i').test(el);
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

/**
 * Keep one PackageReference for `packageId`, set its version, drop extras.
 * New id: always a new unconditioned ItemGroup (never append into a Condition group).
 */
export function upsertPackageReference(xml: string, packageId: string, version: string): string {
  const spans = findPackageReferenceSpans(xml, packageId);
  if (spans.length === 0) return insertPackageReference(xml, packageId, version);

  const updated = setVersionInElement(spans[0].text, version);
  let next = xml.slice(0, spans[0].start) + updated + xml.slice(spans[0].end);
  const delta = updated.length - spans[0].text.length;
  for (let i = spans.length - 1; i >= 1; i--) {
    next = removeSpan(next, spans[i].start + delta, spans[i].end + delta);
  }
  return next;
}

export function removePackageReferences(xml: string, packageId: string): string {
  const spans = findPackageReferenceSpans(xml, packageId);
  let next = xml;
  for (let i = spans.length - 1; i >= 0; i--) {
    next = removeSpan(next, spans[i].start, spans[i].end);
  }
  return next;
}

function insertPackageReference(xml: string, packageId: string, version: string): string {
  const nl = xml.includes('\r\n') ? '\r\n' : '\n';
  const el = `    <PackageReference Include="${packageId}" Version="${version}" />`;
  const block = `  <ItemGroup>${nl}${el}${nl}  </ItemGroup>${nl}`;
  const projectClose = xml.search(/<\/Project>/i);
  if (projectClose < 0) return xml + nl + block;
  return xml.slice(0, projectClose) + block + xml.slice(projectClose);
}

export async function writeProjectXml(projectPath: string, xml: string): Promise<void> {
  await fs.writeFile(projectPath, xml, 'utf8');
}
