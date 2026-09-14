/**
 * One key for the two ways a target framework is written (#114).
 *
 * A project states `net10.0`, `net472`, `netstandard2.0` — the short folder
 * moniker. A registration entry's dependency group states whichever form the
 * package was built with, and the long form (`.NETFramework4.7.2`,
 * `.NETStandard2.0`, `.NETCoreApp3.1`) is still everywhere in the catalog
 * because it is what older packages were published with. Comparing the two as
 * text says a package declares nothing for a framework it declares plenty for.
 *
 * This maps both to the short form and stops there. It is not a compatibility
 * check and must not become one: whether `netstandard2.0` satisfies a `net10.0`
 * project is a question for restore, which knows the fallback chains. All that
 * is decided here is whether two spellings name the same framework.
 */

/** `.NETFramework4.7.2` → `net472`, and everything already short is left alone. */
export function frameworkKey(tfm: string | undefined): string {
  const trimmed = (tfm ?? '').trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();

  // The long form as the catalog writes it: a family name, then a version, then
  // optionally a platform after a comma or a dash.
  const long = /^\.net(framework|standard|coreapp|portable|platform)?\s*([0-9][0-9.]*)?(.*)$/.exec(lower);
  if (long) {
    const [, family, version = '', rest] = long;
    const platform = platformSuffix(rest);
    switch (family) {
      case 'framework':
        // .NET Framework drops the dots: 4.7.2 is `net472`.
        return `net${version.replace(/\./g, '')}${platform}`;
      case 'standard':
        return `netstandard${version}${platform}`;
      case 'coreapp':
        // .NET 5 and later kept the `.NETCoreApp` family name and the short
        // moniker became `net5.0` — the version is what tells them apart.
        return major(version) >= 5 ? `net${version}${platform}` : `netcoreapp${version}${platform}`;
      default:
        return lower.replace(/\s+/g, '');
    }
  }
  return lower.replace(/\s+/g, '');
}

/** `,profile=client` / `-windows10.0.19041` → `-client` / `-windows10.0.19041`. */
function platformSuffix(rest: string): string {
  const dash = /^-([a-z0-9.]+)/.exec(rest);
  if (dash) return `-${dash[1]}`;
  const profile = /^,\s*profile=([a-z0-9.]+)/.exec(rest);
  return profile ? `-${profile[1]}` : '';
}

function major(version: string): number {
  const first = Number(version.split('.')[0]);
  return Number.isFinite(first) ? first : 0;
}

/** Whether two monikers name the same framework, however each is spelled. */
export function sameFramework(a: string | undefined, b: string | undefined): boolean {
  const left = frameworkKey(a);
  return !!left && left === frameworkKey(b);
}
