import type { TextMetrics } from "../overlay/overlay.js";

/**
 * Caption layout for the post-composite path.
 *
 * Captions are drawn onto the finished frame (not into the page) so a zoomed
 * crop can never clip them. That means Reel has to do the text layout itself:
 * real word wrapping from advances measured by the browser, a bar sized to the
 * text rather than guessed, and a fade at each end so captions don't hard-cut.
 */

export interface CaptionCue {
  /** ms since recording start. */
  t: number;
  text: string;
  /** Explicit duration; omit to run until the next cue (or the end). */
  ms?: number;
  position: "bottom" | "top";
  /** Word advances measured in-browser at a 100px reference size. */
  measure?: TextMetrics | null;
}

export interface CaptionLayout {
  lines: string[];
  /** Rendered width of each line, in output px. */
  widths: number[];
  /** 0–1 opacity, ramped at both ends. */
  alpha: number;
  position: "bottom" | "top";
}

/** Fade duration at each end of a caption (ms). */
const FADE_MS = 240;
/** Beyond this, a caption is a paragraph — truncate rather than wall off the app. */
const MAX_LINES = 3;
/** Advances come back measured at this size; scale linearly from it. */
const REFERENCE_SIZE = 100;
/** Fallback average advance (as a fraction of font size) when measurement failed. */
const FALLBACK_ADVANCE = 0.52;

export const CAPTION_FONT_STACK =
  `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

/**
 * The caption visible at time `t`, laid out and faded — or null when no caption
 * is on screen (before the first, after an expired one, between cues).
 */
export function captionAt(
  cues: CaptionCue[],
  t: number,
  endMs: number,
  maxTextWidth: number,
  fontSize: number,
): CaptionLayout | null {
  let i = -1;
  for (let j = 0; j < cues.length; j++) {
    if (cues[j]!.t <= t) i = j;
    else break;
  }
  if (i < 0) return null;

  const cue = cues[i]!;
  if (!cue.text.trim()) return null;
  const end = cue.ms ? cue.t + cue.ms : cues[i + 1]?.t ?? Math.max(endMs, cue.t + 1);
  if (t >= end) return null;

  const alpha = clamp01(Math.min((t - cue.t) / FADE_MS, (end - t) / FADE_MS));
  if (alpha <= 0.01) return null;

  const { lines, widths } = wrap(cue.text, cue.measure, maxTextWidth, fontSize);
  return { lines, widths, alpha, position: cue.position };
}

/** Greedy word wrap using measured advances, scaled to the output font size. */
function wrap(
  text: string,
  measure: TextMetrics | null | undefined,
  maxWidth: number,
  fontSize: number,
): { lines: string[]; widths: number[] } {
  const scale = fontSize / REFERENCE_SIZE;
  const words =
    measure?.words ??
    text
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => ({ word, adv: word.length * FALLBACK_ADVANCE * REFERENCE_SIZE }));
  const space = (measure?.space ?? REFERENCE_SIZE * 0.26) * scale;

  const lines: string[] = [];
  const widths: number[] = [];
  let current: string[] = [];
  let width = 0;

  for (const { word, adv } of words) {
    const w = adv * scale;
    const added = current.length ? space + w : w;
    if (current.length && width + added > maxWidth) {
      lines.push(current.join(" "));
      widths.push(width);
      current = [word];
      width = w;
    } else {
      current.push(word);
      width += added;
    }
  }
  if (current.length) {
    lines.push(current.join(" "));
    widths.push(width);
  }

  if (lines.length > MAX_LINES) {
    lines.length = MAX_LINES;
    widths.length = MAX_LINES;
    lines[MAX_LINES - 1] = `${lines[MAX_LINES - 1]!.replace(/[.,;:]?$/, "")}…`;
  }
  return { lines, widths: widths.map((w) => w * 1.03) }; // small safety margin
}

/**
 * A caption bar as a full-frame SVG, composited over the output. Sized to the
 * wrapped text, positioned top or bottom, and faded via group opacity.
 */
export function captionSvg(layout: CaptionLayout, w: number, h: number): string {
  const fs = captionFontSize(w);
  const padX = Math.round(fs * 1.1);
  const padY = Math.round(fs * 0.68);
  const lineH = Math.round(fs * 1.34);

  const textW = Math.max(...layout.widths, fs);
  const barW = Math.min(w * 0.88, textW + padX * 2);
  const barH = lineH * layout.lines.length + padY * 2 - (lineH - fs) / 2;
  const x = (w - barW) / 2;
  const margin = Math.round(h * 0.05);
  const y = layout.position === "top" ? margin : h - barH - margin;
  const r = Math.round(Math.min(barH * 0.32, fs * 0.9));

  const firstBaseline = y + padY + fs * 0.5 + (lineH - fs) / 4;
  const tspans = layout.lines
    .map(
      (line, i) =>
        `<text x="${(w / 2).toFixed(1)}" y="${(firstBaseline + i * lineH).toFixed(1)}" font-size="${fs}" ` +
        `font-family='${CAPTION_FONT_STACK}' font-weight="600" fill="#ffffff" ` +
        `text-anchor="middle" dominant-baseline="central">${escapeXml(line)}</text>`,
    )
    .join("");

  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <g opacity="${layout.alpha.toFixed(3)}">
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}"
        rx="${r}" fill="rgba(15,15,20,0.88)"/>
      ${tspans}
    </g>
  </svg>`;
}

/** Caption size scales with output width so it reads the same at any resolution. */
export function captionFontSize(outputWidth: number): number {
  return Math.max(14, Math.round(outputWidth * 0.026));
}

/** Text width available inside the bar, for wrapping. */
export function captionMaxTextWidth(outputWidth: number): number {
  const fs = captionFontSize(outputWidth);
  return outputWidth * 0.88 - Math.round(fs * 1.1) * 2;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
