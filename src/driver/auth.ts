import { readFile } from "node:fs/promises";
import type { BrowserContext, Page } from "playwright-core";
import { log, ReelError } from "../util/log.js";

/**
 * Signing in half-way through a demo.
 *
 * `storageState` on the spec authenticates the whole run, which is right when
 * the demo starts inside the product and wrong when it opens on a marketing
 * page or a logged-out home screen. Playwright applies a storage state when a
 * context is *created*, so there is no supported way to cross over mid-run —
 * this is that crossing, done by hand.
 *
 * Two halves, and only one of them is obvious. Cookies belong to the context
 * and go in with one call. Local storage belongs to an *origin*, and can only
 * be written by script running on that origin — so the entries are applied
 * from a page already there, and from a throwaway page for any other origin,
 * which the recorder never sees because it films one page only.
 */

/** The parts of Playwright's storage-state file this needs. */
export interface StorageState {
  cookies?: Parameters<BrowserContext["addCookies"]>[0];
  origins?: { origin: string; localStorage?: { name: string; value: string }[] }[];
}

/**
 * Read and validate a storage state.
 *
 * Checked rather than trusted: the common mistakes are pointing at a file that
 * expired, at the spec itself, or at a path that never existed, and all three
 * otherwise surface as an app that simply renders logged out — a demo that is
 * wrong rather than broken, which is the worst way to find out.
 */
export async function loadStorageState(path: string): Promise<StorageState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new ReelError(
      `No such session file: ${path}`,
      "Save one with `reel capture --url <url> --save-auth <file>`.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ReelError(
      `${path} is not a Playwright storage state (it isn't JSON).`,
      "Re-save it with `reel capture --save-auth`.",
    );
  }

  const state = parsed as StorageState;
  const cookies = state?.cookies?.length ?? 0;
  const origins = state?.origins?.length ?? 0;
  if (!Array.isArray(state?.cookies) && !Array.isArray(state?.origins)) {
    throw new ReelError(
      `${path} is not a Playwright storage state (no cookies or origins).`,
      "Re-save it with `reel capture --save-auth`.",
    );
  }
  if (cookies === 0 && origins === 0) {
    throw new ReelError(
      `${path} holds no session — it has neither cookies nor stored origins.`,
      "The sign-in probably didn't complete before Finish was pressed. Re-save it.",
    );
  }
  return state;
}

/** Same scheme, host and port — the boundary local storage is scoped to. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Expired cookies, which are the difference between "signed in" and "not".
 *
 * A storage state does not stop working loudly. Its cookies simply lapse, the
 * app renders its logged-out view, and the demo records that instead — passing
 * every step, because a logged-out app still has pages. Naming the expiry is
 * the only way that becomes a fixable message rather than a puzzle.
 *
 * `expires` is Playwright's seconds-since-epoch, with -1 meaning a session
 * cookie that never expires on its own.
 */
export function expiredCookies(
  state: StorageState,
  nowMs: number,
): { name: string; expires: number }[] {
  return (state.cookies ?? [])
    .filter((c) => typeof c.expires === "number" && c.expires > 0 && c.expires * 1000 <= nowMs)
    .map((c) => ({ name: c.name, expires: c.expires! }));
}

/**
 * Apply a saved session to a context that is already running.
 *
 * Returns what it did, so the caller can report it rather than the demo going
 * quietly logged-out. `page` is the filmed page: its origin decides which
 * entries can be written without opening anything the camera would catch.
 */
export async function applyStorageState(
  context: BrowserContext,
  page: Page,
  state: StorageState,
  opts: { now?: number } = {},
): Promise<{ cookies: number; origins: string[]; offCamera: string[] }> {
  const expired = expiredCookies(state, opts.now ?? Date.now());
  if (expired.length) {
    // A warning, not an error: a spec may legitimately restore a state whose
    // session cookies matter and whose expired ones don't. Failing the render
    // would be worse than saying so and letting the demo prove it.
    log.warn(
      `${expired.length} of ${state.cookies?.length ?? 0} cookies in this session have expired ` +
        `(${expired.map((c) => c.name).join(", ")}). The app may still render logged out.`,
    );
  }

  const cookies = state.cookies ?? [];
  if (cookies.length) await context.addCookies(cookies);

  const applied: string[] = [];
  const offCamera: string[] = [];
  for (const origin of state.origins ?? []) {
    const entries = origin.localStorage ?? [];
    if (entries.length === 0) continue;

    if (sameOrigin(page.url(), origin.origin)) {
      await writeLocalStorage(page, entries);
      applied.push(origin.origin);
      continue;
    }
    // Another origin — an auth server, a CDN. Written from a page of its own,
    // which is never filmed: the recorder screencasts the demo's page only.
    const scratch = await context.newPage();
    try {
      await scratch.goto(origin.origin, { waitUntil: "domcontentloaded" });
      await writeLocalStorage(scratch, entries);
      applied.push(origin.origin);
      offCamera.push(origin.origin);
    } catch (err) {
      // One unreachable origin should not lose the cookies that did apply.
      log.warn(`Could not restore local storage for ${origin.origin}: ${(err as Error).message}`);
    } finally {
      await scratch.close().catch(() => {});
    }
  }

  return { cookies: cookies.length, origins: applied, offCamera };
}

function writeLocalStorage(
  page: Page,
  entries: { name: string; value: string }[],
): Promise<void> {
  return page.evaluate((items) => {
    for (const { name, value } of items) {
      try {
        window.localStorage.setItem(name, value);
      } catch {
        // A blocked or full localStorage costs this entry, not the sign-in.
      }
    }
  }, entries);
}
