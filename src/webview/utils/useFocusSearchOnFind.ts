/**
 * Focuses the tab's own search input on Ctrl+F / Cmd+F (#93). Kept apart from
 * the predicate it uses so that the decision stays testable in this project's
 * DOM-free test environment.
 *
 * Only the mounted tab listens: App renders one tab at a time, so there is
 * never a second handler racing for the same key.
 */

import { useEffect } from 'react';
import type { RefObject } from 'react';
import { isFindShortcut } from './findShortcut';

export function useFocusSearchOnFind(inputRef: RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isFindShortcut(event)) return;
      const input = inputRef.current;
      if (!input) return;
      // `stopPropagation` is the part that actually claims the shortcut.
      // VS Code's webview preload registers its own keydown listener on this
      // window and forwards every key to the workbench as `did-keydown`
      // regardless of `defaultPrevented` — which is how Ctrl+F reached the
      // editor's find instead of this panel. Keeping the event from reaching
      // `window` is what stops that forwarding; `preventDefault` only ever
      // spoke to the browser, which was never the one answering.
      event.preventDefault();
      event.stopPropagation();
      input.focus();
      input.select();
    };
    // Capture, so this runs before anything else in the frame and the event is
    // stopped on the way down rather than after some other handler has seen it.
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [inputRef]);
}
