import type { Step } from "./schema.js";

/**
 * What a spec pulls in from disk, besides itself.
 *
 * These were part of the render fingerprint, which is gone: skipping a render
 * when nothing changed only ever paid for itself in CI, and CI drift-detection
 * is no longer what Reel is for. The two listers survive it because they answer
 * a question that still gets asked — *what does this spec depend on?* — and one
 * of them is security-adjacent: a storage state is a bearer credential, and
 * knowing which files a spec will read is how you notice one is committed.
 */

/** Every image file a step brings in, branches included. */
export function imageFiles(steps: Step[]): string[] {
  const out: string[] = [];
  for (const step of steps) {
    if ("image" in step) out.push(typeof step.image === "string" ? step.image : step.image.file);
  }
  return out;
}

/**
 * Every session a `signIn` step restores, branches included.
 *
 * A `signIn` file decides what the app renders from that step onward, exactly
 * as `storageState` does for the whole run — so a re-saved session is a changed
 * input, and `--if-changed` must not skip past one.
 */
export function signInStates(steps: Step[]): string[] {
  const out: string[] = [];
  for (const step of steps) {
    if ("signIn" in step) {
      out.push(typeof step.signIn === "string" ? step.signIn : step.signIn.state);
    }
  }
  return out;
}
