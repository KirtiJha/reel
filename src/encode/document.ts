import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { CapturedFrame } from "../capture/frames.js";
import type { CaptionCue } from "../polish/captions.js";
import type { FadeCue } from "../polish/fade.js";
import type { HighlightCue } from "../polish/highlight.js";
import { DEFAULT_ZOOM, resolveTimeline, type Resolved, type ZoomKey } from "../polish/zoom.js";
import { withIdleMotion } from "../polish/zoom.js";
import type { Spec } from "../spec/schema.js";
import { dipColor } from "../polish/fade.js";
import { log } from "../util/log.js";

/**
 * The demo as a document.
 *
 * Every other deliverable bakes the demo into pixels: the camera becomes a
 * cropped raster, a caption becomes burned-in text, an annotation becomes
 * composited SVG. That is correct for a video, and it throws away everything
 * that made the demo legible — the words stop being words, the layout stops
 * being layout, and the result is opaque to search, to translation and to a
 * screen reader.
 *
 * This ships the *data* instead and re-performs it in the browser. The frames
 * are the app's own pixels, because those genuinely are a recording. Everything
 * layered on top stays what it was: text is text, the camera is a transform,
 * an annotation is SVG. It is the same demo, rendered at read time.
 *
 * ## Why one audio element is the clock
 *
 * The hard part of any player is sync, and the way it goes wrong is always the
 * same: two timers that are each individually correct and drift apart. So there
 * is exactly one clock here. When the demo has narration, it is
 * `audio.currentTime` — the audio is the thing a viewer notices drifting, so
 * the audio is what everything else follows. With no narration the clock is a
 * plain elapsed-time counter, and nothing is chasing anything.
 *
 * ## What this is not
 *
 * Not a replacement for the video. A social platform takes an MP4, and this is
 * an HTML document. It is a third deliverable, for a README, a docs site, a
 * landing page or a pull-request preview — places where being a document is an
 * advantage rather than a format problem.
 */

export interface DocumentOptions {
  frames: CapturedFrame[];
  framesDir: string;
  outPath: string;
  spec: Spec;
  durationMs: number;
  /** Longest edge of an emitted frame. Smaller than the video: it is scrubbed, not projected. */
  maxWidth: number;
  zoom: ZoomKey[];
  captions: CaptionCue[];
  highlights: HighlightCue[];
  fades: FadeCue[];
  beats: { label: string; t: number }[];
  /** The mixed narration track, if the demo has one. */
  audioFile?: string | undefined;
}

/** What the browser is handed. Pure data — no baked pixels except the frames. */
export interface Timeline {
  durationMs: number;
  viewport: { w: number; h: number };
  accent: string;
  background: string;
  /** Frame index → time. The image at `i` is on screen until the next one. */
  frames: { t: number; i: number }[];
  /** Camera keyframes, already resolved to crop rects in viewport space. */
  camera: Resolved[];
  transitionMs: number;
  captions: { t: number; text: string; ms?: number; position: string }[];
  highlights: HighlightCue[];
  fades: FadeCue[];
  beats: { label: string; t: number }[];
}

