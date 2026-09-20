/**
 * Wires `implicitDeprecationWatch.ts`'s pure decisions to a real
 * `IntersectionObserver` and real row refs (#118). Kept in its own file,
 * never imported by a test, for the same reason `useFocusSearchOnFind.ts` is
 * apart from `findShortcut.ts`: this project's Jest suite runs in a plain
 * Node environment with no DOM, and `IntersectionObserver` is a browser
 * global plain Node does not have.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { VersionFlag } from '../../types';
import {
  handleVisibilityChange,
  reconcileObservedRows,
  type SendImplicitWatch,
} from './implicitDeprecationWatch';

/** Returns a ref callback for each row's DOM node, wiring it into the watch above. */
export function useLazyDeprecationWatch(
  ids: string[],
  flagsByPackageId: Record<string, Record<string, VersionFlag>>,
  send: SendImplicitWatch,
): (id: string, el: HTMLDivElement | null) => void {
  const rowsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const observedRef = useRef<Set<string>>(new Set());
  const watchingRef = useRef<Set<string>>(new Set());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const flagsRef = useRef(flagsByPackageId);
  flagsRef.current = flagsByPackageId;
  const sendRef = useRef(send);
  sendRef.current = send;

  const setRowRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) rowsRef.current.set(id, el);
    else rowsRef.current.delete(id);
  }, []);

  // The observer itself lives for the whole component lifetime — see
  // `implicitDeprecationWatch.ts`'s `reconcileObservedRows` for why
  // recreating it per render was the bug.
  useEffect(() => {
    const watching = watchingRef.current;
    const observed = observedRef.current;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.packageId;
        if (!id) continue;
        handleVisibilityChange(id, entry.isIntersecting, watching, flagsRef.current, sendRef.current);
      }
    });
    observerRef.current = observer;

    return () => {
      observer.disconnect();
      observerRef.current = null;
      for (const id of watching) sendRef.current({ type: 'UNWATCH_IMPLICIT_PACKAGE', packageId: id });
      watching.clear();
      observed.clear();
    };
  }, []);

  // Keeps the observer's own set of watched rows in step with the displayed
  // list; see `reconcileObservedRows` for the actual merge.
  useEffect(() => {
    const observer = observerRef.current;
    if (!observer) return;
    const { toObserve, toUnobserve } = reconcileObservedRows(
      ids,
      observedRef.current,
      watchingRef.current,
      (id) => rowsRef.current.has(id),
      sendRef.current,
    );
    for (const id of toUnobserve) {
      const el = rowsRef.current.get(id);
      if (el) observer.unobserve(el);
    }
    for (const id of toObserve) {
      const el = rowsRef.current.get(id);
      if (el) observer.observe(el);
    }
  });

  return setRowRef;
}
