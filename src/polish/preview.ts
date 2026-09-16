import { isBranch, type OutputProfile, type Step } from "../spec/schema.js";
import type { CutRange } from "../encode/cut.js";

/**
 * Preview tiers — the difference between iterating on a demo and batch-rendering
 * one.
 *
 * A ten-minute render is minutes of waiting, and nobody tunes an annotation
 * against that. Both tiers here are command-line flags before they are anything
 * else: they pay for themselves at the terminal, and a UI that wants a preview
 * button later builds on the same verb rather than beside it.
 *
 *  - `--draft` renders the whole film small, at a low frame rate, video only,
 *    speaking only lines already in the voice cache. For seeing whether it
 *    flows.
 *  - `--only <beat>` renders one section at full quality. For seeing whether
 *    one shot is right.
 *
 * Neither changes what the demo *does*. A draft drives the same app through the
 * same steps and would produce the same master if asked to; that is what makes
 * it a preview of the real thing rather than a different film.
 */

export interface Preview {
  /** Small, low-fps, video-only, cached narration. */
  draft?: boolean;
  /** Render only the section a named beat labels. */
  only?: string;
}

/** Draft resolution. Small enough to be quick, big enough to read text in. */
const DRAFT_WIDTH = 720;
const DRAFT_FPS = 15;

/**
 * The output profile a draft renders at.
 *
 * Frame rate matters more than resolution here: the per-frame composite is the
 * expensive step, so halving the fps halves the work outright, where halving
 * the width only makes each frame cheaper.
 */
export function draftProfile(profile: OutputProfile): OutputProfile {
  return {
    ...profile,
    fps: Math.min(profile.fps, DRAFT_FPS),
    maxWidth: Math.min(profile.maxWidth, DRAFT_WIDTH),
    gif: { ...profile.gif, fps: Math.min(profile.gif.fps, DRAFT_FPS), maxWidth: DRAFT_WIDTH },
  };
}

/**
 * The section a named beat labels: from the beat before it to the beat after.
 *
 * Both ends rather than just the beat itself, because what you are usually
 * judging is how a moment *arrives* — an annotation appearing over a settled
 * screen, a camera move landing. A range starting exactly at the beat would cut
 * off the run-up that makes it readable.
 *
 * Returns null when nothing matches, so the caller can say which beats exist
 * instead of silently rendering the whole demo.
 */
export function previewRange(
  beats: { label: string; t: number }[],
  only: string,
  endMs: number,
): CutRange | null {
  const sorted = [...beats].sort((a, b) => a.t - b.t);
  const i = sorted.findIndex((b) => b.label.toLowerCase() === only.toLowerCase());
  if (i < 0) return null;
  const startMs = i > 0 ? sorted[i - 1]!.t : 0;
  const next = sorted[i + 1];
  return { startMs, endMs: next ? next.t : endMs };
}

/**
 * How far the drive has to go to cover a named beat: the index of the step
 * *after* the following beat, or null to run the whole spec.
 *
 * Stopping early is the only part of `--only` that saves drive time, and it is
 * sound because the steps after the section cannot change what is inside it —
 * the demo is linear and the frames are already stamped. Everything before it
 * still runs, because the app has state and there is no way to fast-forward an
 * app Reel knows nothing about.
 *
 * Branches are not descended into: a beat inside a branch path is reachable
 * only by taking that path, and stopping mid-branch would leave the recording
 * in a state the spec never describes.
 */
export function driveThrough(steps: Step[], only: string): number | null {
  const want = only.toLowerCase();
  let found = -1;
  for (const [i, step] of steps.entries()) {
    if (isBranch(step)) continue;
    if (!("beat" in step)) continue;
    const label = typeof step.beat === "string" ? step.beat : "";
    if (found < 0) {
      if (label.toLowerCase() === want) found = i;
      continue;
    }
    // The beat after the one asked for closes the section.
    return i + 1;
  }
  // Named beat is the last one (or absent): there is nothing to skip.
  return null;
}

/** Every beat a spec declares, for naming them back when `--only` misses. */
export function beatLabels(steps: Step[]): string[] {
  const out: string[] = [];
  for (const step of steps) {
    if (isBranch(step)) {
      for (const path of step.branch.paths) out.push(...beatLabels(path.steps as Step[]));
      continue;
    }
    if ("beat" in step && typeof step.beat === "string") out.push(step.beat);
    if ("card" in step) out.push(typeof step.card === "string" ? step.card : step.card.title);
  }
  return out;
}
