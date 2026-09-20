/**
 * The two decisions behind lazily asking the feed about a transitive
 * package's id, kept apart from the `IntersectionObserver` and the DOM refs
 * that drive them (`useLazyDeprecationWatch.ts`) the same way
 * `findShortcut.ts` keeps its predicate apart from `useFocusSearchOnFind.ts`'s
 * `keydown` listener — this project's Jest suite runs in a plain Node
 * environment with no DOM at all, so a file that references
 * `IntersectionObserver` even only inside a function body cannot be imported
 * from a test without pulling in a browser global that plain Node does not
 * have. Neither function here touches the DOM, so neither needs one (#118).
 */

import type { WebviewMessage } from '../../messages';
import type { VersionFlag } from '../../types';

export type SendImplicitWatch = (msg: WebviewMessage) => void;

/**
 * One row's own visibility changed — the branch a real `IntersectionObserver`
 * entry drives. An id already known from `flagsByPackageId` is never
 * (re-)asked, which is what keeps scrolling back over an answered row from
 * reading as a flicker.
 */
export function handleVisibilityChange(
  id: string,
  isIntersecting: boolean,
  watching: Set<string>,
  flagsByPackageId: Record<string, Record<string, VersionFlag>>,
  send: SendImplicitWatch,
): void {
  if (isIntersecting) {
    if (watching.has(id) || flagsByPackageId[id.toLowerCase()]) return;
    watching.add(id);
    send({ type: 'WATCH_IMPLICIT_PACKAGE', packageId: id });
  } else if (watching.has(id)) {
    watching.delete(id);
    send({ type: 'UNWATCH_IMPLICIT_PACKAGE', packageId: id });
  }
}

/**
 * Brings the observer's own set of watched rows in step with the ids
 * currently displayed, touching only the ones that actually joined or left —
 * the merge the whole feature rests on. Recreating the observer itself on
 * every list change was an earlier version's own bug: the displayed set
 * narrows on every keystroke of a search, so a fresh observer per keystroke
 * dropped and re-added every still-visible row, sending
 * `UNWATCH_IMPLICIT_PACKAGE` immediately followed by `WATCH_IMPLICIT_PACKAGE`
 * for each — cancelling and restarting a row's request before typing even
 * paused, so the rows this exists for could never get an answer while the
 * box was in use. Diffing instead means an id already observed stays
 * untouched even if this render's list reshuffled around it.
 *
 * `hasElement` stands in for the DOM lookup a real row ref would answer, so a
 * test can supply a plain predicate instead of rendering anything. Mutates
 * `observed` and `watching` in place; the caller still has to call
 * `observe`/`unobserve` on the ids returned, since only it holds the actual
 * nodes and the actual observer.
 */
export function reconcileObservedRows(
  ids: readonly string[],
  observed: Set<string>,
  watching: Set<string>,
  hasElement: (id: string) => boolean,
  send: SendImplicitWatch,
): { toObserve: string[]; toUnobserve: string[] } {
  const current = new Set(ids);
  const toUnobserve: string[] = [];
  const toObserve: string[] = [];

  // A row dropped from the list — filtered out, or the scope changed under
  // it — is exactly as gone as one scrolled away: told so, the same way.
  for (const id of observed) {
    if (current.has(id)) continue;
    toUnobserve.push(id);
    observed.delete(id);
    if (watching.has(id)) {
      watching.delete(id);
      send({ type: 'UNWATCH_IMPLICIT_PACKAGE', packageId: id });
    }
  }
  for (const id of ids) {
    if (observed.has(id)) continue;
    if (!hasElement(id)) continue;
    observed.add(id);
    toObserve.push(id);
  }
  return { toObserve, toUnobserve };
}
