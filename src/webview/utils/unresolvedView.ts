import type { InstalledPackage, UnresolvedReference } from '../../types';

/**
 * What a reference restore could not resolve says, as plain data (#138). The row
 * and the details panel draw from these, so the wording is decided — and tested —
 * once, and no file the webview bundles has to read the disk.
 */

/** The right-hand cell of an unresolved row: the restore code in words, or that restore has not run yet. */
export function unresolvedLabel(unresolved: UnresolvedReference): string {
  if (unresolved.notRestored) return 'not restored yet';
  switch (unresolved.code) {
    case 'NU1101': return 'not found';
    case 'NU1102': return 'no such version';
    default: return 'restore failed';
  }
}

/** Not an error, and says so: the reference is waiting for a restore, not broken. */
export const isNeutral = (unresolved: UnresolvedReference): boolean => unresolved.notRestored === true;

/** The line under the version row of a reference restore has not run on. */
export const NOT_RESTORED_NOTE = 'Declared in the project file; this project has not been restored since it was added.';

export interface RestoreBand {
  code: string;
  message: string;
  /** `· net8.0` — the frameworks it failed for, after the message. */
  frameworks: string;
}

/** The band under the version row for a reference restore failed on; `undefined` for one it has not run on. */
export function restoreBandFor(unresolved: UnresolvedReference | undefined): RestoreBand | undefined {
  if (!unresolved || unresolved.notRestored || !unresolved.message) return undefined;
  return {
    code: unresolved.code ?? '',
    message: unresolved.message,
    frameworks: unresolved.frameworks && unresolved.frameworks.length > 0 ? ` · ${unresolved.frameworks.join(', ')}` : '',
  };
}

/** The unresolved entry of any of a package's rows, for the panel: restore's answer is about the reference, whichever project holds it. */
export function unresolvedOf(entries: readonly InstalledPackage[]): UnresolvedReference | undefined {
  return entries.find((e) => e.unresolved)?.unresolved;
}
