import type { Page } from "playwright-core";
import type { ScreenshotCapture } from "./screenshot.js";
import { log } from "../util/log.js";

/**
 * Scroll as a camera pan, not a browser scroll.
 *
 * Capturing a live scroll is a losing race: Chromium rasterizes asynchronously,
 * so `page.screenshot()` taken mid-scroll returns frames with a blank band
 * where the compositor hasn't caught up. Measured on a normal page, ~30% of
 * frames during a 1.1s scroll carried a visible white band, and neither
 * slowing the scroll nor `--run-all-compositor-stages-before-draw`,
 * `--disable-checker-imaging`, or `--disable-threaded-scrolling` removed it.
 *
 * So Reel doesn't record a scroll — it *renders* one. We take a single settled
 * full-page screenshot, then slice viewport-sized windows down it with easing.
 * The result is artifact-free, runs at the full output frame rate regardless of
 * how slow screenshotting is, and costs one capture instead of dozens.
 *
 * The tradeoff: a full-page screenshot renders `position: fixed` elements only
 * once, at the top. Pages with sticky headers should use `scrollTo` (an instant
 * jump) instead.
 */

export interface PanOptions {
  fromY: number;
  toY: number;
  ms: number;
  fps: number;
  viewport: { width: number; height: number; scale: number };
  /**
   * Timeline position for the first synthesized frame. Supplied on a
   * deterministic recording, where the driver's virtual clock — not elapsed
   * wall-clock — owns the timeline.
   */
  startT?: number;
}

/**
 * Synthesize an eased scroll and append it to the capture timeline. Returns the
 * number of frames written, or 0 if the page couldn't be panned (in which case
 * the caller should fall back to a plain scroll).
 */
export async function panScroll(
  page: Page,
  capture: ScreenshotCapture,
  opts: PanOptions,
): Promise<number> {
  const sharp = (await import("sharp")).default;

  // The overlay is position:fixed, so it would be baked into the top of the
  // tall image and then scroll away with the content. Hide it for the grab.
  await setOverlayVisible(page, false);
  try {
    return await pan(page, capture, opts, sharp);
  } catch (err) {
    // A hidden overlay is invisible in the failure and permanent in the demo:
    // every frame after this one would be missing its cursor and captions. On
    // a `catch` rather than a `finally` so the success path — which restores it
    // itself, in the order the capture loop needs — pays nothing for it.
    await setOverlayVisible(page, true);
    throw err;
  }
}

async function pan(
  page: Page,
  capture: ScreenshotCapture,
  opts: PanOptions,
  sharp: typeof import("sharp"),
): Promise<number> {
  await page.evaluate((y) => window.scrollTo(0, y), opts.fromY);
  await page.waitForTimeout(120); // let the jump settle before the grab

  let tall: Buffer;
  try {
    tall = await page.screenshot({ type: "png", fullPage: true });
  } catch {
    await setOverlayVisible(page, true);
    return 0;
  }

  const image = sharp(tall);
  const meta = await image.metadata();
  const fullW = meta.width ?? 0;
  const fullH = meta.height ?? 0;
  const winH = Math.round(opts.viewport.height * opts.viewport.scale);
  if (!fullW || fullH <= winH) {
    // Nothing to pan over — the page fits in one screen.
    await setOverlayVisible(page, true);
    return 0;
  }

  const scale = fullH / Math.max(1, await pageHeight(page));
  const maxTop = fullH - winH;
  const count = Math.max(2, Math.round((opts.ms / 1000) * opts.fps));
  const startT = opts.startT ?? capture.elapsed();
  const step = opts.ms / (count - 1);

  capture.pause();
  try {
    const raw = await image.raw().toBuffer({ resolveWithObject: true });

    for (let i = 0; i < count; i++) {
      const p = i / (count - 1);
      const y = opts.fromY + (opts.toY - opts.fromY) * easeInOutCubic(p);
      const top = clamp(Math.round(y * scale), 0, maxTop);
      const frame = await sharp(raw.data, {
        raw: { width: raw.info.width, height: raw.info.height, channels: raw.info.channels },
      })
        .extract({ left: 0, top, width: fullW, height: winH })
        .jpeg({ quality: 92 })
        .toBuffer();
      await capture.pushFrame(frame, startT + i * step);
    }

    // Leave the real page where the pan ended, so subsequent steps line up.
    await page.evaluate((y) => window.scrollTo(0, y), opts.toY);
  } finally {
    // Everything between `pause()` and `resume()` used to be on the success
    // path alone, so a throw in the middle of it — a sharp `extract` off the
    // edge of the image, a frame that could not be written — left the overlay
    // hidden and the capture loop paused for the rest of the demo: no cursor,
    // no captions, and in live mode no frames at all, all with no error to
    // connect it to. The order matters too. Restoring the overlay before
    // resuming is what stops the live loop sampling a frame with nothing drawn
    // on it.
    await setOverlayVisible(page, true);
    await page.waitForTimeout(100);
    capture.resume();
  }

  log.debug(`panned ${count} synthetic frames (${opts.fromY} → ${opts.toY})`);
  return count;
}

async function pageHeight(page: Page): Promise<number> {
  return page.evaluate(() =>
    Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight ?? 0,
      window.innerHeight,
    ),
  );
}

/** Compute the scroll offset that frames an element cinematically. */
export async function scrollTargetFor(page: Page, selector: string): Promise<number> {
  return page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      // Land the element a third of the way down the viewport.
      return Math.max(0, window.scrollY + r.top - window.innerHeight / 3);
    });
}

async function setOverlayVisible(page: Page, visible: boolean): Promise<void> {
  await page
    .evaluate((v) => {
      const el = document.getElementById("__reel_overlay__");
      if (el) el.style.visibility = v ? "visible" : "hidden";
    }, visible)
    .catch(() => {});
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(lo, v), Math.max(lo, hi));
}
