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

interface Resolved {
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
