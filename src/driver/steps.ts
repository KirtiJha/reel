import type { Page } from "playwright-core";
import type { Step, Spec } from "../spec/schema.js";
import {
  clearSpotlight,
  hideCard,
  measureText,
  setCaption,
  showCard,
  smoothScroll,
  spotlight,
  toPlaywrightSelector,
} from "../overlay/overlay.js";
import type { Recorder } from "./recorder.js";
import type { TerminalController } from "../terminal/controller.js";
import type { CaptionCue } from "../polish/captions.js";
import { compositesCaptions } from "../polish/frame.js";
import type { Rect, ZoomKey } from "../polish/zoom.js";
import { type GridRegion, measureGrid, regionToRect, tailRegion } from "../terminal/grid.js";
import { panScroll, scrollTargetFor } from "../capture/pan.js";
import type { ScreenshotCapture } from "../capture/screenshot.js";
import type { Scene } from "../encode/html.js";
import { log, ReelError } from "../util/log.js";

export type Mode = "record" | "check" | "stills";

export interface StepContext {
  page: Page;
  spec: Spec;
  mode: Mode;
  fps: number;
  /** ms since recording started; used to timestamp beats/captions. */
  now(): number;
  beats: { label: string; t: number }[];
  /** Auto-zoom camera targets, captured as the demo runs. */
  zoom: ZoomKey[];
  /** Caption timeline — composited in post so zoom never clips it. */
  captions: CaptionCue[];
  /** The running capture, when recording — lets steps synthesize their own frames. */
  capture?: ScreenshotCapture | null;
  /** Owns the demo clock and every operation that consumes demo time. */
  rec: Recorder;
  /** Present when the spec declares a `terminal:` block. */
  term?: TerminalController | null;
  /** Click-through scenes for the interactive HTML build. */
  scenes: Scene[];
  /** Branch path these steps belong to, stamped onto every scene they produce. */
  currentPath?: string;
  /** When the last title card appeared — a card resets the narration context. */
  cardAt?: number;
}

/** Record a scene for the interactive build, tagged with the caption on screen. */
function snap(
  ctx: StepContext,
  label: string,
  extra: { hotspot?: Scene["hotspot"]; chapter?: string; caption?: string } = {},
): void {
  // "stills" records scenes for the interactive build without filming them —
  // how alternate branch paths are captured.
  if (ctx.mode === "check") return;
  ctx.scenes.push({
    t: ctx.now(),
    label,
    caption: extra.caption ?? activeCaptionText(ctx),
    chapter: extra.chapter,
    hotspot: extra.hotspot,
    path: ctx.currentPath,
  });
}

/**
 * The narration for a scene: the most recent caption, even if it has already
 * timed out on screen. In a video an expired caption should disappear; in a
 * click-through each scene is a page the viewer reads, so it keeps the last
 * thing you said until you say something else.
 */
function activeCaptionText(ctx: StepContext): string | undefined {
  const now = ctx.now();
  for (let i = ctx.captions.length - 1; i >= 0; i--) {
    const c = ctx.captions[i]!;
    if (c.t > now) continue;
    // A title card ends the previous section; don't carry its narration past it.
    if (ctx.cardAt !== undefined && ctx.cardAt > c.t) return undefined;
    return c.text;
  }
  return undefined;
}

/** Camera directions, not chapter names — they shouldn't reach the chapter rail. */
const CAMERA_BEATS = /^(hero|outro|intro|wide|done|beat|end)$/i;

/** Element box → hotspot rect, in viewport CSS px. */
function toHotspot(box: { x: number; y: number; width: number; height: number }): Scene["hotspot"] {
  return { x: box.x, y: box.y, w: box.width, h: box.height };
}

/** Hold timings (ms) tuned so a demo reads comfortably on camera. */
const HOLD = {
  afterClick: 450,
  afterType: 350,
  caption: 950,
  beat: 1300,
  afterGoto: 500,
  afterCard: 320,
  afterScroll: 260,
  camera: 520,
};

