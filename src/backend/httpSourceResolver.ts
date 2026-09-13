/**
 * Turning one config file into the sources the HTTP catalog may call (#27).
 *
 * The CLI is invoked as `--configfile <path>`, and with that switch only the
 * named file contributes settings — no chain is walked. So the sources this
 * resolver must reproduce are exactly the ones that single file enables, which
 * is what keeps the HTTP answer and the CLI answer comparable.
 *
 * Audit sources are read too, though nothing is fetched from them here: they
 * are the other half of "origins the user configured", and without them a
 * vulnerability database on its own host — which is the ordinary arrangement —
 * looks like an address nobody asked for.
 *
 * **Why this is memoised.** Resolving means a directory listing, a file read
 * and a full XML parse, and the catalog calls it once per configuration file
 * per operation. An enrichment wave asking about fifty packages across three
 * files turns that into hundreds of file operations — precisely the "multiplied
 * by configuration files" cost that makes the CLI path slow, only moved to the
 * HTTP side. So the result is held per path and revalidated against the file's
 * modification time and size: an edit is picked up on the next call, while an
 * unchanged file costs one `stat`.
 */

import * as fs from 'fs/promises';
import { parseNuGetConfig, uniqueEnabledAuditSources, uniqueEnabledPackageSources } from '../nugetConfigChainResolver';
import { expandNuGetConfigValue } from '../nugetConfigEnv';
import { isHttpPackageUrl } from '../vulnerabilityScanPolicy';
import { credentialForSource, credentialsFromConfigXml, type SourceCredential } from '../nugetSourceCredentials';
import { proxyFromConfigXml, type ProxyLayer } from '../nugetProxy';
import type { CredentialRegistry } from '../nugetHttpAuth';
import type { ProxyRegistry } from '../nugetProxyRegistry';
import type { ConfigSourceResolver, ResolvedConfigSources } from './httpCatalogBackend';

interface DeclaredCredential {
  url: string;
  credential: SourceCredential;
  allowInsecureConnections?: boolean;
}

interface ReadResult {
  resolved: ResolvedConfigSources;
  credentials: DeclaredCredential[];
  /** The proxy this file declares, which governs the feeds it enables. */
  proxy?: ProxyLayer;
}

interface CachedResolution extends ReadResult {
  mtimeMs: number;
  size: number;
}

/**
 * Reads one config file and splits what it enables into HTTP feeds and the
 * rest, registering any credentials it declares.
 *
 * Reading the file is the only moment the passwords exist in this process, and
 * they leave here only as an origin-bound entry in that registry — never on the
 * resolved source, which travels widely. Uncached:
 * {@link createConfigSourceResolver} is what the extension uses.
 */
export async function resolveConfigSources(
  configFile: string,
  credentials?: CredentialRegistry,
): Promise<ResolvedConfigSources> {
  return (await readConfigFile(configFile, credentials)).resolved;
}

/**
 * A resolver that reads each file once and keeps the answer until the file
 * changes. One per session: the cache lives as long as the resolver does.
 */
export function createConfigSourceResolver(
  credentials?: CredentialRegistry,
  proxies?: ProxyRegistry,
): ConfigSourceResolver {
  const cache = new Map<string, CachedResolution>();

  return async (configFile: string): Promise<ResolvedConfigSources> => {
    const stamp = await fileStamp(configFile);
    const held = cache.get(configFile);
    if (held && stamp && held.mtimeMs === stamp.mtimeMs && held.size === stamp.size) {
      // Credentials live in the registry rather than in the cached result, and
      // the registry can have been cleared since; re-registering costs nothing.
      for (const entry of held.credentials) {
        credentials?.remember(entry.url, entry.credential, entry.allowInsecureConnections);
      }
      if (held.proxy) await rememberProxy(held.resolved, held.proxy, proxies);
      return held.resolved;
    }

    const read = await readConfigFile(configFile, credentials);
    if (read.proxy) await rememberProxy(read.resolved, read.proxy, proxies);
    // A file that could not be stat'd is resolved afresh next time rather than
    // remembered: it may be a path that is about to exist.
    if (stamp) cache.set(configFile, { ...read, ...stamp });
    else cache.delete(configFile);
    return read.resolved;
  };
}

async function fileStamp(path: string): Promise<{ mtimeMs: number; size: number } | undefined> {
  try {
    const stat = await fs.stat(path);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return undefined;
  }
}

async function readConfigFile(
  configFile: string,
  credentials?: CredentialRegistry,
): Promise<ReadResult> {
  // Read once and hand the text to the parser, which would otherwise read the
  // same file again — and the credentials section needs that text anyway.
  const xml = await fs.readFile(configFile, 'utf8').catch(() => undefined);
  const parsed = await parseNuGetConfig(configFile, xml);
  const chain = [parsed];
  const packageSources = uniqueEnabledPackageSources(chain);
  const auditSources = uniqueEnabledAuditSources(chain);

  const knownOrigins = [...packageSources, ...auditSources]
    .map((source) => expandNuGetConfigValue(source.url).trim())
    .filter((url) => isHttpPackageUrl(url));

  const servable = packageSources.filter((source) => isServableOverHttp(source));
  const targets = servable
    .map((source) => ({
      // The name travels with the address because the details panel reports
      // which feed answered, and only the configuration knows that name.
      name: source.name,
      url: expandNuGetConfigValue(source.url).trim(),
      protocolVersion: source.protocolVersion,
      knownOrigins,
    }));

  return {
    resolved: {
      targets,
      // Anything this layer will not call is the CLI's business, and that
      // includes a plain-connection feed the configuration never declared
      // acceptable: NuGet refuses those outright, and the user should see its
      // refusal rather than have this quietly do what the CLI would not.
      hasNonHttpSource: packageSources.length > servable.length,
    },
    credentials: rememberCredentials(xml, servable, credentials),
    proxy: xml ? proxyFromConfigXml(xml) : undefined,
  };
}

/**
 * The proxy of a file governs the feeds that file enables. Recorded per feed
 * origin, which is how the transport finds it again from a bare address.
 */
async function rememberProxy(
  resolved: ResolvedConfigSources,
  proxy: ProxyLayer,
  registry?: ProxyRegistry,
): Promise<void> {
  if (!registry) return;
  for (const target of resolved.targets) await registry.remember(target.url, proxy);
}

/** A feed this layer may call at all: https, or http the configuration allows. */
function isServableOverHttp(source: { url: string; allowInsecureConnections?: boolean }): boolean {
  const url = expandNuGetConfigValue(source.url).trim();
  if (!isHttpPackageUrl(url)) return false;
  return /^https:/i.test(url) || source.allowInsecureConnections === true;
}

function rememberCredentials(
  xml: string | undefined,
  sources: Array<{ name: string; url: string; allowInsecureConnections?: boolean }>,
  registry?: CredentialRegistry,
): DeclaredCredential[] {
  if (!xml) return [];
  const declared = credentialsFromConfigXml(xml);
  if (Object.keys(declared).length === 0) return [];

  const found: DeclaredCredential[] = [];
  for (const source of sources) {
    const url = expandNuGetConfigValue(source.url).trim();
    if (!isHttpPackageUrl(url)) continue;
    const credential = credentialForSource(declared, source.name);
    if (!credential) continue;
    found.push({ url, credential, allowInsecureConnections: source.allowInsecureConnections });
    registry?.remember(url, credential, source.allowInsecureConnections);
  }
  return found;
}
