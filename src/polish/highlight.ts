import type { Rect } from "./zoom.js";

/**
 * Annotation that does not interrupt.
 *
 * `callout` stops the film: it pulls the camera wide, dims everything but one
 * element, and holds the timeline while a label is read. That is the right
 * gesture for *stop and look at this*, and the wrong one for *and notice this,
 * as we go* — which is why Reel's own ten-minute tour contains zero callouts.
 * Every one of them would have frozen it.
 *
 * A highlight is the second gesture. It marks an element and gets out of the
 * way: the rest of the screen is untouched, the camera is unchanged, the
 * timeline does not pause, and several may be on screen at once. It outlives
 * the step that drew it — that is the whole point — so its lifetime is a span
 * rather than a hold.
 *
 * Like captions, highlights are composited onto finished frames rather than
 * drawn into the page. Three reasons, in order of how much they matter:
 *
 *  - **Determinism.** This is a pure function of the cue list and the frame
 *    time. Nothing is injected into the page, so no animation, no partial
 *    raster and no layout timing can make two renders of one spec differ.
 *  - **No blocking.** In-page drawing would need the driver to hold the clock
 *    while the annotation animates on, which is exactly what a highlight is
 *    for avoiding.
 *  - **Timing is exact.** A span has a real start and end in demo time instead
 *    of being cleared whenever the next step happens to run.
 *
 * The cost is that the box is measured once, when the step runs. An annotation
 * spanning a `scroll:` will not follow the element down the page. Recording a
 * track of boxes would fix it and is worth doing when something needs it; for
 * an annotation held over narration — what this exists for — one box is right.
 */

export type HighlightShape = "box" | "circle" | "underline";
export type HighlightStyle = "drawn" | "clean";

export interface HighlightCue {
  /** ms since recording start: when the annotation appears. */
  from: number;
  /**
   * ms when it disappears.
   *
   * `untilBeat` leaves this provisional — the beat it names has usually not
   * happened yet when the step runs — so it is finalized by `resolveHighlights`
   * once the whole demo has been driven and every beat has a time.
   */
  to: number;
  /** The element's box in CSS/viewport px, measured when the step ran. */
  rect: Rect;
  shape: HighlightShape;
  style: HighlightStyle;
  label?: string;
  /** A `until:` target, resolved against the beat list after the run. */
  untilBeat?: string;
}

/** A cue as it should be drawn at one instant. */
export interface ActiveHighlight {
  rect: Rect;
  shape: HighlightShape;
  style: HighlightStyle;
  label?: string;
  /** 0–1 opacity, ramped at both ends. */
  alpha: number;
  /** 0–1 progress of the stroke drawing itself on. */
  draw: number;
}

/** How long the stroke takes to draw on. */
const DRAW_MS = 420;
/** Fade at each end, so an annotation never hard-cuts. */
const FADE_MS = 200;
/** A highlight with neither `ms:` nor `until:` lasts this long. */
export const DEFAULT_HIGHLIGHT_MS = 2600;

/**
 * Finalize `until:` spans against the beats the run actually produced.
 *
 * A highlight that names a beat which never happened — a branch not taken, a
 * typo — runs to the end of the demo rather than vanishing or throwing. The
 * annotation is visible for too long, which an author can see and fix; the
 * alternatives are an annotation that silently never appears, and a render that
 * fails at the last step of a long recording.
 */
export function resolveHighlights(
  cues: HighlightCue[],
  beats: { label: string; t: number }[],
  endMs: number,
): HighlightCue[] {
  return cues.map((c) => {
    if (!c.untilBeat) return c;
    const beat = beats.find((b) => b.label === c.untilBeat && b.t > c.from);
    const { untilBeat: _drop, ...rest } = c;
    return { ...rest, to: beat ? beat.t : endMs };
  });
}

/** Every annotation on screen at `t`, with its fade and draw-on progress. */
export function highlightsAt(cues: HighlightCue[], t: number): ActiveHighlight[] {
  const active: ActiveHighlight[] = [];
  for (const c of cues) {
    if (t < c.from || t >= c.to) continue;
    const span = c.to - c.from;
    // A span shorter than the two fades gets a proportional share of each,
    // rather than a fade-out that starts before the fade-in has finished.
    const fade = Math.min(FADE_MS, span / 2);
    const inAlpha = fade > 0 ? (t - c.from) / fade : 1;
    const outAlpha = fade > 0 ? (c.to - t) / fade : 1;
    const alpha = clamp01(Math.min(inAlpha, outAlpha));
    const drawMs = Math.min(DRAW_MS, span);
    active.push({
      rect: c.rect,
      shape: c.shape,
      style: c.style,
      ...(c.label === undefined ? {} : { label: c.label }),
      alpha,
      draw: drawMs > 0 ? clamp01((t - c.from) / drawMs) : 1,
    });
  }
  return active;
}

