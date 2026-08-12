import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CapturedFrame } from "../capture/frames.js";
import type { Spec } from "../spec/schema.js";
import { log } from "../util/log.js";

/**
 * Interactive HTML output (product plan §8, v1.0) — the format a GIF can't be.
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
}

/** Widest sensible embedded frame — beyond this the file balloons for no gain. */
const MAX_EMBED_WIDTH = 1200;

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
  const payload = {
    name: spec.name,
    accent: spec.polish.accent,
    scenes: built.map((s) => ({
      image: s.image,
      label: s.label,
      caption: s.caption ?? null,
      chapter: s.chapter ?? null,
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

function template(
  payload: Record<string, unknown>,
  images: string[],
  spec: Spec,
): string {
  const bg = spec.polish.background || "#0b0b0f";
  const accent = spec.polish.accent;
  const radius = spec.polish.radius || 14;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(spec.name)}</title>
<style>
  :root {
    --accent: ${accent};
    --radius: ${radius}px;
  }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body {
    margin: 0;
    background: ${bg};
    color: #f3f5fa;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    display: flex; flex-direction: column; align-items: center;
    padding: 22px 18px 26px;
    -webkit-font-smoothing: antialiased;
  }
  header { width: 100%; max-width: 1180px; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 14px; }
  h1 { font-size: 16px; font-weight: 650; letter-spacing: -0.01em; margin: 0; }
  .chapters { display: flex; gap: 6px; flex-wrap: wrap; margin-left: auto; }
  .chip {
    border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.05);
    color: rgba(255,255,255,.72); border-radius: 999px; padding: 4px 11px;
    font-size: 12px; cursor: pointer; transition: .18s;
  }
  .chip:hover { background: rgba(255,255,255,.12); color: #fff; }
  .chip[aria-current="true"] { background: var(--accent); border-color: var(--accent); color: #0b0d12; font-weight: 600; }

  /* flex: none is load-bearing — as a shrinkable flex item the stage gets
     shorter than the image it contains, and hotspot percentages (which resolve
     against the stage) drift upward from their targets. */
  .stage {
    position: relative; flex: none; width: 100%; max-width: 1180px; cursor: pointer;
    border-radius: var(--radius); overflow: hidden; background: #000;
    box-shadow: 0 26px 70px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.07);
    line-height: 0;
  }
  .stage img { width: 100%; height: auto; display: block; }

  .hotspot {
    position: absolute; border-radius: 10px; pointer-events: none;
    outline: 2px solid var(--accent); outline-offset: 3px;
    box-shadow: 0 0 0 9999px rgba(6,8,14,.55);
    animation: breathe 1.9s ease-in-out infinite;
  }
  @keyframes breathe {
    0%, 100% { outline-color: var(--accent); opacity: 1; }
    50% { outline-color: rgba(255,255,255,.55); opacity: .82; }
  }
  .nudge {
    position: absolute; transform: translate(-50%, -50%);
    width: 26px; height: 26px; border-radius: 50%;
    background: var(--accent); pointer-events: none;
    animation: ping 1.9s cubic-bezier(0,0,.2,1) infinite;
  }
  @keyframes ping { 0% { transform: translate(-50%,-50%) scale(.5); opacity: .85; } 80%,100% { transform: translate(-50%,-50%) scale(2.6); opacity: 0; } }

  .caption {
    position: absolute; left: 50%; bottom: 5%; transform: translateX(-50%);
    max-width: 82%; padding: 11px 20px; border-radius: 12px;
    background: rgba(15,15,20,.9); font-size: clamp(13px, 1.5vw, 18px);
    font-weight: 600; text-align: center; line-height: 1.35; pointer-events: none;
  }
  .caption:empty { display: none; }

  .bar { width: 100%; max-width: 1180px; display: flex; align-items: center; gap: 14px; margin-top: 14px; }
  button.ctl {
    border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.06); color: #f3f5fa;
    border-radius: 10px; padding: 8px 14px; font: inherit; font-size: 13px; cursor: pointer; transition: .18s;
  }
  button.ctl:hover:not(:disabled) { background: rgba(255,255,255,.14); }
  button.ctl:disabled { opacity: .4; cursor: default; }
  .track { flex: 1; display: flex; gap: 5px; }
  .tick { flex: 1; height: 4px; border-radius: 3px; background: rgba(255,255,255,.16); transition: background .2s; }
  .tick.on { background: var(--accent); }
  .meta { font-size: 12px; color: rgba(255,255,255,.5); white-space: nowrap; }
  kbd {
    font: inherit; font-size: 11px; padding: 1px 5px; border-radius: 4px;
    border: 1px solid rgba(255,255,255,.2); background: rgba(255,255,255,.07);
  }
  @media (max-width: 620px) { .chapters { display: none; } .meta { display: none; } }
</style>
</head>
<body>
  <header>
    <h1>${escapeHtml(spec.name)}</h1>
    <nav class="chapters" id="chapters"></nav>
  </header>

  <div class="stage" id="stage" role="button" tabindex="0" aria-label="Advance the demo">
    <img id="shot" alt="" />
    <div class="hotspot" id="hotspot" hidden></div>
    <div class="nudge" id="nudge" hidden></div>
    <div class="caption" id="caption"></div>
  </div>

  <div class="bar">
    <button class="ctl" id="prev">‹ Back</button>
    <button class="ctl" id="next">Next ›</button>
    <div class="track" id="track"></div>
    <span class="meta"><kbd>←</kbd> <kbd>→</kbd> to step · <kbd>space</kbd> to play</span>
  </div>

<script>
const DATA = ${JSON.stringify(payload)};
const IMAGES = ${JSON.stringify(images)};

const shot = document.getElementById('shot');
const hotspot = document.getElementById('hotspot');
const nudge = document.getElementById('nudge');
const caption = document.getElementById('caption');
const track = document.getElementById('track');
const chapters = document.getElementById('chapters');
const prev = document.getElementById('prev');
const next = document.getElementById('next');
const stage = document.getElementById('stage');

let i = 0;
let timer = null;

DATA.scenes.forEach((_, n) => {
  const t = document.createElement('div');
  t.className = 'tick';
  t.addEventListener('click', (e) => { e.stopPropagation(); stop(); go(n); });
  t.style.cursor = 'pointer';
  track.appendChild(t);
});

const chapterIndex = [];
DATA.scenes.forEach((s, n) => {
  if (!s.chapter) return;
  chapterIndex.push(n);
  const c = document.createElement('button');
  c.className = 'chip';
  c.textContent = s.chapter;
  c.addEventListener('click', (e) => { e.stopPropagation(); stop(); go(n); });
  chapters.appendChild(c);
});

function go(n) {
  i = Math.max(0, Math.min(DATA.scenes.length - 1, n));
  const s = DATA.scenes[i];
  shot.src = IMAGES[s.image];
  shot.alt = s.label || 'Demo step ' + (i + 1);
  caption.textContent = s.caption || '';

  if (s.hotspot) {
    const h = s.hotspot;
    hotspot.hidden = false;
    nudge.hidden = false;
    hotspot.style.left = (h.x * 100) + '%';
    hotspot.style.top = (h.y * 100) + '%';
    hotspot.style.width = (h.w * 100) + '%';
    hotspot.style.height = (h.h * 100) + '%';
    nudge.style.left = ((h.x + h.w / 2) * 100) + '%';
    nudge.style.top = ((h.y + h.h / 2) * 100) + '%';
  } else {
    hotspot.hidden = true;
    nudge.hidden = true;
  }

  [...track.children].forEach((t, n) => t.classList.toggle('on', n <= i));
  [...chapters.children].forEach((c, n) => {
    const start = chapterIndex[n];
    const end = chapterIndex[n + 1] ?? DATA.scenes.length;
    c.setAttribute('aria-current', String(i >= start && i < end));
  });
  prev.disabled = i === 0;
  next.textContent = i === DATA.scenes.length - 1 ? 'Restart' : 'Next ›';
}

function advance() { go(i === DATA.scenes.length - 1 ? 0 : i + 1); }
function stop() { if (timer) { clearInterval(timer); timer = null; } }
function toggle() {
  if (timer) return stop();
  timer = setInterval(() => {
    if (i === DATA.scenes.length - 1) return stop();
    advance();
  }, 2600);
}

stage.addEventListener('click', () => { stop(); advance(); });
next.addEventListener('click', (e) => { e.stopPropagation(); stop(); advance(); });
prev.addEventListener('click', (e) => { e.stopPropagation(); stop(); go(i - 1); });
window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') { stop(); advance(); }
  else if (e.key === 'ArrowLeft') { stop(); go(i - 1); }
  else if (e.key === ' ') { e.preventDefault(); toggle(); }
});

go(0);
</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]!);
}
