import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import pc from "picocolors";
import {
  DEFAULT_MERGE_GAP_MS,
  DEFAULT_THRESHOLD,
  formatRange,
  formatShare,
  groupRanges,
  pixelDelta,
  summarize,
  type DiffReport,
  type Sample,
} from "../diff/compare.js";
import {
  DEFAULT_SAMPLE_FPS,
  decode,
  geometryOf,
  pixels,
  writeComparisonStrip,
  type Geometry,
} from "../diff/media.js";
import { readStamp } from "../spec/fingerprint.js";
import { log, ReelError } from "../util/log.js";

/**
 * `reel diff` — what changed between two renders.
 *
 * The gap this closes: a pull request that touches the app produces a changed
 * demo, and the review surface for that is a binary blob marked "modified". The
 * reviewer either takes it on trust or downloads both files and scrubs. Neither
 * is review.
 *
 * The comparison is only trustworthy because renders are deterministic — see
 * driver/timeline.ts. Without that, re-rendering the *same* spec would differ
 * everywhere and this command would report noise with total confidence, which
 * is worse than not having it.
 */

export interface DiffOptions {
  fps: number;
  threshold: number;
  /** Where to write the before/after/difference strips, or false to skip them. */
  out: string | false;
}

export async function diff(
  beforePath: string,
  afterPath: string,
  opts: DiffOptions,
): Promise<DiffReport & { strips: string[] }> {
  const before = resolve(beforePath);
  const after = resolve(afterPath);
  for (const f of [before, after]) {
    try {
      await stat(f);
    } catch {
      throw new ReelError(`No such file: ${f}`, "Pass two rendered demos — the GIF, MP4 or WebM.");
    }
  }

  const work = await mkdtemp(join(tmpdir(), "reel-diff-"));
  try {
    log.phase("Decoding");
    const [a, b] = await Promise.all([
      decode(before, join(work, "before"), opts.fps),
      decode(after, join(work, "after"), opts.fps),
    ]);
    log.info(`${a.frames.length} samples vs ${b.frames.length}, at ${opts.fps} fps`);

    // The newer render defines the grid; a viewport change is reported, not
    // quietly resized away.
    const geo = await geometryOf(b.frames[0]!);
    const beforeGeo = await geometryOf(a.frames[0]!);
    if (beforeGeo.width !== geo.width || beforeGeo.height !== geo.height) {
      log.warn(
        `Different shapes: ${beforeGeo.width}×${beforeGeo.height} → ${geo.width}×${geo.height}. ` +
          `Compared at the newer size, so most frames will read as changed.`,
      );
    }

    log.phase("Comparing");
    const samples = await compareFrames(a.frames, b.frames, geo, opts.fps);

    // Beat labels are a convenience, not a dependency: a render from another
    // checkout has no stamp beside it, and the diff still stands without one.
    const beats = await beatsFor(after, before);
    const sampleMs = 1000 / opts.fps;
    const ranges = groupRanges(samples, beats, opts.threshold, DEFAULT_MERGE_GAP_MS, sampleMs);
    const report = summarize(samples, ranges, a.durationMs, b.durationMs, opts.fps, opts.threshold);

    const strips =
      opts.out === false || ranges.length === 0
        ? []
        : await writeStrips(a.frames, b.frames, geo, samples, report, opts);

    return { ...report, strips };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Score every sample, including the ones only one render has.
 *
 * A demo that got longer is one of the most common real changes — a step added,
 * a pause lengthened — and treating the extra tail as "nothing to compare"
 * would report the single change nobody needs to be told about while hiding the
 * one they do.
 */
async function compareFrames(
  a: string[],
  b: string[],
  geo: Geometry,
  fps: number,
): Promise<Sample[]> {
  const samples: Sample[] = [];
  const n = Math.max(a.length, b.length);
  const shared = Math.min(a.length, b.length);

  for (let i = 0; i < n; i++) {
    const t = Math.round((i / fps) * 1000);
    if (i >= shared) {
      samples.push({ t, score: 1, missing: i >= a.length ? "before" : "after" });
      continue;
    }
    const [pa, pb] = await Promise.all([pixels(a[i]!, geo), pixels(b[i]!, geo)]);
    samples.push({ t, score: pixelDelta(pa!, pb!) });
  }
  return samples;
}

/** Beats recorded beside either render, preferring the newer one's. */
async function beatsFor(after: string, before: string): Promise<{ label: string; t: number }[]> {
  for (const file of [after, before]) {
    const stamp = await readStamp(join(dirname(file), ".reel-stamp.json"));
    if (stamp?.beats?.length) return stamp.beats;
  }
  return [];
}

/**
 * One strip per changed range, taken at the range's worst moment.
 *
 * The peak rather than the midpoint: a change that fades in is most legible at
 * its strongest, and a strip sampled mid-fade understates what happened.
 */
async function writeStrips(
  a: string[],
  b: string[],
  geo: Geometry,
  samples: Sample[],
  report: DiffReport,
  opts: DiffOptions,
): Promise<string[]> {
  const dir = opts.out as string;
  await mkdir(dir, { recursive: true });
  const written: string[] = [];

  for (let i = 0; i < report.ranges.length; i++) {
    const r = report.ranges[i]!;
    const inRange = samples.filter((s) => s.t >= r.startMs && s.t <= r.endMs && !s.missing);
    if (inRange.length === 0) continue; // range exists in only one render
    const peak = inRange.reduce((best, s) => (s.score > best.score ? s : best), inRange[0]!);
    const index = samples.indexOf(peak);
    if (index >= a.length || index >= b.length) continue;

    const out = join(dir, `${String(i + 1).padStart(2, "0")}-${(r.startMs / 1000).toFixed(1)}s.png`);
    await writeComparisonStrip(a[index]!, b[index]!, geo, out);
    written.push(out);
  }
  return written;
}

export function printDiff(report: DiffReport & { strips: string[] }): void {
  log.phase("Difference");

  if (report.identical) {
    log.ok("Identical — the two renders are the same demo, frame for frame.");
    return;
  }

  const before = (report.durationBeforeMs / 1000).toFixed(1);
  const after = (report.durationAfterMs / 1000).toFixed(1);
  if (report.durationBeforeMs !== report.durationAfterMs) {
    const delta = (report.durationAfterMs - report.durationBeforeMs) / 1000;
    log.info(`Length ${before}s → ${after}s (${delta > 0 ? "+" : ""}${delta.toFixed(1)}s)`);
  } else {
    log.info(`Length ${after}s, unchanged`);
  }
  log.info(
    `${report.changedSamples} of ${report.samples} samples differ (${formatShare(report.changedFraction)} of the running time)`,
  );

  for (const r of report.ranges) {
    // Aligned columns: the list is meant to be scanned for the biggest change,
    // and ragged numbers make that a reading exercise.
    const when = formatRange(r).padEnd(14);
    const size = formatShare(r.mean).padStart(6);
    const where = r.beats.length ? pc.dim(` · ${r.beats.join(", ")}`) : "";
    const only = r.truncated ? pc.yellow(" · only in one render") : "";
    console.error(`  ${pc.cyan(when)} ${size} of pixels${where}${only}`);
  }

  if (report.strips.length) {
    log.info(`\nBefore / after / difference:`);
    for (const s of report.strips) log.info(`  ${s}`);
  }
}

export const DIFF_DEFAULTS = {
  fps: DEFAULT_SAMPLE_FPS,
  threshold: DEFAULT_THRESHOLD,
};
