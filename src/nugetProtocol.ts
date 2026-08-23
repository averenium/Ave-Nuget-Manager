/**
 * NuGet protocolVersion on a packageSources <add>.
 * Docs: current is "3"; defaults to "2" when the URL does not end in .json.
 */

export function effectiveProtocolVersion(
  url: string,
  explicit?: string,
): '2' | '3' | undefined {
  if (!/^https?:\/\//i.test(url.trim())) return undefined;
  if (explicit === '2' || explicit === '3') return explicit;
  const path = url.trim().split(/[?#]/)[0].toLowerCase().replace(/\/+$/, '');
  return path.endsWith('.json') ? '3' : '2';
}
