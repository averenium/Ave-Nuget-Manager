/**
 * Credentials for an HTTP source, read from the configuration the CLI reads (#27).
 *
 * Until now the HTTP path sent nothing and a private feed answered 401, which
 * sent the work back to the CLI. That is correct but gives up the whole benefit
 * exactly where feeds are slowest — a corporate repository. The credentials are
 * already in `nuget.config`; this reads them the way NuGet does.
 *
 * Three rules, each of which is a test below:
 *
 * - **A credential belongs to one origin.** It is attached only to requests to
 *   the origin of the source it was configured for. A feed spreading resources
 *   across sibling hosts is still one feed for *reading*, but a password is not
 *   something to hand a host merely because it shares a domain.
 * - **Nothing leaves over a plain connection** unless the source itself is
 *   declared insecure-connection-allowed, which is the switch NuGet already
 *   requires for an `http://` feed to be used at all.
 * - **The password never leaves this layer.** It is turned into a header and is
 *   never logged, traced, or put in a URL; the encrypted form is decrypted only
 *   at the moment of use.
 *
 * What is deliberately not here: credential-provider plugins, interactive
 * sign-in, and Windows integrated authentication. A feed needing any of those
 * answers 401 and the work falls back to the CLI, which has them.
 */

import { decryptNuGetConfigPassword, supportsEncryptedNuGetPasswords } from './nugetConfigDpapi';
import { expandNuGetConfigValue } from './nugetConfigEnv';
import { decodeXmlLocalName, encodeXmlLocalName } from './nugetConfigXmlName';
import { extractSection, maskXmlComments } from './nugetConfigXmlSections';

export interface SourceCredential {
  username: string;
  /** Either given in the clear, or held encrypted until the moment of use. */
  password: string;
  encrypted: boolean;
}

function attributeValue(inner: string, key: string): string | undefined {
  const match = new RegExp(
    `<add\\s+key\\s*=\\s*["']${key}["']\\s+value\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    'i',
  ).exec(inner);
  const raw = match?.[1] ?? match?.[2];
  return raw === undefined ? undefined : unescapeXml(raw);
}

/** Shared with the proxy reader: the same attributes, the same escaping. */
export function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Every credential the file declares, by source name as written there. Names
 * are XML-encoded in this section — a source called `my feed` appears as
 * `my_x0020_feed` — so they are decoded back before use.
 */
export function credentialsFromConfigXml(xml: string): Record<string, SourceCredential> {
  const section = maskXmlComments(extractSection(xml, 'packageSourceCredentials'));
  const out: Record<string, SourceCredential> = {};
  const blockRe = /<([^\s/>]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(section)) !== null) {
    if (match[1].toLowerCase() === 'add') continue;
    const name = decodeXmlLocalName(match[1]);
    const inner = match[2];
    const username = attributeValue(inner, 'Username');
    if (username === undefined) continue;

    const clear = attributeValue(inner, 'ClearTextPassword');
    const encrypted = attributeValue(inner, 'Password');
    if (clear !== undefined) {
      out[name] = { username, password: clear, encrypted: false };
    } else if (encrypted !== undefined) {
      out[name] = { username, password: encrypted, encrypted: true };
    }
  }
  return out;
}

/** The credential for one source, looked up the way NuGet names these blocks. */
export function credentialForSource(
  credentials: Record<string, SourceCredential>,
  sourceName: string,
): SourceCredential | undefined {
  const direct = credentials[sourceName];
  if (direct) return direct;
  // Written by hand, the block may carry the encoded spelling verbatim.
  const encoded = encodeXmlLocalName(sourceName);
  const found = Object.entries(credentials)
    .find(([name]) => name === encoded || name.toLowerCase() === sourceName.toLowerCase());
  return found?.[1];
}

/**
 * The header value, with environment references expanded and an encrypted
 * password decrypted. Returns nothing when the password cannot be recovered —
 * on a machine that cannot decrypt it, for instance — so the request simply
 * goes out unauthenticated and the CLI takes over on the 401.
 */
export async function basicAuthHeader(credential: SourceCredential): Promise<string | undefined> {
  const username = expandNuGetConfigValue(credential.username).trim();
  let password = expandNuGetConfigValue(credential.password);
  if (credential.encrypted) {
    if (!supportsEncryptedNuGetPasswords()) return undefined;
    try {
      password = await decryptNuGetConfigPassword(password);
    } catch {
      return undefined;
    }
  }
  if (!username && !password) return undefined;
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

/** True when a credential may be sent to this address at all. */
export function mayAuthenticate(url: string, allowInsecureConnections?: boolean): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    // A password over a plain connection travels in readable form. NuGet already
    // makes the user declare an http feed acceptable; without that declaration
    // nothing is sent and the request goes out anonymous.
    return parsed.protocol === 'http:' && allowInsecureConnections === true;
  } catch {
    return false;
  }
}
