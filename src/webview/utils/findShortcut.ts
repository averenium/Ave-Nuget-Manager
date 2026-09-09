/**
 * Ctrl+F / Cmd+F focuses the tab's own search box (#93).
 *
 * VS Code's native find widget is only available to a `WebviewPanel`, never to
 * a sidebar `WebviewView` (#58), which is why these tabs carry a search input
 * of their own. The box is easy to miss while the one shortcut a reader
 * reaches for does nothing, so the panel answers that shortcut itself.
 */

export interface FindShortcutEvent {
  /** Physical key, independent of layout. */
  code?: string;
  /** What the layout produces — only consulted when `code` is unavailable. */
  key?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Decided on the physical key rather than the character: on a Ukrainian or any
 * other non-Latin layout, Ctrl+F reports `key` as `'а'`, so matching the letter
 * would leave the shortcut dead for exactly the people most likely to hit it.
 *
 * Ctrl+Shift+F is left alone — that is "find in files" elsewhere, and taking it
 * here would shadow a binding this panel has no answer for.
 */
export function isFindShortcut(event: FindShortcutEvent): boolean {
  if (event.altKey || event.shiftKey) return false;
  if (!event.ctrlKey && !event.metaKey) return false;
  return event.code ? event.code === 'KeyF' : event.key?.toLowerCase() === 'f';
}
