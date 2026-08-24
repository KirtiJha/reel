/**
 * Comparing two renders.
 *
 * A demo lives in a README, so the thing a reviewer actually sees when a pull
 * request touches the app is a changed binary they can't read. `reel diff`
 * answers the question the diff can't: *which part of the demo moved*.
 *
 * The comparison only means something because Reel's output is deterministic.
 * Elsewhere a re-render differs everywhere by a pixel or two and every
 * comparison drowns in noise; here identical inputs give identical bytes, so a
 * difference is a real difference and can be reported without hedging.
 *
 * Everything in this module is pure — no ffmpeg, no sharp, no filesystem — so
 * the interesting decisions (what counts as changed, where a change starts and
 * ends, which beat it belongs to) are testable without rendering anything.
 */

/** How different two pixels must be before the difference is counted at all. */
export const CHANNEL_TOLERANCE = 12;

/**
 * Fraction of pixels that differ between two raw RGB buffers.
 *
 * The per-channel tolerance absorbs the only variation Reel's own encoders
 * introduce: GIF palette quantisation and lossy video both move flat colour by
 * a value or two, and counting that would make every comparison look changed.
 */
export function pixelDelta(a: Buffer, b: Buffer, channels = 3, tolerance = CHANNEL_TOLERANCE): number {
  if (a.length !== b.length) {
    throw new Error(`cannot compare buffers of different sizes (${a.length} vs ${b.length})`);
  }
  const pixels = Math.floor(a.length / channels);
  if (pixels === 0) return 0;

  let differing = 0;
  for (let p = 0; p < pixels; p++) {
    const i = p * channels;
    // Alpha is ignored deliberately: a fully transparent pixel reads as an
    // arbitrary colour, and comparing it produces differences nobody can see.
    for (let c = 0; c < 3; c++) {
      if (Math.abs(a[i + c]! - b[i + c]!) > tolerance) {
        differing++;
        break;
      }
    }
  }
  return differing / pixels;
}

export interface Sample {
  /** Time in the demo, ms from the start. */
  t: number;
  /** Fraction of pixels that differ, 0–1. */
  score: number;
  /** Set when one render simply ran out of frames before the other. */
  missing?: "before" | "after";
}

export interface Range {
  startMs: number;
  endMs: number;
  /** Worst single sample in the range. */
  peak: number;
  /** Average across the range, which is what "how much moved" really means. */
  mean: number;
  samples: number;
  /** True when part of this range exists in only one of the two renders. */
  truncated: boolean;
  /** Beat labels this range overlaps, when the render left beats behind. */
  beats: string[];
}

/**
 * Below this fraction of changed pixels, a sample counts as identical.
 *
 * The number that used to be here was 0.2%, justified as sitting "well under a
 * moving cursor (~0.3%) but above encoder dither". Measured against real
 * renders, both halves of that were wrong, and the consequence was the worst
 * kind of bug this tool can have — a demo whose price changed from £9 to USD 29
 * was reported as *identical*, frame for frame.
 *
 * What the measurements actually say, on a 1100×700 app compared at 480 wide:
 *
 *   unchanged demo, re-rendered      0.0000%   ← renders are deterministic,
 *   same render, mp4 vs webm         0.0000%     so the floor really is zero
 *   same render, mp4 vs gif          0.0728%   ← palette quantisation, diffuse
 *   a changed price                  0.1682%   ← the signal, and it was missed
 *
 * So the honest floor is not "a moving cursor" — two renders of one spec are
 * byte-identical, which is the whole point of the project — it is GIF palette
 * quantisation, and only when comparing *across* formats. 0.1% sits between
 * that and the smallest real change measured, with room either side.
 *
 * Tiling was tried first, on the theory that a text change is concentrated and
 * quantisation noise is diffuse. It separates them less well, not more (7.2%
 * against 12.5% on the worst tile), because quantisation concentrates in
 * gradients. The simple fraction, with an honest number, is better.
 */
export const DEFAULT_THRESHOLD = 0.001;

