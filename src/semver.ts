/**
 * Compare two SemVer strings. Returns:
 *  > 0 if a > b (a is newer)
 *  = 0 if equal
 *  < 0 if a < b (a is older)
 */
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
