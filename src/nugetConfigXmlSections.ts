/**
 * Shared, comment-safe helpers for reading/writing a nuget.config XML
 * file's top-level `<sectionName>...</sectionName>` containers by regex (no
 * XML parser dependency — see #85, where the write side must stay
 * surgical-text-edit rather than reformat-on-every-save).
 *
 * A comment that happens to mention the section's own tag name in prose
 * (e.g. `<!-- <packageSourceMapping> configures which source gets which
 * ids -->`) would otherwise let a lazy `[\s\S]*?` body capture swallow
 * through to the real closing tag, corrupting or losing whatever sits
 * between them — including unrelated sibling sections. Matching the section
 * boundary always happens against a comment-masked copy; the real,
 * untouched text is what's actually read from and spliced when writing.
 */

import { maskXmlComments } from './xmlComments';

export { maskXmlComments };

export interface SectionBounds {
  /** Start of the leading `<tagName...>` open tag. */
  fullStart: number;
  /** End of the trailing `</tagName>` close tag. */
  fullEnd: number;
  /** Start of the section's inner content, right after the open tag. */
  innerStart: number;
  /** End of the section's inner content, right before the close tag. */
  innerEnd: number;
}

/**
 * Locates one `<tagName ...>...</tagName>` container by finding its open
 * and close tags independently against a masked copy (rather than one lazy
 * `<tagName[^>]*>([\s\S]*?)<\/tagName>` regex), so neither can be fooled by
 * comment text mentioning the tag name.
 */
export function findSectionBounds(xml: string, tagName: string): SectionBounds | undefined {
  const masked = maskXmlComments(xml);
  const openRe = new RegExp(`<[ \\t]*${tagName}[^>]*>`, 'i');
  const openMatch = openRe.exec(masked);
  if (!openMatch) return undefined;
  const innerStart = openMatch.index + openMatch[0].length;
  const closeRe = new RegExp(`<\\/[ \\t]*${tagName}[ \\t]*>`, 'i');
  const closeMatch = closeRe.exec(masked.slice(innerStart));
  if (!closeMatch) return undefined;
  const innerEnd = innerStart + closeMatch.index;
  return { fullStart: openMatch.index, fullEnd: innerEnd + closeMatch[0].length, innerStart, innerEnd };
}

/** Inner content of `<tagName>...</tagName>`, or '' if absent. Real text — comments untouched. */
export function extractSection(xml: string, tagName: string): string {
  const bounds = findSectionBounds(xml, tagName);
  return bounds ? xml.slice(bounds.innerStart, bounds.innerEnd) : '';
}

/** Removes the whole `<tagName>...</tagName>` container plus its leading whitespace. */
export function removeSection(xml: string, tagName: string): string {
  const bounds = findSectionBounds(xml, tagName);
  if (!bounds) return xml;
  let start = bounds.fullStart;
  while (start > 0 && /\s/.test(xml[start - 1])) start--;
  return `${xml.slice(0, start)}\n${xml.slice(bounds.fullEnd)}`;
}

function eolOf(xml: string): '\r\n' | '\n' {
  return xml.includes('\r\n') ? '\r\n' : '\n';
}

/** Child markup between tags: no extra blank lines, one trailing EOL before `</tag>`. */
function normalizeSectionInner(inner: string, eol: '\r\n' | '\n'): string {
  const stripped = inner
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/^\n+/, '')
    .replace(/[ \t\n]+$/, '');
  if (!stripped) return '';
  return `${stripped.replace(/\n/g, eol)}${eol}`;
}

/** Replaces (or appends, if absent) `<tagName>...</tagName>` with freshly formatted `inner`. */
export function replaceSection(xml: string, tagName: string, inner: string): string {
  const eol = eolOf(xml);
  const block = `  <${tagName}>${eol}${normalizeSectionInner(inner, eol)}  </${tagName}>`;
  const bounds = findSectionBounds(xml, tagName);
  if (bounds) return xml.slice(0, bounds.fullStart) + block.trimStart() + xml.slice(bounds.fullEnd);
  if (/<\/configuration>/i.test(xml)) {
    return xml.replace(/<\/configuration>/i, `${block}${eol}</configuration>`);
  }
  return `${xml.replace(/[ \t\r\n]+$/, '')}${eol}${block}${eol}`;
}