export async function runStep(step: Step, ctx: StepContext, i: number): Promise<void> {
  const { page, mode } = ctx;
  const label = describe(step);
  log.step(`${String(i + 1).padStart(2, "0")}  ${label}`);

  // In check mode we assert the flow works as fast as possible: real actions
  // and state waits run, but cosmetic motion/holds are skipped.
  const cinematic = mode === "record";

  if ("goto" in step) {
    const target = resolveUrl(ctx.spec.url, step.goto);
    await page.goto(target, { waitUntil: "domcontentloaded" });
    await settle(page);
    zoomOut(ctx); // new page → establishing wide shot
    await ctx.rec.hold(HOLD.afterGoto);
    return;
  }

  if ("click" in step) {
    const box = await pointAt(ctx, step.click, cinematic);
    // Snap before the click: the interactive build shows the state you act on,
    // with the target as its hotspot, and advances to the result.
    snap(ctx, label, { hotspot: box ? toHotspot(box) : undefined });
    await locate(page, step.click).click();
    await ctx.rec.hold(HOLD.afterClick);
    return;
  }

  if ("dblclick" in step) {
    const box = await pointAt(ctx, step.dblclick, cinematic);
    snap(ctx, label, { hotspot: box ? toHotspot(box) : undefined });
    await locate(page, step.dblclick).dblclick();
    await ctx.rec.hold(HOLD.afterClick);
    return;
  }

  if ("hover" in step) {
    const box = await pointAt(ctx, step.hover, cinematic);
    snap(ctx, label, { hotspot: box ? toHotspot(box) : undefined });
    await locate(page, step.hover).hover();
    return;
  }

  if ("type" in step) {
    const { selector, text, delay } = step.type;
    const box = await pointAt(ctx, selector, cinematic);
    snap(ctx, label, { hotspot: box ? toHotspot(box) : undefined });
    const loc = locate(page, selector);
    await loc.click();
    await ctx.rec.typeInto(loc, text, delay);
    await ctx.rec.hold(HOLD.afterType);
    return;
  }

  if ("fill" in step) {
    await locate(page, step.fill.selector).fill(step.fill.text);
    return;
  }

  if ("press" in step) {
    if (step.press.selector) await locate(page, step.press.selector).press(step.press.key);
    else await page.keyboard.press(step.press.key);
    return;
  }

  if ("scrollTo" in step) {
    await locate(page, step.scrollTo).scrollIntoViewIfNeeded();
    await ctx.rec.hold(300);
    return;
  }

  if ("scroll" in step) {
    const { to, ms } = step.scroll;
    const targetY =
      typeof to === "number" ? to : await scrollTargetFor(page, toPlaywrightSelector(to));
    if (!cinematic) {
      await page.evaluate((y) => window.scrollTo(0, y), targetY);
      return;
    }
    zoomOut(ctx); // a tight crop during a scroll is disorienting
    const fromY = await page.evaluate(() => window.scrollY);
    // Prefer a synthesized pan: capturing a live scroll races Chromium's
    // rasterizer and bakes blank bands into the frames (see capture/pan.ts).
    const scaledMs = ctx.rec.timeline.scale(ms);
    const panned = ctx.capture
      ? await panScroll(page, ctx.capture, {
          fromY,
          toY: targetY,
          ms: scaledMs,
          fps: ctx.fps,
          viewport: ctx.spec.viewport,
          startT: ctx.rec.now(),
        })
      : 0;
    if (panned === 0) await smoothScroll(page, targetY, scaledMs);
    ctx.rec.timeline.advanceScaled(scaledMs);
    await ctx.rec.hold(HOLD.afterScroll);
    snap(ctx, label);
    return;
  }

  if ("waitFor" in step) {
    await locate(page, step.waitFor).waitFor({ state: "visible" });
    return;
  }

  if ("waitForUrl" in step) {
    await page.waitForURL(step.waitForUrl.includes("*") ? step.waitForUrl : `**${step.waitForUrl}**`);
    return;
  }

  if ("waitForNetworkIdle" in step) {
    await page.waitForLoadState("networkidle");
    return;
  }

  if ("expect" in step) {
    await assertExpectation(page, step.expect);
    return;
  }

  if ("caption" in step) {
    const cue = typeof step.caption === "string"
      ? { text: step.caption, ms: undefined as number | undefined, position: "bottom" as const }
      : step.caption;
    if (cinematic) {
      // Measure with the browser's own text engine so the renderer can wrap at
      // real word boundaries instead of guessing an average glyph width.
      const measure = await measureText(page, cue.text);
      ctx.captions.push({ t: ctx.now(), text: cue.text, ms: cue.ms, position: cue.position, measure });
      // Draw into the page only when nothing will composite the caption later,
      // and decide that with the *same* test the renderer uses. These had drifted
      // apart: this checked auto-zoom alone while the renderer also runs for a
      // device frame, padding or a background — so `zoom: false` with a frame
      // drew the caption in the page and composited it again on top, at a
      // different size. Two captions, in every frame, in the shipped encoder.
      const inPage = !compositesCaptions(ctx.spec.polish);
      if (inPage) await setCaption(page, cue.text);
      await ctx.rec.hold(cue.ms ?? HOLD.caption);
      if (inPage && cue.ms) await setCaption(page, "");
    }
    return;
  }

  if ("beat" in step) {
    const beatLabel = typeof step.beat === "string" ? step.beat : label;
    ctx.beats.push({ label: beatLabel, t: ctx.now() });
    // Hero/outro beats read best as wide establishing/closing shots.
    const wide = /hero|outro|intro|wide/i.test(beatLabel);
    if (wide) zoomOut(ctx);
    if (cinematic) {
      await ctx.rec.hold(HOLD.beat);
      // A descriptively-named beat is a chapter boundary; "hero"/"outro" are
      // camera directions, and a card right before has already named the scene.
      const lastChapter = [...ctx.scenes].reverse().find((s) => s.chapter)?.chapter;
      const isChapter = !CAMERA_BEATS.test(beatLabel) && lastChapter !== beatLabel;
      snap(ctx, beatLabel, { chapter: isChapter ? beatLabel : undefined });
    }
    return;
  }

  if ("card" in step) {
    const c = typeof step.card === "string" ? { title: step.card, subtitle: undefined, ms: 1800 } : step.card;
    // A title card is a natural chapter boundary — worth a storyboard frame.
    ctx.beats.push({ label: c.title, t: ctx.now() });
    if (cinematic) {
      zoomOut(ctx); // never crop into a full-screen card
      await showCard(page, c.title, c.subtitle);
      await ctx.rec.hold(Math.min(500, c.ms)); // let it settle before the snap
      ctx.cardAt = ctx.now();
      snap(ctx, c.title, { chapter: c.title, caption: c.subtitle });
      await ctx.rec.hold(Math.max(0, c.ms - 500));
      await hideCard(page);
      await ctx.rec.hold(HOLD.afterCard);
    }
    return;
  }

  if ("callout" in step) {
    const { selector, text, ms } = step.callout;
    // Waiting for visibility first means a callout also asserts the element
    // exists — so it works as a check-mode step, not just decoration.
    const loc = locate(page, selector);
    await loc.waitFor({ state: "visible" });
    if (cinematic) {
      const box = await loc.boundingBox();
      if (box) {
        // Pull the camera wide: the dim and the ring are the emphasis here, and
        // a tight crop would fight them (and clip the label). Author an
        // explicit `zoom:` step before the callout if you want both.
        zoomOut(ctx);
        await spotlight(page, { x: box.x, y: box.y, w: box.width, h: box.height }, text);
        await ctx.rec.hold(Math.min(450, ms));
        snap(ctx, label, { hotspot: toHotspot(box), caption: text });
        await ctx.rec.hold(Math.max(0, ms - 450));
        await clearSpotlight(page);
        await ctx.rec.hold(300); // let the dim fade out before moving on
      }
    }
    return;
  }

  if ("zoom" in step) {
    if (step.zoom === "out") {
      zoomOut(ctx);
      await ctx.rec.hold(HOLD.camera);
      return;
    }
    const { to, level, ms } = step.zoom;
    if (ctx.mode === "record" && ctx.spec.polish.zoom === "auto") {
      if (!to) {
        ctx.zoom.push({ t: ctx.now(), rect: null, ms });
      } else if (isTerminalTarget(ctx, to)) {
        // A terminal has no element tree, so the target is a region of the
        // emulator's grid rather than a box on the page.
        const rect = await terminalRect(ctx, to);
        if (rect) ctx.zoom.push({ t: ctx.now(), rect, level, ms });
        else log.debug(`zoom: nothing on the terminal matched "${to}" — camera held`);
      } else {
        const box = await locate(page, to).boundingBox();
        if (box) {
          ctx.zoom.push({
            t: ctx.now(),
            rect: { x: box.x, y: box.y, w: box.width, h: box.height },
            level,
            ms,
          });
        }
      }
    }
    await ctx.rec.hold(ms ?? HOLD.camera);
    return;
  }

  if ("hold" in step) {
    await ctx.rec.hold(step.hold);
    return;
  }

  if ("run" in step) {
    const term = requireTerminal(ctx, "run");
    const r = typeof step.run === "string" ? { cmd: step.run, hidden: false } : step.run;
    await term.run(r);
    // A hidden command produced no frames, so there is nothing to point the
    // camera at and nothing new for a storyboard beat to capture.
    if (!r.hidden) {
      await autoZoomOutput(ctx, term);
      snap(ctx, label);
    }
    return;
  }

  if ("expectOutput" in step) {
    await requireTerminal(ctx, "expectOutput").expectOutput(step.expectOutput);
    return;
  }

  if ("clear" in step) {
    if (step.clear) {
      await requireTerminal(ctx, "clear").clear();
      // The rows the camera was framing are gone; anything else crops to blank.
      zoomOut(ctx);
    }
    return;
  }

  if ("show" in step) {
    const term = requireTerminal(ctx, "show");
    await term.show(step.show);
    // Switching surfaces is a scene change: pull the camera wide, and give the
    // viewer a moment to register that they're looking at something else.
    zoomOut(ctx);
    await ctx.rec.hold(HOLD.afterGoto);
    snap(ctx, label);
    return;
  }

  throw new ReelError(`Unknown step: ${JSON.stringify(step)}`);
}

