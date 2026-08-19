import React, { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_RATIO = 0.5;
const MIN_LIST_PX = 160;
const MIN_DETAIL_PX = 180;

interface Props {
  left: React.ReactNode;
  right: React.ReactNode;
  /** Pixel width from content measure; used until the user drags the splitter. */
  autoListWidthPx?: number | null;
  defaultRatio?: number;
  splitLabel?: string;
}

export function SplitPane({
  left,
  right,
  autoListWidthPx = null,
  defaultRatio = DEFAULT_RATIO,
  splitLabel = 'Resize list',
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [listWidthPx, setListWidthPx] = useState<number | null>(null);

  const clampListWidth = useCallback((px: number, bodyWidth: number) => {
    const max = Math.max(MIN_LIST_PX, bodyWidth - MIN_DETAIL_PX);
    return Math.min(max, Math.max(MIN_LIST_PX, Math.round(px)));
  }, []);

  useEffect(
    () => () => { document.body.classList.remove('is-resizing-split'); },
    [],
  );

  const onSplitPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add('is-resizing-split');
  };

  const onSplitPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || !bodyRef.current) return;
    const rect = bodyRef.current.getBoundingClientRect();
    setListWidthPx(clampListWidth(e.clientX - rect.left, rect.width));
  };

  const onSplitPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    document.body.classList.remove('is-resizing-split');
  };

  return (
    <div className="pkg-body" ref={bodyRef}>
      <div
        className="packages-left"
        style={
          listWidthPx == null
            ? { width: autoListWidthPx ?? `${defaultRatio * 100}%`, maxWidth: '50%' }
            : { width: listWidthPx, maxWidth: 'none' }
        }
      >
        <div className="packages-left__scroll">{left}</div>
      </div>

      <div
        className="pkg-split"
        role="separator"
        aria-orientation="vertical"
        aria-label={splitLabel}
        tabIndex={0}
        onPointerDown={onSplitPointerDown}
        onPointerMove={onSplitPointerMove}
        onPointerUp={onSplitPointerUp}
        onPointerCancel={onSplitPointerUp}
        onKeyDown={(e) => {
          if (!bodyRef.current) return;
          const step = e.shiftKey ? 40 : 16;
          const current = listWidthPx
            ?? autoListWidthPx
            ?? Math.round(bodyRef.current.clientWidth * defaultRatio);
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            setListWidthPx(clampListWidth(current - step, bodyRef.current.clientWidth));
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            setListWidthPx(clampListWidth(current + step, bodyRef.current.clientWidth));
          }
        }}
      />

      <div className="packages-right">{right}</div>
    </div>
  );
}
