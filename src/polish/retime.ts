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