/** Terminal steps are meaningless without a terminal; say so precisely. */
function requireTerminal(ctx: StepContext, step: string): TerminalController {
  if (!ctx.term) {
    throw new ReelError(
      `\`${step}\` needs a \`terminal:\` block in the spec.`,
      "Add `terminal: { cols: 90, rows: 24 }` to enable terminal steps.",
    );
  }
  return ctx.term;
}

/**
 * Assert what the app actually rendered. `waitFor` only proves an element
 * appears; this checks text and counts, which is what makes `reel check` a
 * genuine smoke test rather than a selector-existence probe.
 */
async function assertExpectation(
  page: Page,
  e: { selector: string; text?: string; count?: number; visible: boolean },
): Promise<void> {
  const loc = page.locator(toPlaywrightSelector(e.selector));

  if (e.count !== undefined) {
    const actual = await pollFor(async () => {
      const n = await loc.count();
      return n === e.count ? n : null;
    });
    if (actual === null) {
      throw new ReelError(
        `expect failed: "${e.selector}" matched ${await loc.count()} element(s), expected ${e.count}.`,
      );
    }
  }

  if (e.text !== undefined) {
    const found = await pollFor(async () => {
      const txt = (await loc.first().textContent().catch(() => null)) ?? "";
      return txt.includes(e.text!) ? txt : null;
    });
    if (found === null) {
      const actual = (await loc.first().textContent().catch(() => null)) ?? "(no match)";
      throw new ReelError(
        `expect failed: "${e.selector}" does not contain "${e.text}".`,
        `Actual text: ${actual.trim().slice(0, 120)}`,
      );
    }
    return;
  }

  if (e.count === undefined) {
    // Bare expectation: presence (or absence) of the element.
    try {
      await loc.first().waitFor({ state: e.visible ? "visible" : "hidden" });
    } catch {
      throw new ReelError(
        `expect failed: "${e.selector}" is not ${e.visible ? "visible" : "hidden"}.`,
      );
    }
  }
}

