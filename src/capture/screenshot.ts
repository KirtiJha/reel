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
    private readonly opts: { fps: number },
  ) {}

  async start(): Promise<void> {
    await mkdir(this.framesDir, { recursive: true });
    this.startWall = Date.now();
    this.running = true;
    this.loop = this.run();
    log.debug(`screenshot capture started @ ${this.opts.fps}fps target`);
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

  async stop(): Promise<CapturedFrame[]> {
    this.running = false;
    await this.loop?.catch(() => {});
    // Guarantee a final frame at the end state even if it was deduped.
    await this.grabFinal();
    this.frames.sort((a, b) => a.t - b.t);
    log.debug(`captured ${this.frames.length} retina frames`);
    return this.frames;
  }

  /** Force-capture the final frame so the ending is always represented. */
  private async grabFinal(): Promise<void> {
    try {
      const buf = await this.page.screenshot({ type: "jpeg", quality: 92 });
      const t = Date.now() - this.startWall;
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
