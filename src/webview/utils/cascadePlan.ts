import type { BatchUpdateItem } from '../../types';
import type { CascadeAction, WebviewMessage } from '../../messages';
import type { CascadeMode } from '../../cascadeResult';
import { packageIdsEqual } from '../../pathCompare';

/** The batch a `batch` plan sends: one change, so the host writes it together and restores once. */
export function batchMessageFor(
  items: BatchUpdateItem[],
  includePrerelease: boolean,
): Extract<WebviewMessage, { type: 'UPDATE_PACKAGES_BATCH' }> {
  // The bump and what has to move with it disagree until all of it is in: a
  // restore between them would refuse the first for a package that has not moved.
  return { type: 'UPDATE_PACKAGES_BATCH', kind: 'other', includePrerelease, items, together: true };
}

export interface CascadeMove {
  packageId: string;
  fromVersion: string;
  toVersion: string;
  /**
   * Under a central version, the project a write for this package goes through:
   * one that references it directly. `dotnet add` on a project that does not
   * would add the reference there. Absent for an ordinary, single-project closure.
   */
  writeIn?: string;
}

export type CascadePlan =
  /** Nothing is written; a held write is dropped. */
  | { kind: 'drop' }
  /** The write that was held goes ahead as it was asked for — nothing else has to move. */
  | { kind: 'proceed' }
  /** One batch for the project: the bump and the dependents proposed with it. */
  | { kind: 'batch'; items: BatchUpdateItem[] }
  | { kind: 'block'; packageId: string };

export interface CascadePlanInput {
  action: CascadeAction | 'close';
  mode: CascadeMode;
  packageId: string;
  projectPath: string;
  moves: CascadeMove[];
  /** The framework the held write is confined to, for a reference pinned per framework (#82). */
  confineFramework?: string;
}

/**
 * What a decision on the dependents proposal does (#109). Kept apart from the
 * layer that carries it out so the rules are stated — and tested — once.
 *
 * **Update only this package** declines the proposal and writes the bump alone.
 * **Update anyway** goes ahead with what was established: the bump with the
 * dependents that were, and the bump alone when nothing was. Neither writes a
 * dependent that could not be judged.
 *
 * When what is left is only the bump and a write is waiting, the waiting write
 * itself goes ahead exactly as it was asked for, so what it carried (a framework
 * confinement, a confirmation already given) survives. Asked for on a row there
 * is no such write, and the bump is sent as a batch of one.
 */
export function planFor(input: CascadePlanInput): CascadePlan {
  const batchOf = (moves: CascadeMove[]): CascadePlan => ({
    kind: 'batch',
    items: moves.map((m) => ({
      packageId: m.packageId,
      fromVersion: m.fromVersion,
      toVersion: m.toVersion,
      projects: [m.writeIn ?? input.projectPath],
      framework: packageIdsEqual(m.packageId, input.packageId) ? input.confineFramework : undefined,
    })),
  });
  const bump = input.moves.find((m) => packageIdsEqual(m.packageId, input.packageId));
  const bumpAlone = (): CascadePlan => {
    if (input.mode === 'apply') return { kind: 'proceed' };
    return bump ? batchOf([bump]) : { kind: 'drop' };
  };

  switch (input.action) {
    case 'cancel':
    case 'close':
      return { kind: 'drop' };
    case 'block':
      return { kind: 'block', packageId: input.packageId };
    case 'update-only':
      return bumpAlone();
    case 'never-offer':
      // Chosen from inside a popup or page that is holding a write: the update
      // goes ahead as asked, the bump alone. Asked on a row nothing is waiting,
      // and the control is not drawn there.
      return input.mode === 'apply' ? { kind: 'proceed' } : { kind: 'drop' };
    case 'update-anyway':
      return input.moves.length <= 1 ? bumpAlone() : batchOf(input.moves);
    case 'take-all':
      if (input.mode === 'apply' && input.moves.length <= 1) return { kind: 'proceed' };
      return input.moves.length === 0 ? { kind: 'drop' } : batchOf(input.moves);
  }
}
