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

function extractSection(xml: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = regex.exec(xml);
  return m ? m[1] : '';
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

function replaceSection(xml: string, tagName: string, inner: string): string {
  const eol = eolOf(xml);
  const block = `  <${tagName}>${eol}${normalizeSectionInner(inner, eol)}  </${tagName}>`;
  const regex = new RegExp(`<[ \t]*${tagName}[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'i');
  if (regex.test(xml)) return xml.replace(regex, block.trimStart());
  if (/<\/configuration>/i.test(xml)) {
    return xml.replace(/<\/configuration>/i, `${block}${eol}</configuration>`);
  }
  return `${xml.replace(/[ \t\r\n]+$/, '')}${eol}${block}${eol}`;
}

function removeSection(xml: string, tagName: string): string {
  return xml.replace(new RegExp(`\\s*<${tagName}[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'i'), '\n');
}

function upsertAdd(section: string, key: string, value: string): string {
  const addRe = /<add\b([^>]*?)\s*(\/?)>/gi;
  let found = false;
  const next = section.replace(addRe, (full, attrInner: string, slash: string) => {
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

function removeAdd(section: string, key: string): string {
  return removeAddByKey(section, key);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function listAdds(section: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  const re = /<add\b([^>]*?)\s*\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
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

function removeAddByKey(section: string, key: string): string {
  return section.replace(
    new RegExp(
      `\\s*<add\\b[^>]*\\bkey\\s*=\\s*"${escapeRegExp(key)}"(?:[^>]*/>|[^>]*>\\s*</add\\s*>)`,
      'gi',
    ),
    '',
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
  const next = removeAddByKey(section, sourceName);
  if (!/<add\s/i.test(next) && !/<clear\s*\/>/i.test(next)) return removeSection(xml, 'auditSources');
  return replaceSection(xml, 'auditSources', next.endsWith('\n') ? next : `${next}\n`);
}

export function upsertAuditSource(xml: string, sourceName: string, url: string): string {
  const section = upsertAdd(extractSection(xml, 'auditSources'), sourceName, url);
  return replaceSection(xml, 'auditSources', section.endsWith('\n') ? section : `${section}\n`);
}

type AddAttr = { name: string; value: string };

function parseAddAttrList(inner: string): AddAttr[] {
  const out: AddAttr[] = [];
  const re = /([A-Za-z_][\w.\-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    out.push({ name: m[1], value: unescapeXml(m[2]) });
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
  const blockRe = new RegExp(`(<${sectionName}[^>]*>)([\\s\\S]*?)(</${sectionName}>)`, 'i');
  return xml.replace(blockRe, (_full, open: string, inner: string, close: string) => {
    const next = inner.replace(/<add\b([^>]*?)\s*(\/?)>/gi, (full, attrInner: string, slash: string) => {
      const attrs = parseAddAttrList(attrInner);
      const key = attrs[attrIndex(attrs, 'key')]?.value;
      if (!key || key.toLowerCase() !== sourceName.toLowerCase()) return full;
      patch(attrs);
      const body = attrs.map((a) => `${a.name}="${escapeXml(a.value)}"`).join(' ');
      return `<add ${body}${slash ? ' />' : '>'}`;
    });
    return `${open}${next}${close}`;
  });
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

export function extractCredentialUsernames(xml: string): Record<string, string> {
  const section = extractSection(xml, 'packageSourceCredentials');
  const out: Record<string, string> = {};
  const blockRe = /<([^\s/>]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(section)) !== null) {
    const raw = m[1];
    if (raw.toLowerCase() === 'add') continue;
    const name = decodeXmlLocalName(raw);
    const user = /<add\s+key\s*=\s*"Username"\s+value\s*=\s*"([^"]*)"/i.exec(m[2]);
    if (user) out[name] = unescapeXml(user[1]);
  }
  return out;
}

function credentialBlockInner(xml: string, sourceName: string): string | undefined {
  const section = extractSection(xml, 'packageSourceCredentials');
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
  const enc = /<add\s+key\s*=\s*"Password"\s+value\s*=\s*"([^"]*)"/i.exec(inner);
  if (enc) return { value: unescapeXml(enc[1]), encrypted: true };
  const clear = /<add\s+key\s*=\s*"ClearTextPassword"\s+value\s*=\s*"([^"]*)"/i.exec(inner);
  if (clear) return { value: unescapeXml(clear[1]), encrypted: false };
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
  section = section.replace(blockRe, '');
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
    const key = /<add\b[^>]*\bkey\s*=\s*"([^"]*)"/i.exec(line);
    if (!key || key[1].toLowerCase() !== want) continue;
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
  section = removeAdd(section, sourceUrl);
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
  section = section.replace(
    /\s*<packageSource\b([^>]*)>[\s\S]*?<\/packageSource>/gi,
    (full, attrs: string) => {
      const parsed = parseAddAttrList(attrs);
      const key = parsed[attrIndex(parsed, 'key')]?.value;
      return key !== undefined && key.toLowerCase() === wantKey ? '' : full;
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