/**
 * Changed samples that are close together belong to the same event.
 *
 * A dialog opening is one change, but the samples through its animation dip
 * below the threshold whenever a frame lands mid-fade. Without bridging, a
 * single visual event is reported as five, and the report stops being readable.
 */
export const DEFAULT_MERGE_GAP_MS = 500;

export function groupRanges(
  samples: Sample[],
  beats: { label: string; t: number }[] = [],
  threshold = DEFAULT_THRESHOLD,
  mergeGapMs = DEFAULT_MERGE_GAP_MS,
  sampleMs = 0,
): Range[] {
  const changed = samples.filter((s) => s.score > threshold || s.missing);
  if (changed.length === 0) return [];

  const groups: Sample[][] = [[changed[0]!]];
  for (const s of changed.slice(1)) {
    const current = groups[groups.length - 1]!;
    const previous = current[current.length - 1]!;
    if (s.t - previous.t <= mergeGapMs) current.push(s);
    else groups.push([s]);
  }

  return groups.map((g) => {
    const scores = g.map((s) => s.score);
    const startMs = g[0]!.t;
    // A range covers the sample interval it sits in, not just the instants that
    // were measured; a single changed sample is a window, not a point.
    const endMs = g[g.length - 1]!.t + sampleMs;
    return {
      startMs,
      endMs,
      peak: Math.max(...scores),
      mean: scores.reduce((a, b) => a + b, 0) / scores.length,
      samples: g.length,
      truncated: g.some((s) => Boolean(s.missing)),
      beats: beatsOverlapping(startMs, endMs, beats),
    };
  });
}

/**
 * Which beats a time range touches.
 *
 * A beat runs until the next one starts, so a change is attributed to every
 * beat whose span it overlaps — a range that straddles a boundary genuinely
 * affects both, and naming only the first would send a reader to the wrong
 * part of the demo.
 */
export function beatsOverlapping(
  startMs: number,
  endMs: number,
  beats: { label: string; t: number }[],
): string[] {
  if (beats.length === 0) return [];
  const sorted = [...beats].sort((a, b) => a.t - b.t);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const beat = sorted[i]!;
    const to = i + 1 < sorted.length ? sorted[i + 1]!.t : Infinity;
    if (beat.t < endMs && to > startMs) out.push(beat.label);
  }
  return out;
}

export interface DiffReport {
  identical: boolean;
  /** Samples compared, and how many of them differed. */
  samples: number;
  changedSamples: number;
  /** Fraction of the demo's running time that differs, 0–1. */
  changedFraction: number;
  ranges: Range[];
  durationBeforeMs: number;
  durationAfterMs: number;
  fps: number;
}

export function summarize(
  samples: Sample[],
  ranges: Range[],
  durationBeforeMs: number,
  durationAfterMs: number,
  fps: number,
  threshold = DEFAULT_THRESHOLD,
): DiffReport {
  const changedSamples = samples.filter((s) => s.score > threshold || s.missing).length;
  return {
    identical: ranges.length === 0 && durationBeforeMs === durationAfterMs,
    samples: samples.length,
    changedSamples,
    changedFraction: samples.length ? changedSamples / samples.length : 0,
    ranges,
    durationBeforeMs,
    durationAfterMs,
    fps,
  };
}

/** `2.4s–4.2s`, the form a reader can scrub to. */
export function formatRange(r: { startMs: number; endMs: number }): string {
  return `${(r.startMs / 1000).toFixed(1)}s–${(r.endMs / 1000).toFixed(1)}s`;
}

/**
 * A change of 0.4% of pixels is a cursor; 40% is a redesign. Percentages this
 * small print as `0.0%`, which reads as "no change" — exactly the wrong
 * impression — so small values keep a second digit.
 */
export function formatShare(fraction: number): string {
  const pct = fraction * 100;
  if (pct >= 10) return `${pct.toFixed(0)}%`;
  if (pct >= 1) return `${pct.toFixed(1)}%`;
  return `${pct.toFixed(2)}%`;
}
