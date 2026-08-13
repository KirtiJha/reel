import type { Step } from "../spec/schema.js";

/**
 * When is it safe to run a step a second time?
 *
 * Blanket retries are dangerous in a demo: re-running a half-completed `type`
 * duplicates the text, and re-running a click that already landed submits
 * twice. The safe cases are narrow but cover the flakiness that actually
 * happens — an element that wasn't ready yet.
 */

/**
 * Steps that never mutate anything, so repeating them is always safe.
 * (`goto` is included: navigating to the same URL again is idempotent.)
 */
const PURE_STEPS = [
  "goto",
  "waitFor",
  "waitForUrl",
  "waitForNetworkIdle",
  "expect",
  "scrollTo",
  "scroll",
  "hover",
  "callout",
  "zoom",
] as const;

/**
 * Playwright waits for actionability before acting, so a timeout means the
 * action never happened and the page is untouched. Anything else — a detached
 * node mid-click, a navigation — may have landed, and is not retried.
 */
const NEVER_ACTED = /Timeout .*exceeded|waiting for (locator|selector)|element is not (visible|attached|enabled|stable)/i;

export function isRetryable(step: Step, err: unknown): boolean {
  const key = Object.keys(step)[0];
  if (key && (PURE_STEPS as readonly string[]).includes(key)) return true;

  // Mutating steps are retried only when the failure proves nothing happened.
  const message = err instanceof Error ? err.message : String(err ?? "");
  return NEVER_ACTED.test(message);
}

/** Backoff between attempts — short, since the driver is already inside a wait. */
export function retryDelayMs(attempt: number): number {
  return Math.min(2000, 250 * 2 ** attempt);
}