/** Retry a check until it returns non-null, or the budget runs out. */
async function pollFor<T>(fn: () => Promise<T | null>, timeoutMs = 5_000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v !== null) return v;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Move the synthetic cursor to a target and pulse, before the real action — and
 * record the element box as an auto-zoom camera target so the view eases toward
 * whatever is being interacted with.
 */
async function pointAt(
  ctx: StepContext,
  selector: string,
  cinematic: boolean,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  if (!cinematic) return null;
  const box = await locate(ctx.page, selector).boundingBox();
  if (!box) return null;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  if (ctx.spec.polish.zoom === "auto") {
    ctx.zoom.push({ t: ctx.now(), rect: { x: box.x, y: box.y, w: box.width, h: box.height } });
  }
  if (ctx.spec.polish.cursor !== "none") {
    await ctx.rec.glideCursor(cx, cy);
    await ctx.rec.pulse(cx, cy);
  }
  return box;
}

/** Record a zoom-out (full-frame) camera target. */
function zoomOut(ctx: StepContext): void {
  if (ctx.mode === "record" && ctx.spec.polish.zoom === "auto") {
    ctx.zoom.push({ t: ctx.now(), rect: null });
  }
}

/**
 * Whether a camera target names a region of the terminal grid rather than an
 * element. Only meaningful while the terminal is the surface on screen: in a
 * hybrid spec `text=` addresses the app's DOM once `show: app` has run.
 */
