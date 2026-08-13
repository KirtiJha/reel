import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright-core";
import type { CapturedFrame } from "./frames.js";
import { log } from "../util/log.js";

/**
 * Retina frame capture via a timestamped `page.screenshot()` loop.
 *
 * Why not CDP screencast: screencast (and CDP captureScreenshot) only ever
 * returns CSS-resolution frames — on a 2× viewport you get 1000×720, not
 * 2000×1440. Only Playwright's `page.screenshot()` honors deviceScaleFactor, so
 * that's the sole path to true retina output.
 *
 * The loop runs concurrently with step execution, sampling the page at a target
 * rate. Two properties keep it efficient and correct:
 *  - **Dedup**: with the determinism layer (frozen clock, no animations), a
 *    static hold produces byte-identical PNGs; we skip them, so a 3s hold costs
 *    one frame, not 90. The encoder reconstructs the hold from timestamps.
 *  - **Timestamps**: every kept frame records its real capture time, so uneven
 *    sampling (a slow screenshot here and there) still plays back at the correct
 *    speed.
 */
export class ScreenshotCapture {
  private frames: CapturedFrame[] = [];
  private index = 0;
  private running = false;
  private paused = false;
  private startWall = 0;
  private loop: Promise<void> | null = null;
  private lastBuf: Buffer | null = null;

  constructor(
    private readonly page: Page,
    private readonly framesDir: string,
    private readonly opts: { fps: number; deterministic?: boolean },
  ) {}

  async start(): Promise<void> {
    await mkdir(this.framesDir, { recursive: true });
    this.startWall = Date.now();
    this.running = true;
    // A deterministic recording is sampled by the driver at exact timeline
    // positions, so there is no free-running loop — that loop is precisely what
    // makes frame count and timestamps depend on machine speed.
    if (!this.opts.deterministic) this.loop = this.run();
    log.debug(
      this.opts.deterministic
        ? "deterministic capture started (driver-sampled)"
        : `screenshot capture started @ ${this.opts.fps}fps target`,
    );
  }

  /**
   * Capture the current page state and stamp it at an exact timeline position.
   * Deduped like the live loop, so a hold that changes nothing stays one frame.
   */
  async frameAt(t: number): Promise<void> {
    let buf: Buffer;
    try {
      await this.waitForPaint();
      buf = await this.page.screenshot({ type: "jpeg", quality: 92 });
    } catch {
      return; // navigating or closed — the next sample will catch up
    }
    if (this.lastBuf && this.lastBuf.equals(buf)) return;
    this.lastBuf = buf;
    const file = `frame-${String(this.index++).padStart(6, "0")}.jpg`;
    await writeFile(join(this.framesDir, file), buf);
    this.frames.push({ file, t });
  }

  private async run(): Promise<void> {
    const interval = 1000 / this.opts.fps;
    while (this.running) {
      const started = Date.now();
      if (!this.paused) await this.grab();
      const wait = interval - (Date.now() - started);
      if (wait > 0) await sleep(wait);
    }
  }

  /** ms since capture started — the clock frame timestamps are relative to. */
  elapsed(): number {
    return Date.now() - this.startWall;
  }

  /**
   * Stop sampling without ending the recording. Used when a step synthesizes
   * its own frames (see capture/pan.ts) and live screenshots would race it.
   */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /**
   * Append an externally-rendered frame to the timeline. The buffer must match
   * the dimensions of captured frames so the encoder sees one uniform sequence.
   */
  async pushFrame(buf: Buffer, t: number): Promise<void> {
    const file = `frame-${String(this.index++).padStart(6, "0")}.jpg`;
    await writeFile(join(this.framesDir, file), buf);
    this.frames.push({ file, t });
    this.lastBuf = buf; // so the next live grab isn't deduped against a stale frame
  }

  /**
   * Block until the renderer has committed a frame.
   *
   * A deterministic sample is taken immediately after mutating the page (moving
   * the cursor, pressing a key), and the cursor sits on its own compositor
   * layer thanks to `will-change: transform`. Screenshotting straight away
   * races the commit, so the same demo could catch a style change one run and
   * miss it the next — which is exactly the nondeterminism this mode exists to
   * remove. Two animation frames guarantee the previous mutation is on screen.
   */
  private async waitForPaint(): Promise<void> {
    await this.page
      .evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      )
      .catch(() => {
        /* navigating — the screenshot below will report the real problem */
      });
  }

  /** Capture one frame, deduping against the previous one. */
  private async grab(): Promise<void> {
    let buf: Buffer;
    try {
      // Retina JPEG: high quality but ~2-3× faster to encode than PNG, so the
      // capture loop can keep up with the target fps for smooth motion. The
      // frame is downscaled at encode time, where q92 artifacts vanish.
      buf = await this.page.screenshot({ type: "jpeg", quality: 92 });
    } catch {
      // Page navigating / closed mid-shot — skip this tick.
      return;
    }
    if (this.lastBuf && this.lastBuf.equals(buf)) return; // unchanged → dedup
    this.lastBuf = buf;
    const t = Date.now() - this.startWall;
    const file = `frame-${String(this.index++).padStart(6, "0")}.jpg`;
    await writeFile(join(this.framesDir, file), buf);
    this.frames.push({ file, t });
  }

  /**
   * End the recording. `finalT` stamps the closing frame on a deterministic
   * run, where the driver — not the wall clock — owns the timeline.
   */
  /**
   * The frames captured so far, without ending the recording. Used to build the
   * run-up clip when a step fails mid-demo, where `stop()` would be wrong: the
   * recording is being abandoned, not finished.
   */
  captured(): CapturedFrame[] {
    return [...this.frames].sort((a, b) => a.t - b.t);
  }

  async stop(finalT?: number): Promise<CapturedFrame[]> {
    this.running = false;
    await this.loop?.catch(() => {});
    // Guarantee a final frame at the end state even if it was deduped.
    await this.grabFinal(finalT);
    this.frames.sort((a, b) => a.t - b.t);
    log.debug(`captured ${this.frames.length} retina frames`);
    return this.frames;
  }

  /** Force-capture the final frame so the ending is always represented. */
  private async grabFinal(finalT?: number): Promise<void> {
    try {
      const buf = await this.page.screenshot({ type: "jpeg", quality: 92 });
      const t = finalT ?? Date.now() - this.startWall;
      if (!this.lastBuf || !this.lastBuf.equals(buf)) {
        const file = `frame-${String(this.index++).padStart(6, "0")}.jpg`;
        await writeFile(join(this.framesDir, file), buf);
        this.frames.push({ file, t });
      }
    } catch {
      /* nothing to add */
    }
  }
}
