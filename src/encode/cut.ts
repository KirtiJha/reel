/**
 * Cutting a shorter demo out of a longer one.
 *
 * One recording, several deliverables. A three-minute walkthrough belongs on
 * YouTube, a ninety-second version on LinkedIn, forty seconds on Twitter and
 * something much shorter in a README — and the moment those become four specs
 * they start drifting, which is the exact failure this project exists to
 * prevent. So a cut is not a re-recording: it names a range of the demo that
 * was already filmed, and encodes the frames that are already on disk.
 *
 * That makes cuts cheap (one extra encode, no browser) and correct for free —
 * a cut cannot disagree with the master about what the app did, because it is
 * literally the same frames.
 *
 * Everything here is pure: no ffmpeg, no filesystem. The decisions worth
 * getting right — which frame a cut opens on, how a range is resolved from
 * beat labels, what happens to a caption that straddles the out point — are
 * testable without rendering anything.
 */

import type { CapturedFrame } from "../capture/frames.js";

/** Anything the recording placed on the timeline: a beat, a caption, a zoom. */
export interface Timed {
  t: number;
}

export interface CutRange {
  startMs: number;
  endMs: number;
}

/**
 * Where a cut starts and ends, given what the recording actually produced.
 *
 * `from` and `to` are beat labels or millisecond offsets. Labels are the point
 * of the feature: a cut written as `from: hero, to: pricing` keeps meaning the
 * right thing when the demo above it gets slower, while `from: 12400` silently
 * starts pointing at the middle of a sentence.
 */
export function resolveCutRange(
  cut: { from?: string | number; to?: string | number },
  beats: { label: string; t: number }[],
  durationMs: number,
): CutRange {
  const startMs = resolveEdge(cut.from, beats, 0, "from");
  const endMs = resolveEdge(cut.to, beats, durationMs, "to");

  if (endMs <= startMs) {
    throw new Error(
      `cut ends at ${endMs}ms, which is not after it starts (${startMs}ms) — ` +
        `check the order of "from" and "to".`,
    );
  }
  return { startMs, endMs };
}

function resolveEdge(
  edge: string | number | undefined,
  beats: { label: string; t: number }[],
  fallback: number,
  which: "from" | "to",
): number {
  if (edge === undefined) return fallback;
  if (typeof edge === "number") return edge;

  const beat = beats.find((b) => b.label === edge);
  if (!beat) {
    // Naming the beats that do exist turns this from a puzzle into a typo.
    const known = beats.length ? beats.map((b) => `"${b.label}"`).join(", ") : "none";
    throw new Error(`cut "${which}: ${edge}" names no beat in this demo. Beats recorded: ${known}.`);
  }
  return beat.t;
}

/**
 * The frames a cut is made of, rebased so the cut starts at zero.
 *
 * The subtle part is the opening frame. The screencast only emits a frame when
 * something changes, so at any given moment the picture on screen is the *last*
 * frame at or before it — often one emitted seconds earlier. Slicing to frames
 * whose timestamp falls inside the range therefore opens the cut on whatever
 * happens to change next, with the first stretch missing entirely.
 *
 * So the frame in effect at the in point is carried in and rebased to zero.
 */
export function sliceFrames(
  frames: CapturedFrame[],
  { startMs, endMs }: CutRange,
): CapturedFrame[] {
  if (frames.length === 0) return [];

  const inside = frames.filter((f) => f.t >= startMs && f.t < endMs);

  // The picture already on screen when the cut opens.
  let opening: CapturedFrame | undefined;
  for (const f of frames) {
    if (f.t <= startMs) opening = f;
    else break;
  }

  const kept =
    opening && (inside.length === 0 || inside[0]!.t > startMs) ? [opening, ...inside] : inside;

  return kept.map((f, i) => ({
    ...f,
    // The carried-in frame becomes the cut's frame zero; everything else keeps
    // its spacing relative to the in point.
    t: i === 0 ? 0 : Math.max(0, f.t - startMs),
  }));
}

/**
 * Timeline entries that fall inside a cut, rebased alongside the frames.
 *
 * An entry already in effect at the in point is carried in and clamped to zero,
 * for the same reason the opening frame is: a caption that appeared two seconds
 * before the cut starts is still on screen when it opens, and dropping it would
 * leave the cut narrating nothing.
 */
export function sliceTimeline<T extends Timed>(
  items: T[],
  { startMs, endMs }: CutRange,
  { carryIn = true }: { carryIn?: boolean } = {},
): T[] {
  const inside = items.filter((i) => i.t >= startMs && i.t < endMs);

  let carried: T | undefined;
  if (carryIn) {
    for (const i of items) {
      if (i.t <= startMs) carried = i;
      else break;
    }
  }

  const kept =
    carried && (inside.length === 0 || inside[0]!.t > startMs) ? [carried, ...inside] : inside;

  return kept.map((i, idx) => ({ ...i, t: idx === 0 && i.t <= startMs ? 0 : i.t - startMs }));
}

/**
 * Annotation spans that overlap a cut, clipped to it and rebased.
 *
 * `sliceTimeline` keys off a single `t`, which is the wrong question for a
 * span: a highlight that goes up before the in point and comes down after it is
 * on screen for the whole cut, yet has no `t` inside the range at all. Asking
 * whether the two intervals overlap is what keeps it.
 */
export function sliceSpans<T extends { from: number; to: number }>(
  spans: T[],
  { startMs, endMs }: CutRange,
): T[] {
  return spans
    .filter((s) => s.to > startMs && s.from < endMs)
    .map((s) => ({
      ...s,
      from: Math.max(0, s.from - startMs),
      to: Math.min(endMs, s.to) - startMs,
    }));
}

/** How long a cut runs, which is what the encoder needs to hold the last frame. */
export function cutDuration({ startMs, endMs }: CutRange): number {
  return endMs - startMs;
}
