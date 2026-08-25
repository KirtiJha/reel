import type { BrowserContext } from "playwright-core";
import type { Deterministic } from "../spec/schema.js";

/**
 * Chromium flags that make rasterization reproducible.
 *
 * Everything else in this file makes the *app* behave the same twice. This
 * makes the *renderer* do so, which turns out to be a separate problem.
 *
 * Partial raster is the one that matters. Chromium keeps previously rasterized
 * tiles and re-rasterizes only what a change is believed to have touched, so
 * after a DOM mutation some tiles on screen are freshly drawn and others are
 * reused — and which is which depends on timing. The two are not quite
 * bit-identical: antialiased edges land a level or two apart. The result is a
 * frame that differs between runs by a handful of pixels along rounded corners,
 * on roughly one run in two, in a tool whose whole promise is that the same
 * spec renders the same bytes.
 *
 * It costs some raster work on each change. That is the right trade here: this
 * browser exists to be filmed, once, not to feel fast.
 */
export const DETERMINISTIC_LAUNCH_ARGS = ["--disable-partial-raster"];

/**
 * Make a real web app behave reproducibly enough to record. This is the gap
 * VHS never had to close (a terminal is fully controlled) and the reason naive
 * "record the video" tools produce flaky, drifting demos.
 *
 * Everything here is installed as an init script so it runs BEFORE any app
 * code on every document (including navigations and iframes).
 */
export async function applyDeterminism(
  context: BrowserContext,
  d: Deterministic,
): Promise<void> {
  // Shim esbuild/tsx's keepNames `__name` helper for ALL injected scripts —
  // registered first so every later init script / page.evaluate can rely on it.
  // (In dev/tsx, injected functions with named inner helpers reference __name,
  // which doesn't exist in the browser; the compiled build doesn't need this.)
  await context.addInitScript(() => {
    (globalThis as unknown as { __name?: unknown }).__name ||= (f: unknown) => f;
  });

  if (d.freezeClock !== undefined) {
    const epoch =
      typeof d.freezeClock === "number"
        ? d.freezeClock
        : Date.parse(d.freezeClock);
    if (!Number.isFinite(epoch)) {
      throw new Error(`deterministic.freezeClock is not a valid date: ${d.freezeClock}`);
    }
    await context.addInitScript(freezeClockScript, epoch);
  }

  if (d.seedRandom !== undefined) {
    await context.addInitScript(seedRandomScript, d.seedRandom);
  }

  if (d.disableAnimations) {
    // Injected as a style so it applies to every document; also re-applied by
    // the overlay layer for late-mounted nodes.
    await context.addInitScript(disableAnimationsScript);
  }
}

/* The functions below are serialized and run in the page context. They must be
   self-contained (no closure over Node values except the passed argument). */

function freezeClockScript(epoch: number): void {
  const OriginalDate = Date;
  // A Date that reports a frozen "now" but still constructs real dates when
  // given explicit args, so app logic that formats specific dates still works.
  class FrozenDate extends OriginalDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(epoch);
      } else {
        // @ts-expect-error variadic passthrough
        super(...args);
      }
    }
    static override now(): number {
      return epoch;
    }
  }
  // @ts-expect-error override global
  window.Date = FrozenDate;

  const start = epoch;
  let virtual = 0;
  const perf = window.performance;
  if (perf) {
    Object.defineProperty(perf, "now", {
      configurable: true,
      value: () => virtual,
    });
  }
  // Advance the virtual perf clock deterministically per animation frame so
  // requestAnimationFrame-driven code progresses without wall-clock coupling.
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb: FrameRequestCallback) =>
    raf(() => {
      virtual += 16;
      cb(virtual);
    });
  void start;
}

function seedRandomScript(seed: number): void {
  // Mulberry32 — tiny, deterministic PRNG.
  let a = seed >>> 0;
  window.Math.random = function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function disableAnimationsScript(): void {
  const apply = () => {
    if (document.getElementById("__reel_no_anim__")) return;
    const style = document.createElement("style");
    style.id = "__reel_no_anim__";
    // Scope to the app (body subtree) only — Reel's overlay is mounted on
    // <html>, outside <body>, so its synthetic cursor can still animate.
    style.textContent = `
      body, body *, body *::before, body *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
        scroll-behavior: auto !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply, { once: true });
  } else {
    apply();
  }
}
