import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { LoadedSpec } from "../spec/load.js";
import { resolveOutput } from "../spec/load.js";
import { defaultPath, trunkSteps, type BranchConfig, type Step } from "../spec/schema.js";
import type { Scene } from "../encode/html.js";
import { runStep, type StepContext } from "./steps.js";
import { Timeline } from "./timeline.js";
import { Recorder } from "./recorder.js";
import { setCursorAt, installOverlay } from "../overlay/overlay.js";
import { TerminalController } from "../terminal/controller.js";
import { log } from "../util/log.js";

/**
 * Recording the paths the video doesn't take.
 *
 * A video is linear, so the rendered GIF/MP4 follows one designated path. The
 * click-through can show all of them — but only if they were recorded, and an
 * app has state: you cannot rewind into the path not taken.
 *
 * The only approach that holds for an app Reel knows nothing about is to run
 * the trunk again. That's affordable because the replay is silent: no capture,
 * no demo time, no motion. The alternate itself is then captured as explicit
 * stills rather than a timeline — which is exactly what a click-through needs,
 * and guarantees these frames can never leak into the video.
 *
 * Known limit: a fresh browser context resets cookies and storage, but not a
 * server's database. For a server-backed app, pin the responses with `mock:` so
 * every path starts from the same place.
 */

export interface BranchPoint {
  id: string;
  /** Index of the branch step in `spec.steps`. */
  index: number;
  config: BranchConfig;
}

export interface AlternateResult {
  scenes: Scene[];
}

export interface AlternateOptions {
  browser: Browser;
  loaded: LoadedSpec;
  framesDir: string;
  points: BranchPoint[];
  fps: number;
  makeContext: (browser: Browser, loaded: LoadedSpec) => Promise<BrowserContext>;
  /**
   * False to only verify that each path still runs (drift detection), without
   * capturing anything. Every path is a flow that can break, so `reel check`
   * has to walk all of them, not just the one the video takes.
   */
  capture?: boolean;
}

let stillCounter = 0;

/** Capture the current page as a still and return its file name. */
async function captureStill(page: Page, framesDir: string): Promise<string | undefined> {
  try {
    // Two animation frames, same as the deterministic sampler: a still taken
    // straight after a mutation can race the compositor.
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
    const buf = await page.screenshot({ type: "jpeg", quality: 92 });
    const file = `alt-${String(stillCounter++).padStart(5, "0")}.jpg`;
    await writeFile(join(framesDir, file), buf);
    return file;
  } catch {
    return undefined;
  }
}

/**
 * Record every path the video doesn't take, as stills.
 * Returns the scenes to append to the interactive build.
 */
export async function recordAlternatePaths(opts: AlternateOptions): Promise<AlternateResult> {
  const { browser, loaded, framesDir, points, fps } = opts;
  const { spec } = loaded;
  const scenes: Scene[] = [];

  for (const point of points) {
    const skip = defaultPath(point.config);
    const alternates = point.config.paths.filter((p) => p !== skip);
    if (alternates.length === 0) continue;

    const trunk = trunkSteps(spec.steps as Step[], point.index);

    for (const path of alternates) {
      const pathId = `${point.id}:${slug(path.label)}`;
      log.step(`Branch “${path.label}” — replaying ${trunk.length} steps, then recording`);

      const context = await opts.makeContext(browser, loaded);
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(15_000);
        await page.goto(spec.url, { waitUntil: "domcontentloaded" }).catch(() => {});
        // Cards and spotlights draw through the overlay, so the stills need it
        // even though nothing is being filmed.
        await installOverlay(page, {
          cursor: spec.polish.cursor !== "none",
          captions: spec.polish.captions,
          accent: spec.polish.accent,
          animate: false,
        });

        const timeline = new Timeline(spec.polish.speed);
        const rec = new Recorder(page, null, timeline, {
          fps,
          deterministic: true,
          cinematic: false, // silent: no frames, no demo time, no motion
          animationsDisabled: spec.deterministic.disableAnimations,
        });
        const term = spec.terminal
          ? new TerminalController(
              page,
              spec.terminal,
              rec,
              spec.terminal.cwd ? resolveOutput(loaded, spec.terminal.cwd) : loaded.dir,
            )
          : null;

        const ctx: StepContext = {
          page,
          spec,
          mode: "check", // replay the trunk without recording anything
          fps,
          now: () => timeline.now(),
          beats: [],
          zoom: [],
          captions: [],
          rec,
          term,
          scenes: [],
        };

        for (const step of trunk) await runStep(step as Step, ctx, -1);

        const capturing = opts.capture !== false;

        // Now run the path itself — capturing a still per scene, or just
        // proving it still works.
        const pathScenes: Scene[] = [];
        const recCtx: StepContext = {
          ...ctx,
          mode: capturing ? "stills" : "check",
          scenes: pathScenes,
          currentPath: pathId,
        };

        for (let i = 0; i < path.steps.length; i++) {
          const before = pathScenes.length;
          await runStep(path.steps[i] as Step, recCtx, i);
          if (!capturing || pathScenes.length === before) continue;

          // Park the cursor on the target so a still reads like a frame from
          // the filmed path rather than a bare screenshot.
          const fresh = pathScenes[before]!;
          if (fresh.hotspot && spec.polish.cursor !== "none") {
            await setCursorAt(
              page,
              fresh.hotspot.x + fresh.hotspot.w / 2,
              fresh.hotspot.y + fresh.hotspot.h / 2,
            );
          }
          const file = await captureStill(page, framesDir);
          for (let k = before; k < pathScenes.length; k++) pathScenes[k]!.frameFile = file;
        }

        if (!capturing) {
          log.ok(`Branch path “${path.label}” still works.`);
          continue;
        }

        // A closing still, so the path ends on its result rather than on the
        // last thing that was clicked.
        const endFile = await captureStill(page, framesDir);
        if (endFile) {
          pathScenes.push({
            t: 0,
            label: `${path.label} — done`,
            path: pathId,
            frameFile: endFile,
            caption: pathScenes[pathScenes.length - 1]?.caption,
          });
        }

        scenes.push(...pathScenes.filter((s) => s.frameFile));
        log.debug(`branch path ${pathId}: ${pathScenes.length} scenes`);
      } finally {
        await context.close().catch(() => {});
      }
    }
  }

  return { scenes };
}

function slug(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "path";
}
