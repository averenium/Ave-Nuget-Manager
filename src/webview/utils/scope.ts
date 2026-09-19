import { fileName } from './pathUtils';
import type { WorkspaceScope } from '../../types';

/** Mirrors `AppState['activeTab']` — kept local so this pure module never has to import the `.tsx` context file that owns it. */
type TabId = 'packages' | 'sources' | 'updates' | 'log' | 'agents';

export function scopeLabel(scope: WorkspaceScope | null): string {
  if (!scope) return '';
  if (scope.kind === 'solution') return fileName(scope.solutionPath);
  if (scope.kind === 'folder') return fileName(scope.folderPath);
  if (scope.kind === 'project' && scope.projectPath) return fileName(scope.projectPath);
  return '';
}

export function scopeIcon(scope: WorkspaceScope | null): string {
  if (scope?.kind === 'solution') return '📦';
  if (scope?.kind === 'folder') return '🗂️';
  return '📄';
}

/** Absolute path identifying a scope — matches the host's own `scopeIdentityPath`. */
export function scopeIdentityPath(scope: WorkspaceScope | null): string | null {
  if (!scope) return null;
  if (scope.kind === 'solution') return scope.solutionPath;
  if (scope.kind === 'folder') return scope.folderPath;
  return scope.projectPath || null;
}

export interface ScopeChooserRenderState {
  /** Whether the chooser should show at all, on whichever tab is active (#129). */
  visible: boolean;
  /**
   * Whether it was reached by an explicit press of the corner control, rather
   * than showing up unprompted because the folder is still ambiguous — a
   * pressed-open chooser is always closable, back to wherever it was opened
   * from, an ambiguous folder included (#129). Also narrows the columns.
   */
  tight: boolean;
  /**
   * Whether the dimmed package list belongs behind it (#113). Only the
   * Packages tab has one; reopened from elsewhere there is nothing of that
   * shape to peek at, so that tab's own content simply steps aside (#129).
   */
  showBackdrop: boolean;
  /** Whether there is a current scope to mark and to offer keeping. */
  showCurrent: boolean;
}

/**
 * What the corner scope control should show, independent of which tab it was
 * pressed from — the chooser used to be reachable only through `PackagesTab`,
 * so pressing the control anywhere else opened nothing (#129).
 *
 * Unprompted — the folder is still ambiguous and nothing has picked it yet —
 * the chooser is the Packages tab's own body, exactly as the mockup draws it:
 * the toolbar stays, only the package list is replaced (#113). It does not
 * take over any other tab just because the workspace happens to be
 * ambiguous; a reader who lands on Log or Sources first still sees that
 * tab's own content. Once the corner control is actually pressed, though,
 * the chooser has to show wherever that press happened, scope pinned or not.
 */
export function scopeChooserRenderState(
  scope: WorkspaceScope | null,
  hasScopeChoices: boolean,
  scopeChooserOpen: boolean,
  activeTab: TabId,
): ScopeChooserRenderState {
  const ambientOnPackages = activeTab === 'packages' && scope === null;
  const visible = hasScopeChoices && (scopeChooserOpen || ambientOnPackages);
  const tight = visible && scopeChooserOpen;
  const showBackdrop = tight && activeTab === 'packages';
  const showCurrent = scope !== null;
  return { visible, tight, showBackdrop, showCurrent };
}
