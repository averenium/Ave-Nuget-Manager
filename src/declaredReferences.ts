import { maskXmlComments } from './xmlComments';
import { packageIdKey, packageIdsEqual } from './pathCompare';

/**
 * A `<PackageReference>` a project file declares (#138). The restore graph says
 * what resolved; this says what was asked for, which is the only way to tell a
 * reference that never made it into the graph from one that was never there.
 */
export interface DeclaredReference {
  id: string;
  /** What the project file states, else what `Directory.Packages.props` does under central management, else `''`. */
  version: string;
  /**
   * The reference, or the group it sits in, has a `Condition`. Whether it
   * applies depends on properties this does not evaluate, so its absence from the
   * restore graph proves nothing.
   */
  conditional: boolean;
}

function attribute(attributes: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attributes);
  return m ? (m[1] ?? m[2]) : undefined;
}

function childValue(body: string | undefined, name: string): string | undefined {
  if (!body) return undefined;
  const m = new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`, 'i').exec(body);
  return m?.[1];
}

/** `<PackageVersion Include="X" Version="1.0.0" />` of a `Directory.Packages.props`, by id key. */
export function centralVersions(propsXml: string): Map<string, string> {
  const versions = new Map<string, string>();
  const masked = maskXmlComments(propsXml);
  for (const m of masked.matchAll(/<PackageVersion\b([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageVersion>)/gi)) {
    const id = attribute(m[1], 'Include');
    const version = attribute(m[1], 'Version') ?? childValue(m[2], 'Version');
    if (id && version) versions.set(packageIdKey(id), version);
  }
  return versions;
}

/**
 * The direct references of a project file, once each, in the order declared.
 *
 * Only `Include` declares a reference: an `Update` item changes one that exists,
 * and an id written as an MSBuild property (`$(Name)`) cannot be named without
 * evaluating the project. Comments are masked first, so a reference quoted in
 * prose is not one.
 */
export function declaredReferences(projectXml: string, propsXml?: string): DeclaredReference[] {
  const central = propsXml ? centralVersions(propsXml) : new Map<string, string>();
  const masked = maskXmlComments(projectXml);
  const out: DeclaredReference[] = [];
  for (const group of masked.matchAll(/<ItemGroup\b([^>]*)>([\s\S]*?)<\/ItemGroup>/gi)) {
    const groupConditional = /\bCondition\s*=/i.test(group[1]);
    for (const ref of group[2].matchAll(/<PackageReference\b([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageReference>)/gi)) {
      const attributes = ref[1];
      const id = attribute(attributes, 'Include');
      if (!id || id.includes('$(')) continue;
      if (out.some((o) => packageIdsEqual(o.id, id))) continue;
      const version = attribute(attributes, 'Version')
        ?? childValue(ref[2], 'Version')
        ?? attribute(attributes, 'VersionOverride')
        ?? childValue(ref[2], 'VersionOverride')
        ?? central.get(packageIdKey(id))
        ?? '';
      out.push({ id, version, conditional: groupConditional || /\bCondition\s*=/i.test(attributes) });
    }
  }
  return out;
}
