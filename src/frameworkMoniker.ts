/**
 * One key for the several ways a target framework is written (#114).
 *
 * A project states `net10.0`, `net472`, `netstandard2.0` — the short folder
 * moniker. A registration entry's dependency group states whichever form the
 * package was built with, and the long form (`.NETFramework4.7.2`,
 * `.NETStandard2.0`, `.NETCoreApp3.1`) is still everywhere in the catalog
 * because it is what older packages were published with. `project.assets.json`
 * writes a third form again — `.NETFramework,Version=v4.7.2` — and these are
 * shared utilities, so it has to be read here even where nothing reads it yet.
 * Comparing any two of these as text says a package declares nothing for a
 * framework it declares plenty for.
 *
 * This maps them all to the short form and stops there. It is not a
 * compatibility check and must not become one: whether `netstandard2.0`
 * satisfies a `net10.0` project is a question for restore, which knows the
 * fallback chains. All that is decided here is whether two spellings name the
 * same framework.
 */

/**
 * The short moniker for a spelling this recognises, `undefined` for one it does
 * not.
 *
 * Kept separate from the two exports below because they want opposite things
 * from a moniker nobody recognises: a comparison key has to be normalised so
 * two spellings of it still match, while a label has to be left exactly as
 * written, since a half-normalised `.netportable0.0-profile259` is a spelling
 * that exists nowhere.
 */
function parseMoniker(lower: string): string | undefined {
  const short = parseMonikerShort(lower);
  return short ? repairDotlessModern(short) : short;
}

function parseMonikerShort(lower: string): string | undefined {
  // `.NETFramework,Version=v4.7.2` — the form `project.assets.json` uses.
  const versioned = /^\.net(framework|standard|coreapp|platform)?,\s*version=v([0-9][0-9.]*)(.*)$/
    .exec(lower);
  if (versioned) {
    const [, family, version, rest] = versioned;
    return shorten(family, version, platformSuffix(rest));
  }
  // `.NETFramework4.7.2` — the form the catalog uses.
  const joined = /^\.net(framework|standard|coreapp|platform)?([0-9][0-9.]*)(.*)$/.exec(lower);
  if (joined) {
    const [, family, version, rest] = joined;
    return shorten(family, version, platformSuffix(rest));
  }
  // Already short: `net10.0`, `net472`, `netstandard2.0`, `netcoreapp3.1`.
  if (/^(net|netstandard|netcoreapp)[0-9]/.test(lower)) return lower;
  return undefined;
}

/**
 * Repairs a dotless `netDDD` that is really a modern moniker with its dot
 * lost, not a .NET Framework version (#123).
 *
 * Measured on the project's own lab Nexus (Sonatype Nexus 3.76.0): its
 * generated registration rewrites every modern moniker into the
 * `.NETFramework` family before this ever sees it — `net9.0` arrives as
 * `.NETFramework9.0` and `net10.0` as `.NETFramework1.0.0` (Nexus reads
 * `net10` as the packed .NET Framework 1.0 and keeps the trailing `.0`).
 * `shorten()` above turns both into a dotless `netDDD` the same way it turns
 * a real `.NETFramework4.7.2` into `net472` — it has no reason to doubt the
 * feed, so the false claim rides along.
 *
 * The two never collide: .NET Framework is finished at 4.8.1 and modern .NET
 * starts at 5.0, so every dotless shape .NET Framework ever actually shipped
 * is either two digits starting 1–4 (`net11` … `net48`) or three digits
 * starting with 4 (`net403`, `net472`, `net481`) — anything else is a modern
 * moniker that lost its dot, read back with the last digit as the minor and
 * the rest as the major. `net10` stays .NET Framework 1.0, which is exactly
 * what the broken producer does *not* write for .NET 10 — it writes `net100`.
 */
function repairDotlessModern(short: string): string {
  const match = /^net(\d+)((?:-[a-z0-9.]+)?)$/.exec(short);
  if (!match) return short;
  const [, digits, platform] = match;
  if (isClassicFrameworkDigits(digits)) return short;
  const minor = digits.slice(-1);
  const major = digits.slice(0, -1);
  return `net${major}.${minor}${platform}`;
}

function isClassicFrameworkDigits(digits: string): boolean {
  if (digits.length === 2) return /^[1-4]/.test(digits);
  if (digits.length === 3) return digits.startsWith('4');
  // No dotless .NET Framework moniker was ever this short or this long —
  // leave it alone rather than guess.
  return true;
}

function shorten(
  family: string | undefined,
  version: string,
  platform: string,
): string | undefined {
  switch (family) {
    case 'framework':
      // .NET Framework drops the dots: 4.7.2 is `net472`.
      return `net${version.replace(/\./g, '')}${platform}`;
    case 'standard':
      return `netstandard${version}${platform}`;
    case 'coreapp':
      // .NET 5 and later kept the `.NETCoreApp` family name and the short
      // moniker became `net5.0` — the version is what tells them apart.
      return major(version) >= 5 ? `net${version}${platform}` : `netcoreapp${version}${platform}`;
    default:
      // `.NETPortable`, `.NETPlatform` and anything else: no short form worth
      // inventing, and a wrong one would claim two frameworks are the same.
      return undefined;
  }
}

/**
 * The comparison key: `.NETFramework,Version=v4.7.2`, `.NETFramework4.7.2` and
 * `net472` all answer `net472`. A spelling this does not recognise is
 * normalised only for case and whitespace, so it still matches itself and
 * nothing else.
 */
export function frameworkKey(tfm: string | undefined): string {
  const raw = (tfm ?? '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  return parseMoniker(lower) ?? lower.replace(/\s+/g, '');
}

/**
 * The same moniker as a reader should see it: the short form when there is one,
 * and otherwise exactly what the feed wrote. A moniker with no short form is
 * left alone rather than half-converted — `.NETPortable0.0-Profile259` is a real
 * thing to write and `.netportable0.0-profile259` is not.
 */
export function frameworkLabel(tfm: string | undefined): string {
  const raw = (tfm ?? '').trim();
  if (!raw) return '';
  return parseMoniker(raw.toLowerCase()) ?? raw;
}

/** `,profile=client` / `-windows10.0.19041` → `-client` / `-windows10.0.19041`. */
function platformSuffix(rest: string): string {
  const dash = /^-([a-z0-9.]+)/.exec(rest);
  if (dash) return `-${dash[1]}`;
  const profile = /^,\s*profile=([a-z0-9.]+)/.exec(rest);
  return profile ? `-${profile[1]}` : '';
}

function major(version: string): number {
  const first = Number(version.split('.')[0]);
  return Number.isFinite(first) ? first : 0;
}
