import * as path from 'path';
import * as os from 'os';

export interface FileAlias {
  /** Absolute path on disk. */
  absPath: string;
  /** Zip-relative path used in logs, traces, and the archive (`projects/p01.csproj`). */
  dest: string;
}

export interface SanitizeContext {
  home: string;
  workspaceRoots: string[];
  hostname: string;
  /** Pack-time file ids — applied before home/workspace so names match zip entries. */
  aliases?: FileAlias[];
}

const KEEP_URL_SEGMENTS = new Set([
  'v2', 'v3', 'nuget', 'api', 'index.json', 'repository', 'service',
  'query', 'search', 'metadata', '_packaging', 'packages', 'package',
  'registrationsbaseurl', 'packagebaseaddress',
]);

function pathVariants(p: string): string[] {
  if (!p) return [];
  const resolved = path.resolve(p);
  return [...new Set([p, resolved].filter((s) => s.length > 1))];
}

function isPathLike(from: string): boolean {
  return /[\\/]/.test(from) || /^[A-Za-z]:/.test(from);
}

/**
 * Match a disk path whether it was logged with `\`, `/`, or JSON-escaped `\\`.
 * `d:\\Repo\\Foo.csproj` in jsonl must hit the same rule as `d:\Repo\Foo.csproj`.
 */
function pathToFlexibleRegex(from: string): RegExp {
  const normalized = from.replace(/\\/g, '/').replace(/\/+/g, '/');
  const unc = normalized.startsWith('//');
  const posix = normalized.startsWith('/') && !unc;
  const segs = normalized.split('/').filter(Boolean);
  const body = segs.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]+');
  const prefix = unc || posix ? '[\\\\/]+' : '';
  return new RegExp(prefix + body, 'gi');
}

const GENERIC_BASENAMES = new Set([
  'nuget.config',
  'nuget.config.xml',
  'directory.packages.props',
  'directory.build.props',
  'global.json',
  'packages.config',
]);

function destBasename(dest: string): string {
  return dest.split('/').pop() ?? dest;
}

const PROJECT_FILE_EXT = /\.(csproj|fsproj|vbproj|sln|slnx)$/i;

function uniqueProjectAliases(ctx: SanitizeContext): FileAlias[] {
  const byBase = new Map<string, FileAlias[]>();
  for (const alias of ctx.aliases ?? []) {
    if (!PROJECT_FILE_EXT.test(alias.absPath)) continue;
    const key = path.basename(alias.absPath).toLowerCase();
    const list = byBase.get(key) ?? [];
    list.push(alias);
    byBase.set(key, list);
  }
  const unique: FileAlias[] = [];
  for (const [, list] of byBase) {
    if (list.length === 1) unique.push(list[0]);
  }
  unique.sort((a, b) => path.basename(b.absPath).length - path.basename(a.absPath).length);
  return unique;
}

/**
 * `../Folder/Foo.csproj` and leftover `../Folder/p02.csproj` → `projects/p02.csproj`.
 * Must run before the bare-basename replace, otherwise the directory prefix stays.
 */
function applyRelativeProjectRefs(text: string, ctx: SanitizeContext): string {
  let out = text;
  const prefix = String.raw`(?:\.[\\/]+)?(?:\.\.[\\/]+)*(?:[^"'<>\s\\/]+[\\/]+)+`;
  for (const alias of uniqueProjectAliases(ctx)) {
    const orig = path.basename(alias.absPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const destFile = destBasename(alias.dest).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(prefix + orig, 'gi'), alias.dest);
    if (destFile.toLowerCase() !== orig.toLowerCase()) {
      out = out.replace(new RegExp(prefix + destFile, 'gi'), alias.dest);
    }
  }
  return out;
}