export async function writeDocument(opts: DocumentOptions): Promise<void> {
  const { frames, framesDir, spec, durationMs } = opts;
  if (frames.length === 0) {
    log.warn("No frames captured — skipping the document build.");
    return;
  }

  // Only the frames that changed. The capture already emits on visual change,
  // so this is the demo's real information content: Reel's own tour moves 100
  // times across ten minutes, against 18,540 frames in the encoded video.
  const images: string[] = [];
  for (const f of frames) {
    const buf = await sharp(join(framesDir, f.file))
      .resize({ width: opts.maxWidth, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    images.push(`data:image/webp;base64,${buf.toString("base64")}`);
  }

  const cfg = { viewport: { w: spec.viewport.width, h: spec.viewport.height }, ...DEFAULT_ZOOM };
  // The same camera the video gets, including idle drift — resolved here so the
  // player interpolates rather than recomputing geometry it has no business
  // knowing about.
  const drifting =
    spec.polish.idleMotion === "drift" ||
    (spec.polish.idleMotion === "auto" && spec.polish.zoom === "auto");
  const resolved = resolveTimeline(opts.zoom, cfg);
  const camera = drifting
    ? withIdleMotion(resolved, frames.map((f) => f.t), durationMs, {
        afterMs: spec.polish.idleMotionAfter,
        scale: spec.polish.idleMotionScale,
      })
    : resolved;

  const timeline: Timeline = {
    durationMs,
    viewport: { w: spec.viewport.width, h: spec.viewport.height },
    accent: spec.polish.accent,
    background: dipColor(spec.polish.background),
    frames: frames.map((f, i) => ({ t: Math.round(f.t), i })),
    camera,
    transitionMs: DEFAULT_ZOOM.transitionMs,
    // Only what a player needs: a CaptionCue also carries measured word
    // advances, which exist so sharp can wrap text. A browser wraps its own.
    captions: opts.captions
      .filter((c) => c.text.trim())
      .map((c) => ({ t: Math.round(c.t), text: c.text, ...(c.ms ? { ms: c.ms } : {}), position: c.position })),
    highlights: opts.highlights,
    fades: opts.fades,
    beats: opts.beats,
  };

  const audio = opts.audioFile
    ? `data:audio/mp4;base64,${(await readFile(opts.audioFile)).toString("base64")}`
    : "";

  const html = buildDocumentHtml(spec.name, timeline, images, audio);
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(opts.outPath), { recursive: true });
  await writeFile(opts.outPath, html, "utf8");

  const kb = Math.round(Buffer.byteLength(html) / 1024);
  log.ok(
    `player → ${opts.outPath} (${images.length} frames, ${timeline.captions.length} captions, ` +
      `${audio ? "narrated, " : ""}${kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`})`,
  );
}

export function buildDocumentHtml(
  name: string,
  timeline: Timeline,
  images: string[],
  audio: string,
): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)}</title>
<style>${STYLE}</style>
</head><body>
<div id="app">
  <div id="stage" role="img" aria-label="${esc(name)}">
    <div id="shot">
      <img id="frame" alt="">
      <!-- Inside the camera, not beside it: an annotation is attached to the
           thing it marks, so it has to be carried by the same transform. -->
      <svg id="marks" preserveAspectRatio="none"></svg>
    </div>
    <div id="veil"></div>
    <p id="caption" aria-live="polite"></p>
  </div>
  <div id="bar">
    <button id="play" aria-label="Play">▶</button>
    <div id="scrub" role="slider" aria-label="Timeline" tabindex="0"><div id="done"></div><div id="ticks"></div></div>
    <span id="clock">0:00</span>
  </div>
  <nav id="rail" aria-label="Chapters"></nav>
</div>
<!-- The script is the whole player. The data above it is the demo. -->
<script id="timeline" type="application/json">${jsonForScript(timeline)}</script>
<script id="images" type="application/json">${jsonForScript(images)}</script>
${audio ? `<audio id="audio" preload="auto" src="${audio}"></audio>` : ""}
<script>${PLAYER}</script>
</body></html>`;
}

/**
 * JSON safe to sit inside a `<script>`.
 *
 * A caption is author text and can contain anything. `</script>` inside a
 * string literal ends the element regardless of JSON quoting, so the sequence
 * is broken up rather than trusted.
 */
export function jsonForScript(v: unknown): string {
  return (
    JSON.stringify(v)
      // `</script>` inside a string literal ends the element regardless of JSON
      // quoting, and a caption is author text that can contain anything.
      .replace(/</g, "\\u003c")
      // U+2028/U+2029 are valid in JSON but are line terminators in JavaScript
      // source, so an unescaped one is a syntax error in the embedded script.
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029")
  );
}

