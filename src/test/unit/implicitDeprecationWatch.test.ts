import { handleVisibilityChange, reconcileObservedRows } from '../../webview/utils/implicitDeprecationWatch';
import type { WebviewMessage } from '../../messages';

function collector() {
  const sent: WebviewMessage[] = [];
  return { send: (msg: WebviewMessage) => sent.push(msg), sent };
}

describe('handleVisibilityChange (#118)', () => {
  it('asks once when a row becomes visible', () => {
    const watching = new Set<string>();
    const { send, sent } = collector();

    handleVisibilityChange('Example.Transitive', true, watching, {}, send);

    expect(watching.has('Example.Transitive')).toBe(true);
    expect(sent).toEqual([{ type: 'WATCH_IMPLICIT_PACKAGE', packageId: 'Example.Transitive' }]);
  });

  it('does not ask again for a row already being watched', () => {
    const watching = new Set(['Example.Transitive']);
    const { send, sent } = collector();

    handleVisibilityChange('Example.Transitive', true, watching, {}, send);

    expect(sent).toEqual([]);
  });

  it('does not ask for a row whose flags are already known — scrolling back over it must not flicker', () => {
    const watching = new Set<string>();
    const { send, sent } = collector();
    const flags = { 'example.transitive': { '1.0.0': { deprecation: 'Legacy' } } };

    handleVisibilityChange('Example.Transitive', true, watching, flags, send);

    expect(watching.has('Example.Transitive')).toBe(false);
    expect(sent).toEqual([]);
  });

  it('cancels the ask when a watched row stops being visible', () => {
    const watching = new Set(['Example.Transitive']);
    const { send, sent } = collector();

    handleVisibilityChange('Example.Transitive', false, watching, {}, send);

    expect(watching.has('Example.Transitive')).toBe(false);
    expect(sent).toEqual([{ type: 'UNWATCH_IMPLICIT_PACKAGE', packageId: 'Example.Transitive' }]);
  });

  it('does nothing when a row not being watched stops being visible', () => {
    const watching = new Set<string>();
    const { send, sent } = collector();

    handleVisibilityChange('Example.Transitive', false, watching, {}, send);

    expect(sent).toEqual([]);
  });
});

describe('reconcileObservedRows (#118)', () => {
  const hasElement = () => true;

  it('starts observing every displayed id that has a DOM node and is not observed yet', () => {
    const observed = new Set<string>();
    const watching = new Set<string>();
    const { send } = collector();

    const { toObserve, toUnobserve } = reconcileObservedRows(
      ['Example.One', 'Example.Two'], observed, watching, hasElement, send,
    );

    expect(toObserve.sort()).toEqual(['Example.One', 'Example.Two']);
    expect(toUnobserve).toEqual([]);
    expect(observed).toEqual(new Set(['Example.One', 'Example.Two']));
  });

  it('leaves an already-observed id untouched when the list is unchanged, even mid-fetch', () => {
    // This is the exact case an earlier version got wrong: recreating the
    // observer on every list change sent UNWATCH immediately followed by
    // WATCH for every still-visible row on every keystroke of a search,
    // cancelling a request before it could ever finish.
    const observed = new Set(['Example.One']);
    const watching = new Set(['Example.One']);
    const { send, sent } = collector();

    const { toObserve, toUnobserve } = reconcileObservedRows(
      ['Example.One'], observed, watching, hasElement, send,
    );

    expect(toObserve).toEqual([]);
    expect(toUnobserve).toEqual([]);
    expect(watching.has('Example.One')).toBe(true);
    expect(sent).toEqual([]);
  });

  it('unwatches and unobserves an id dropped from the list, and cancels its ask if one was in flight', () => {
    const observed = new Set(['Example.One', 'Example.Two']);
    const watching = new Set(['Example.One']);
    const { send, sent } = collector();

    const { toObserve, toUnobserve } = reconcileObservedRows(
      ['Example.Two'], observed, watching, hasElement, send,
    );

    expect(toUnobserve).toEqual(['Example.One']);
    expect(toObserve).toEqual([]);
    expect(observed).toEqual(new Set(['Example.Two']));
    expect(watching.has('Example.One')).toBe(false);
    expect(sent).toEqual([{ type: 'UNWATCH_IMPLICIT_PACKAGE', packageId: 'Example.One' }]);
  });

  it('drops an id from the observed set without sending UNWATCH when it was never being watched', () => {
    // An id can be observed without being watched — its flags already
    // arrived, so `handleVisibilityChange` never asked for it. Filtering it
    // out of the list must not send a cancellation nobody is waiting on.
    const observed = new Set(['Example.Answered']);
    const watching = new Set<string>();
    const { send, sent } = collector();

    const { toUnobserve } = reconcileObservedRows([], observed, watching, hasElement, send);

    expect(toUnobserve).toEqual(['Example.Answered']);
    expect(sent).toEqual([]);
  });

  it('does not observe an id whose row has no DOM node yet', () => {
    const observed = new Set<string>();
    const watching = new Set<string>();
    const { send } = collector();

    const { toObserve } = reconcileObservedRows(['Example.NotMounted'], observed, watching, () => false, send);

    expect(toObserve).toEqual([]);
    expect(observed.has('Example.NotMounted')).toBe(false);
  });

  it('handles a full turnover — every previously displayed id replaced by a new set', () => {
    const observed = new Set(['Example.Old']);
    const watching = new Set(['Example.Old']);
    const { send, sent } = collector();

    const { toObserve, toUnobserve } = reconcileObservedRows(
      ['Example.New'], observed, watching, hasElement, send,
    );

    expect(toUnobserve).toEqual(['Example.Old']);
    expect(toObserve).toEqual(['Example.New']);
    expect(observed).toEqual(new Set(['Example.New']));
    expect(sent).toEqual([{ type: 'UNWATCH_IMPLICIT_PACKAGE', packageId: 'Example.Old' }]);
  });
});