function uniqueStemAliases(ctx: SanitizeContext): FileAlias[] {
  const byStem = new Map<string, FileAlias[]>();
  for (const alias of uniqueProjectAliases(ctx)) {
    const stem = path.basename(alias.absPath, path.extname(alias.absPath)).toLowerCase();
    const list = byStem.get(stem) ?? [];
    list.push(alias);
    byStem.set(stem, list);
  }
  const unique: FileAlias[] = [];
  for (const [, list] of byStem) {
    if (list.length === 1) unique.push(list[0]);
  }
  unique.sort((a, b) => path.basename(b.absPath).length - path.basename(a.absPath).length);
  return unique;
}

function destForProjectFileName(fileName: string, ctx: SanitizeContext): string | undefined {
  const key = fileName.toLowerCase();
  if (!key) return undefined;
  const origHits = (ctx.aliases ?? []).filter(
    (alias) => path.basename(alias.absPath).toLowerCase() === key,
  );
  if (origHits.length === 1) return origHits[0].dest;
  const destHits = (ctx.aliases ?? []).filter(
    (alias) => destBasename(alias.dest).toLowerCase() === key,
  );
  if (destHits.length === 1) return destHits[0].dest;
  return undefined;
}

/**
 * `.sln` Project lines keep the display name and folder after a basename-only replace:
 * `= "AVE.ElectricityBot", "AVE.ElectricityBot/p01.csproj"`.
 */
