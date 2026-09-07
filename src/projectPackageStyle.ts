import * as fs from 'fs/promises';
import * as path from 'path';
import { maskXmlComments } from './xmlComments';

export type ProjectPackageStyle = 'sdk' | 'legacy-packageref' | 'packages-config';

export const PACKAGES_CONFIG_SKIP =
  'packages.config is not supported. Convert to PackageReference or use nuget.exe.';

/**
 * True when the root `<Project>` (or an `<Sdk>` element) is SDK-style.
 * Matches against a comment-masked copy (#85) — e.g. a legacy project whose
 * only `Sdk=` mention is inside a "migrated from Sdk=..." comment must not
 * be misclassified as SDK-style, which would route package operations
 * through `dotnet add` instead of the XML-edit path this project needs.
 */
export function isSdkStyleProject(xml: string): boolean {
  const masked = maskXmlComments(xml);
  if (/<\s*Project\b[^>]*\bSdk\s*=/i.test(masked)) return true;
  if (/<\s*Sdk\b[^>]*\bName\s*=/i.test(masked)) return true;
  return false;
}

/**
 * SDK (`Sdk=`) stays on `dotnet add`.
 * PackageReference in a non-SDK file uses the XML path, even if `packages.config`
 * is still on disk (incomplete migration).
 * Skip only when there are no PackageReference nodes and `packages.config` exists.
 * Empty XML or a fragment without `<Project` falls back to SDK so callers keep the CLI path.
 */
export function detectProjectPackageStyle(
  projectXml: string,
  packagesConfigExists: boolean,
): ProjectPackageStyle {
  if (!projectXml.trim() || !/<\s*Project\b/i.test(maskXmlComments(projectXml))) return 'sdk';
  if (isSdkStyleProject(projectXml)) return 'sdk';
  if (hasPackageReference(projectXml)) return 'legacy-packageref';
  if (packagesConfigExists) return 'packages-config';
  return 'legacy-packageref';
}

/** Matches against a comment-masked copy (#85) — see {@link isSdkStyleProject}. */
export function hasPackageReference(xml: string): boolean {
  return /<PackageReference\b/i.test(maskXmlComments(xml));
}

export async function packagesConfigExists(projectPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(path.dirname(projectPath), 'packages.config'));
    return true;
  } catch {
    return false;
  }
}
