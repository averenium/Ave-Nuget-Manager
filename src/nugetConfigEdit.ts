/**
 * Read/write nuget.config XML for Sources tab edits.
 * Never returns password or API-key values — only presence / username.
 */

import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import type { CliResult } from './types';
import { encodeXmlLocalName, decodeXmlLocalName } from './nugetConfigXmlName';
import { encryptNuGetConfigPassword, supportsEncryptedNuGetPasswords } from './nugetConfigDpapi';
import { pathsEqual } from './pathCompare';
import {
  extractSection,
  findSectionBounds,
  maskXmlComments,
  removeSection,
  replaceSection,
} from './nugetConfigXmlSections';

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

export function isXmlElementName(name: string): boolean {
  return /^[\p{L}_][\p{L}\p{Nd}._\-]*$/u.test(name);
}

/** First (comment-safe) match of a non-global `regex` against `text`. */
function execMasked(text: string, regex: RegExp): RegExpExecArray | null {
  return regex.exec(maskXmlComments(text));
}

/** Removes the first (comment-safe) match of a non-global `regex`. */
function removeMaskedMatch(text: string, regex: RegExp): string {
  const m = execMasked(text, regex);
  if (!m) return text;
  return text.slice(0, m.index) + text.slice(m.index + m[0].length);
}

/**
 * Removes every (comment-safe) match of a global `regex` whose captured
 * attrs (group 1) satisfy `shouldRemove` — comment-safe equivalent of
 * `text.replace(regex, cb)` for a paired open/close tag, where matching
 * (and thus replacing) directly against a masked copy would also blank out
 * any real comment elsewhere in the string once written back to disk.
 */
function removeMaskedMatches(
  text: string,
  regex: RegExp,
  shouldRemove: (attrs: string) => boolean,
): string {
  const masked = maskXmlComments(text);
  const spans: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(masked)) !== null) {
    if (shouldRemove(m[1] ?? '')) spans.push([m.index, m.index + m[0].length]);
  }
  if (spans.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const [start, end] of spans) {
    out += text.slice(cursor, start);
    cursor = end;
  }
  return out + text.slice(cursor);
}

/**
 * Comment-safe equivalent of `text.replace(globalRegex, replacer)`: matches
 * against a masked copy (so a comment mentioning e.g. `<add ...>` can't be
 * treated as, or silently rewritten as, a real entry), but splices the
 * replacer's output into the real, untouched text at the same offsets.
 * `replacer` gets the same `(full, ...groups)` shape as `String.replace`.
 */
function replaceMaskedMatches(
  text: string,
  regex: RegExp,
  replacer: (full: string, ...groups: string[]) => string,
): string {
  const masked = maskXmlComments(text);
  const spans: Array<{ start: number; end: number; replacement: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(masked)) !== null) {
    const full = m[0];
    const replacement = replacer(full, ...(m.slice(1) as string[]));
    if (replacement !== full) spans.push({ start: m.index, end: m.index + full.length, replacement });
  }
  if (spans.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const { start, end, replacement } of spans) {
    out += text.slice(cursor, start) + replacement;
    cursor = end;
  }
  return out + text.slice(cursor);
}

