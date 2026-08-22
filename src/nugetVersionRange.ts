/**
 * NuGet version range (`VersionRange`) used by VulnerabilityInfo pages.
 * https://learn.microsoft.com/en-us/nuget/concepts/package-versioning#version-ranges
 */
import { compareSemVer } from './semver';

export interface NuGetVersionRange {
  min?: string;
  minInclusive: boolean;
  max?: string;
  maxInclusive: boolean;
}

export function parseNuGetVersionRange(raw: string): NuGetVersionRange | undefined {
  const s = raw.trim();
  if (!s) return undefined;

  const bracket = s.match(/^([\[\(])\s*([^,]*?)\s*,\s*([^\]\)]*?)\s*([\]\)])$/);
  if (bracket) {
    const min = bracket[2].trim();
    const max = bracket[3].trim();
    return {
      min: min || undefined,
      minInclusive: bracket[1] === '[',
      max: max || undefined,
      maxInclusive: bracket[4] === ']',
    };
  }

  if (/^[\[\(]/.test(s) || /[\]\)]$/.test(s)) return undefined;
  return { min: s, minInclusive: true, max: s, maxInclusive: true };
}

export function versionInNuGetRange(version: string, rangeRaw: string): boolean {
  const range = parseNuGetVersionRange(rangeRaw);
  if (!range || !version.trim()) return false;
  if (range.min) {
    const cmp = compareSemVer(version, range.min);
    if (range.minInclusive ? cmp < 0 : cmp <= 0) return false;
  }
  if (range.max) {
    const cmp = compareSemVer(version, range.max);
    if (range.maxInclusive ? cmp > 0 : cmp >= 0) return false;
  }
  return true;
}
