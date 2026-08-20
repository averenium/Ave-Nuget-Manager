import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNugetManager } from '../context/NugetManagerContext';

interface Props {
  packageId: string;
  blocked: boolean;
  x: number;
  y: number;
  onClose: () => void;
}

/** Right-click menu on Installed / Groups preview rows. Portal + capture dismiss so it cannot stick. */
export function BlockedPackageMenu({ packageId, blocked, x, y, onClose }: Props) {
  const { send } = useNugetManager();
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - 4) {
      left = Math.max(4, window.innerWidth - rect.width - 4);
    }
    if (top + rect.height > window.innerHeight - 4) {
      top = Math.max(4, window.innerHeight - rect.height - 4);
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [x, y]);

  useEffect(() => {
    const close = () => onCloseRef.current();
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
      window.removeEventListener('scroll', close, true);
    };
  }, []);

  return createPortal(
    <div
      ref={rootRef}
      className="pkg-ctx-menu"
      style={{ left: x, top: y }}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        type="button"
        className="pkg-ctx-menu__item"
        role="menuitem"
        onClick={() => {
          send({ type: 'SET_PACKAGE_BLOCKED', packageId, blocked: !blocked });
          onClose();
        }}
      >
        {blocked ? 'Unblock updates' : 'Block updates'}
      </button>
    </div>,
    document.body,
  );
}
