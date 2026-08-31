/**
 * XML local-name encode/decode used by NuGet for packageSourceCredentials
 * (same idea as XmlConvert.EncodeLocalName / DecodeName).
 * A source named "Test Source" is stored as <Test_x0020_Source>.
 */

function isNameStart(ch: string): boolean {
  return ch === '_' || /\p{L}/u.test(ch);
}

function isNameChar(ch: string, first: boolean): boolean {
  if (first) return isNameStart(ch);
  return isNameStart(ch) || /\p{Nd}/u.test(ch) || ch === '.' || ch === '-';
}

function encodeCodePoint(code: number): string {
  const hex = code.toString(16).toUpperCase();
  return `_x${hex.padStart(code > 0xffff ? 8 : 4, '0')}_`;
}

function looksLikeEscape(rest: string): boolean {
  return /^x[0-9A-Fa-f]{4}_/.test(rest) || /^x[0-9A-Fa-f]{8}_/.test(rest);
}

/** Encode a package source name as a nuget.config credentials element. */
export function encodeXmlLocalName(name: string): string {
  const chars = [...name];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const rest = chars.slice(i + 1).join('');
    if (ch === '_' && looksLikeEscape(rest)) {
      out += '_x005F_';
      continue;
    }
    if (isNameChar(ch, i === 0)) out += ch;
    else out += encodeCodePoint(ch.codePointAt(0) ?? 0);
  }
  return out;
}

/** Decode a credentials element name back to the package source key. */
export function decodeXmlLocalName(name: string): string {
  return name.replace(/_x([0-9A-Fa-f]{4}|[0-9A-Fa-f]{8})_/g, (_, hex: string) =>
    String.fromCodePoint(parseInt(hex, 16)),
  );
}
