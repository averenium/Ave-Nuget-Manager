/**
 * What an HTTP status means to each layer, in one place (#27).
 *
 * Four layers ask four different questions of the same number, and they were
 * answering them in four files — which is how two of the answers drifted apart
 * without anyone noticing. The questions really are different, so the answers
 * differ on purpose; stating them side by side is what makes the differences
 * legible instead of accidental.
 *
 * | Question | Asked by | Answer |
 * |---|---|---|
 * | Does this say anything about the resource? | the capability probe | `saysNothingAboutResource` |
 * | Is it worth asking again right now? | the retry layer | `worthRepeating` |
 * | May the answer be kept? | the response cache | `worthCaching` |
 * | Should the log paint this as a failure? | the log | `readsAsFailure` |
 *
 * Where they diverge, and why:
 *
 * - **A 500 says nothing and is not worth repeating.** A server that has
 *   thrown will throw again on the same request; recording "this resource does
 *   not work" would be just as wrong, since the fault is the moment, not the
 *   resource. So it suppresses a verdict without earning a retry.
 * - **A 404 is an answer.** It is how a feed says it does not hold a package,
 *   which is worth caching and is not a failure to show in red — while for the
 *   probe, a 404 on the index itself means there is no v3 there at all.
 * - **A 304 is an answer about an answer.** Only the cache has anything to do
 *   with it; it renews what is already held rather than being held itself.
 */

/** Status classes that describe the moment rather than the resource. */
export function saysNothingAboutResource(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/**
 * Worth one more attempt: a gateway or upstream that failed to pass the request
 * on, an overloaded feed that asked to be tried later, or no response at all.
 * Notably **not** a 500 or 501 — the server received the request and dealt with
 * it badly, and repeating it changes nothing but the delay.
 */
export function worthRepeating(status: number): boolean {
  return status === 0 || status === 408 || status === 429
    || status === 502 || status === 503 || status === 504;
}

/** Answers that may be reused within the window: a document, or a definite "not here". */
export function worthCaching(status: number): boolean {
  return status === 200 || status === 404 || status === 410;
}

/**
 * Whether the log should paint the row as a failure. A missing package is an
 * ordinary answer; a refusal or a server error is worth the eye.
 */
export function readsAsFailure(status: number): boolean {
  if (status === 0) return true;
  if (status === 404 || status === 410) return false;
  return status >= 400;
}
