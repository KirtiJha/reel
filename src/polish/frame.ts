import type { Polish } from "../spec/schema.js";

/**
 * Device frames, padding, and backgrounds (product plan §8 v0.2).
 *
 * This composites the captured app view inside optional window chrome
 * (traffic-light dots + URL pill), with a padded, coloured/gradient backdrop and
 * a soft drop shadow — the Screen-Studio-style presentation layer. It's a static
 * decoration, so the geometry and SVGs are computed once and reused for every
 * frame; only the content image changes.
 */

export interface FrameLayout {
  /** Final composited canvas size (even dimensions for yuv420p). */
  canvasW: number;
  canvasH: number;
  /** Where the content image is pasted. */
  contentX: number;
  contentY: number;
  contentW: number;
  contentH: number;
  /** Full-canvas background + window chrome, as an SVG string. */
  decorSvg: string;
  /** Content corner mask (rounds corners to match the window), or null. */
  contentMaskSvg: string | null;
}

/** Whether any framing/padding/background/radius composite is needed. */
export function framingEnabled(p: Polish): boolean {
  return p.frame !== "none" || p.padding > 0 || p.radius > 0;
}

/**
 * Whether the sharp render path runs — and therefore whether captions are drawn
 * in post rather than into the page.
 *
 * The driver and the encoder both need this answer and must never disagree: if
 * the driver thinks the caption will be composited it leaves the page alone, and
 * if it thinks otherwise it draws one. Getting that backwards yields either no
 * caption or two, so the question is asked in exactly one place.
 */
export function compositesCaptions(p: Polish): boolean {
  return p.zoom === "auto" || framingEnabled(p);
}

export function computeFrameLayout(
  p: Polish,
  contentW: number,
  contentH: number,
  url: string,
): FrameLayout {
  const sc = contentW / 1000; // scale reference px to actual output resolution
  const hasFrame = p.frame !== "none";
  const isBrowser = p.frame === "browser";

  // Title bar height and window corner radius derive from content width.
  const titleBar = hasFrame ? even(clamp(Math.round(contentW * (isBrowser ? 0.05 : 0.038)), 30, 68)) : 0;
  const winR = hasFrame ? clamp(Math.round(contentW * 0.016), 10, 26) : Math.round(p.radius * sc);
  const pad = even(Math.round((p.padding > 0 ? p.padding : hasFrame ? 60 : 0) * sc));

  const contentX = pad;
  const contentY = pad + titleBar;
  const canvasW = even(contentW + pad * 2);
  const canvasH = even(contentH + titleBar + pad * 2);

  const decorSvg = buildDecor({
    canvasW, canvasH, contentX, pad, titleBar, contentW, contentH, winR,
    background: p.background, frame: p.frame, url,
  });

  // Content corners: with a title bar, round only the bottom; without a frame,
  // round all four by `radius`.
  let contentMaskSvg: string | null = null;
  if (hasFrame) {
    contentMaskSvg = maskSvg(contentW, contentH, { tl: 0, tr: 0, br: winR, bl: winR });
  } else if (winR > 0) {
    contentMaskSvg = maskSvg(contentW, contentH, { tl: winR, tr: winR, br: winR, bl: winR });
  }

  return { canvasW, canvasH, contentX, contentY, contentW, contentH, decorSvg, contentMaskSvg };
}

interface DecorArgs {
  canvasW: number;
  canvasH: number;
  contentX: number;
  pad: number;
  titleBar: number;
  contentW: number;
  contentH: number;
  winR: number;
  background: string;
  frame: Polish["frame"];
  url: string;
}

