import { writeFile, mkdir } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright-core";
import type { CapturedFrame } from "./frames.js";
import { log, ReelError } from "../util/log.js";
import { onCleanup } from "../util/dispose.js";

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
  /**
   * The first frame write that failed, kept rather than thrown.
   *
   * `run()` is a fire-and-forget loop — nobody awaits it until `stop()` — so a
   * rejection out of it is an unhandled rejection, which Node turns into a raw
   * stack and an immediate exit. That exit happens *outside* `record()`'s try,
   * so its `finally` never runs and the temp directory, the browser and the
   * app's detached process group all survive the process that owned them.
   * Recording it here and re-raising it from `stop()` puts the failure back
   * inside the block that knows how to clean up after it.
   */
  private failure: ReelError | null = null;
  /** Bytes written so far, which is what makes a "disk full" message useful. */
  private written = 0;
  private forgetCleanup: (() => void) | null = null;

  constructor(
    private readonly page: Page,
    private readonly framesDir: string,
    private readonly opts: { fps: number; deterministic?: boolean },
  ) {}

  async start(): Promise<void> {
    await mkdir(this.framesDir, { recursive: true });
    // Ctrl-C during a long render never reaches `record()`'s `finally`, and
    // this directory is where the render's intermediates live (the constant-fps
    // expansion and the processed sequence are both written under it), so it is
    // the tens of gigabytes worth reclaiming. Synchronous, because the signal
    // path cannot await — see util/dispose.ts.
    this.forgetCleanup = onCleanup(() => {
      if (process.env.REEL_KEEP_FRAMES) return;
      rmSync(this.framesDir, { recursive: true, force: true });
    });
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
    // Awaited by the driver, inside `record()`'s try — so this one can fail
    // loudly and land where the cleanup is.
    if (!(await this.write(buf, t))) throw this.failure!;
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
    if (!(await this.write(buf, t))) throw this.failure!;
    this.lastBuf = buf; // so the next live grab isn't deduped against a stale frame
  }

  /**
   * Write one frame and add it to the timeline. Returns false — rather than
   * rejecting — when the write failed, so the free-running loop can stop
   * cleanly instead of rejecting into nowhere.
   *
   * The first failure is the one kept: once the disk is full every subsequent
   * frame fails the same way, and the tenth ENOSPC says nothing the first did
   * not.
   */
  private async write(buf: Buffer, t: number): Promise<boolean> {
    if (this.failure) return false;
    const file = `frame-${String(this.index++).padStart(6, "0")}.jpg`;
    try {
      await writeFile(join(this.framesDir, file), buf);
    } catch (err) {
      this.failure = this.writeError(err as NodeJS.ErrnoException);
      this.running = false; // stop the loop rather than fail once per tick
      return false;
    }
    this.written += buf.length;
    this.frames.push({ file, t });
    return true;
  }

  /**
   * Turn an errno into something worth acting on.
   *
   * "ENOSPC: no space left on device" names neither the volume that filled nor
   * how much the render had already put there, and the volume is very rarely
   * the one the author is looking at — frames go to TMPDIR, while the spec and
   * its outputs are in the repository. Both facts are known here.
   */
  private writeError(err: NodeJS.ErrnoException): ReelError {
    const root = process.env.TMPDIR || tmpdir();
    const soFar = `${this.index} frames (${bytes(this.written)})`;
    if (err.code === "ENOSPC") {
      return new ReelError(
        `Ran out of disk space capturing frame ${this.index} — ${soFar} written to ${this.framesDir}.`,
        `Frames are staged under ${root}, not next to the spec. Free space there, or set ` +
          `TMPDIR to a volume with room for a few times ${bytes(this.written)} and record again. ` +
          `A shorter demo, a lower \`output.fps\` or \`--draft\` all cost less space.`,
      );
    }
    if (err.code === "ENOENT") {
      return new ReelError(
        `Reel's frame directory disappeared while recording: ${this.framesDir}.`,
        `Something outside Reel removed it mid-capture — a temp-file reaper over ${root} ` +
          "(systemd-tmpfiles, tmpwatch) is the usual cause, as is a second `reel` run cleaning up.",
      );
    }
    return new ReelError(
      `Could not write capture frame ${this.index} to ${this.framesDir}: ${err.message}`,
      `${soFar} had been written. Check that ${root} is writable and has space.`,
    );
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
    // Deliberately not thrown: this runs on the fire-and-forget loop, where a
    // rejection kills the process outright. `write` has recorded it and halted
    // the loop; `stop()` raises it where someone is listening.
    await this.write(buf, Date.now() - this.startWall);
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
    // Whatever the loop could not write is raised here, on the awaited path, so
    // it surfaces as a Reel error inside `record()` — which then tears down the
    // browser, the app and the temp directory on its way out.
    if (this.failure) throw this.failure;
    // Guarantee a final frame at the end state even if it was deduped.
    await this.grabFinal(finalT);
    if (this.failure) throw this.failure;
    this.frames.sort((a, b) => a.t - b.t);
    log.debug(`captured ${this.frames.length} retina frames (${bytes(this.written)})`);
    return this.frames;
  }

  /** Force-capture the final frame so the ending is always represented. */
  private async grabFinal(finalT?: number): Promise<void> {
    let buf: Buffer;
    try {
      buf = await this.page.screenshot({ type: "jpeg", quality: 92 });
    } catch {
      return; /* nothing to add */
    }
    if (this.lastBuf && this.lastBuf.equals(buf)) return;
    await this.write(buf, finalT ?? Date.now() - this.startWall);
  }

  /**
   * Drop the frames directory from the signal-path cleanup list, for a caller
   * that has already removed it itself. Not required: `rmSync` on a directory
   * that has gone is a no-op, so an unreleased disposer costs nothing beyond a
   * set entry — this exists so a long-lived process (`reel ci` walking fifty
   * specs) need not accumulate them.
   */
  release(): void {
    this.forgetCleanup?.();
    this.forgetCleanup = null;
  }
}

/** Sizes in a message a human reads, not in bytes. */
function bytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 && u > 0 ? v.toFixed(1) : Math.round(v)}${units[u]}`;
}
