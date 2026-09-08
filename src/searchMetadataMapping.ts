import type { PackageMetadata, SearchedVersionMetadata } from './types';

/**
 * `dotnet package search` (even with `--verbosity detailed`) never returns
 * authors/license-as-expression/tags/dependencies for a package — the
 * fields Part 2 (#86) exists precisely because search can't produce them.
 * Shared by `CliBackend.getMetadata` (fresh call) and
 * `WebviewMessageBroker`'s cache-hit path (from `enrichPackage`'s already-run
 * detailed search) so both build the same shape from the same source data.
 */
export function searchedMetadataToPackageMetadata(
  packageId: string,
  version: string,
  m: SearchedVersionMetadata,
): PackageMetadata {
  return {
    id: packageId,
    version,
    authors: m.authors ?? '',
    projectUrl: m.projectUrl,
    licenseUrl: m.licenseUrl,
    description: m.description ?? '',
    tags: m.tags ? m.tags.split(/[\s,]+/).filter(Boolean) : [],
    deprecation: m.deprecation,
  };
}
