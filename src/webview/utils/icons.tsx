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

/** Start a trace — a plain filled dot, same "record" convention as most apps. */
export function IconRecordDot() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <circle cx="8" cy="8" r="5" fill="currentColor" />
    </svg>
  );
}

/** Stop & save the trace zip. */
export function IconStopSquare() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor" />
    </svg>
  );
}

export function IconCopy() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        d="M6.25 6.25h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.75 9.75h-1a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v1"
      />
    </svg>
  );
}

/** Clear log — traced from a real broom icon (svgrepo.com), not hand-drawn. */
export function IconBroom() {
  return (
    <svg viewBox="0 0 57.042 57.042" width="12" height="12" aria-hidden="true">
      <path
        fill="currentColor"
        d="M49.48,55.758l-8.571-29c-0.071-0.239-0.23-0.428-0.43-0.554c-0.433-6.226-5.623-11.162-11.958-11.162 s-11.524,4.936-11.958,11.162c-0.2,0.126-0.359,0.315-0.43,0.554l-8.571,29c-0.09,0.302-0.031,0.629,0.158,0.882 c0.188,0.252,0.485,0.401,0.801,0.401h40c0.315,0,0.612-0.149,0.801-0.401C49.511,56.387,49.57,56.061,49.48,55.758z M28.521,17.042c5.177,0,9.447,3.954,9.95,9h-19.9C19.073,20.996,23.344,17.042,28.521,17.042z M40.447,55.042l-4-17.226 c-0.124-0.539-0.665-0.873-1.2-0.748c-0.538,0.125-0.872,0.662-0.747,1.2l3.895,16.774h-8.874V43c0-0.552-0.447-1-1-1 s-1,0.448-1,1v12.042H18.6l3.894-16.774c0.125-0.538-0.21-1.075-0.747-1.2c-0.536-0.126-1.076,0.209-1.2,0.748l-3.999,17.226 H9.859l7.981-27h21.363l7.98,27H40.447z"
      />
      <rect fill="currentColor" x="27.521" width="2" height="14.042" />
    </svg>
  );
}

/** Tiny filled shield — badge overlay only (see .log-toolbar__badge-icon), not a standalone button icon. */
export function IconShieldBadge() {
  return (
    <svg viewBox="0 0 16 16" width="7" height="7" aria-hidden="true">
      <path fill="currentColor" d="M8 1 13 3v4c0 3.5-2.2 5.8-5 7-2.8-1.2-5-3.5-5-7V3Z" />
    </svg>
  );
}

/** Output Channel — a text/log panel, not a shell prompt (no terminal `>`). */
export function IconOutputPanel() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <rect x="1.8" y="2.2" width="12.4" height="11.6" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" d="M4.2 5.6h7.6M4.2 8h5.4M4.2 10.4h7.6" />
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
 * Install — an arrow into a tray, not the bare `↓` this button used to show
 * (#88). That glyph is the panel's own downgrade mark, so a package that was
 * never installed appeared to offer a downgrade. The tray is what separates
 * "put this on disk" from "move to a lower version"; sizes match IconTrash,
 * its neighbour in the same 24×24 slot.
 */
export function IconInstall() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path fill="currentColor" d="M8 9.5 4 4.5h2.4V1h3.2v3.5H12Z" />
      <path fill="currentColor" d="M3 10v4h10v-4h-1.5v2.5h-7V10H3Z" />
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

/** Source-control branch — by destination kind (source repo), not by forge vendor, so it reads the same for GitHub/GitLab/Bitbucket/Azure DevOps (#86). */
export function IconBranch() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="7" cy="6" r="2" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="9" r="2" />
      <path d="M7 8v8M17 11v1a3 3 0 0 1-3 3H7" />
    </svg>
  );
}

/** One commit on the branch line — the exact revision the package was built from (#86). */
export function IconCommit() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="3.5" />
      <path d="M2 12h6.5M15.5 12H22" />
    </svg>
  );
}

/** A project's own site — by destination kind, distinct from a source-control link (#86). */
export function IconGlobe() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
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

/** Disclosure triangles for a row that opens into per-framework rows (#82). */
export function IconChevronRight() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function IconChevronDown() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/**
 * The apply button when the picked version is the one already installed (#82).
 * A check says "you are there"; the `=` it replaces read as an operator, and
 * sat oddly beside the ↑ and ↓ it shares a slot with.
 */
export function IconCheck() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 13 4.5 4.5L19 7" />
    </svg>
  );
}