/**
 * Draw the active annotations, mapped through the camera.
 *
 * `crop` is the rect the renderer is showing at this instant, in the same
 * CSS/viewport space the boxes were measured in. Mapping through it is what
 * makes an annotation part of the picture rather than pasted on top: it tracks
 * the zoom, drifts with idle motion, and slides off frame when the camera moves
 * away — where a caption deliberately does none of those things.
 */
export function highlightSvg(
  active: ActiveHighlight[],
  crop: Rect,
  outW: number,
  outH: number,
  accent: string,
): string {
  if (active.length === 0) return "";
  const sx = outW / crop.w;
  const sy = outH / crop.h;
  // Stroke weight follows the output size, not the zoom: a marker pen does not
  // get thicker because the camera pushed in.
  const stroke = Math.max(2, Math.round(outW * 0.0035));

  const parts: string[] = [];
  for (const a of active) {
    const box = {
      x: (a.rect.x - crop.x) * sx,
      y: (a.rect.y - crop.y) * sy,
      w: a.rect.w * sx,
      h: a.rect.h * sy,
    };
    // Off-frame: the camera has moved away. Cheap to skip and it keeps librsvg
    // from rasterizing geometry far outside the canvas.
    if (box.x > outW || box.y > outH || box.x + box.w < 0 || box.y + box.h < 0) continue;
    parts.push(shapeSvg(a, box, stroke, accent, outW, outH));
  }
  if (parts.length === 0) return "";
  return `<svg width="${outW}" height="${outH}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`;
}

function shapeSvg(
  a: ActiveHighlight,
  box: Rect,
  stroke: number,
  accent: string,
  outW: number,
  outH: number,
): string {
  // Seeded from the geometry, so the same annotation wobbles the same way in
  // every render. An unseeded jitter would be the one thing in this file
  // capable of breaking byte-identical output.
  const rnd = mulberry32(hash(`${a.shape}:${Math.round(box.x)}:${Math.round(box.y)}:${Math.round(box.w)}:${Math.round(box.h)}`));
  const pad = stroke * 2.5;
  const b = { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 };

  const { d, length } = a.shape === "circle"
    ? ellipsePath(b, a.style, rnd)
    : a.shape === "underline"
      ? underlinePath(b, a.style, rnd, stroke)
      : boxPath(b, a.style, rnd);

  // Drawing the stroke on: dash the whole path and retract the offset. Static
  // attributes, so this costs a render-time animation nothing.
  const drawn = length * (1 - a.draw);
  const path =
    `<path d="${d}" fill="none" stroke="${accent}" stroke-width="${stroke}" ` +
    `stroke-linecap="round" stroke-linejoin="round" ` +
    `stroke-dasharray="${length.toFixed(1)}" stroke-dashoffset="${drawn.toFixed(1)}"/>`;

  const label = a.label ? labelSvg(a.label, b, stroke, accent, outW, outH, a.draw) : "";
  return `<g opacity="${a.alpha.toFixed(3)}">${path}${label}</g>`;
}

/** A rounded rectangle, wobbled at the corners when drawn by hand. */
function boxPath(b: Rect, style: HighlightStyle, rnd: () => number): { d: string; length: number } {
  const r = Math.min(10, b.w / 6, b.h / 6);
  if (style === "clean") {
    const d =
      `M${f(b.x + r)},${f(b.y)} H${f(b.x + b.w - r)} A${f(r)},${f(r)} 0 0 1 ${f(b.x + b.w)},${f(b.y + r)} ` +
      `V${f(b.y + b.h - r)} A${f(r)},${f(r)} 0 0 1 ${f(b.x + b.w - r)},${f(b.y + b.h)} ` +
      `H${f(b.x + r)} A${f(r)},${f(r)} 0 0 1 ${f(b.x)},${f(b.y + b.h - r)} ` +
      `V${f(b.y + r)} A${f(r)},${f(r)} 0 0 1 ${f(b.x + r)},${f(b.y)} Z`;
    return { d, length: 2 * (b.w + b.h) };
  }
  // Hand-drawn: corners miss slightly and the closing stroke overshoots, the
  // two things that read as "drawn round it" rather than "a rectangle".
  const j = () => (rnd() - 0.5) * Math.min(9, b.h * 0.09);
  const p = [
    [b.x + j(), b.y + j()],
    [b.x + b.w + j(), b.y + j()],
    [b.x + b.w + j(), b.y + b.h + j()],
    [b.x + j(), b.y + b.h + j()],
  ] as const;
  // Past the start, like a pen lifting late. It has to continue in the
  // *direction of travel* — the last edge runs bottom-left to top-left, so the
  // overshoot goes up. Carrying it rightwards instead laid it along the top
  // edge, where it was perfectly invisible.
  const over = 6 + rnd() * 10;
  const d =
    `M${f(p[0][0])},${f(p[0][1])} L${f(p[1][0])},${f(p[1][1])} L${f(p[2][0])},${f(p[2][1])} ` +
    `L${f(p[3][0])},${f(p[3][1])} L${f(p[0][0])},${f(p[0][1])} ` +
    `L${f(p[0][0] + over * 0.3)},${f(p[0][1] - over)}`;
  return { d, length: 2 * (b.w + b.h) + over };
}