function redactSlnProjectLines(text: string, ctx: SanitizeContext): string {
  return text.replace(
    /(\s*Project\("[^"]+"\)\s*=\s*")([^"]*)(",\s*")([^"]*)(")/g,
    (all, pre: string, _name: string, mid: string, projPath: string, end: string) => {
      const base = projPath.replace(/\\/g, '/').split('/').pop() ?? '';
      const dest = destForProjectFileName(base, ctx);
      if (!dest) return all;
      const destStem = destBasename(dest).replace(/\.[^.]+$/, '');
      return `${pre}${destStem}${mid}${dest}${end}`;
    },
  );
}

/** slnx `Path="Folder/Foo.fsproj"` and leftover `Path="Folder/p02.fsproj"`. */
function redactXmlProjectPathAttrs(text: string, ctx: SanitizeContext): string {
  return text.replace(
    /<(Project(?:Reference)?)\b([^>]*?)(\s*\/?)>/gi,
    (all, tag: string, attrs: string, close: string) => {
      const pathMatch = attrs.match(/\s(Path|Include)\s*=\s*("([^"]*)"|'([^']*)')/i);
      if (!pathMatch) return all;
      const value = pathMatch[3] ?? pathMatch[4] ?? '';
      const base = value.replace(/\\/g, '/').split('/').pop() ?? '';
      if (!PROJECT_FILE_EXT.test(base)) return all;
      const dest = destForProjectFileName(base, ctx);
      if (!dest) return all;
      const destStem = destBasename(dest).replace(/\.[^.]+$/, '');
      const attrName = pathMatch[1];
      let next = attrs.replace(pathMatch[0], ` ${attrName}="${dest}"`);
      next = next.replace(/(\sName\s*=\s*)("[^"]*"|'[^']*')/i, `$1"${destStem}"`);
      return `<${tag}${next}${close}>`;
    },
  );
}
function redactSolutionProjectNames(text: string, ctx: SanitizeContext): string {
  let out = text;
  for (const alias of uniqueStemAliases(ctx)) {
    const stem = path.basename(alias.absPath, path.extname(alias.absPath));
    if (stem.length < 2) continue;
    const destStem = destBasename(alias.dest).replace(/\.[^.]+$/, '');
    const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(Project\\("[^"]+"\\)\\s*=\\s*")${esc}(")`, 'gi'), `$1${destStem}$2`);
    out = out.replace(
      new RegExp(`(<(?:ProjectReference|Project)\\b[^>]*\\sName=")${esc}(")`, 'gi'),
      `$1${destStem}$2`,
    );
  }
  return out;
}

/** Full paths (longest first), then unique file names, then workspace/home. */
export function buildPathReplacements(ctx: SanitizeContext): Array<{ from: string; to: string }> {
  const rows: Array<{ from: string; to: string }> = [];

  for (const alias of ctx.aliases ?? []) {
    for (const from of pathVariants(alias.absPath)) {
      rows.push({ from, to: alias.dest });
    }
  }

  const byBase = new Map<string, FileAlias[]>();
  for (const alias of ctx.aliases ?? []) {
    const key = path.basename(alias.absPath).toLowerCase();
    const list = byBase.get(key) ?? [];
    list.push(alias);
    byBase.set(key, list);
  }
  for (const [, list] of byBase) {
    if (list.length !== 1) continue;
    const alias = list[0];
    const base = path.basename(alias.absPath);
    if (GENERIC_BASENAMES.has(base.toLowerCase())) continue;
    const destBase = destBasename(alias.dest);
    if (base.toLowerCase() === destBase.toLowerCase()) continue;
    rows.push({ from: base, to: destBase });
  }

  for (const root of ctx.workspaceRoots) {
    for (const from of pathVariants(root)) {
      rows.push({ from, to: '<workspace>' });
    }
  }
  const home = ctx.home || os.homedir();
  for (const from of pathVariants(home)) {
    rows.push({ from, to: '~' });
  }
  const base = path.basename(home);
  if (base) {
    rows.push({ from: `C:\\Users\\${base}`, to: '~' });
    rows.push({ from: `/Users/${base}`, to: '~' });
    rows.push({ from: `/home/${base}`, to: '~' });
  }
  rows.sort((a, b) => b.from.length - a.from.length);
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.from.toLowerCase()}=>${r.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function applyPaths(text: string, replacements: Array<{ from: string; to: string }>): string {
  let out = text;
  for (const { from, to } of replacements) {
    if (isPathLike(from)) {
      out = out.replace(pathToFlexibleRegex(from), to);
      continue;
    }
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'gi'), to);
  }
  return out;
}

function workspaceRootsNormalized(ctx: SanitizeContext): string[] {
  return ctx.workspaceRoots
    .map((root) => path.resolve(root).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase())
    .filter((root) => root.length > 1);
}

/** Last pass: any leftover `d://Repo//…` style path after JSON `\\` became `/`. */
function redactLeftoverDrivePaths(text: string, ctx: SanitizeContext): string {
  const roots = workspaceRootsNormalized(ctx);
  return text.replace(/(?<![A-Za-z])[A-Za-z]:[\\/]+[^\s"'<>|]*/g, (m) => {
    const collapsed = m.replace(/\\/g, '/').replace(/\/+/g, '/');
    const lower = collapsed.toLowerCase();
    for (const root of roots) {
      if (lower === root) return '<workspace>';
      if (lower.startsWith(`${root}/`)) return `<workspace>${collapsed.slice(root.length)}`;
    }
    const name = collapsed.split('/').pop() ?? '';
    return name ? `<path>/${name}` : '<path>';
  });
}

function hrefFrom(parsed: URL, pathname: string): string {
  parsed.username = '';
  parsed.password = '';
  return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}${parsed.hash}`;
}

export function sanitizeFeedUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'nuget.org' || host.endsWith('.nuget.org')) {
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  }

  const parts = parsed.pathname.split('/').filter(Boolean);
  if (host === 'pkgs.dev.azure.com' || host.endsWith('.pkgs.visualstudio.com') || host.endsWith('.visualstudio.com')) {
    if (parts[0]) parts[0] = '<org>';
    if (parts[1] && parts[1] !== '_packaging') parts[1] = '<project>';
    const pack = parts.indexOf('_packaging');
    if (pack >= 0 && parts[pack + 1]) parts[pack + 1] = '<feed>';
    return hrefFrom(parsed, '/' + parts.join('/'));
  }
  if (host === 'nuget.pkg.github.com' || host === 'github.com') {
    if (parts[0]) parts[0] = '<org>';
    return hrefFrom(parsed, '/' + parts.join('/'));
  }

  parsed.hostname = 'host.example';
  const redactedPath = '/' + parts
    .map((seg) => (KEEP_URL_SEGMENTS.has(seg.toLowerCase()) ? seg : '<id>'))
    .join('/');
  return hrefFrom(parsed, redactedPath).replace('://host.example', '://<host>');
}

function redactUrlsInText(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, (m) => {
    const trimmed = m.replace(/[.,;)]+$/, '');
    const suffix = m.slice(trimmed.length);
    return sanitizeFeedUrl(trimmed) + suffix;
  });
}

/** Paths, home, host, emails, credentials. Longest workspace root first. */
export function sanitizeText(text: string, ctx: SanitizeContext): string {
  const replacements = buildPathReplacements(ctx);
  const pathRows = replacements.filter((r) => isPathLike(r.from));
  const nameRows = replacements.filter((r) => !isPathLike(r.from));
  let out = applyPaths(text, pathRows);
  out = applyRelativeProjectRefs(out, ctx);
  out = applyPaths(out, nameRows);
  out = redactSlnProjectLines(out, ctx);
  out = redactSolutionProjectNames(out, ctx);
  out = redactLeftoverDrivePaths(out, ctx);

  out = out.replace(/:\/\/[^/@\s]+:[^/@\s]+@/g, '://<redacted>@');
  out = out.replace(/ClearTextPassword\s*=\s*("[^"]*"|'[^']*'|\S+)/gi, 'ClearTextPassword=<redacted>');
  out = out.replace(/\b(password|pwd|apikey|api[_-]?key|access[_-]?token|secret)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi, '$1=<redacted>');
  out = out.replace(
    /\b(Server|Data Source|User ID|UID|Initial Catalog)\s*=\s*[^;\s"]+/gi,
    (m) => m.replace(/=\s*.+$/, '=<redacted>'),
  );

  out = out.replace(
    /("([^"\\]*(?:password|pwd|apikey|api[_-]?key)[^"\\]*)"\s*:\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s,}\]]+)/gi,
    '$1"<redacted>"',
  );

  out = redactUrlsInText(out);

  if (ctx.hostname && ctx.hostname.length > 1) {
    const hostEsc = ctx.hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${hostEsc}\\b`, 'gi'), '<host>');
  }

  out = out.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '<email>');
  out = out.replace(/\\/g, '/');
  return out.replace(/:\/\//g, '\u0000').replace(/\/{2,}/g, '/').replace(/\u0000/g, '://');
}

