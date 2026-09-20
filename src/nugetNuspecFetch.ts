/**
 * The licence of a version nobody has installed (#89).
 *
 * A version bump can move a package from one licence to another, and nothing
 * in the toolchain says so: restore succeeds, `--outdated` is silent, and the
 * manifest diff shows a version number. The measured example is
 * `SixLabors.ImageSharp`, which states `Apache-2.0` through 2.x and carries a
 * split licence — commercial for a range of uses — from 3.x.
 *
 * Almost always the metadata resource settles it, since it states
 * `licenseExpression` per version and the catalog already carries that. This
 * module exists for the one case it cannot answer: an **empty** expression,
 * which means either a licence bundled as a file or a package old enough to
 * predate the `<license>` element entirely. Measured on the public feed, the
 * registration leaf has no `licenseFile` key at all, so the only thing that
 * tells those two apart is the package's own `.nuspec` — one kilobyte, from
 * the content resource, fetched only when a user actually selects such a
 * version.
 *
 * The address comes from the source's own service index, never constructed
 * against a well-known host: a package resolved from a private feed is asked
 * of that feed.
 */

import { parseNuspec, type NuspecMetadata } from './nuspecParser';
import type {
  HttpFetcher,
  ProbeTarget,
  SourceCapabilityStore,
} from './nugetSourceCapabilities';
import type { PackageLicense } from './types';

/**
 * Ids and versions are lowercased in every predictable path of the protocol,
 * and the version is the *normalised* one — build metadata (`1.0.0+sha.abc`)
 * is not part of a package's identity to NuGet and never appears in the
 * address, so leaving it on asks for a version the feed does not have.
 */
function flatPath(packageId: string, version: string): string {
  const id = packageId.trim().toLowerCase();
  const normalised = version.trim().split('+')[0].toLowerCase();
  return `${id}/${normalised}/${id}.nuspec`;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export class NuspecReader {
  /**
   * One answer per address for the session: a published version never
   * changes. Holds the whole parsed nuspec rather than only the licence, so a
   * release-notes lookup and a licence lookup for the same version (#125)
   * share the one fetch instead of each paying for their own.
   */
  private readonly _held = new Map<string, NuspecMetadata | undefined>();

  constructor(
    private readonly _capabilities: SourceCapabilityStore,
    private readonly _fetch: HttpFetcher,
  ) {}

  /**
   * The parsed nuspec of one version, or `undefined` when it cannot be read —
   * no content resource, no such package, a body that is not a nuspec.
   */
  async metadata(
    target: ProbeTarget,
    packageId: string,
    version: string,
    signal?: AbortSignal,
  ): Promise<NuspecMetadata | undefined> {
    if (!packageId.trim() || !version.trim()) return undefined;
    await this._capabilities.ensure(target, signal);

    for (const base of this._capabilities.resourceUrls(target.url, 'PackageBaseAddress')) {
      const url = joinUrl(base, flatPath(packageId, version));
      if (this._held.has(url)) return this._held.get(url);

      let response;
      try {
        response = await this._fetch(url, signal, undefined, { wantText: true });
      } catch {
        // A dropped connection says nothing about the package; another address
        // may still answer, and a later selection may try again.
        continue;
      }
      if (response.status !== 200 || !response.text) continue;

      const parsed = parseNuspec(response.text);
      this._held.set(url, parsed);
      return parsed;
    }
    return undefined;
  }

  /**
   * The `<license>` element of one version (#89).
   *
   * `undefined` is deliberately indistinguishable from "declares no licence":
   * both mean this layer has nothing to state, and the comparison above treats
   * an unknown licence as a reason to stay quiet rather than to guess.
   */
  async license(
    target: ProbeTarget,
    packageId: string,
    version: string,
    signal?: AbortSignal,
  ): Promise<PackageLicense | undefined> {
    return (await this.metadata(target, packageId, version, signal))?.license;
  }

  /** Drops what is held — used when the configuration changes under us. */
  clear(): void {
    this._held.clear();
  }
}