/** An ellipse round the element — the circling gesture, not a geometric circle. */
function ellipsePath(b: Rect, style: HighlightStyle, rnd: () => number): { d: string; length: number } {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  // Circling something always encloses more than its box.
  const rx = (b.w / 2) * 1.08;
  const ry = (b.h / 2) * 1.18;
  // Ramanujan — the dash length has to match the path or the draw-on desyncs.
  const length = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
  if (style === "clean") {
    const d =
      `M${f(cx - rx)},${f(cy)} A${f(rx)},${f(ry)} 0 1 1 ${f(cx + rx)},${f(cy)} ` +
      `A${f(rx)},${f(ry)} 0 1 1 ${f(cx - rx)},${f(cy)} Z`;
    return { d, length };
  }
  // Drawn: start a little past the left, tilt, and close past the start.
  const tilt = (rnd() - 0.5) * 8;
  const wob = 1 + (rnd() - 0.5) * 0.08;
  const d =
    `M${f(cx - rx)},${f(cy + ry * 0.14)} ` +
    `A${f(rx)},${f(ry * wob)} ${f(tilt)} 1 1 ${f(cx + rx)},${f(cy)} ` +
    `A${f(rx)},${f(ry * wob)} ${f(tilt)} 1 1 ${f(cx - rx * 0.96)},${f(cy - ry * 0.1)}`;
  return { d, length: length * 1.06 };
}

/** A stroke under the element, the way you underline a word while talking. */
function underlinePath(
  b: Rect,
  style: HighlightStyle,
  rnd: () => number,
  stroke: number,
): { d: string; length: number } {
  const y = b.y + b.h - stroke;
  if (style === "clean") {
    return { d: `M${f(b.x)},${f(y)} H${f(b.x + b.w)}`, length: b.w };
  }
  // A hand-drawn line sags in the middle and lifts at the end.
  const sag = 2 + rnd() * 4;
  const lift = (rnd() - 0.5) * 5;
  const d =
    `M${f(b.x)},${f(y + lift)} Q${f(b.x + b.w / 2)},${f(y + sag + 3)} ${f(b.x + b.w)},${f(y - lift)}`;
  return { d, length: b.w * 1.04 };
}

/**
 * The optional label, placed above the annotation — or below it when the
 * annotation is near the top of frame and there is no room above.
 */
function labelSvg(
  text: string,
  b: Rect,
  stroke: number,
  accent: string,
  outW: number,
  outH: number,
  draw: number,
): string {
  const fs = Math.max(13, Math.round(outW * 0.021));
  const padX = Math.round(fs * 0.72);
  const padY = Math.round(fs * 0.42);
  // No in-browser measurement here, unlike captions: a label is a few words by
  // design, so an advance estimate is enough and keeps this a pure function.
  const textW = text.length * fs * 0.54;
  const barW = Math.min(outW * 0.5, textW + padX * 2);
  const barH = fs + padY * 2;
  const above = b.y - barH - stroke * 3;
  const y = above > 4 ? above : Math.min(b.y + b.h + stroke * 3, outH - barH - 4);
  const x = clamp(b.x + b.w / 2 - barW / 2, 4, Math.max(4, outW - barW - 4));
  // Fades in behind the stroke, so the shape lands first and the words follow.
  const alpha = clamp01((draw - 0.45) / 0.4);
  if (alpha <= 0) return "";
  return (
    `<g opacity="${alpha.toFixed(3)}">` +
    `<rect x="${f(x)}" y="${f(y)}" width="${f(barW)}" height="${f(barH)}" rx="${f(Math.min(barH / 2, 10))}" ` +
    `fill="rgba(15,15,20,0.92)" stroke="${accent}" stroke-width="1"/>` +
    `<text x="${f(x + barW / 2)}" y="${f(y + barH / 2)}" font-size="${fs}" ` +
    `font-family='${LABEL_FONT_STACK}' font-weight="600" fill="#ffffff" ` +
    `text-anchor="middle" dominant-baseline="central">${escapeXml(text)}</text>` +
    `</g>`
  );
}

const LABEL_FONT_STACK =
  `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

function f(n: number): string {
  return n.toFixed(1);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function escapeXml(s: string): string {
  return s.replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!,
  );
}

/** Stable 32-bit hash of the geometry, so the wobble is reproducible. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Small seeded PRNG — the jitter must never come from Math.random(). */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
