import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { LoadedSpec } from "../spec/load.js";
import { resolveOutput } from "../spec/load.js";
import { resolveOutputProfile } from "../spec/schema.js";
import { applyDeterminism } from "./determinism.js";
import { Timeline } from "./timeline.js";
import { Recorder } from "./recorder.js";
import { installOverlay } from "../overlay/overlay.js";
import { ScreenshotCapture } from "../capture/screenshot.js";
import { startApp, type RunningApp } from "./app.js";
import { runStep, type StepContext, type Mode } from "./steps.js";
import { encode, writeStoryboard } from "../encode/encode.js";
import { writeInteractiveHtml, type Scene } from "../encode/html.js";
import { renderWithZoom } from "../polish/render.js";
import { framingEnabled } from "../polish/frame.js";
import { narrate } from "../narrate/index.js";
import { buildRetime, parseDuration } from "../polish/retime.js";
import { applyRedaction } from "../privacy/redact.js";
import { applyMocks } from "../mock/mock.js";
import type { ZoomKey } from "../polish/zoom.js";
import type { CaptionCue } from "../polish/captions.js";
import { log, ReelError } from "../util/log.js";

export interface RunResult {
  frames: number;
  beats: number;
  durationMs: number;
  outputs: string[];
}

/**
 * Full record pipeline: boot app → launch browser → apply determinism →
 * install overlay → screencast → run steps → encode. `mode: "check"` runs the
 * same steps headlessly and skips capture/encode — that's the CI drift test.
 */
