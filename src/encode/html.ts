import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CapturedFrame } from "../capture/frames.js";
import type { Spec } from "../spec/schema.js";
import { PLAYER_CSS, PLAYER_JS } from "./player.js";
import { log } from "../util/log.js";

/**
 * Interactive HTML output — the format a GIF can't be.
 *
 * A recorded demo is passive: the viewer watches at your pace. The interactive
 * build turns the same spec into a click-through: each meaningful moment is a
 * scene, the element you acted on becomes a hotspot, and the viewer advances at
 * their own pace. This is what interactive-demo SaaS sells; here it falls out of
 * the spec you already wrote, as one self-contained file with no hosting.
 *
 * Scenes use the RAW captured frames rather than the polished render, so hotspot
 * coordinates map linearly from viewport CSS pixels — no unwinding of the zoom
 * crop or device-frame offsets. The presentation (rounded corners, shadow,
 * background) is re-created in CSS instead, which also keeps the file small.
 */

export interface Hotspot {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Scene {
  /** ms since recording start — used to pick the frame that represents it. */
  t: number;
  /** Short description of what's happening (from the step). */
  label: string;
  /** The caption on screen at this moment, if any. */
  caption?: string;
  /** Set when this scene opens a chapter (a card or a hero/outro beat). */
  chapter?: string;
  /** The element to click, in viewport CSS px. */
  hotspot?: Hotspot;
}

export interface HtmlOptions {
  scenes: Scene[];
  frames: CapturedFrame[];
  framesDir: string;
  outPath: string;
  spec: Spec;
  /** Cap the embedded image width (px). */
  maxWidth: number;
  /** End of the recording (ms), so the last scene gets a real duration. */
  durationMs?: number;
}

/** Widest sensible embedded frame — beyond this the file balloons for no gain. */
const MAX_EMBED_WIDTH = 1200;

/**
 * URL-safe slug for a chapter, so a link to a scene survives a re-record as
 * long as the chapter keeps its name.
 */
export function slugify(v: string): string {
  return v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * How long each scene was on screen, from the recorded timeline. Autoplay uses
 * these instead of a fixed interval, so the click-through breathes the way the
 * video does — a title card lingers, a click doesn't.
 */
export function sceneDurations(times: number[], endMs: number): number[] {
  return times.map((t, i) => {
    const next = times[i + 1] ?? Math.max(endMs, t);
    return Math.max(600, Math.round(next - t));
  });
}

/** Chapter slugs, de-duplicated so two chapters with one name stay addressable. */
export function assignSlugs(chapters: (string | undefined)[]): (string | null)[] {
  const used = new Map<string, number>();
  return chapters.map((c) => {
    if (!c) return null;
    const base = slugify(c) || "chapter";
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}

export async function writeInteractiveHtml(opts: HtmlOptions): Promise<void> {
  const sharp = (await import("sharp")).default;
  const { scenes, frames, framesDir, outPath, spec } = opts;

  if (scenes.length === 0) {
    log.warn("No interactive scenes were recorded — skipping HTML output.");
    return;
  }

  const width = Math.min(opts.maxWidth || MAX_EMBED_WIDTH, MAX_EMBED_WIDTH);
  const cache = new Map<string, number>(); // frame file → image index
  const images: string[] = [];
  const built: (Scene & { image: number })[] = [];

  for (const scene of scenes) {
    const frame = nearestFrame(frames, scene.t);
    if (!frame) continue;
    let index = cache.get(frame.file);
    if (index === undefined) {
      const buf = await sharp(join(framesDir, frame.file))
        .resize({ width, withoutEnlargement: true })
        .jpeg({ quality: 78, mozjpeg: true })
        .toBuffer();
      index = images.length;
      images.push(`data:image/jpeg;base64,${buf.toString("base64")}`);
      cache.set(frame.file, index);
    }
    built.push({ ...scene, image: index });
  }

  if (built.length === 0) {
    log.warn("Interactive scenes had no matching frames — skipping HTML output.");
    return;
  }

  const vp = spec.viewport;
  const durations = sceneDurations(
    built.map((s) => s.t),
    opts.durationMs ?? (built[built.length - 1]?.t ?? 0) + 1500,
  );
  const slugs = assignSlugs(built.map((s) => s.chapter));
  const payload = {
    name: spec.name,
    scenes: built.map((s, i) => ({
      image: s.image,
      label: s.label,
      caption: s.caption ?? null,
      chapter: s.chapter ?? null,
      slug: slugs[i],
      ms: durations[i],
      // Normalised to the viewport so the hotspot scales with the image.
      hotspot: s.hotspot
        ? {
            x: s.hotspot.x / vp.width,
            y: s.hotspot.y / vp.height,
            w: s.hotspot.w / vp.width,
            h: s.hotspot.h / vp.height,
          }
        : null,
    })),
  };

  const html = template(payload, images, spec);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, html, "utf8");
  const kb = Math.round(Buffer.byteLength(html) / 1024);
  log.ok(`html → ${outPath} (${built.length} scenes, ${images.length} frames, ${kb} KB)`);
}

function nearestFrame(frames: CapturedFrame[], t: number): CapturedFrame | undefined {
  let best: CapturedFrame | undefined;
  let bestD = Infinity;
  for (const f of frames) {
    const d = Math.abs(f.t - t);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
}

function template(payload: Record<string, unknown>, images: string[], spec: Spec): string {
  const accent = spec.polish.accent;
  const radius = spec.polish.radius || 14;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(spec.name)}</title>
<style>
  :root { --accent: ${accent}; --radius: ${radius}px; }
${PLAYER_CSS}
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>${escapeHtml(spec.name)}</h1>
      <nav class="chapters spacer" id="chapters" aria-label="Chapters"></nav>
    </header>

    <div class="stage" id="stage" role="button" tabindex="0" aria-label="Advance the demo">
      <img id="shot" alt="" />
      <div class="hotspot" id="hotspot" hidden></div>
      <div class="nudge" id="nudge" hidden></div>
      <div class="caption" id="caption"></div>
    </div>

    <div class="bar">
      <button class="ctl" id="prev" type="button">‹ Back</button>
      <button class="ctl" id="play" type="button" aria-label="Play the demo">▶ Play</button>
      <button class="ctl" id="next" type="button">Next ›</button>
      <div class="track" id="track" role="group" aria-label="Steps"></div>
      <span class="meta" id="counter"></span>
      <button class="ctl" id="link" type="button">Copy link</button>
      <span class="meta"><kbd>←</kbd> <kbd>→</kbd> step · <kbd>space</kbd> play</span>
    </div>
  </div>

  <div class="sr" id="live" role="status" aria-live="polite"></div>

<script>
const DATA = ${JSON.stringify(payload)};
const IMAGES = ${JSON.stringify(images)};
${PLAYER_JS}
</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]!);
}
