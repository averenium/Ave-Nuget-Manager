import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNugetManager } from '../context/NugetManagerContext';

export function AgentsTab() {
  const { state, send } = useNugetManager();
  const { bundledVersion, detected, installs } = state.agents;
  const updateExisting = installs.some((row) => row.outdated);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);

  const openInstallMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setMenu({ x: rect.right, y: rect.bottom + 4 });
  };

  return (
    <div className="agents-tab" role="region" aria-label="Agent skills">
      <article className="skill-card">
        <div className="skill-card__head">
          <h2 className="skill-card__title">
            <span className="skill-card__badge">SKILL</span>
            Dependency breaking-changes review
          </h2>
          {installs.length === 0 ? (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => send({ type: 'INSTALL_AGENT_SKILL' })}
            >
              Install…
            </button>
          ) : (
            <div className={`btn-split${updateExisting ? '' : ' btn-split--more-only'}`}>
              {updateExisting && (
                <button
                  type="button"
                  className="btn btn--primary btn-split__main"
                  onClick={() => send({ type: 'INSTALL_AGENT_SKILL', updateExisting: true })}
                >
                  Update
                </button>
              )}
              <button
                ref={moreRef}
                type="button"
                className="btn btn--primary btn-split__more"
                title="More"
                aria-label="More"
                aria-haspopup="menu"
                aria-expanded={menu !== null}
                onClick={(e) => {
                  if (menu) {
                    setMenu(null);
                    return;
                  }
                  openInstallMenu(e);
                }}
              >
                <KebabIcon />
              </button>
            </div>
          )}
        </div>
        <p className="skill-card__copy">
          Reviews NuGet bumps from official release notes and the restore graph
          (resolved packages, transitives, diamonds) — not an empty git diff.
          This panel copies skill files only; it does not run the agent.
        </p>
        <p className="skill-card__meta">Bundled version {bundledVersion}</p>
        {detected.length === 0 && (
          <p className="skill-card__hint">
            No Cursor, Claude, or Kiro folder or CLI was found. Install… can still
            copy into a skill directory or a Custom folder.
          </p>
        )}
        {installs.length === 0 ? (
          <p className="skill-card__status">Not installed</p>
        ) : (
          <ul className="skill-card__installs">
            {installs.map((row) => (
              <li key={row.destDir} className="skill-card__install">
                <div className="skill-card__install-head">
                  <strong>{row.label}</strong>
                  <span className="skill-card__ver">v{row.version}</span>
                  {row.outdated && (
                    <span className="skill-card__outdated">Update available</span>
                  )}
                </div>
                <div className="skill-card__path" title={row.destDir}>{row.destDir}</div>
              </li>
            ))}
          </ul>
        )}
      </article>
      {menu && (
        <InstallElsewhereMenu
          x={menu.x}
          y={menu.y}
          excludeRef={moreRef}
          onClose={() => setMenu(null)}
          onPick={() => {
            setMenu(null);
            send({ type: 'INSTALL_AGENT_SKILL' });
          }}
        />
      )}
    </div>
  );
}

function InstallElsewhereMenu({
  x,
  y,
  excludeRef,
  onClose,
  onPick,
}: {
  x: number;
  y: number;
  excludeRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onPick: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let left = x - rect.width;
    let top = y;
    if (left < 4) left = 4;
    if (top + rect.height > window.innerHeight - 4) {
      top = Math.max(4, window.innerHeight - rect.height - 4);
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [x, y]);

  useEffect(() => {
    const close = () => onCloseRef.current();
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || excludeRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, []);

  return createPortal(
    <div
      ref={rootRef}
      className="pkg-ctx-menu"
      style={{ left: x, top: y }}
      role="menu"
    >
      <button
        type="button"
        className="pkg-ctx-menu__item"
        role="menuitem"
        onClick={onPick}
      >
        Install to another location
      </button>
    </div>,
    document.body,
  );
}

function KebabIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="3.5" r="1.35" fill="currentColor" />
      <circle cx="8" cy="8" r="1.35" fill="currentColor" />
      <circle cx="8" cy="12.5" r="1.35" fill="currentColor" />
    </svg>
  );
}
