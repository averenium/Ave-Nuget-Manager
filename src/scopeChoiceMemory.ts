import { pathsEqual } from './pathCompare';
import type { KeyValueStore } from './nugetSourceCapabilities';
import type { ScopeChoices } from './types';

export type RememberedScopeChoice =
  | { kind: 'file'; path: string }
  | { kind: 'folder' };

export interface ScopeChoiceMemory {
  get(folderPath: string): RememberedScopeChoice | undefined;
  set(folderPath: string, choice: RememberedScopeChoice): Thenable<void> | Promise<void>;
}

const STORAGE_KEY = 'averenium.nugetManager.folderScopeChoice';

/**
 * Remembers, per folder, which solution/project/"all projects" the reader
 * picked the last time that folder was ambiguous (#113 item 4), so the
 * in-panel chooser can be skipped and the choice restored silently next time.
 *
 * Workspace state rather than global: what a folder resolves to is a
 * property of this workspace, and a machine-wide table would carry choices
 * made in an unrelated project into one that only happens to share a path.
 */
export function scopeChoiceMemory(state: KeyValueStore): ScopeChoiceMemory {
  return {
    get: (folderPath) => {
      const all = state.get<Record<string, RememberedScopeChoice>>(STORAGE_KEY, {});
      return all[folderPath];
    },
    set: (folderPath, choice) => {
      const all = state.get<Record<string, RememberedScopeChoice>>(STORAGE_KEY, {});
      return state.update(STORAGE_KEY, { ...all, [folderPath]: choice });
    },
  };
}

/**
 * The remembered choice, only when it still applies to what is actually
 * there now — a solution or project that was deleted, or a folder that
 * dropped to a single project, is not silently restored; the chooser asks
 * again instead of resolving to something that no longer exists.
 */
export function resolveRememberedChoice(
  remembered: RememberedScopeChoice,
  choices: ScopeChoices,
): RememberedScopeChoice | undefined {
  if (remembered.kind === 'folder') {
    return choices.offerAllProjects ? remembered : undefined;
  }
  const stillThere =
    choices.solutions.some((s) => pathsEqual(s.path, remembered.path)) ||
    choices.projects.some((p) => pathsEqual(p.path, remembered.path));
  return stillThere ? remembered : undefined;
}
