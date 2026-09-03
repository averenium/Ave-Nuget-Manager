import React from 'react';
import { BLOCKED_UPDATES_TOOLTIP } from '../../blockedPackages';
import { IconMarkUp, IconMarkSlash, IconMarkWarning } from '../utils/icons';

interface Props {
  name: string;
  nameTitle?: string;
  aside?: React.ReactNode;
  selected?: boolean;
  muted?: boolean;
  hasUpdate?: boolean;
  blocked?: boolean;
  hasVulnerability?: boolean;
  vulnerabilityVia?: boolean;
  vulnerabilityTitle?: string;
  hasNoMappingSource?: boolean;
  unmappedTitle?: string;
  className?: string;
  onActivate?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  children?: React.ReactNode;
}

/** Shared list row chrome for Packages and Updates. */
export function PkgListRow({
  name,
  nameTitle,
  aside,
  selected,
  muted,
  hasUpdate,
  blocked,
  hasVulnerability,
  vulnerabilityVia,
  vulnerabilityTitle,
  hasNoMappingSource,
  unmappedTitle,
  className,
  onActivate,
  onContextMenu,
  children,
}: Props) {
  const interactive = !!onActivate;
  return (
    <div
      className={[
        'pkg-row',
        selected ? 'pkg-row--selected' : '',
        muted ? 'pkg-row--muted' : '',
        interactive ? '' : 'pkg-row--static',
        hasUpdate ? 'pkg-row--has-update' : '',
        hasVulnerability ? 'pkg-row--vulnerable' : '',
        className ?? '',
      ].filter(Boolean).join(' ')}
      role={interactive ? 'option' : undefined}
      aria-selected={interactive ? (selected ?? false) : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onActivate}
      onContextMenu={onContextMenu
        ? (e) => {
            e.preventDefault();
            e.stopPropagation();
            onContextMenu(e);
          }
        : undefined}
      onKeyDown={interactive
        ? (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onActivate();
            }
          }
        : undefined}
    >
      <div className="pkg-row__title">
        <span className="pkg-row__name" title={nameTitle ?? name}>
          {name}
          {hasUpdate ? (
            <span className="pkg-row__mark pkg-row__mark--update" aria-hidden="true"><IconMarkUp /></span>
          ) : null}
          {blocked ? (
            <span className="pkg-row__mark pkg-row__mark--blocked" title={BLOCKED_UPDATES_TOOLTIP}>
              <IconMarkSlash />
            </span>
          ) : null}
          {hasVulnerability ? (
            <span
              className={`pkg-row__mark ${vulnerabilityVia ? 'pkg-row__mark--vuln-via' : 'pkg-row__mark--vuln'}`}
              title={vulnerabilityTitle}
            ><IconMarkWarning /></span>
          ) : null}
          {hasNoMappingSource ? (
            <span className="pkg-row__mark pkg-row__mark--unmapped" title={unmappedTitle}>
              <IconMarkSlash />
            </span>
          ) : null}
        </span>
        {aside}
      </div>
      {children}
    </div>
  );
}