function buildDecor(a: DecorArgs): string {
  const bg = backgroundFill(a.background, a.canvasW, a.canvasH);
  const winX = a.contentX;
  const winY = a.pad;
  const winW = a.contentW;
  const winH = a.titleBar + a.contentH;
  const shadowBlur = Math.round(a.contentW * 0.02);
  const shadowY = Math.round(a.contentW * 0.01);

  const chrome = a.frame !== "none" ? windowChrome(a) : "";

  return `<svg width="${a.canvasW}" height="${a.canvasH}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${bg.def}
    <filter id="reelShadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="${shadowY}" stdDeviation="${shadowBlur}" flood-color="#000000" flood-opacity="0.42"/>
    </filter>
  </defs>
  <rect width="${a.canvasW}" height="${a.canvasH}" fill="${bg.fill}"/>
  <rect x="${winX}" y="${winY}" width="${winW}" height="${winH}" rx="${a.winR}" ry="${a.winR}"
    fill="${a.frame !== "none" ? "#1c1d23" : "#000000"}" filter="url(#reelShadow)"
    ${a.frame === "none" ? 'fill-opacity="0.01"' : ""}/>
  ${chrome}
</svg>`;
}

function windowChrome(a: DecorArgs): string {
  const barY = a.pad;
  const cx = a.contentX + Math.round(a.titleBar * 0.42);
  const cy = barY + a.titleBar / 2;
  const r = Math.max(4, Math.round(a.titleBar * 0.11));
  const gap = r * 3.1;
  const dots = ["#ff5f57", "#febc2e", "#28c840"]
    .map((c, i) => `<circle cx="${cx + i * gap}" cy="${cy}" r="${r}" fill="${c}"/>`)
    .join("");

  let urlPill = "";
  if (a.frame === "browser") {
    const pillH = Math.round(a.titleBar * 0.52);
    const pillY = barY + (a.titleBar - pillH) / 2;
    const pillX = cx + 3 * gap + r * 2;
    const pillW = Math.min(a.contentW * 0.62, a.contentW - (pillX - a.contentX) - a.titleBar * 0.5);
    const fs = Math.round(pillH * 0.46);
    const text = truncateUrl(a.url, Math.floor(pillW / (fs * 0.52)));
    urlPill = `
    <rect x="${pillX}" y="${pillY}" width="${Math.max(0, pillW)}" height="${pillH}" rx="${pillH / 2}" fill="#0e0f14"/>
    <text x="${pillX + pillW / 2}" y="${pillY + pillH / 2}" font-size="${fs}" fill="#8a90a2"
      font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
      text-anchor="middle" dominant-baseline="central">${escapeXml(text)}</text>`;
  }
  return dots + urlPill;
}

/** Solid color, or a linear gradient built from any colors found in the string. */
function backgroundFill(bg: string, w: number, h: number): { fill: string; def: string } {
  const colors = bg.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)/g);
  if (bg.includes("gradient") && colors && colors.length >= 2) {
    const stops = colors
      .map((c, i) => `<stop offset="${(i / (colors.length - 1)) * 100}%" stop-color="${c}"/>`)
      .join("");
    return {
      fill: "url(#reelBg)",
      def: `<linearGradient id="reelBg" x1="0%" y1="0%" x2="100%" y2="100%">${stops}</linearGradient>`,
    };
  }
  return { fill: bg, def: "" };
}

function maskSvg(w: number, h: number, r: { tl: number; tr: number; br: number; bl: number }): string {
  const d =
    `M${r.tl},0 H${w - r.tr} A${r.tr},${r.tr} 0 0 1 ${w},${r.tr} ` +
    `V${h - r.br} A${r.br},${r.br} 0 0 1 ${w - r.br},${h} ` +
    `H${r.bl} A${r.bl},${r.bl} 0 0 1 0,${h - r.bl} ` +
    `V${r.tl} A${r.tl},${r.tl} 0 0 1 ${r.tl},0 Z`;
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="#fff"/></svg>`;
}

function truncateUrl(url: string, maxChars: number): string {
  const clean = url.replace(/^https?:\/\//, "");
  if (clean.length <= maxChars) return clean;
  return clean.slice(0, Math.max(3, maxChars - 1)) + "…";
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function even(n: number): number {
  return n % 2 === 0 ? n : n + 1;
}
