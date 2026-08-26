/**
 * Post-hoc reshaping of the demo timeline.
 *
 * Everything downstream of the driver — frames, captions, zoom keys, beats,
 * interactive scenes — is timestamped in demo time. That makes pacing a pure
 * remapping problem: cap the dead gaps, or scale the whole thing to fit a
 * target length, without re-recording anything.
 */

export interface RetimeOptions {
  /**
   * Cap any stretch where nothing changes at this many ms. Long holds are the
   * main reason a demo drags; the frames either side are untouched.
   */
  maxIdleMs?: number;
  /** Scale the result to exactly this length (ms). Applied after trimming. */
  targetMs?: number;
}

export interface Retimed {
  /** Map a demo-time position to its new position. */
  map(t: number): number;
  /** The new end of the recording. */
  endMs: number;
  /** True when the timeline was actually changed. */
  changed: boolean;
}

/**
 * Build a piecewise-linear remap from the frame timeline. Frames are the only
 * places where the picture can change, so the gaps between them are exactly the
 * intervals that can be safely compressed.
 */
export function buildRetime(
  frameTimes: number[],
  endMs: number,
  opts: RetimeOptions,
): Retimed {
  const identity: Retimed = { map: (t) => t, endMs, changed: false };
  if (!opts.maxIdleMs && !opts.targetMs) return identity;

  // Breakpoints: every frame, plus the end of the recording.
  const src = [...new Set(frameTimes.filter((t) => Number.isFinite(t)))].sort((a, b) => a - b);
  if (src.length === 0) return identity;
  if (src[src.length - 1]! < endMs) src.push(endMs);
  if (src.length < 2) return identity;

  // Trim: walk the gaps, capping each one.
  const dst: number[] = [src[0]!];
  const cap = opts.maxIdleMs && opts.maxIdleMs > 0 ? opts.maxIdleMs : Infinity;
  for (let i = 1; i < src.length; i++) {
    const gap = Math.min(src[i]! - src[i - 1]!, cap);
    dst.push(dst[i - 1]! + gap);
  }

  // Scale: stretch or squeeze the trimmed timeline onto the target length.
  let scale = 1;
  const trimmedEnd = dst[dst.length - 1]!;
  if (opts.targetMs && trimmedEnd > 0) scale = opts.targetMs / trimmedEnd;
  if (scale !== 1) for (let i = 0; i < dst.length; i++) dst[i] = dst[i]! * scale;

  const newEnd = dst[dst.length - 1]!;
  const changed = Math.abs(newEnd - endMs) > 0.5 || dst.some((v, i) => Math.abs(v - src[i]!) > 0.5);
  if (!changed) return identity;

  return {
    endMs: Math.round(newEnd),
    changed: true,
    map(t: number): number {
      if (t <= src[0]!) return Math.round(dst[0]! + (t - src[0]!) * scale);
      if (t >= src[src.length - 1]!) return Math.round(newEnd + (t - src[src.length - 1]!) * scale);
      // Binary search for the segment containing t.
      let lo = 0;
      let hi = src.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (src[mid]! <= t) lo = mid;
        else hi = mid;
      }
      const span = src[hi]! - src[lo]!;
      const p = span > 0 ? (t - src[lo]!) / span : 0;
      return Math.round(dst[lo]! + (dst[hi]! - dst[lo]!) * p);
    },
  };
}

/** A spoken line, in demo time, with the length it actually came back as. */
export interface SpokenSpan {
  t: number;
  durationMs: number;
}

/**
 * Stretch the timeline so every spoken line fits in the gap it was written for.
 *
 * This is the piece that makes narration land with the picture rather than race
 * it. A caption's `ms` was chosen for reading; the same sentence spoken takes
 * longer, so the interval starting at each line has to grow to at least the
 * length of its audio, plus a breath before the next one starts.
 *
 * Only stretching happens here — an interval that is already long enough is
 * left exactly as it was, so a well-paced demo is not disturbed by adding a
 * soundtrack, and a line that fits costs nothing.
 *
 * Everything downstream is timestamped in demo time, so this remains a remap:
 * frames, captions, zoom keys, beats and scenes all follow, and nothing is
 * re-recorded.
 */
