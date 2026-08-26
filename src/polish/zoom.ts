/**
 * Auto-zoom geometry (product plan §9 — "the core craft").
 *
 * A zoom timeline is a list of keyframes captured while the demo runs: each
 * action records the bounding box of the element it touched, and wide moments
 * (page loads, hero/outro beats) record `null` to mean "show the whole frame".
 *
 * At render time we sample this timeline once per output frame, easing the
 * crop rectangle between keyframes so the camera glides toward whatever the
 * viewer should be looking at. Everything here is in CSS/viewport pixels; the
 * renderer scales into device pixels.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ZoomKey {
  /** ms since recording start. */
  t: number;
  /** Element box to focus, or null for a full-frame (zoomed-out) shot. */
  rect: Rect | null;
  /**
   * Explicit magnification (1 = whole viewport, 2 = half of it). Overrides the
   * automatic "element size × padding" sizing when set by a `zoom:` step.
   */
  level?: number;
  /** Camera move duration for this keyframe (ms). Defaults to the config. */
  ms?: number;
}

export interface ZoomConfig {
  viewport: { w: number; h: number };
  /** How much breathing room around the focused element (multiplier). */
  padding: number;
  /** Smallest crop as a fraction of the viewport → caps max zoom. */
  minCropFraction: number;
  /** Camera move duration between keyframes (ms). */
  transitionMs: number;
}

export const DEFAULT_ZOOM: Omit<ZoomConfig, "viewport"> = {
  padding: 3.2, // generous context around the focused element
  minCropFraction: 0.62, // never zoom past ~1.6× (keeps upscaled text sharp)
  transitionMs: 480,
};

/**
 * Turn a focused element box into a crop rectangle that (a) shares the
 * viewport's aspect ratio so scaling never distorts, (b) is centered on the
 * element, (c) is clamped to the viewport, and (d) never zooms in past the
 * configured maximum.
 */
export function toCrop(box: Rect, cfg: ZoomConfig, level?: number): Rect {
  const vp = cfg.viewport;
  const aspect = vp.w / vp.h;
  const minW = vp.w * cfg.minCropFraction;

  // An explicit level sizes the crop directly: the viewport divided by the
  // magnification, centered on the element. Author intent beats heuristics.
  if (level && level > 0) {
    const lw = clamp(vp.w / level, vp.w * 0.25, vp.w);
    return centerOn(box, lw, lw / aspect, vp);
  }

  // Start from the element size plus padding, in both axes.
  let cw = clamp(box.w * cfg.padding, minW, vp.w);
  let ch = cw / aspect;

  // Make sure the element's height also fits with padding.
  const neededH = clamp(box.h * cfg.padding, vp.h * cfg.minCropFraction, vp.h);
  if (neededH > ch) {
    ch = neededH;
    cw = ch * aspect;
    if (cw > vp.w) {
      cw = vp.w;
      ch = cw / aspect;
    }
  }
  if (ch > vp.h) {
    ch = vp.h;
    cw = ch * aspect;
  }

  return centerOn(box, cw, ch, vp);
}

/** Center a crop of the given size on a box, clamped inside the viewport. */
function centerOn(box: Rect, cw: number, ch: number, vp: { w: number; h: number }): Rect {
  const x = clamp(box.x + box.w / 2 - cw / 2, 0, Math.max(0, vp.w - cw));
  const y = clamp(box.y + box.h / 2 - ch / 2, 0, Math.max(0, vp.h - ch));
  return { x, y, w: cw, h: ch };
}

export function fullRect(cfg: ZoomConfig): Rect {
  return { x: 0, y: 0, w: cfg.viewport.w, h: cfg.viewport.h };
}

export interface Resolved {
  t: number;
  rect: Rect;
  /** Camera move duration into this keyframe (ms). */
  ms?: number;
}

/** Precompute the settled crop rect for each keyframe (plus a full-frame at t=0). */
export function resolveTimeline(keys: ZoomKey[], cfg: ZoomConfig): Resolved[] {
  const full = fullRect(cfg);
  const resolved: Resolved[] = [{ t: 0, rect: full }];
  for (const k of [...keys].sort((a, b) => a.t - b.t)) {
    resolved.push({ t: k.t, rect: k.rect ? toCrop(k.rect, cfg, k.level) : full, ms: k.ms });
  }
  return resolved;
}

