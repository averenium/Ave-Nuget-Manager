import type { DeclaredDependencyGroup } from '../../types';
import { frameworkKey, frameworkLabel } from '../../frameworkMoniker';
import { sortTargetFrameworksDesc } from '../../targetFrameworks';

export { defaultGroupFor } from '../../frameworkCompatibility';

/**
 * The decisions behind the declared-dependencies section (#114), kept out of the
 * component so they can be tested: the repository has no React harness, and
 * these are where the section can be wrong.
 */

/**
 * Everything the picker can offer: the frameworks the feed named, in the order
 * the badges elsewhere use, plus the group that names none where there is one.
 *
 * The catch-all belongs in the list because it can be the default, and a default
 * nobody can choose again is a trap — moving off it would be one-way.
 *
 * Labels keep the feed's own spelling for a moniker with no short form, so a
 * badge reads as something that exists: `.NETPortable0.0-Profile259` is a real
 * thing to write and `.netportable0.0-profile259` is not.
 */
export function declaredOptions(
  groups: DeclaredDependencyGroup[],
): Array<{ key: string; label: string }> {
  const labels = new Map<string, string>();
  for (const group of groups) {
    const key = frameworkKey(group.targetFramework);
    if (key && !labels.has(key)) labels.set(key, frameworkLabel(group.targetFramework));
  }
  const named = sortTargetFrameworksDesc([...labels.keys()])
    .map((key) => ({ key, label: labels.get(key) ?? key }));
  return groups.some((g) => !frameworkKey(g.targetFramework))
    ? [...named, { key: '', label: 'any framework' }]
    : named;
}
