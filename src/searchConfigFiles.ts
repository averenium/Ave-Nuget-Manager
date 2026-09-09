/**
 * Which config files in the resolved chain are worth handing to
 * `dotnet package search` (#91). The search loop asks one config file at a
 * time, once per package, so a file that can never answer costs a process
 * launch for every package in every enrich cycle.
 *
 * A file with no enabled package sources is exactly that case, and it is
 * already knowable from the chain the resolver produced — no probe needed.
 * `Microsoft.VisualStudio.FallbackLocation.config` is the one that shows up on
 * a normal Windows install: it declares no sources at all, so every query
 * against it exits 1 with "No package sources found."
 *
 * Judging each file by its *own* enabled sources is what `--configfile` means:
 * that switch makes NuGet use only that file's settings, so a source disabled
 * in some other file of the chain has no bearing on this query, and one
 * declared here does answer even if a nearer file cleared it.
 */

import type { NuGetConfigFile } from './types';

export function searchableConfigFiles(chain: readonly NuGetConfigFile[]): string[] {
  return chain
    .filter((file) => file.sources.some((source) => source.enabled))
    .map((file) => file.filePath);
}