function isTerminalTarget(ctx: StepContext, to: string): boolean {
  if (!ctx.term?.visible) return false;
  return to === "output" || to === "cursor" || to.startsWith("text=");
}

/**
 * Resolve a terminal camera target to a viewport rect.
 *
 * Returns null when the target can't be framed — no measurable grid, or text
 * that isn't on screen. Callers treat that as "leave the camera alone", which
 * is better than cropping to a region that holds nothing.
 */
async function terminalRect(ctx: StepContext, to: string): Promise<Rect | null> {
  const term = ctx.term;
  if (!term) return null;

  let region: GridRegion | null = null;
  if (to === "output") region = term.outputRegion()?.region ?? null;
  else if (to === "cursor") region = term.cursorRegion();
  else if (to.startsWith("text=")) region = term.findRegion(to.slice("text=".length));
  if (!region) return null;

  const metrics = await measureGrid(ctx.page);
  if (!metrics) return null;

  const maxRows = ctx.spec.polish.zoomRows;
  // Trim to the newest rows first, then to the columns those rows actually use:
  // fitting content before trimming rows would measure width against text that
  // is about to be cropped away.
  const framed = term.fit(tailRegion(region, maxRows));
  const rect = regionToRect(framed, metrics, term.cols);
  log.debug(
    `terminal zoom "${to}" → rows ${framed.row0}-${framed.row1}, cols ${framed.col0}-${framed.col1}`,
  );
  return rect;
}

/**
 * After a command runs, ease the camera onto what it printed.
 *
 * Opt-in via `polish.zoomOutput`, and silent on a command that printed nothing:
 * there is nothing new to look at, and a move onto a bare prompt reads as a
 * twitch rather than a camera decision.
 */
async function autoZoomOutput(ctx: StepContext, term: TerminalController): Promise<void> {
  if (ctx.mode !== "record") return;
  if (ctx.spec.polish.zoom !== "auto") return;
  if (!ctx.spec.polish.zoomOutput) return;
  const out = term.outputRegion();
  if (!out?.printed) return;
  const rect = await terminalRect(ctx, "output");
  if (!rect) return;
  ctx.zoom.push({ t: ctx.now(), rect });
  // Let the move finish inside the step, the way an explicit `zoom:` does.
  // Without this the camera is still at its old rect when the next step runs,
  // so a beat straight after a command captures the first frame of the ease —
  // which reads as the camera never having moved at all.
  await ctx.rec.hold(HOLD.camera);
}

function locate(page: Page, selector: string) {
  return page.locator(toPlaywrightSelector(selector)).first();
}

/** Best-effort settle after navigation without hanging on chatty apps. */
async function settle(page: Page): Promise<void> {
  await Promise.race([
    page.waitForLoadState("networkidle").catch(() => {}),
    page.waitForTimeout(2500),
  ]);
}

function resolveUrl(base: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return new URL(path, base).toString();
}

function describe(step: Step): string {
  const key = Object.keys(step)[0]!;
  const val = (step as Record<string, unknown>)[key];
  if (typeof val === "string") return `${key} ${val}`;
  if (typeof val === "number") return `${key} ${val}`;
  if (typeof val === "object" && val) {
    const v = val as Record<string, unknown>;
    if ("cmd" in v) return `${key} ${v.cmd}`;
    if ("selector" in v) return `${key} ${v.selector}${"text" in v ? ` "${v.text}"` : ""}`;
    if ("title" in v) return `${key} “${v.title}”`;
    if ("text" in v) return `${key} “${v.text}”`;
    if ("to" in v) return `${key} ${v.to}`;
  }
  return key;
}
