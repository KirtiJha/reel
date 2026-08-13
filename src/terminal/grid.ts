import type { Page } from "playwright-core";
import type { Rect } from "../polish/zoom.js";

/**
 * Grid geometry for the terminal layer.
 *
 * A web demo aims the camera at an element box. A terminal has no element tree
 * — the screen is one `<pre>` whose rows are separated by newlines — so the
 * only real geometry is the monospace grid the emulator already maintains.
 * This module turns a region of that grid into the pixel rect the camera
 * pipeline already speaks, which is the whole integration surface: everything
 * downstream of a `ZoomKey` is unchanged.
 */

/** A rectangular block of cells. Rows and columns are inclusive of `row0`/`col0`. */
export interface GridRegion {
  row0: number;
  /** Inclusive: a single-row region has `row1 === row0`. */
  row1: number;
  col0?: number;
  /** Exclusive, defaulting to the full width. */
  col1?: number;
}

/** Where the grid sits on the page, and how big one cell is. */
export interface CellMetrics {
  /** Viewport pixel coordinates of the top-left of cell (0, 0). */
  originX: number;
  originY: number;
  cellW: number;
  cellH: number;
}

/**
 * Convert a grid region to a viewport-pixel rect.
 *
 * Pure, so the arithmetic is unit-testable without a browser: measurement is
 * the caller's job (see `measureGrid`).
 */
export function regionToRect(region: GridRegion, m: CellMetrics, cols: number): Rect {
  const c0 = clamp(region.col0 ?? 0, 0, cols);
  const c1 = clamp(region.col1 ?? cols, c0 + 1, cols);
  const r0 = Math.max(0, Math.min(region.row0, region.row1));
  const r1 = Math.max(region.row0, region.row1);
  return {
    x: m.originX + c0 * m.cellW,
    y: m.originY + r0 * m.cellH,
    w: (c1 - c0) * m.cellW,
    h: (r1 - r0 + 1) * m.cellH,
  };
}

/**
 * Keep the last `maxRows` of a region.
 *
 * When a command prints more than fits the shot, the newest lines are the ones
 * being read — framing the head would park the camera on output that has
 * already scrolled out of interest.
 */
export function tailRegion(region: GridRegion, maxRows: number): GridRegion {
  if (maxRows <= 0) return region;
  const height = region.row1 - region.row0 + 1;
  if (height <= maxRows) return region;
  return { ...region, row0: region.row1 - maxRows + 1 };
}

/**
 * Narrow a region's columns to the text actually in it.
 *
 * Without this a region spans the whole grid width, and a crop that wide is
 * about the size of the viewport — the camera would "move" to exactly where it
 * already was. Framing the printed columns is what produces real magnification.
 * Rows are untouched; only the column bounds are computed.
 */
export function fitToContent(region: GridRegion, screen: string): GridRegion {
  const lines = screen.split("\n").slice(region.row0, region.row1 + 1);
  let col0 = Infinity;
  let col1 = 0;
  for (const line of lines) {
    const text = line.replace(/\s+$/, "");
    if (!text) continue; // a blank row constrains nothing
    col0 = Math.min(col0, text.length - text.trimStart().length);
    col1 = Math.max(col1, text.length);
  }
  // All blank: leave the columns alone rather than collapsing to zero width.
  if (col1 === 0) return region;
  return { ...region, col0: Number.isFinite(col0) ? col0 : 0, col1 };
}

/**
 * Find the rows spanned by `needle` in the terminal's plain text.
 *
 * Matching runs over the same text `expectOutput` reads, so `text=` in a spec
 * means the same thing in both places. Returns null when absent.
 */
export function findTextRegion(screen: string, needle: string): GridRegion | null {
  if (!needle) return null;
  const lines = screen.split("\n");

  // A single-line match is the common case and the cheapest to check.
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(needle)) return { row0: i, row1: i };
  }

  // Otherwise the needle may straddle a wrap: match against the joined text and
  // map the offset back to a row range.
  const flat = lines.join("\n");
  const at = flat.indexOf(needle);
  if (at < 0) return null;
  const row0 = flat.slice(0, at).split("\n").length - 1;
  const row1 = flat.slice(0, at + needle.length).split("\n").length - 1;
  return { row0, row1 };
}

/**
 * Measure the live grid in the page.
 *
 * Cell width comes from a probe span rather than `element width / cols`: the
 * screen is a flex child that is wider than the grid it holds, so dividing its
 * box would overstate every cell and skew the crop to the right.
 */
export async function measureGrid(page: Page): Promise<CellMetrics | null> {
  return page
    .evaluate(() => {
      const el = document.getElementById("__reel_term_screen__");
      if (!el) return null;
      const box = el.getBoundingClientRect();
      const cs = getComputedStyle(el);

      const probe = document.createElement("span");
      probe.textContent = "M".repeat(100);
      Object.assign(probe.style, {
        position: "absolute",
        visibility: "hidden",
        whiteSpace: "pre",
        font: cs.font,
        letterSpacing: cs.letterSpacing,
      } as CSSStyleDeclaration);
      el.appendChild(probe);
      const cellW = probe.getBoundingClientRect().width / 100;
      probe.remove();

      const lineH = parseFloat(cs.lineHeight);
      const cellH = Number.isFinite(lineH) && lineH > 0 ? lineH : parseFloat(cs.fontSize) * 1.45;

      return {
        originX: box.left + parseFloat(cs.paddingLeft || "0"),
        originY: box.top + parseFloat(cs.paddingTop || "0"),
        cellW,
        cellH,
      };
    })
    .catch(() => null);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
