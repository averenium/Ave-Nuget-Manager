import { compareSemVer } from './semver';

/** Bundled Roslyn next to the SDK that `dotnet --version` selected. */
export interface RoslynCap {
  sdkVersion: string;
  /** Numeric SemVer from `csc -version` (e.g. `5.6.0`). */
  compilerVersion: string;
}

export interface SdkListEntry {
  version: string;
  directory: string;
}

const CODE_ANALYSIS_PREFIX = 'microsoft.codeanalysis';

export function isCodeAnalysisPackage(packageId: string): boolean {
  return packageId.toLowerCase().startsWith(CODE_ANALYSIS_PREFIX);
}

export function isCodeAnalysisFamily(family: string): boolean {
  return family.toLowerCase() === 'microsoft.codeanalysis';
}

/** First `major.minor.patch` in `csc -version` output. */
export function parseCscNumericVersion(text: string): string | undefined {
  const m = text.match(/(\d+\.\d+\.\d+)/);
  return m?.[1];
}

export function parseDotnetVersion(stdout: string): string {
  return stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
}

/** Lines like `10.0.301 [C:\Program Files\dotnet\sdk]`. */
export function parseListSdks(stdout: string): SdkListEntry[] {
  const entries: SdkListEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.trim().match(/^(\S+)\s+\[(.+)\]\s*$/);
    if (!m) continue;
    entries.push({ version: m[1], directory: m[2].trim() });
  }
  return entries;
}

export function maxVersionAtOrBelow(versions: string[], cap: string): string | undefined {
  const allowed = versions.filter((v) => v && compareSemVer(v, cap) <= 0);
  if (allowed.length === 0) return undefined;
  return [...allowed].sort((a, b) => compareSemVer(b, a))[0];
}

export function versionsAtOrBelow(versions: string[], cap: string): string[] {
  return versions.filter((v) => v && compareSemVer(v, cap) <= 0);
}

/**
 * Groups target for one id. CodeAnalysis never uses nuget.org latest when a
 * probe result is present. `null` (csc failed) → omit. `undefined` → no policy.
 */
export function groupsTargetVersion(
  packageId: string,
  latestVersion: string | undefined,
  versions: string[] | undefined,
  cap: RoslynCap | null | undefined,
): string | undefined {
  if (!isCodeAnalysisPackage(packageId)) return latestVersion;
  if (cap === undefined) return latestVersion;
  if (cap === null) return undefined;
  return maxVersionAtOrBelow(versions ?? [], cap.compilerVersion);
}

/** Upgrade already installed to a version newer than the SDK compiler. */
export function needsRoslynUpgradeConfirm(opts: {
  packageId: string;
  chosenVersion: string;
  installedVersions: string[];
  cap: RoslynCap | null | undefined;
}): boolean {
  const { packageId, chosenVersion, installedVersions, cap } = opts;
  if (!isCodeAnalysisPackage(packageId) || !cap || !chosenVersion) return false;
  if (installedVersions.length === 0) return false;
  const isUpgrade = installedVersions.some((v) => compareSemVer(chosenVersion, v) > 0);
  if (!isUpgrade) return false;
  return compareSemVer(chosenVersion, cap.compilerVersion) > 0;
}

export function isOverRoslynCap(
  packageId: string,
  version: string,
  cap: RoslynCap | null | undefined,
): boolean {
  if (!isCodeAnalysisPackage(packageId)) return false;
  if (cap === undefined) return false;
  if (cap === null) return true;
  return compareSemVer(version, cap.compilerVersion) > 0;
}

export function withoutOverRoslynCap<T extends { packageId: string; toVersion: string }>(
  items: T[],
  cap: RoslynCap | null | undefined,
): T[] {
  return items.filter((i) => !isOverRoslynCap(i.packageId, i.toVersion, cap));
}

export function roslynCapRejectMessage(
  items: Array<{ packageId: string; toVersion: string }>,
  cap: RoslynCap | null | undefined,
): string {
  const first = items.find((i) => isOverRoslynCap(i.packageId, i.toVersion, cap));
  if (!first) return 'Microsoft.CodeAnalysis.* cannot be group-updated until the SDK compiler version is known.';
  if (!cap) {
    return `${first.packageId}: group update skipped — SDK compiler version is unknown (csc -version failed).`;
  }
  return `${first.packageId} ${first.toVersion} is newer than the compiler in SDK ${cap.sdkVersion} (${cap.compilerVersion}). Update the .NET SDK before a group update.`;
}