const DROP_XML_BLOCKS = [
  /<packageSourceCredentials\b[^>]*>[\s\S]*?<\/packageSourceCredentials>/gi,
  /<packageSourceCredentials\b[^>]*\/>/gi,
  /<apikeys\b[^>]*>[\s\S]*?<\/apikeys>/gi,
  /<apikeys\b[^>]*\/>/gi,
  /<clearTextApiKeys\b[^>]*>[\s\S]*?<\/clearTextApiKeys>/gi,
  /<clearTextApiKeys\b[^>]*\/>/gi,
];

/** Keep structure (ports, OS, tags) — mask registry hosts, image names, env values, registry keys. */
const KEEP_CONTAINER_OR_REGISTRY_TAGS = new Set([
  'containerport',
  'containerimagetags',
  'enablesdkcontainersupport',
  'dockerdefaulttargetos',
]);

function isContainerOrRegistryTag(tag: string): boolean {
  const t = tag.toLowerCase();
  if (KEEP_CONTAINER_OR_REGISTRY_TAGS.has(t)) return false;
  if (/^(container|docker|registry)/i.test(tag)) return true;
  return t === 'restoresources' || t === 'restoreadditionalprojectsources';
}

function redactAttrValues(attrs: string, names: string[]): string {
  let out = attrs;
  for (const name of names) {
    out = out.replace(
      new RegExp(`(\\s${name}\\s*=\\s*)("[^"]*"|'[^']*')`, 'gi'),
      '$1"<redacted>"',
    );
  }
  return out;
}

