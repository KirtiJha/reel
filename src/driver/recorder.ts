import type { Locator, Page } from "playwright-core";
import type { ScreenshotCapture } from "../capture/screenshot.js";
import { cursorPathAt, moveCursorTo, pulseCursor, rippleAt, setCursorAt } from "../overlay/overlay.js";
import type { Timeline } from "./timeline.js";

/**
 * Everything that consumes demo time goes through here.
 *
 * Two recording modes share one interface:
 *  - **deterministic** (default): the driver samples the page at exact timeline
 *    positions and synthesizes motion frame by frame, so frame count and
 *    timestamps are a pure function of the spec. This generalizes the trick
 *    `capture/pan.ts` already used for scrolls.
 *  - **realtime**: the legacy free-running screenshot loop, kept as an escape
 *    hatch for apps whose own animation has to be filmed as it happens.
 */

export interface RecorderOptions {
  fps: number;
  /** Sample at exact timeline positions instead of on a wall-clock loop. */
  deterministic: boolean;
  /** False in `check` mode — run the actions, skip the cosmetics. */
  cinematic: boolean;
  /** Whether the app's own CSS animation is suppressed. */
  animationsDisabled: boolean;
}

/**
 * How long to really wait before sampling a held frame when the app's
 * animations are disabled. Long enough for a render to land, short enough that
 * a deterministic recording isn't paced by its own hold durations.
 */
const SETTLE_CAP_MS = 220;

export class Recorder {
  private cursor = { x: -100, y: -100 };

  constructor(
    private readonly page: Page,
    private readonly capture: ScreenshotCapture | null,
    readonly timeline: Timeline,
    private readonly opts: RecorderOptions,
  ) {}

  now(): number {
    return this.timeline.now();
  }

  get deterministic(): boolean {
    return this.opts.deterministic;
  }

  /** False in `check` mode, where actions run but nothing is filmed. */
  get cinematic(): boolean {
    return this.opts.cinematic;
  }

  /** A real wait that costs no demo time — for letting the app catch up. */
  async settle(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms).catch(() => {});
  }

  /** Capture the current state at the current timeline position. */
  async frame(): Promise<void> {
    if (this.opts.deterministic) await this.capture?.frameAt(this.timeline.now());
  }

  /**
   * Hold the current state for an authored duration. The frame is stamped at
   * the *start* of the hold, because a frame plays until the next one — so it
   * has to be on screen for the whole beat, not appear at the end of it.
   */
  async hold(ms: number): Promise<void> {
    if (!this.opts.cinematic) return;
    const d = this.timeline.scale(ms);
    if (!this.opts.deterministic) {
      await this.page.waitForTimeout(d);
      this.timeline.advanceScaled(d);
      return;
    }
    // With app animation suppressed there is nothing to film during a hold, so
    // wait only long enough for the render to settle and let the encoder
    // reproduce the hold from one frame.
    await this.page.waitForTimeout(
      this.opts.animationsDisabled ? Math.min(d, SETTLE_CAP_MS) : d,
    );
    await this.capture?.frameAt(this.timeline.now());
    this.timeline.advanceScaled(d);
  }

  /**
   * Capture the current state and advance the clock without waiting.
   *
   * For content that has already been produced and is only being replayed —
   * terminal output, typed characters — where a real wait would slow the
   * recording down without changing a single pixel.
   */
  async frameFor(ms: number): Promise<void> {
    if (!this.opts.cinematic) return;
    await this.capture?.frameAt(this.timeline.now());
    this.timeline.advanceScaled(this.timeline.scale(ms));
  }

  /**
   * Synthesize a motion segment: `render(p)` puts the page in its state at
   * progress p, and one frame is captured per output frame. The frame count is
   * `duration × fps`, so it never depends on how fast screenshots come back.
   */
  async motion(ms: number, render: (p: number) => Promise<void>): Promise<void> {
    if (!this.opts.cinematic) {
      await render(1);
      return;
    }
    const d = this.timeline.scale(ms);
    const n = Math.max(2, Math.round((d / 1000) * this.opts.fps));
    const start = this.timeline.now();
    for (let i = 0; i < n; i++) {
      const p = i / (n - 1);
      await render(p);
      await this.capture?.frameAt(start + Math.round((d * i) / (n - 1)));
    }
    this.timeline.advanceScaled(d);
  }

  /** Ease the synthetic cursor to a point, along the same arc `glide()` draws. */
  async glideCursor(x: number, y: number, ms = 520): Promise<void> {
    if (!this.opts.cinematic) return;
    const from = { ...this.cursor };
    this.cursor = { x, y };
    if (!this.opts.deterministic) {
      await moveCursorTo(this.page, x, y, { fps: this.opts.fps });
      this.timeline.advanceScaled(this.timeline.scale(ms));
      return;
    }
    await this.motion(ms, async (p) => {
      const at = cursorPathAt(from, { x, y }, p);
      await setCursorAt(this.page, at.x, at.y);
    });
  }

  /** Click feedback: the cursor presses in as a ring expands out. */
  async pulse(x: number, y: number, ms = 380): Promise<void> {
    if (!this.opts.cinematic) return;
    if (!this.opts.deterministic) {
      await pulseCursor(this.page, x, y);
      return;
    }
    await this.motion(ms, async (p) => {
      // Matches the page-side keyframes: press in by 35%, then release.
      const scale = p < 0.35 ? 1 - 0.14 * (p / 0.35) : 0.86 + 0.14 * ((p - 0.35) / 0.65);
      await setCursorAt(this.page, x, y, scale);
      await rippleAt(this.page, x, y, p);
    });
    await rippleAt(this.page, x, y, 1);
  }

  /**
   * Type text at a readable cadence, capturing one frame per character so the
   * typing reads on camera without depending on screenshot throughput.
   */
  async typeInto(loc: Locator, text: string, delayMs: number): Promise<void> {
    if (!this.opts.cinematic) {
      await loc.pressSequentially(text, { delay: 0 });
      return;
    }
    if (!this.opts.deterministic) {
      await loc.pressSequentially(text, { delay: delayMs });
      this.timeline.advanceScaled(this.timeline.scale(delayMs * text.length));
      return;
    }
    const per = this.timeline.scale(delayMs);
    for (const ch of text) {
      await loc.pressSequentially(ch, { delay: 0 });
      await this.capture?.frameAt(this.timeline.now());
      this.timeline.advanceScaled(per);
    }
  }
}