/**
 * Sample the eased crop rectangle at time `t` (ms). Between keyframes the
 * camera holds; at each keyframe it eases from the previously settled rect to
 * the new one over `transitionMs`.
 */
export function sampleRect(resolved: Resolved[], t: number, cfg: ZoomConfig): Rect {
  // Find the last keyframe at or before t.
  let i = 0;
  for (let j = 0; j < resolved.length; j++) {
    if (resolved[j]!.t <= t) i = j;
    else break;
  }
  const to = resolved[i]!;
  const from = resolved[i - 1] ?? to;
  const progress = clamp01((t - to.t) / (to.ms || cfg.transitionMs));
  const eased = easeInOutCubic(progress);
  return lerpRect(from.rect, to.rect, eased);
}

function lerpRect(a: Rect, b: Rect, t: number): Rect {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    w: a.w + (b.w - a.w) * t,
    h: a.h + (b.h - a.h) * t,
  };
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * Drift the camera where the picture would otherwise be frozen.
 *
 * A demo that narrates over a settled screen has nothing moving in it: the
 * capture emits frames only on visual change, so a stretch with no change is a
 * single still image held for however long the voice takes. On Reel's own tour
 * that reached fifty-eight seconds.
 *
 * A slow push-in fixes it for almost nothing. Frames are already on disk and
 * the camera is already interpolated per output frame, so this is one more
 * keyframe rather than a new render path — and being a pure function of the
 * frame times, it cannot make two renders of one spec differ.
 *
 * Only genuinely idle stretches qualify. A stretch containing a real keyframe
 * is already moving, and drifting through it would fight the direction the
 * author asked for.
 */
export function withIdleMotion(
  resolved: Resolved[],
  frameTimes: number[],
  endMs: number,
  opts: { afterMs: number; scale: number },
): Resolved[] {
  const afterMs = Math.max(0, opts.afterMs);
  // Below 1 the crop shrinks, which reads as pushing in. At or above 1 there is
  // nothing to do, and a negative would invert the frame.
  if (!(opts.scale > 0 && opts.scale < 1)) return resolved;

  const marks = [...new Set(frameTimes.filter((t) => Number.isFinite(t) && t >= 0))].sort(
    (a, b) => a - b,
  );
  if (marks.length === 0) return resolved;
  if (marks[marks.length - 1]! < endMs) marks.push(endMs);

  const added: Resolved[] = [];
  for (let i = 1; i < marks.length; i++) {
    const from = marks[i - 1]!;
    const to = marks[i]!;
    const idle = to - from;
    if (idle <= afterMs) continue;

    const start = from + afterMs;
    // A stretch the author already directed is not idle.
    if (resolved.some((r) => r.t > from && r.t < to)) continue;

    // The authored shot governing this stretch is what we drift around.
    let base: Resolved | undefined;
    for (const r of resolved) {
      if (r.t <= start) base = r;
      else break;
    }
    if (!base) continue;

    // Where the camera actually is by now, which includes a drift added for an
    // earlier stretch. Reading only `resolved` here meant every stretch aimed
    // at the same shrunk rect, so a spec with no keyframes of its own — any
    // `zoom: false` chapter — pushed in once and then held a still for the rest
    // of the run, which is the exact thing this function exists to prevent.
    let held: Resolved = base;
    for (const r of added) if (r.t <= start) held = r;

    // Alternate in and out rather than always pushing in. Compounding the
    // shrink across a dozen silences would crop away most of the frame and
    // upscale what was left; easing back to the authored shot keeps the camera
    // moving through every one of them and never past a single step of zoom.
    const rect = sameRect(held.rect, base.rect) ? shrink(base.rect, opts.scale) : base.rect;

    added.push({
      t: Math.round(start),
      rect,
      // Eased across the whole remaining silence, so it reads as a drift rather
      // than a move that arrives and then sits still again.
      ms: Math.round(to - start),
    });
  }
  if (added.length === 0) return resolved;
  return [...resolved, ...added].sort((a, b) => a.t - b.t);
}

/** Same shot, to within rounding — sub-pixel differences are not a move. */
function sameRect(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.w - b.w) < 0.5 &&
    Math.abs(a.h - b.h) < 0.5
  );
}

/** Scale a crop about its centre — smaller rect, closer camera. */
function shrink(r: Rect, scale: number): Rect {
  const w = r.w * scale;
  const h = r.h * scale;
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}