const PAIR_TAGS =
  'Container(?!Port\\b|ImageTags\\b)[A-Za-z0-9]*|Docker[A-Za-z0-9]*|Registry[A-Za-z0-9]*|RestoreSources|RestoreAdditionalProjectSources';

function redactContainerAndRegistryXml(xml: string): string {
  const pair = new RegExp(`<(${PAIR_TAGS})(\\s[^>]*)?>([\\s\\S]*?)<\\/\\1>`, 'gi');
  let out = xml.replace(pair, (_all, tag: string, attrs: string | undefined) => {
    return `<${tag}${attrs ?? ''}><redacted></${tag}>`;
  });
  out = out.replace(
    /<([A-Za-z][\w.-]*)(\s[^>]*?)\/>/gi,
    (all, tag: string, attrs: string) => {
      if (!isContainerOrRegistryTag(tag)) return all;
      const t = tag.toLowerCase();
      const names = t.startsWith('registry')
        ? ['Key', 'Name', 'Value', 'Id', 'Include']
        : ['Value', 'Registry', 'Repository', 'Image', 'Include'];
      return `<${tag}${redactAttrValues(attrs, names)} />`;
    },
  );
  return out;
}

const SECRET_NAME = /password|pwd|apikey|api[_-]?key/i;

function nameLooksSecret(name: string): boolean {
  return SECRET_NAME.test(name);
}

function redactSecretNamedXml(xml: string): string {
  const pair = /<([A-Za-z][\w.-]*?(?:password|pwd|apikey|api[_-]?key)[\w.-]*)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let out = xml.replace(pair, (_all, tag: string, attrs: string | undefined) => {
    return `<${tag}${attrs ?? ''}><redacted></${tag}>`;
  });

  out = out.replace(
    /\s([A-Za-z_][\w.-]*?(?:password|pwd|apikey|api[_-]?key)[\w.-]*)\s*=\s*("[^"]*"|'[^']*')/gi,
    ' $1="<redacted>"',
  );

  out = out.replace(
    /<([A-Za-z][\w.-]*)(\s[^>]*?)\/>/gi,
    (all, tag: string, attrs: string) => {
      const keyed = attrs.match(/\s(?:key|Key|Include|Name)\s*=\s*("[^"]*"|'[^']*')/);
      if (!keyed) return all;
      const keyVal = keyed[1].slice(1, -1);
      if (!nameLooksSecret(keyVal) && !nameLooksSecret(tag)) return all;
      return `<${tag}${redactAttrValues(attrs, ['value', 'Value', 'Password', 'ClearTextPassword', 'apiKey', 'ApiKey'])} />`;
    },
  );
  return out;
}

/** Same as {@link sanitizeText}, plus nuget.config identity, HintPath, container/registry csproj settings. */
export function sanitizeXml(text: string, ctx: SanitizeContext): string {
  let out = text;
  for (const re of DROP_XML_BLOCKS) {
    out = out.replace(re, '');
  }
  out = out.replace(/\s(Password|ClearTextPassword|Username|apiKey|ApiKey)="[^"]*"/gi, '');
  out = out.replace(/<HintPath>[\s\S]*?<\/HintPath>/gi, '<HintPath><redacted></HintPath>');
  out = redactContainerAndRegistryXml(out);
  out = redactSecretNamedXml(out);
  out = redactXmlProjectPathAttrs(out, ctx);
  return sanitizeText(out, ctx);
}

export function sanitizeFileName(filePath: string): string {
  return path.basename(filePath).replace(/[<>:"|?*]/g, '_');
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local date-time in the default save name, e.g. `nuget-manager-trace-2026-08-21_00-31-12.zip`. */
export function defaultTraceZipName(at: Date): string {
  return `nuget-manager-trace-${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}_${pad2(at.getHours())}-${pad2(at.getMinutes())}-${pad2(at.getSeconds())}.zip`;
}
