import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Page } from "playwright-core";
import type { CapturedFrame } from "../capture/frames.js";
import type { Step } from "../spec/schema.js";
import { log } from "../util/log.js";

/**
 * What a failing step leaves behind.
 *
 * A drift check that prints "locator.click: Timeout 8000ms exceeded" tells you
 * a step broke, not why. The page was right there when it happened — the state
 * that would answer the question is the one thing not captured. Playwright
 * taught everyone to expect a screenshot on failure; this does the same, plus
 * the frames already in hand from the recording, so you get the approach as
 * well as the moment.
 *
 * Best-effort throughout: a failure report must never mask the failure it is
 * reporting.
 */

export interface FailureArtifacts {
  /** Directory everything was written to. */
  dir: string;
  /** Full-page screenshot at the moment of failure. */
  screenshot?: string;
  /** The last few seconds before it broke, as a GIF. */
  clip?: string;
  /** The page's HTML, for when the screenshot doesn't explain it. */
  html?: string;
  /** Machine-readable summary of what failed. */
  report: string;
}

export interface FailureContext {
  /** 1-based step number as the user counts them. */
  stepNumber: number;
  /** How the driver described the step in its log. */
  label: string;
  step: Step;
  error: Error;
  specPath: string;
  /** Frames captured so far, when recording. */
  frames?: CapturedFrame[];
  framesDir?: string;
  /** Where to write. Defaults to `.reel-failures/` beside the spec. */
  outDir?: string;
  /** Seconds of run-up to include in the clip. */
  clipSeconds?: number;
}

/** Terminal colour codes, which help in a console and hurt in a JSON file. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

export function stripAnsi(v: string): string {
  return v.replace(ANSI, "");
}

/** How much lead-up is useful without turning the clip into the whole demo. */
const DEFAULT_CLIP_SECONDS = 4;

export async function captureFailure(
  page: Page | null,
  ctx: FailureContext,
): Promise<FailureArtifacts | null> {
  const dir = ctx.outDir ?? join(dirname(resolve(ctx.specPath)), ".reel-failures");
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    return null; // nowhere to write — don't compound the original failure
  }

  const artifacts: FailureArtifacts = { dir, report: join(dir, "failure.json") };

  if (page) {
    try {
      // Full page, not just the viewport: the element the step wanted may have
      // moved below the fold, which is itself the answer.
      await page.screenshot({ path: join(dir, "failure.png"), fullPage: true });
      artifacts.screenshot = join(dir, "failure.png");
    } catch {
      /* page already closed or crashed */
    }
    try {
      const html = await page.content();
      await writeFile(join(dir, "failure.html"), html, "utf8");
      artifacts.html = join(dir, "failure.html");
    } catch {
      /* nothing to serialize */
    }
  }

  const clip = await writeClip(ctx, dir);
  if (clip) artifacts.clip = clip;

  const report = {
    spec: ctx.specPath,
    step: ctx.stepNumber,
    label: ctx.label,
    kind: Object.keys(ctx.step)[0] ?? "step",
    // Playwright's messages carry a "Call log:" tail that explains what it was
    // waiting for; it's the most useful part, so keep the whole thing — minus
    // the terminal colour codes, which are noise in a file meant for machines.
    error: stripAnsi(ctx.error.message),
    at: new Date().toISOString(),
    artifacts: {
      screenshot: artifacts.screenshot,
      clip: artifacts.clip,
      html: artifacts.html,
    },
  };
  try {
    await writeFile(artifacts.report, JSON.stringify(report, null, 2) + "\n", "utf8");
  } catch {
    /* the console output still carries the failure */
  }

  return artifacts;
}

/**
 * Render the run-up to the failure as a GIF from the frames already captured.
 * Only possible while recording — `check` captures nothing by design.
 */
async function writeClip(ctx: FailureContext, dir: string): Promise<string | undefined> {
  const { frames, framesDir } = ctx;
  if (!frames?.length || !framesDir) return undefined;

  const endT = frames[frames.length - 1]!.t;
  const windowMs = (ctx.clipSeconds ?? DEFAULT_CLIP_SECONDS) * 1000;
  const tail = frames.filter((f) => f.t >= endT - windowMs);
  if (tail.length === 0) return undefined;

  try {
    const { buildConcatManifest } = await import("../encode/encode.js");
    const { ffmpeg } = await import("../encode/ffmpeg.js");
    const manifest = buildConcatManifest(tail, 700, endT + 700);
    await writeFile(join(framesDir, "failure.concat"), manifest, "utf8");
    const out = join(dir, "failure.gif");
    await ffmpeg(
      [
        "-y",
        "-f", "concat", "-safe", "0", "-i", "failure.concat",
        "-vf",
        "fps=12,scale=720:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse",
        out,
      ],
      framesDir,
    );
    return out;
  } catch {
    // The encoder failing here is not worth surfacing — the screenshot and the
    // error message are the important part.
    return undefined;
  }
}

/** A single still is often enough; keep the copy path for callers that have one. */
export async function copyStill(from: string, dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const to = join(dir, name);
  await copyFile(from, to);
  return to;
}

/** Tell the user where to look, in the order they'll want it. */
export function reportFailure(a: FailureArtifacts | null): void {
  if (!a) return;
  log.info(`Failure artifacts → ${a.dir}`);
  if (a.screenshot) log.info(`  the page when it broke   ${a.screenshot}`);
  if (a.clip) log.info(`  the seconds before it     ${a.clip}`);
  if (a.html) log.info(`  the DOM at that moment    ${a.html}`);
}
