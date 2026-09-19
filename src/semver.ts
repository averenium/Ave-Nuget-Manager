/**
 * Compare two SemVer strings. Returns:
 *  > 0 if a > b (a is newer)
 *  = 0 if equal
 *  < 0 if a < b (a is older)
 */
/**
 * Whether two version strings name the same version.
 *
 * String identity is not enough: the same version is written `1.0` in a project
 * file and `1.0.0` by a feed, and build metadata (`1.2.3+build.7`) is part of
 * the string but never part of the identity — the flat container even strips it
 * while registration keeps it. Comparing the parsed forms is what makes a
 * version from one source match the same version from another.
 */
export function versionsEqual(a: string, b: string): boolean {
  const strip = (v: string): string => v.trim().split('+')[0];
  return compareSemVer(strip(a), strip(b)) === 0;
}

/** Whether a version string carries a pre-release label (`-preview`, `-rc.1`, …). */
export function isPrerelease(version: string): boolean {
  return version.includes('-');
}

export function compareSemVer(a: string, b: string): number {
  const pa = parseSemVer(a);
  const pb = parseSemVer(b);
  for (let i = 0; i < 4; i++) {
    const diff = (pa[i] as number) - (pb[i] as number);
    if (diff !== 0) return diff;
  }
  // Pre-release: no suffix (stable) > has suffix (pre-release)
  if (pa[4] === pb[4]) return 0;
  if (pa[4] === '') return 1;
  if (pb[4] === '') return -1;
  return pa[4] < pb[4] ? -1 : 1;
}

function parseSemVer(v: string): [number, number, number, number, string] {
  const m = v.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:[.\-](.*))?$/);
  if (!m) return [0, 0, 0, 0, v];
  return [
    parseInt(m[1] ?? '0', 10),
    parseInt(m[2] ?? '0', 10),
    parseInt(m[3] ?? '0', 10),
    parseInt(m[4] ?? '0', 10),
    m[5] ?? '',
  ];
}
