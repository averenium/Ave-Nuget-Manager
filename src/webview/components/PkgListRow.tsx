import React from 'react';

interface Props {
  name: string;
  nameTitle?: string;
  aside?: React.ReactNode;
  selected?: boolean;
  muted?: boolean;
  hasUpdate?: boolean;
  hasVulnerability?: boolean;
  vulnerabilityVia?: boolean;
  vulnerabilityTitle?: string;
  className?: string;
  onActivate?: () => void;
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
  hasVulnerability,
  vulnerabilityVia,
  vulnerabilityTitle,
  className,
  onActivate,
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
          {hasUpdate ? <span className="pkg-row__mark pkg-row__mark--update" aria-hidden="true">↑</span> : null}
          {hasVulnerability ? (
            <span
              className={`pkg-row__mark ${vulnerabilityVia ? 'pkg-row__mark--vuln-via' : 'pkg-row__mark--vuln'}`}
              title={vulnerabilityTitle}
            >⚠</span>
          ) : null}
        </span>
        {aside}
      </div>
      {children}
    </div>
  );
}
