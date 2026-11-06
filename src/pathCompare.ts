/**
 * Path / package-id comparison that works in both the extension host and the
 * webview (no Node `path` module).
 *
 * Windows `dotnet list` often reports `D:\src\App.csproj` while the .sln parser
 * yields `d:/src/App.csproj` — strict `===` then fails in the detail panel.
 */

export function normalizeFsPath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function pathsEqual(a: string, b: string): boolean {
  if (a === b) return true;
  const na = normalizeFsPath(a);
  const nb = normalizeFsPath(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Relative vs absolute (dotnet sometimes reports a path relative to the .sln)
  return na.endsWith('/' + nb) || nb.endsWith('/' + na);
}

export function packageIdsEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The key to file a package under in a `Map` or `Set`, so that two ids
 * `packageIdsEqual` calls equal land on one entry. Use this instead of
 * lower-casing an id in place: it keeps the definition of "the same id" in
 * this file (#109).
 */
export function packageIdKey(id: string): string {
  return id.toLowerCase();
}