export function buildAudioRetime(
  frameTimes: number[],
  lines: SpokenSpan[],
  endMs: number,
  opts: { breathMs?: number } = {},
): Retimed {
  const identity: Retimed = { map: (t) => t, endMs, changed: false };
  const spoken = lines
    .filter((l) => Number.isFinite(l.t) && l.durationMs > 0)
    .sort((a, b) => a.t - b.t);
  if (spoken.length === 0) return identity;

  const breath = Math.max(0, opts.breathMs ?? 0);

  // Breakpoints: every frame, every line boundary, and the end. Line starts
  // must be breakpoints or a stretch would be spread across a segment that
  // begins before the line does, and the audio would drift off its cue.
  const marks = new Set<number>();
  for (const t of frameTimes) if (Number.isFinite(t)) marks.add(Math.max(0, t));
  for (const l of spoken) marks.add(Math.max(0, l.t));
  marks.add(endMs);
  const src = [...marks].sort((a, b) => a - b);
  if (src.length < 2) return identity;

  // How much room each line needs, measured from where it starts.
  const needed = new Map<number, number>();
  for (const l of spoken) {
    const at = Math.max(0, l.t);
    needed.set(at, Math.max(needed.get(at) ?? 0, l.durationMs + breath));
  }

  // Walk forward, carrying each line's requirement until it is satisfied. A
  // line whose audio outlasts several segments stretches the last one it
  // reaches rather than smearing across all of them, which keeps every
  // intermediate cue where the author put it.
  const dst: number[] = [src[0]!];
  let owed = 0; // ms of audio still to be covered by the segments ahead
  for (let i = 1; i < src.length; i++) {
    const from = src[i - 1]!;
    const gap = src[i]! - from;
    const need = needed.get(from);
    if (need !== undefined) owed = Math.max(owed, need);
    const take = Math.max(gap, owed);
    dst.push(dst[i - 1]! + take);
    owed = Math.max(0, owed - take);
  }

  const newEnd = dst[dst.length - 1]! + owed;
  const changed = dst.some((v, i) => Math.abs(v - src[i]!) > 0.5) || owed > 0.5;
  if (!changed) return identity;

  return {
    endMs: Math.round(newEnd),
    changed: true,
    map(t: number): number {
      if (t <= src[0]!) return Math.round(dst[0]! + (t - src[0]!));
      const last = src.length - 1;
      if (t >= src[last]!) return Math.round(dst[last]! + (t - src[last]!));
      let lo = 0;
      let hi = last;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (src[mid]! <= t) lo = mid;
        else hi = mid;
      }
      const span = src[hi]! - src[lo]!;
      const p = span > 0 ? (t - src[lo]!) / span : 0;
      return Math.round(dst[lo]! + (dst[hi]! - dst[lo]!) * p);
    },
  };
}

/**
 * Make room for narration without stopping the demo.
 *
 * The companion to `buildAudioRetime`, and the one a product tour wants.
 * Stretching grows the hold a line sits on until the sentence finishes, which
 * never cuts narration off and never lets the picture move either: a long line
 * freezes the frame for as long as it takes to say. Measured on Reel's own
 * ten-minute tour, that produced three separate stretches where a single still
 * image held for the better part of a minute under a voiceover.
 *
 * Flow inverts the relationship. The demo runs at the pace it was authored, a
 * line is placed at its cue and plays over whatever happens next, and time is
 * inserted *only* where a line would collide with the one after it or run past
 * the end. What was a fifty-second freeze becomes fifty seconds of a product
 * doing things with someone talking over it, which is what a demo is.
 *
 * Frame times are not needed: the only positions that can move are the line
 * boundaries, so this is a step function with at most one insertion per line.
 */
export function buildFlowRetime(
  lines: SpokenSpan[],
  endMs: number,
  opts: { breathMs?: number } = {},
): Retimed {
  const identity: Retimed = { map: (t) => t, endMs, changed: false };
  const spoken = lines
    .filter((l) => Number.isFinite(l.t) && l.durationMs > 0)
    .sort((a, b) => a.t - b.t);
  if (spoken.length === 0) return identity;

  const breath = Math.max(0, opts.breathMs ?? 0);

  // Where time has to be inserted, and how much. Each deficit is measured
  // against the *original* spacing, which is correct because a line and the one
  // after it both shift by everything inserted before them — so the gap between
  // them changes only by what is inserted between them.
  const inserts: { at: number; add: number }[] = [];
  for (const [i, line] of spoken.entries()) {
    const start = Math.max(0, line.t);
    const last = i === spoken.length - 1;
    const nextAt = last ? endMs : Math.max(0, spoken[i + 1]!.t);
    // No breath after the final line: what follows is the end of the demo, and
    // the encoder already holds the last frame.
    const needed = line.durationMs + (last ? 0 : breath);
    const deficit = needed - (nextAt - start);
    if (deficit > 0.5) inserts.push({ at: nextAt, add: deficit });
  }
  if (inserts.length === 0) return identity;

  const total = inserts.reduce((n, i) => n + i.add, 0);
  // `at <= t` rather than `<`: the insertion belongs to the silence *before*
  // the next line, so the line itself starts after it and the frame that holds
  // is the one already on screen.
  const shift = (t: number): number =>
    inserts.reduce((n, i) => (i.at <= t ? n + i.add : n), 0);

  return {
    endMs: Math.round(endMs + total),
    changed: true,
    map: (t) => Math.round(t + shift(t)),
  };
}

/**
 * Parse an authored duration: a number of ms, or a string like "30s", "1500ms",
 * "1.5s". Returns undefined for anything unparseable.
 */
export function parseDuration(v: number | string | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.round(v) : undefined;
  const m = /^\s*([\d.]+)\s*(ms|s|m)?\s*$/i.exec(v);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = (m[2] ?? "s").toLowerCase();
  const ms = unit === "ms" ? n : unit === "m" ? n * 60_000 : n * 1000;
  return Math.round(ms);
}