function upsertAdd(section: string, key: string, value: string): string {
  const addRe = /<add\b([^>]*?)\s*(\/?)>/gi;
  let found = false;
  const next = replaceMaskedMatches(section, addRe, (full, attrInner, slash) => {
    const attrs = parseAddAttrList(attrInner);
    const ki = attrIndex(attrs, 'key');
    if (ki < 0 || attrs[ki].value.toLowerCase() !== key.toLowerCase()) return full;
    found = true;
    const vi = attrIndex(attrs, 'value');
    if (vi >= 0) attrs[vi] = { name: attrs[vi].name, value };
    else attrs.push({ name: 'value', value });
    const body = attrs.map((a) => `${a.name}="${escapeXml(a.value)}"`).join(' ');
    return `<add ${body}${slash ? ' />' : '>'}`;
  });
  if (found) return next;
  const line = `    <add key="${escapeXml(key)}" value="${escapeXml(value)}" />\n`;
  const trimmed = section.replace(/\s+$/, '');
  return `${trimmed}${trimmed && !trimmed.endsWith('\n') ? '\n' : ''}${line}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function listAdds(section: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  const re = /<add\b([^>]*?)\s*\/?>/gi;
  const masked = maskXmlComments(section);
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const attrs = parseAddAttrList(m[1]);
    const key = attrs[attrIndex(attrs, 'key')]?.value;
    const value = attrs[attrIndex(attrs, 'value')]?.value;
    if (key === undefined || value === undefined) continue;
    out.push({ key, value });
  }
  return out;
}

/**
 * Enable or disable a source via `<disabledPackageSources>`.
 * Disable writes `value="true"`. Enable writes `value="false"` so a nearer
 * file can override a farther disable (removing the key would leave the parent off).
 */
export function setPackageSourceDisabled(xml: string, sourceName: string, disabled: boolean): string {
  let section = extractSection(xml, 'disabledPackageSources');
  section = upsertAdd(section, sourceName, disabled ? 'true' : 'false');
  return replaceSection(xml, 'disabledPackageSources', section.endsWith('\n') ? section : `${section}\n`);
}

/**
 * Removes the `<add>` (`<add ... />` or `<add ...></add>`) whose `key` decodes
 * (parsed + `unescapeXml`ed, like {@link upsertAdd} already does) to `key`.
 * Compares the *decoded* value instead of baking the raw key into a regex
 * against already-escaped XML text — a name like `Contoso & Co` (stored as
 * `key="Contoso &amp; Co"`) never matches the latter.
 */
function removeAddByDecodedKey(section: string, key: string): string {
  const want = key.toLowerCase();
  return removeMaskedMatches(
    section,
    /\s*<add\b([^>]*?)(?:\/>|>\s*<\/add\s*>)/gi,
    (attrInner) => {
      const attrs = parseAddAttrList(attrInner);
      const k = attrs[attrIndex(attrs, 'key')]?.value;
      return k !== undefined && k.toLowerCase() === want;
    },
  );
}

/** Replace `<auditSources>` (optional `<clear />`). Does not touch `<disabledPackageSources>`. */
export function replaceAuditSources(
  xml: string,
  sources: Array<{ name: string; url: string }>,
  clear: boolean,
): string {
  if (!clear && sources.length === 0) return removeSection(xml, 'auditSources');
  let inner = clear ? '    <clear />\n' : '';
  for (const src of sources) {
    inner += `    <add key="${escapeXml(src.name)}" value="${escapeXml(src.url)}" />\n`;
  }
  return replaceSection(xml, 'auditSources', inner);
}

export function removeAuditSource(xml: string, sourceName: string): string {
  const section = extractSection(xml, 'auditSources');
  if (!section) return xml;
  const next = removeAddByDecodedKey(section, sourceName);
  if (!/<add\s/i.test(next) && !/<clear\s*\/>/i.test(next)) return removeSection(xml, 'auditSources');
  return replaceSection(xml, 'auditSources', next.endsWith('\n') ? next : `${next}\n`);
}

export function upsertAuditSource(xml: string, sourceName: string, url: string): string {
  const section = upsertAdd(extractSection(xml, 'auditSources'), sourceName, url);
  return replaceSection(xml, 'auditSources', section.endsWith('\n') ? section : `${section}\n`);
}

type AddAttr = { name: string; value: string };

// Matches either quote style XML allows for an attribute value — a
// single-quoted `<add key='Foo' value='bar' />` is valid XML too, and
// dotnet/Visual Studio only ever write double quotes, so this only ever
// matters for a hand-edited file.
const ATTR_RE = /([A-Za-z_][\w.\-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAddAttrList(inner: string): AddAttr[] {
  const out: AddAttr[] = [];
  const re = new RegExp(ATTR_RE.source, ATTR_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    out.push({ name: m[1], value: unescapeXml(m[2] ?? m[3] ?? '') });
  }
  return out;
}

function attrIndex(attrs: AddAttr[], name: string): number {
  const want = name.toLowerCase();
  return attrs.findIndex((a) => a.name.toLowerCase() === want);
}

function setBoolAttr(attrs: AddAttr[], officialName: string, enabled: boolean, aliases: string[] = []): void {
  for (const name of aliases) {
    const i = attrIndex(attrs, name);
    if (i >= 0) attrs.splice(i, 1);
  }
  const i = attrIndex(attrs, officialName);
  if (!enabled) {
    if (i >= 0) attrs.splice(i, 1);
    return;
  }
  if (i >= 0) attrs[i] = { name: officialName, value: 'true' };
  else attrs.push({ name: officialName, value: 'true' });
}

function rewriteSourceAddsInSection(
  xml: string,
  sectionName: string,
  sourceName: string,
  patch: (attrs: AddAttr[]) => void,
): string {
  const bounds = findSectionBounds(xml, sectionName);
  if (!bounds) return xml;
  const inner = xml.slice(bounds.innerStart, bounds.innerEnd);
  const nextInner = replaceMaskedMatches(inner, /<add\b([^>]*?)\s*(\/?)>/gi, (full, attrInner, slash) => {
    const attrs = parseAddAttrList(attrInner);
    const key = attrs[attrIndex(attrs, 'key')]?.value;
    if (!key || key.toLowerCase() !== sourceName.toLowerCase()) return full;
    patch(attrs);
    const body = attrs.map((a) => `${a.name}="${escapeXml(a.value)}"`).join(' ');
    return `<add ${body}${slash ? ' />' : '>'}`;
  });
  return xml.slice(0, bounds.innerStart) + nextInner + xml.slice(bounds.innerEnd);
}

/** Set or clear `allowInsecureConnections` / `disableTLSCertificateValidation` on a source `<add>`. */
export function setPackageSourceConnectionFlags(
  xml: string,
  sourceName: string,
  flags: {
    allowInsecureConnections?: boolean;
    disableTlsCertificateValidation?: boolean;
  },
): string {
  const patch = (attrs: AddAttr[]): void => {
    if (flags.allowInsecureConnections !== undefined) {
      setBoolAttr(attrs, 'allowInsecureConnections', flags.allowInsecureConnections);
    }
    if (flags.disableTlsCertificateValidation !== undefined) {
      setBoolAttr(attrs, 'disableTLSCertificateValidation', flags.disableTlsCertificateValidation, [
        'disableTlsVerification',
        'disableTLSCertificateVerification',
      ]);
    }
  };
  let next = rewriteSourceAddsInSection(xml, 'packageSources', sourceName, patch);
  next = rewriteSourceAddsInSection(next, 'auditSources', sourceName, patch);
  return next;
}

/**
 * Declare a new `<packageSources>` entry (or update it in place if `name`
 * already exists there — same "insert-or-update" shape as `upsertAuditSource`).
 */
export function addPackageSource(
  xml: string,
  name: string,
  url: string,
  opts?: { protocolVersion?: '2' | '3' },
): string {
  const section = upsertAdd(extractSection(xml, 'packageSources'), name, url);
  let next = replaceSection(xml, 'packageSources', section.endsWith('\n') ? section : `${section}\n`);
  next = rewriteSourceAddsInSection(next, 'packageSources', name, (attrs) => {
    const i = attrIndex(attrs, 'protocolVersion');
    if (opts?.protocolVersion) {
      const entry = { name: 'protocolVersion', value: opts.protocolVersion };
      if (i >= 0) attrs[i] = entry;
      else attrs.push(entry);
    } else if (i >= 0) {
      attrs.splice(i, 1);
    }
  });
  return next;
}

/**
 * Remove one `<packageSources>` entry entirely (not a soft
 * `<disabledPackageSources>` toggle). Removing the last one also drops the
 * section, unless a `<clear />` is still there — same shape as `removeAuditSource`.
 */
export function removePackageSourceEntry(xml: string, name: string): string {
  const section = extractSection(xml, 'packageSources');
  if (!section) return xml;
  const next = removeAddByDecodedKey(section, name);
  if (!/<add\s/i.test(next) && !/<clear\s*\/>/i.test(next)) return removeSection(xml, 'packageSources');
  return replaceSection(xml, 'packageSources', next.endsWith('\n') ? next : `${next}\n`);
}

export function extractCredentialUsernames(xml: string): Record<string, string> {
  const section = maskXmlComments(extractSection(xml, 'packageSourceCredentials'));
  const out: Record<string, string> = {};
  const blockRe = /<([^\s/>]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(section)) !== null) {
    const raw = m[1];
    if (raw.toLowerCase() === 'add') continue;
    const name = decodeXmlLocalName(raw);
    const user = /<add\s+key\s*=\s*["']Username["']\s+value\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[2]);
    if (user) out[name] = unescapeXml(user[1] ?? user[2] ?? '');
  }
  return out;
}

function credentialBlockInner(xml: string, sourceName: string): string | undefined {
  const section = maskXmlComments(extractSection(xml, 'packageSourceCredentials'));
  const elementName = encodeXmlLocalName(sourceName);
  const blockRe = new RegExp(
    `<${escapeRegExp(elementName)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegExp(elementName)}>`,
    'i',
  );
  return blockRe.exec(section)?.[1];
}

/** Existing password as stored. Encrypted blobs are copied as-is, never decrypted here. */
function extractStoredPassword(
  xml: string,
  sourceName: string,
): { value: string; encrypted: boolean } | undefined {
  const inner = credentialBlockInner(xml, sourceName);
  if (!inner) return undefined;
  const enc = /<add\s+key\s*=\s*["']Password["']\s+value\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(inner);
  if (enc) return { value: unescapeXml(enc[1] ?? enc[2] ?? ''), encrypted: true };
  const clear = /<add\s+key\s*=\s*["']ClearTextPassword["']\s+value\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(inner);
  if (clear) return { value: unescapeXml(clear[1] ?? clear[2] ?? ''), encrypted: false };
  return undefined;
}

export function mergePackageSourceCredentials(
  xml: string,
  sourceName: string,
  opts: {
    username: string;
    password?: string;
    passwordEncrypted?: boolean;
    clear?: boolean;
    /** Used when moving credentials to another file and the password field was left blank. */
    passwordFallbackXml?: string;
  },
): string {
  if (opts.clear) return setPackageSourceCredentials(xml, sourceName, null);
  const replacing = opts.password !== undefined && opts.password !== '';
  const stored = replacing
    ? undefined
    : (extractStoredPassword(xml, sourceName)
      ?? (opts.passwordFallbackXml
        ? extractStoredPassword(opts.passwordFallbackXml, sourceName)
        : undefined));
  const password = replacing ? opts.password! : (stored?.value ?? '');
  const encrypted = replacing ? !!opts.passwordEncrypted : !!stored?.encrypted;
  if (!opts.username && !password) return setPackageSourceCredentials(xml, sourceName, null);
  return setPackageSourceCredentials(xml, sourceName, { username: opts.username, password, encrypted });
}

/** URLs from `<apikeys>` and `<clearTextApiKeys>` — never the stored values. */
export function extractApiKeyUrls(xml: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const add of [
    ...listAdds(extractSection(xml, 'apikeys')),
    ...listAdds(extractSection(xml, 'clearTextApiKeys')),
  ]) {
    const id = add.key.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(add.key);
  }
  return out;
}

/**
 * Set or remove `<packageSourceCredentials>` for one source.
 * `creds === null` removes the block.
 * `encrypted: true` writes NuGet's `Password` (DPAPI blob). Otherwise `ClearTextPassword`.
 */
export function setPackageSourceCredentials(
  xml: string,
  sourceName: string,
  creds: { username: string; password: string; encrypted?: boolean } | null,
): string {
  const elementName = encodeXmlLocalName(sourceName);
  if (!elementName || !isXmlElementName(elementName)) {
    throw new Error(`Cannot write credentials for source "${sourceName}": name is not a valid nuget.config element.`);
  }
  let section = extractSection(xml, 'packageSourceCredentials');
  const blockRe = new RegExp(
    `\\s*<${escapeRegExp(elementName)}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${escapeRegExp(elementName)}>`,
    'i',
  );
  section = removeMaskedMatch(section, blockRe);
  if (creds) {
    const passKey = creds.encrypted ? 'Password' : 'ClearTextPassword';
    const block =
      `    <${elementName}>\n` +
      `      <add key="Username" value="${escapeXml(creds.username)}" />\n` +
      `      <add key="${passKey}" value="${escapeXml(creds.password)}" />\n` +
      `    </${elementName}>\n`;
    const trimmed = section.replace(/\s+$/, '');
    section = `${trimmed}${trimmed && !trimmed.endsWith('\n') ? '\n' : ''}${block}`;
  }
  if (!/<[A-Za-z_]/.test(section)) return removeSection(xml, 'packageSourceCredentials');
  return replaceSection(xml, 'packageSourceCredentials', section.endsWith('\n') ? section : `${section}\n`);
}

/**
 * 0-based line of `<add key="name">` inside packageSources, else auditSources.
 * Used to reveal a feed in the editor.
 */
export function findPackageSourceLine(xml: string, sourceName: string): number | undefined {
  const want = sourceName.toLowerCase();
  const lines = xml.split(/\r?\n/);
  let section: 'package' | 'audit' | null = null;
  let packageHit: number | undefined;
  let auditHit: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/<packageSources[\s>]/i.test(line)) section = 'package';
    else if (/<\/packageSources>/i.test(line)) section = null;
    else if (/<auditSources[\s>]/i.test(line)) section = 'audit';
    else if (/<\/auditSources>/i.test(line)) section = null;
    const key = /<add\b[^>]*\bkey\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(line);
    const keyValue = key?.[1] ?? key?.[2];
    if (keyValue === undefined || keyValue.toLowerCase() !== want) continue;
    if (section === 'package' && packageHit === undefined) packageHit = i;
    if (section === 'audit' && auditHit === undefined) auditHit = i;
  }
  return packageHit ?? auditHit;
}

function setUrlKeyedSection(
  xml: string,
  sectionName: string,
  sourceUrl: string,
  value: string | null,
): string {
  let section = extractSection(xml, sectionName);
  section = removeAddByDecodedKey(section, sourceUrl);
  if (value !== null && value !== '') {
    section = upsertAdd(section, sourceUrl, value);
  }
  if (!/<add\s/i.test(section)) return removeSection(xml, sectionName);
  return replaceSection(xml, sectionName, section.endsWith('\n') ? section : `${section}\n`);
}

export function setApiKeyEntry(xml: string, sourceUrl: string, apiKey: string | null): string {
  return setUrlKeyedSection(xml, 'apikeys', sourceUrl, apiKey);
}

/**
 * Non-Windows analogue of `<apikeys>`: NuGet will not DPAPI-decrypt this section.
 * Host may read values later for Push; they are never sent to the webview.
 */
export function setClearTextApiKeyEntry(xml: string, sourceUrl: string, apiKey: string | null): string {
  return setUrlKeyedSection(xml, 'clearTextApiKeys', sourceUrl, apiKey);
}

/**
 * Set (or remove, when `patterns` is empty) one source's `<packageSourceMapping>`
 * glob patterns. Mirrors {@link setPackageSourceCredentials}'s extract → mutate
 * → replace/remove shape; `<clear />`, if present, is left untouched.
 */
export function setPackageSourceMappingPatterns(
  xml: string,
  sourceName: string,
  patterns: string[],
): string {
  let section = extractSection(xml, 'packageSourceMapping');
  // Compare the *decoded* key (a source named "Contoso & Co" is stored on
  // disk as key="Contoso &amp; Co") rather than baking the raw, unescaped
  // sourceName into a regex against already-escaped XML text — otherwise the
  // old block for such a name is never matched and a stale duplicate
  // <packageSource> is left behind. Same approach as rewriteSourceAddsInSection.
  const wantKey = sourceName.toLowerCase();
  section = removeMaskedMatches(
    section,
    /\s*<packageSource\b([^>]*)>[\s\S]*?<\/packageSource>/gi,
    (attrs) => {
      const parsed = parseAddAttrList(attrs);
      const key = parsed[attrIndex(parsed, 'key')]?.value;
      return key !== undefined && key.toLowerCase() === wantKey;
    },
  );
  const unique = [...new Set(patterns.map((p) => p.trim()).filter(Boolean))];
  if (unique.length > 0) {
    const packages = unique.map((p) => `      <package pattern="${escapeXml(p)}" />`).join('\n');
    const block = `    <packageSource key="${escapeXml(sourceName)}">\n${packages}\n    </packageSource>\n`;
    const trimmed = section.replace(/\s+$/, '');
    section = `${trimmed}${trimmed && !trimmed.endsWith('\n') ? '\n' : ''}${block}`;
  }
  if (!/<packageSource\b/i.test(section) && !/<clear\s*\/>/i.test(section)) {
    return removeSection(xml, 'packageSourceMapping');
  }
  return replaceSection(xml, 'packageSourceMapping', section.endsWith('\n') ? section : `${section}\n`);
}

export async function patchNuGetConfigOnDisk(
  filePath: string,
  mutate: (xml: string) => string,
): Promise<void> {
  const xml = await fs.readFile(filePath, 'utf-8');
  const next = mutate(xml);
  if (next === xml) return;
  await fs.writeFile(filePath, next, 'utf-8');
}

function openNuGetConfigDocument(filePath: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(
    (d) => !d.isClosed && pathsEqual(d.fileName, filePath),
  );
}

/** Prefer the editor buffer so a dirty nuget.config is not overwritten from disk. */
export async function readNuGetConfigText(filePath: string): Promise<string> {
  const open = openNuGetConfigDocument(filePath);
  if (open) return open.getText();
  return fs.readFile(filePath, 'utf-8');
}

function fullDocumentRange(doc: vscode.TextDocument): vscode.Range {
  if (doc.lineCount === 0) {
    return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
  }
  const last = doc.lineAt(doc.lineCount - 1);
  return new vscode.Range(new vscode.Position(0, 0), last.range.end);
}

async function patchNuGetConfigDocument(
  doc: vscode.TextDocument,
  mutate: (xml: string) => string,
): Promise<void> {
  const xml = doc.getText();
  const next = mutate(xml);
  if (next === xml) return;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, fullDocumentRange(doc), next);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    throw new Error(`Could not update ${doc.fileName} in the editor.`);
  }
  const saved = await doc.save();
  if (!saved) {
    throw new Error(`Could not save ${doc.fileName}.`);
  }
}

/**
 * Patch a nuget.config. If the file is open (including unsaved), mutate the
 * editor buffer via WorkspaceEdit and save. Otherwise read/write the disk file.
 */
export async function patchNuGetConfigFile(
  filePath: string,
  mutate: (xml: string) => string,
): Promise<void> {
  const doc = openNuGetConfigDocument(filePath);
  if (doc) {
    await patchNuGetConfigDocument(doc, mutate);
    return;
  }
  await patchNuGetConfigOnDisk(filePath, mutate);
}

/**
 * Write or remove a source API key.
 * Windows: `<apikeys>` DPAPI blob (NuGet `FromBase64String` + Unprotect).
 * Not Windows: `<clearTextApiKeys>` plaintext — NuGet CLI cannot decrypt `<apikeys>` here;
 * the extension will use this section for Push later.
 */
export async function writeSourceApiKey(
  configFilePath: string,
  sourceUrl: string,
  apiKey: string | null,
): Promise<CliResult> {
  const encrypted = supportsEncryptedNuGetPasswords();
  let stored = apiKey;
  if (stored !== null && stored !== '' && encrypted) {
    stored = await encryptNuGetConfigPassword(stored);
  }
  await patchNuGetConfigFile(configFilePath, (xml) => {
    if (stored === null || stored === '') {
      return setClearTextApiKeyEntry(setApiKeyEntry(xml, sourceUrl, null), sourceUrl, null);
    }
    if (encrypted) {
      return setApiKeyEntry(setClearTextApiKeyEntry(xml, sourceUrl, null), sourceUrl, stored);
    }
    return setClearTextApiKeyEntry(setApiKeyEntry(xml, sourceUrl, null), sourceUrl, stored);
  });
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
}