export async function record(loaded: LoadedSpec, mode: Mode = "record"): Promise<RunResult> {
  const { spec } = loaded;
  let app: RunningApp | null = null;
  let browser: Browser | null = null;
  const workDir = await mkdtemp(join(tmpdir(), "reel-"));
  const framesDir = join(workDir, "frames");

  const profile = resolveOutputProfile(spec.output);

  try {
    if (spec.run) {
      // Resolve the app's working directory relative to the spec file, so specs
      // are portable regardless of where `reel` is invoked from.
      const cwd = spec.run.cwd ? resolveOutput(loaded, spec.run.cwd) : loaded.dir;
      app = await startApp({ ...spec.run, cwd });
    }

    // Headless in both modes: screencast works headless and it's what CI runs,
    // so what you record is what `reel check` verifies.
    browser = await chromium.launch({ headless: true });
    const context = await createContext(browser, loaded);
    await applyDeterminism(context, spec.deterministic);
    if (spec.mock) await applyMocks(context, spec.mock, loaded);
    if (spec.redact) await applyRedaction(context, spec.redact);

    const page = await context.newPage();
    // In CI drift mode, fail fast: a gone selector shouldn't cost 30s.
    if (mode === "check") page.setDefaultTimeout(8_000);

    // A virtual timeline makes the output a function of the spec rather than of
    // machine speed; see driver/timeline.ts.
    const deterministic = spec.deterministic.timeline;
    const timeline = new Timeline(spec.polish.speed);

    const capture =
      mode === "record"
        ? new ScreenshotCapture(page, framesDir, { fps: profile.fps, deterministic })
        : null;

    // Navigate to the base URL first so the overlay has a document to attach to.
    await page.goto(spec.url, { waitUntil: "domcontentloaded" }).catch(() => {});
    if (mode === "record") {
      await installOverlay(page, {
        cursor: spec.polish.cursor !== "none",
        captions: spec.polish.captions,
        accent: spec.polish.accent,
        animate: !deterministic,
      });
      // Web fonts swap in a beat after first paint; starting capture before
      // they're ready bakes a flash of fallback text into the opening frames.
      await waitForFonts(page);
    }

    await capture?.start();
    const beats: { label: string; t: number }[] = [];
    const zoom: ZoomKey[] = [];
    const captions: CaptionCue[] = [];
    const scenes: Scene[] = [];
    const rec = new Recorder(page, capture, timeline, {
      fps: profile.fps,
      deterministic,
      cinematic: mode === "record",
      animationsDisabled: spec.deterministic.disableAnimations,
    });
    const ctx: StepContext = {
      page,
      spec,
      mode,
      fps: profile.fps,
      now: () => timeline.now(),
      beats,
      zoom,
      captions,
      capture,
      rec,
      scenes,
    };
    // The opening frame: without it the timeline starts at the first thing that
    // moves, and the lead-in has to be reconstructed at encode time.
    await rec.frame();

    // Re-install overlay on every navigation (new document wipes it).
    if (mode === "record") {
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) {
          installOverlay(page, {
            cursor: spec.polish.cursor !== "none",
            captions: spec.polish.captions,
            accent: spec.polish.accent,
          }).catch(() => {});
        }
      });
    }

    log.phase(`Recording “${spec.name}” (${spec.steps.length} steps)`);
    for (let i = 0; i < spec.steps.length; i++) {
      await runStep(spec.steps[i]!, ctx, i);
    }

    // A closing scene so the interactive build ends on the finished state.
    if (mode === "record") {
      scenes.push({ t: timeline.now(), label: "Done" });
    }

    let durationMs = timeline.now();
    const frames = (await capture?.stop(deterministic ? durationMs : undefined)) ?? [];

    // Pacing: cap dead air and/or fit a target length. Everything downstream is
    // timestamped in demo time, so this is a remap — no re-recording.
    const retime = buildRetime(frames.map((f) => f.t), durationMs, {
      maxIdleMs: spec.polish.trimIdle,
      targetMs: parseDuration(spec.output.targetDuration),
    });
    if (retime.changed) {
      for (const f of frames) f.t = retime.map(f.t);
      for (const c of captions) c.t = retime.map(c.t);
      for (const z of zoom) z.t = retime.map(z.t);
      for (const b of beats) b.t = retime.map(b.t);
      for (const s of scenes) s.t = retime.map(s.t);
      log.step(`Pacing ${(durationMs / 1000).toFixed(1)}s → ${(retime.endMs / 1000).toFixed(1)}s`);
      durationMs = retime.endMs;
    }

    if (mode === "check") {
      log.ok(`Drift check passed — all ${spec.steps.length} steps completed.`);
      return { frames: 0, beats: beats.length, durationMs, outputs: [] };
    }

    // Encode deliverables.
    const outputs: string[] = [];
    const storyboardDir = spec.output.storyboard
      ? resolveOutput(loaded, spec.output.storyboard)
      : undefined;
    const targets = {
      gif: spec.output.gif ? resolveOutput(loaded, spec.output.gif) : undefined,
      mp4: spec.output.mp4 ? resolveOutput(loaded, spec.output.mp4) : undefined,
      webm: spec.output.webm ? resolveOutput(loaded, spec.output.webm) : undefined,
    };
    const encodeOpts = {
      fps: profile.fps,
      maxWidth: profile.maxWidth,
      // The closing hold normally guarantees the ending is readable, but it
      // would push the result past an explicitly requested length — and a
      // target duration is usually a hard limit (a social embed's cap).
      tailMs: parseDuration(spec.output.targetDuration) ? 0 : 900,
      endMs: durationMs,
      gif: profile.gif,
    };
    // Skip the whole encode phase for an HTML-only build — it needs frames, not
    // a video, and the CFR expansion is the most expensive step in the pipeline.
    const needsEncode = Boolean(targets.gif || targets.mp4 || targets.webm || storyboardDir);
    if (needsEncode) log.phase("Encoding");

    // The sharp render path handles auto-zoom AND the presentation layer
    // (device frame / padding / background). Use it when either is requested;
    // otherwise the fast concat encoder suffices.
    if (!needsEncode) {
      /* nothing to encode */
    } else if (spec.polish.zoom === "auto" || framingEnabled(spec.polish)) {
      await renderWithZoom(
        frames,
        framesDir,
        { ...targets, storyboard: storyboardDir },
        encodeOpts,
        {
          timeline: zoom,
          viewport: spec.viewport,
          captions: spec.polish.captions ? captions : [],
          polish: spec.polish,
          url: spec.url,
        },
        beats,
      );
    } else {
      await encode(frames, framesDir, targets, encodeOpts);
      if (storyboardDir) await writeStoryboard(beats, frames, framesDir, storyboardDir);
    }
    for (const t of [targets.gif, targets.mp4, targets.webm, storyboardDir]) if (t) outputs.push(t);

    // Interactive build: the same demo as a self-contained click-through.
    if (spec.output.html) {
      const htmlPath = resolveOutput(loaded, spec.output.html);
      log.phase("Interactive");
      await writeInteractiveHtml({
        scenes,
        frames,
        framesDir,
        outPath: htmlPath,
        spec,
        maxWidth: profile.maxWidth,
      });
      outputs.push(htmlPath);
    }

    // Narration: subtitles and localized variants (all opt-in).
    const out = spec.output;
    if (out.subtitles || out.languages?.length) {
      let subtitleBase: string | undefined;
      if (out.subtitles === true) {
        const src = targets.mp4 ?? targets.webm ?? targets.gif;
        subtitleBase = src ? src.replace(/\.[^.]+$/, "") : undefined;
      } else if (typeof out.subtitles === "string") {
        subtitleBase = resolveOutput(loaded, out.subtitles).replace(/\.(srt|vtt)$/i, "");
      }
      log.phase("Narration");
      const narrated = await narrate({
        captions,
        endMs: durationMs,
        mp4: targets.mp4,
        webm: targets.webm,
        subtitleBase,
        languages: out.languages,
        workDir,
      });
      outputs.push(...narrated);
    }

    return { frames: frames.length, beats: beats.length, durationMs, outputs };
  } finally {
    await browser?.close().catch(() => {});
    await app?.stop().catch(() => {});
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Wait for web fonts to finish loading (bounded, so a font that never resolves
 * can't hang a recording). Without this the first frames can catch fallback
 * text mid-swap — a subtle but very visible "cheap recording" tell.
 */
async function waitForFonts(page: Page): Promise<void> {
  await Promise.race([
    page.evaluate(() => (document as any).fonts?.ready).catch(() => {}),
    page.waitForTimeout(3_000),
  ]);
}

async function createContext(browser: Browser, loaded: LoadedSpec): Promise<BrowserContext> {
  const { spec } = loaded;
  return browser.newContext({
    viewport: { width: spec.viewport.width, height: spec.viewport.height },
    deviceScaleFactor: spec.viewport.scale,
    colorScheme: spec.theme,
    reducedMotion: spec.deterministic.reducedMotion ? "reduce" : "no-preference",
    // Pin locale/timezone alongside the frozen clock — otherwise a CI runner in
    // another region renders different dates than the machine that recorded.
    locale: spec.deterministic.locale,
    timezoneId: spec.deterministic.timezone,
    storageState: spec.storageState ? resolveOutput(loaded, spec.storageState) : undefined,
  });
}

/** Convenience wrapper for `reel check`. */
export async function check(loaded: LoadedSpec): Promise<void> {
  try {
    await record(loaded, "check");
  } catch (err) {
    if (err instanceof ReelError) throw err;
    throw new ReelError(
      `Drift check FAILED: ${(err as Error).message}`,
      "A step could not complete — your demo no longer matches the app.",
    );
  }
}
