import { fileName } from './pathUtils';
import type { WorkspaceScope } from '../../types';

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
