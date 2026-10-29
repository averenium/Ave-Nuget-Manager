import * as path from 'path';
import * as os from 'os';
import { sourceScopeOf } from './nugetServiceIndex';

export interface FileAlias {
  /** Absolute path on disk. */
  absPath: string;
  /** Zip-relative path used in logs, traces, and the archive (`projects/p01.csproj`). */
  dest: string;
}

export interface SourceAlias {
  /** The source as configured. */
  url: string;
  /** `s01`, `s02`, ... — what the archive calls it (#133). */
  alias: string;
}

export interface SanitizeContext {
  home: string;
  workspaceRoots: string[];
  hostname: string;
  /** Pack-time file ids — applied before home/workspace so names match zip entries. */
  aliases?: FileAlias[];
  /**
   * Package sources by number, so an archive can say which source a request
   * belonged to without naming its host (#133). Without them three repositories
   * on one host all read as the same `https://<host>/repository/<id>/index.json`.
   */
  sourceAliases?: SourceAlias[];
}

/** `s01`, `s02`, ... for each distinct source, in the order they are given. */
export function assignSourceAliases(urls: readonly string[]): SourceAlias[] {
  const seen = new Set<string>();
  const out: SourceAlias[] = [];
  for (const url of urls) {
    const scope = sourceScopeOf(url);
    if (!scope) continue;
    const key = `${scope.origin}${scope.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, alias: `s${String(out.length + 1).padStart(2, '0')}` });
  }
  return out;
}

/**
 * A source's address, up to and not including `index.json`, becomes `<s01>`;
 * what follows it — `/index.json`, `/v3/search`, a package id — is untouched, so
 * the request stays readable and only the part that names the feed is gone.
 */
function applySourceAliases(text: string, ctx: SanitizeContext): string {
  const rows = (ctx.sourceAliases ?? [])
    .map(({ url, alias }) => ({ scope: sourceScopeOf(url), alias }))
    .filter((row): row is { scope: { origin: string; path: string }; alias: string } => !!row.scope)
    .sort((a, b) => (b.scope.origin + b.scope.path).length - (a.scope.origin + a.scope.path).length);
  let out = text;
  for (const { scope, alias } of rows) {
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escaped = escape(scope.origin + scope.path);
    // A boundary after it, so `/repository/a` does not eat the front of `/repository/ab`.
    out = out.replace(new RegExp(`${escaped}(?![A-Za-z0-9._~%-])`, 'gi'), `<${alias}>`);
  }
  return out;
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
    // `cwd` fields are the containing directory, no trailing filename — the
    // full-path rule above never matches those, so the real folder hierarchy
    // below the workspace root passed through unredacted (#38 review).
    const fromDir = path.dirname(alias.absPath);
    if (fromDir && fromDir !== path.parse(fromDir).root) {
      const toDir = path.dirname(alias.dest).replace(/\\/g, '/');
      for (const from of pathVariants(fromDir)) {
        rows.push({ from, to: toDir });
      }
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

/**
 * Paths, home, host, emails, credentials. Longest workspace root first.
 *
 * Only ever for text meant to be read as text. It rewrites every backslash and
 * collapses runs of slashes, which is exactly what damages JSON syntax: run
 * over an encoded line it turned `\n` into `/n` and `\"` into `/"`, and the
 * line stopped parsing (#134). A JSON line goes through `sanitizeJsonLines`.
 *
 * `replacements` lets a caller that sanitises many strings against one context
 * build the path rows once.
 *
 * `keepJsonEscapes` is for text that is JSON but cannot be parsed to be
 * sanitised as data (a body cut off by the preview limit): a backslash that
 * introduces a JSON escape is left alone, and runs of slashes are not
 * collapsed, since `//` is ordinary content there.
 */
export function sanitizeText(
  text: string,
  ctx: SanitizeContext,
  replacements: Array<{ from: string; to: string }> = buildPathReplacements(ctx),
  options: { keepJsonEscapes?: boolean } = {},
): string {
  text = applySourceAliases(text, ctx);
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
  // Whole escapes are kept as pairs, so the second backslash of `\\` is not
  // taken for the start of another.
  if (options.keepJsonEscapes) return out.replace(/\\["\\/bfnrtu]|\\/g, (match) => (match.length === 2 ? match : '/'));
  out = out.replace(/\\/g, '/');
  // NUL is the sentinel the swap below parks `://` under while the run of
  // slashes beside it is collapsed.
  // eslint-disable-next-line no-control-regex -- the sentinel is the point
  return out.replace(/:\/\//g, '\u0000').replace(/\/{2,}/g, '/').replace(/\u0000/g, '://');
}

const SECRET_KEY = /password|pwd|apikey|api[_-]?key|access[_-]?token|secret/i;

/**
 * Keys are text too: `INSTALL_PACKAGE_MULTI` carries `frameworks` keyed by the
 * absolute path of each project. Two keys that sanitise to the same name are
 * kept apart rather than one silently replacing the other.
 */
function sanitizeValue(value: unknown, clean: (text: string) => string, cleanKey: (text: string) => string): unknown {
  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, clean, cleanKey));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      let name = cleanKey(key);
      for (let n = 2; Object.prototype.hasOwnProperty.call(out, name); n += 1) name = `${cleanKey(key)}#${n}`;
      // What `sanitizeText` does to `"password": "x"` in text: a value is a
      // secret by the name of its key. Only a string or a number can be one: a
      // flag such as `clearApiKey: false` names a secret and holds none, and
      // hiding it loses a fact the diagnosis may need.
      out[name] = SECRET_KEY.test(key) && (typeof item === 'string' || typeof item === 'number')
        ? '<redacted>'
        : sanitizeValue(item, clean, cleanKey);
    }
    return out;
  }
  return value;
}

/** The indent of a pretty-printed JSON text, or nothing for a compact one. */
function indentOf(text: string): number | undefined {
  const match = /^\s*[[{]\s*\n( +)\S/.exec(text);
  return match ? match[1].length : undefined;
}

/**
 * A string that is itself a JSON document (a `dotnet` stdout, a response body)
 * is sanitised as data and written back the way it was laid out, rather than as
 * text, whose backslash pass would take the escapes out of it. `undefined` when
 * it is not one that parses.
 */
function sanitizeEmbeddedJson(
  text: string,
  clean: (text: string) => string,
  cleanKey: (text: string) => string,
): string | undefined {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const lead = /^\s*/.exec(text)?.[0] ?? '';
  const trail = /\s*$/.exec(text)?.[0] ?? '';
  return lead + JSON.stringify(sanitizeValue(parsed, clean, cleanKey), null, indentOf(text)) + trail;
}

/**
 * Sanitises a JSON Lines file by sanitising the text inside each event, then
 * writing the event out again (#134). No pass ever runs over JSON syntax, so
 * the escapes inside a payload, the `\n` and `\"` of a `dotnet` stdout or a
 * response body, cannot be damaged, and every line stays one parseable
 * object.
 *
 * A line that is not JSON to begin with is kept as a text field of a small
 * object rather than passed through, so the result is valid JSON Lines
 * whatever it was given.
 */
export function sanitizeJsonLines(jsonl: string, ctx: SanitizeContext): string {
  const replacements = buildPathReplacements(ctx);
  const cleanKey = (text: string) => sanitizeText(text, ctx, replacements);
  const clean = (text: string): string => {
    const nested = sanitizeEmbeddedJson(text, clean, cleanKey);
    if (nested !== undefined) return nested;
    // Cut off by the preview limit, so it cannot be read as data, but still
    // JSON text whose escapes are not ours to rewrite.
    return /^\s*[[{]/.test(text)
      ? sanitizeText(text, ctx, replacements, { keepJsonEscapes: true })
      : sanitizeText(text, ctx, replacements);
  };
  const lines = jsonl.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.map((line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return JSON.stringify({ kind: 'unparseable', text: sanitizeText(line, ctx, replacements) });
    }
    return JSON.stringify(sanitizeValue(parsed, clean, cleanKey));
  }).map((line) => `${line}\n`).join('');
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

/**
 * NuGet's `<config>` section only ever pairs `.user`/`.username` with a
 * `.password` key for proxy settings (`http_proxy.user` / `http_proxy.password`,
 * same for `https_proxy`) — matching only next to that sibling avoids treating
 * an unrelated `key="..."` that merely contains "user" (a feed name, say) as
 * secret. `<add key="X.password" .../>` implies `X.user`/`X.username` is just
 * as sensitive, whether or not the sibling appears before or after it.
 */
function proxyUserKeysNextToPassword(xml: string): Set<string> {
  const keys = new Set<string>();
  const re = /<add\s[^>]*\bkey\s*=\s*["']([^"']+)\.password["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const prefix = m[1].toLowerCase();
    keys.add(`${prefix}.user`);
    keys.add(`${prefix}.username`);
  }
  return keys;
}

/**
 * Free-text settings whose whole value is inherently internal-only info with
 * no debugging benefit to keeping partial fragments — unlike a single
 * hostname, `no_proxy` is a comma-separated exclusion list that can embed any
 * number of internal domain fragments no single rule can pattern-match.
 */
const FULL_VALUE_SECRET_KEYS = new Set(['no_proxy', 'noproxy']);

function redactSecretNamedXml(xml: string): string {
  const proxyUserKeys = proxyUserKeysNextToPassword(xml);

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
      const keyLower = keyVal.toLowerCase();
      if (
        !nameLooksSecret(keyVal) && !nameLooksSecret(tag)
        && !proxyUserKeys.has(keyLower) && !FULL_VALUE_SECRET_KEYS.has(keyLower)
      ) return all;
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
