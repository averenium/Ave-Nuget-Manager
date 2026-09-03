import React from 'react';

/** Shared small (12x12) icon set used across Sources and Packages rows/buttons. */

export function IconPencil() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        fill="currentColor"
        d="M11.35 1.65a1.5 1.5 0 0 1 2.12 0l.88.88a1.5 1.5 0 0 1 0 2.12l-7.6 7.6-3.36.77.77-3.36 7.19-7.19Zm1.06 1.06-7 7-.34 1.5 1.5-.34 7-7-1.16-1.16Z"
      />
    </svg>
  );
}

export function IconTrash() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        fill="currentColor"
        d="M6.5 1.5h3a1 1 0 0 1 1 1V3h3a.75.75 0 0 1 0 1.5h-.4l-.66 8.53A1.75 1.75 0 0 1 10.71 15H5.29a1.75 1.75 0 0 1-1.74-1.97L2.9 4.5h-.4a.75.75 0 0 1 0-1.5h3v-.5a1 1 0 0 1 1-1Zm-2.1 3 .65 8.4a.25.25 0 0 0 .25.23h5.4a.25.25 0 0 0 .25-.23l.65-8.4H4.4ZM6.25 6a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 6.25 6Zm3.5 0a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5a.75.75 0 0 1 .75-.75Z"
      />
    </svg>
  );
}

/**
 * Fixed-viewBox replacements for the `↑`/`⊘`/`⚠`/`∅` row marks (#60) — plain
 * Unicode glyphs render each symbol at a different natural size and baseline
 * position depending on the platform font, which no amount of CSS centering
 * on the outer badge can fully compensate for. An SVG has exact, symmetric
 * coordinates instead, so it centers correctly inside `.pkg-row__mark`'s
 * circular border regardless of font/platform.
 */
export function IconMarkUp() {
  return (
    <svg viewBox="0 0 16 16" width="8" height="8" aria-hidden="true">
      <path fill="currentColor" d="M8 2.5 13 9H9.7v4.5h-3.4V9H3Z" />
    </svg>
  );
}

/** Diagonal bar only — `.pkg-row__mark`'s own border supplies the ring, for both blocked (⊘) and unmapped (∅). */
export function IconMarkSlash() {
  return (
    <svg viewBox="0 0 16 16" width="9" height="9" aria-hidden="true">
      <line x1="3.5" y1="12.5" x2="12.5" y2="3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function IconMarkWarning() {
  return (
    <svg viewBox="0 0 16 16" width="9" height="9" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        d="M8 2.2 14.3 13.5H1.7Z"
      />
      <rect x="7.35" y="6.4" width="1.3" height="3.8" fill="currentColor" />
      <rect x="7.35" y="11" width="1.3" height="1.3" fill="currentColor" />
    </svg>
  );
}
