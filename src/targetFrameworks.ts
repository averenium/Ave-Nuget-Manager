/**
 * Ordering for the target-framework badges (#86). The `lib/<tfm>/` folder
 * names NuGet ships are not sortable as text, and not sortable as numbers
 * either: `net11.0` comes before `net9.0` alphabetically, and `net48` looks
 * larger than `net8.0` while being .NET Framework 4.8 — six years older than
 * .NET 8. Newest-first therefore needs the moniker parsed, not compared.
 */

/** Lower rank sorts first. Modern .NET, then .NET Core, then .NET Standard, then .NET Framework, then everything else. */
const FAMILY_MODERN = 0;
const FAMILY_CORE = 1;
const FAMILY_STANDARD = 2;
const FAMILY_FRAMEWORK = 3;
const FAMILY_OTHER = 4;

export interface ParsedTargetFramework {
  family: number;
  /** Numeric components, most significant first. Empty for an unrecognised moniker. */
  version: number[];
  /** The part after the first `-` (`windows10.0.19041`, `ios14.0`, `client`), lowercased; empty when there is none. */
  platform: string;
  raw: string;
}

function dottedVersion(text: string): number[] {
  return text.split('.').map((p) => parseInt(p, 10) || 0);
}

/**
 * `net472` is 4.7.2 and `net48` is 4.8 — .NET Framework packs its version into
 * bare digits, one component per digit.
 */
function packedVersion(digits: string): number[] {
  return [...digits].map((d) => parseInt(d, 10) || 0);
}

export function parseTargetFramework(tfm: string): ParsedTargetFramework {
  const lower = tfm.trim().toLowerCase();
  const dash = lower.indexOf('-');
  const base = dash >= 0 ? lower.slice(0, dash) : lower;
  const platform = dash >= 0 ? lower.slice(dash + 1) : '';

  const standard = /^netstandard([\d.]+)$/.exec(base);
  if (standard) return { family: FAMILY_STANDARD, version: dottedVersion(standard[1]), platform, raw: tfm };

  const core = /^netcoreapp([\d.]+)$/.exec(base);
  if (core) return { family: FAMILY_CORE, version: dottedVersion(core[1]), platform, raw: tfm };

  // A dot is what separates `net8.0` (.NET 8) from `net80` — which does not
  // exist, but `net48` does and means something entirely different.
  const dotted = /^net(\d+)\.(\d+)$/.exec(base);
  if (dotted) {
    const major = parseInt(dotted[1], 10);
    return {
      family: major >= 5 ? FAMILY_MODERN : FAMILY_FRAMEWORK,
      version: [major, parseInt(dotted[2], 10)],
      platform,
      raw: tfm,
    };
  }

  const packed = /^net(\d{2,})$/.exec(base);
  if (packed) return { family: FAMILY_FRAMEWORK, version: packedVersion(packed[1]), platform, raw: tfm };

  return { family: FAMILY_OTHER, version: [], platform, raw: tfm };
}

/** Descending: the later component wins, a missing one counts as 0 (`net8.0` and `net8.0.0` are equal). */
function compareVersionsDesc(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Newest first. A platform-specific moniker follows the plain one of the same version (`net8.0` before `net8.0-windows`). */
export function compareTargetFrameworks(a: string, b: string): number {
  const pa = parseTargetFramework(a);
  const pb = parseTargetFramework(b);

  if (pa.family !== pb.family) return pa.family - pb.family;

  const byVersion = compareVersionsDesc(pa.version, pb.version);
  if (byVersion !== 0) return byVersion;

  if (pa.platform !== pb.platform) {
    if (!pa.platform) return -1;
    if (!pb.platform) return 1;
    return pa.platform < pb.platform ? -1 : 1;
  }

  const ra = pa.raw.toLowerCase();
  const rb = pb.raw.toLowerCase();
  return ra < rb ? -1 : ra > rb ? 1 : 0;
}

export function sortTargetFrameworksDesc(frameworks: string[]): string[] {
  return [...frameworks].sort(compareTargetFrameworks);
}
