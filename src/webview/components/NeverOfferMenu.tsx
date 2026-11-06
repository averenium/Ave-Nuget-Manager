import React, { useEffect, useRef, useState } from 'react';

interface Props {
  /** The item was chosen: the offer is switched off and the waiting update goes ahead. */
  onChoose: () => void;
  /** Lets the surface keep Escape for the menu while it is open. */
  onOpenChange?: (open: boolean) => void;
  /** Where the menu hangs from; the popup and the page each anchor it to their own corner. */
  className?: string;
}

/**
 * The control that switches the proposal off (#109): a muted `⋯` at the top
 * right of a popup or page that is holding a write, opening a one-item menu in
 * the right-click menu's own look. The note under the item says what choosing it
 * does to the update that is waiting and where to undo it; it is plain text, so
 * a click meant for the item cannot open Settings instead.
 */
export function NeverOfferMenu({ onChoose, onOpenChange, className }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const set = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        onOpenChange?.(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      onOpenChange?.(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, onOpenChange]);

  return (
    <div className={`never-offer${className ? ` ${className}` : ''}`} ref={rootRef}>
      <button
        type="button"
        className={`popup__more${open ? ' popup__more--open' : ''}`}
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => set(!open)}
      >
        ⋯
      </button>
      {open && (
        <div className="pkg-ctx-menu never-offer__menu" role="menu">
          <button type="button" className="pkg-ctx-menu__item" role="menuitem" onClick={onChoose}>
            Never offer to update dependents
          </button>
          <div className="pkg-ctx-menu__note pkg-ctx-menu__note--block">
            This update goes ahead without them. Turn it back on in Settings.
          </div>
        </div>
      )}
    </div>
  );
}