function esc(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const STYLE = `
:root { color-scheme: dark; --accent: #6d8bff; }
* { box-sizing: border-box; margin: 0; }
body {
  background: #07080c; color: #e8eaf0; min-height: 100vh;
  display: flex; align-items: center; justify-content: center; padding: 3vmin;
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
#app { width: 100%; max-width: 1200px; }
#stage {
  position: relative; overflow: hidden; border-radius: 14px;
  background: #000; aspect-ratio: var(--ar, 16/10);
  box-shadow: 0 24px 70px rgba(0,0,0,.55);
}
/* The camera. Transformed rather than cropped, so it interpolates per animation
   frame instead of per encoded frame — smoother than the video it came from. */
#shot { position: absolute; inset: 0; transform-origin: 0 0; will-change: transform; }
#frame { width: 100%; height: 100%; display: block; object-fit: fill; }
#marks { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
#veil { position: absolute; inset: 0; pointer-events: none; opacity: 0; }
/* Text stays text: selectable, translatable, and read aloud by a screen
   reader — none of which survives being burned into a frame. */
#caption {
  position: absolute; left: 50%; transform: translateX(-50%);
  bottom: 5%; max-width: 88%; padding: .6em 1.1em; border-radius: .7em;
  background: rgba(15,15,20,.88); font-weight: 600; font-size: clamp(13px, 2.1vw, 21px);
  text-align: center; opacity: 0; transition: opacity .12s linear;
}
#caption.top { bottom: auto; top: 5%; }
#bar { display: flex; align-items: center; gap: 12px; margin-top: 14px; }
button {
  font: inherit; color: inherit; background: #171a22; border: 1px solid #262b37;
  border-radius: 9px; width: 42px; height: 34px; cursor: pointer;
}
button:hover { background: #1e222c; }
#scrub { position: relative; flex: 1; height: 8px; border-radius: 5px; background: #191d26; cursor: pointer; }
#done { position: absolute; inset: 0 auto 0 0; width: 0; border-radius: 5px; background: var(--accent); }
#ticks { position: absolute; inset: 0; }
#ticks i { position: absolute; top: -3px; width: 2px; height: 14px; background: #39405230; }
#clock { font-variant-numeric: tabular-nums; color: #98a0b3; font-size: 13px; min-width: 42px; }
#rail { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
#rail button { width: auto; padding: 0 12px; font-size: 13px; color: #98a0b3; }
#rail button[aria-current="true"] { color: #e8eaf0; border-color: var(--accent); }
@media (prefers-reduced-motion: reduce) { #shot { transition: none !important; } }
`;

/**
 * The player.
 *
 * Kept as a string for the same reason `src/authoring/observe.ts` is: the
 * bundler rewrites function declarations, and injected code that depends on the
 * build's output shape breaks in ways that look like the page's fault.
 */
const PLAYER = `
(() => {
  var T = JSON.parse(document.getElementById('timeline').textContent);
  var IMG = JSON.parse(document.getElementById('images').textContent);
  var audio = document.getElementById('audio');
  var stage = document.getElementById('stage'), shot = document.getElementById('shot');
  var frame = document.getElementById('frame'), marks = document.getElementById('marks');
  var veil = document.getElementById('veil'), cap = document.getElementById('caption');
  var play = document.getElementById('play'), scrub = document.getElementById('scrub');
  var done = document.getElementById('done'), clock = document.getElementById('clock');
  var rail = document.getElementById('rail'), ticks = document.getElementById('ticks');

  document.documentElement.style.setProperty('--accent', T.accent);
  stage.style.setProperty('--ar', T.viewport.w + '/' + T.viewport.h);
  marks.setAttribute('viewBox', '0 0 ' + T.viewport.w + ' ' + T.viewport.h);

  // Decode every frame up front. A scrub that had to wait on a decode would
  // stutter exactly where a viewer is paying most attention.
  var cache = IMG.map(function (src) { var i = new Image(); i.src = src; return i; });

  var playing = false, virtual = 0, last = 0, shown = -1;

  // One clock. With narration the audio is it, because audio is what a viewer
  // notices drifting; without, a plain counter. Nothing chases anything.
  function now() { return audio ? audio.currentTime * 1000 : virtual; }

  function ease(t) { return t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  function cameraAt(t) {
    var i = 0;
    for (var j = 0; j < T.camera.length; j++) { if (T.camera[j].t <= t) i = j; else break; }
    var to = T.camera[i], from = T.camera[i-1] || to;
    var p = ease(clamp01((t - to.t) / (to.ms || T.transitionMs)));
    return {
      x: from.rect.x + (to.rect.x - from.rect.x) * p,
      y: from.rect.y + (to.rect.y - from.rect.y) * p,
      w: from.rect.w + (to.rect.w - from.rect.w) * p,
      h: from.rect.h + (to.rect.h - from.rect.h) * p
    };
  }

  function frameAt(t) {
    var i = 0;
    for (var j = 0; j < T.frames.length; j++) { if (T.frames[j].t <= t) i = T.frames[j].i; else break; }
    return i;
  }

  function captionAt(t) {
    var found = null;
    for (var j = 0; j < T.captions.length; j++) {
      var c = T.captions[j];
      if (c.t > t) break;
      var end = c.ms ? c.t + c.ms : (T.captions[j+1] ? T.captions[j+1].t : T.durationMs);
      found = t < end ? c : null;
    }
    return found;
  }

  function fadeAt(t) {
    var best = 0;
    for (var j = 0; j < T.fades.length; j++) {
      var f = T.fades[j], span = f.to - f.from; if (span <= 0) continue;
      var a = 0;
      if (f.kind === 'dip') { if (t < f.from || t > f.to) continue; a = 1 - Math.abs((t - f.from)/span - .5) * 2; }
      else if (f.kind === 'out') { if (t <= f.from) continue; a = t >= f.to ? 1 : (t - f.from)/span; }
      else { if (t >= f.to) continue; a = t <= f.from ? 1 : 1 - (t - f.from)/span; }
      if (a > best) best = a;
    }
    return best;
  }

  function drawMarks(t) {
    var out = '';
    for (var j = 0; j < T.highlights.length; j++) {
      var h = T.highlights[j];
      if (t < h.from || t >= h.to) continue;
      var span = h.to - h.from, fade = Math.min(200, span/2);
      var alpha = clamp01(Math.min((t - h.from)/fade, (h.to - t)/fade));
      var r = h.rect, pad = 6;
      // Drawn in viewport space inside the camera's own transform, so a mark
      // stays attached to the thing it marks.
      if (h.shape === 'circle') {
        out += '<ellipse cx="' + (r.x + r.w/2) + '" cy="' + (r.y + r.h/2) + '" rx="' + (r.w/2 + pad) +
               '" ry="' + (r.h/2 + pad) + '" fill="none" stroke="' + T.accent + '" stroke-width="3" vector-effect="non-scaling-stroke" opacity="' + alpha + '"/>';
      } else if (h.shape === 'underline') {
        out += '<line x1="' + r.x + '" y1="' + (r.y + r.h + pad) + '" x2="' + (r.x + r.w) + '" y2="' + (r.y + r.h + pad) +
               '" stroke="' + T.accent + '" stroke-width="3" stroke-linecap="round" opacity="' + alpha + '"/>';
      } else {
        out += '<rect x="' + (r.x - pad) + '" y="' + (r.y - pad) + '" width="' + (r.w + pad*2) + '" height="' + (r.h + pad*2) +
               '" rx="6" fill="none" stroke="' + T.accent + '" stroke-width="3" vector-effect="non-scaling-stroke" opacity="' + alpha + '"/>';
      }
    }
    marks.innerHTML = out;
  }

  function render(t) {
    var c = cameraAt(t);
    // CSS applies these right to left: translate in the shot's own pixels,
    // then scale. So the crop's origin lands at 0,0 and its width fills the
    // stage. Scaling against the viewport instead of the stage would leave the
    // shot at its authored size inside a stage that is usually smaller.
    var s = stage.clientWidth / c.w;
    shot.style.transform = 'scale(' + s + ') translate(' + (-c.x) + 'px,' + (-c.y) + 'px)';
    shot.style.width = T.viewport.w + 'px';
    shot.style.height = T.viewport.h + 'px';

    var fi = frameAt(t);
    if (fi !== shown) { frame.src = cache[fi].src; shown = fi; }

    var cue = captionAt(t);
    cap.textContent = cue ? cue.text : '';
    cap.style.opacity = cue ? '1' : '0';
    cap.className = cue && cue.position === 'top' ? 'top' : '';

    var f = fadeAt(t);
    veil.style.background = T.background;
    veil.style.opacity = String(f);

    drawMarks(t);

    var p = clamp01(t / T.durationMs);
    done.style.width = (p * 100) + '%';
    clock.textContent = fmt(t) ;
    for (var j = 0; j < railBtns.length; j++) {
      railBtns[j].setAttribute('aria-current', String(T.beats[j].t <= t && (!T.beats[j+1] || T.beats[j+1].t > t)));
    }
  }

  function fmt(ms) {
    var s = Math.max(0, Math.floor(ms/1000));
    return Math.floor(s/60) + ':' + String(s%60).padStart(2,'0');
  }

  function tick(now_) {
    if (playing) {
      if (!audio) { virtual += now_ - (last || now_); }
      last = now_;
      if (now() >= T.durationMs) { pause(); seek(T.durationMs); }
    }
    render(Math.min(now(), T.durationMs));
    requestAnimationFrame(tick);
  }

  function start() {
    playing = true; last = 0; play.textContent = '❚❚'; play.setAttribute('aria-label','Pause');
    // Autoplay with sound is blocked until a gesture, which is why this is on a
    // button rather than automatic.
    if (audio) audio.play().catch(function () {});
  }
  function pause() {
    playing = false; play.textContent = '▶'; play.setAttribute('aria-label','Play');
    if (audio) audio.pause();
  }
  function seek(ms) {
    ms = Math.max(0, Math.min(ms, T.durationMs));
    if (audio) audio.currentTime = ms / 1000; else virtual = ms;
    render(ms);
  }

  play.addEventListener('click', function () { playing ? pause() : start(); });
  scrub.addEventListener('pointerdown', function (e) {
    var move = function (ev) {
      var b = scrub.getBoundingClientRect();
      seek(((ev.clientX - b.left) / b.width) * T.durationMs);
    };
    move(e);
    var up = function () { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });
  scrub.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') seek(now() + 5000);
    else if (e.key === 'ArrowLeft') seek(now() - 5000);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === ' ' && e.target === document.body) { e.preventDefault(); playing ? pause() : start(); }
  });

  var railBtns = [];
  T.beats.forEach(function (b, j) {
    var el = document.createElement('button');
    el.textContent = b.label;
    el.addEventListener('click', function () { seek(b.t); if (!playing) start(); });
    rail.appendChild(el); railBtns.push(el);
    var tick_ = document.createElement('i');
    tick_.style.left = (clamp01(b.t / T.durationMs) * 100) + '%';
    ticks.appendChild(tick_);
    void j;
  });

  // Deep link: #t=90 opens ninety seconds in, so a chapter can be shared.
  var m = /[#&]t=([0-9.]+)/.exec(location.hash);
  seek(m ? parseFloat(m[1]) * 1000 : 0);
  requestAnimationFrame(tick);
})();
`;
