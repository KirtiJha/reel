/**
 * Cleanup that has to run even when the process is being killed.
 *
 * A recording owns three things the operating system will not tidy up for it: a
 * temp directory that grows to tens of gigabytes of intermediate frames, a
 * headless Chromium, and the app's own detached process group — which keeps its
 * port bound and so breaks the *next* run as well. All three are released in
 * `record()`'s `finally`, and a signal never reaches a `finally`: the default
 * disposition of SIGINT is to terminate the process where it stands. Ctrl-C at
 * minute 20 of a render therefore leaked all of it.
 *
 * So anything that allocates one of those registers a disposer here, and the
 * CLI runs them from its signal handlers before exiting.
 *
 * **Disposers are synchronous on purpose.** The signal path has no time to
 * await anything: Playwright installs its own SIGINT handler that calls
 * `process.exit()` as soon as the browser is closed, and an async disposer
 * would be cut off half way through the `rm` it was in the middle of. Every
 * teardown that matters here has a synchronous form — `rmSync`, `process.kill`
 * — so requiring one costs nothing and removes the race.
 */

export type Disposer = () => void;

const disposers = new Set<Disposer>();

/**
 * Register cleanup to run if the process is signalled or dies unexpectedly.
 * Returns a function that unregisters it, to be called on the normal path where
 * the owner has already cleaned up after itself.
 */
export function onCleanup(fn: Disposer): () => void {
  disposers.add(fn);
  return () => {
    disposers.delete(fn);
  };
}

/**
 * Run every registered disposer, most recently registered first, and forget
 * them. Ordering is deliberate: the last thing allocated is usually the one
 * built on top of the others.
 *
 * A disposer that throws must not strand the ones after it — this runs while
 * the process is already on its way out, and a half-finished teardown is the
 * failure it exists to prevent.
 */
export function runCleanup(): void {
  for (const fn of [...disposers].reverse()) {
    disposers.delete(fn);
    try {
      fn();
    } catch {
      /* already gone, or never existed — keep going */
    }
  }
}

/** How many disposers are outstanding. For tests, and for `--verbose`. */
export function pendingCleanups(): number {
  return disposers.size;
}
