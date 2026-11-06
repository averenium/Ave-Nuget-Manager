/**
 * Writes held back for a dependents answer (#109).
 *
 * A write is a function, which does not belong in the reducer's state, so the
 * ones waiting on an answer live here, keyed by the question they wait on.
 * `release` hands the write back to be run; `drop` forgets it.
 */

/** How long a write waits for the answer before it goes ahead, and says so in the Log. */
export const CASCADE_ANSWER_BUDGET_MS = 25_000;

const held = new Map<string, () => void>();
let counter = 0;

export function nextCascadeId(kind: 'apply' | 'asked'): string {
  counter += 1;
  return `cascade-${kind}-${counter}`;
}

export function holdWrite(requestId: string, write: () => void): void {
  held.set(requestId, write);
}

/** The held write, removed — or `undefined` when there is none (an asked question holds nothing). */
export function releaseWrite(requestId: string): (() => void) | undefined {
  const write = held.get(requestId);
  held.delete(requestId);
  return write;
}

export function dropWrite(requestId: string): void {
  held.delete(requestId);
}

export function hasHeldWrite(requestId: string): boolean {
  return held.has(requestId);
}


/** A write that arrived while another was waiting for its answer (#109). */
export interface QueuedWrite {
  request: import('./cascadeState').CascadeAsk['request'];
  write: () => void;
}

const queue: QueuedWrite[] = [];

/** Puts a write behind the one in front of it. Replacing that one would drop it without a word. */
export function enqueueWrite(item: QueuedWrite): void {
  queue.push(item);
}

export function dequeueWrite(): QueuedWrite | undefined {
  return queue.shift();
}

export function queuedCount(): number {
  return queue.length;
}

export function clearQueue(): void {
  queue.length = 0;
}
