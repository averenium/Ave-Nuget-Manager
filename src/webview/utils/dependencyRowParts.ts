import type { DependencyRow } from '../../types';

/**
 * What a row of the Dependencies section shows, apart from its id (#86, #137).
 * Two annotations, deliberately different weights: a range with a ceiling that
 * the resolved version violates is red on the version itself (NuGet already
 * reports this as NU1608); a bare-minimum floor whose major was lifted is a
 * quiet hint beside the version, never on the version itself.
 *
 * `showDeclared` decides whether the range is worth the space, not the status:
 * a range with a ceiling is a real constraint and is shown even when the
 * resolved version sits inside it, while a bare floor that was simply met is
 * noise. "asked X" already carries the range, so it replaces the plain form.
 */
export interface DependencyRowParts {
  /** "asked [2.0.0, )" — only for a major-lifted row, in place of the range. */
  hint?: string;
  /** The warning glyph before the range, for a resolved version outside it. */
  warning: boolean;
  range?: string;
  version: string;
  versionBad: boolean;
}

export function dependencyRowParts(row: DependencyRow): DependencyRowParts {
  const liftedMajor = row.status === 'major-lifted';
  const outside = row.status === 'outside-range';
  return {
    hint: liftedMajor ? `asked ${row.declaredRange}` : undefined,
    warning: !liftedMajor && outside,
    range: !liftedMajor && row.showDeclared ? row.declaredRange : undefined,
    version: row.resolvedVersion ?? '—',
    versionBad: outside,
  };
}
