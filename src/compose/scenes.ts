import { entranceCss, type Look } from "../scene/looks.js";
import { esc } from "../scene/templates.js";
import type { ShotManifest } from "../shoot/manifest.js";

/**
 * Scene sub-compositions.
 *
 * Every scene of the film is its own HTML file under `compositions/frames/`,
 * mounted by the index host via `data-composition-src`. That is the structure
 * HyperFrames' production loop assumes — "each scene at
 * `compositions/frames/NN-*.html`", assembled into an index — and it is worth
 * the extra files: a scene you can open, snapshot and rewrite on its own is a
 * scene an agent can iterate on without touching the rest of the cut.
 *
 * ## The transport rule, which is unlike ordinary HTML
 *
 * The runtime fetches the file, parses it, and clones **only the contents of
 * `<template>`** into the host slot. Everything outside — including the whole
 * `<head>` — is discarded. So `<style>` and `<script>` go *inside* the
 * template, which is exactly where habit says they should not. A stylesheet in
 * `<head>` passes every static check and then ships a scene of unstyled text in
 * the top-left corner.
 *
 * Two more rules that only fail at mount time:
 *
 *  - **Style the root by `#root`, never by a class.** At render the CSS is
 *    scoped to the composition id, so a class selector on the root stops
 *    matching.
 *  - **The host's `data-composition-id`, the inner root's, and the
 *    `window.__timelines` key must all be the same string.** A mismatch is
 *    silent in lint and shows up as a 45-second wait per scene followed by
 *    static frames.
 */

/** Seconds; one frame at 60fps, the unit the waterfall rule is written in. */
const F = 1 / 60;
/** Waterfall entry: binary reveal, short whip, overlapping cascade. */
const WORD_TRAVEL = 56;
const WORD_DUR = 0.16;
/** How long a scene takes to dissolve into the next one. */
export const HANDOFF = 0.5;

const r3 = (n: number): number => Number(n.toFixed(3));

/** Display size in px: the look's own scale, or a proportion of the frame. */
function displayPx(look: Look, frame: Frame): number {
  return look.displayCqw === undefined
    ? Math.round(frame.height * 0.09)
    : Math.round((look.displayCqw / 100) * frame.width);
}

/**
 * Families a browser resolves for itself, which must not be declared.
 *
 * `-apple-system` and `BlinkMacSystemFont` are keywords, and the `ui-*`
 * families plus the bare generics are CSS generics; an `@font-face` for any of
 * them declares a face that does not exist.
 */
const GENERIC_FAMILIES = new Set([
  "-apple-system", "blinkmacsystemfont", "system-ui", "ui-sans-serif", "ui-serif",
  "ui-monospace", "ui-rounded", "sans-serif", "serif", "monospace", "cursive", "fantasy",
]);

/**
 * Declare every named family as a local face.
 *
 * `hyperframes check` rejects a family it cannot resolve, correctly: a font the
 * renderer silently substitutes is not the typography anyone approved. Nothing
 * here is downloadable — these are system faces — so `src: local(...)` states
 * the truth, that the face is expected to be on the machine.
 */
export function fontFaces(...stacks: string[]): string {
  // A caller that vendored real faces passes them separately; this only covers
  // the system stacks Reel's own looks use.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const stack of stacks) {
    for (const raw of stack.split(",")) {
      const name = raw.trim().replace(/^["']|["']$/g, "");
      const key = name.toLowerCase();
      if (!name || seen.has(key) || GENERIC_FAMILIES.has(key)) continue;
      seen.add(key);
      out.push(`      @font-face { font-family: "${name}"; src: local("${name}"); }`);
    }
  }
  return out.join("\n");
}

export interface SceneFrame {
  /** `00-title`, `01-shot-taskflow` — the file stem and the composition id. */
  id: string;
  /** Path relative to the project root. */
  src: string;
  /** Composition time this scene starts. */
  at: number;
  /** How long its host clip runs. */
  duration: number;
  /** Contact-sheet caption for the storyboard. */
  scene: string;
  title: string;
  /** Where to seek for the storyboard's poster — past the entrance. */
  poster: number;
  transitionIn: string;
  /**
   * The time-coded shot sequence — the windows this scene develops across.
   *
   * Written into the storyboard below the metadata, which is where their format
   * puts a frame's narrative and where a scene author reads it from. Absent on
   * a frame reassembled from a storyboard, because by then the sequence is the
   * author's own writing and lives in the file rather than in this struct.
   */
  sequence?: string;
  /**
   * What is said over this frame.
   *
   * Their storyboard format's own field, and the reason a line with no audio is
   * still worth carrying: the words reach the plan even when the voice does
   * not, so a frame missing its track says so instead of being silently mute.
   */
  voiceover?: string;
}

interface Frame {
  width: number;
  height: number;
}

/** Wrap a scene body in the transport container the runtime actually reads. */
function subComposition(id: string, frame: Frame, style: string, markup: string, js: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <!-- The head is metadata for this file only; the runtime discards it and
         clones the <template> contents alone. Nothing load-bearing lives here. -->
  </head>
  <body>
    <template>
      <style>
${style}
      </style>

      <div id="root" data-composition-id="${id}" data-width="${frame.width}" data-height="${frame.height}">
${markup}
      </div>

      <script>
        (function () {
          var tl = gsap.timeline({ paused: true });
${js}
          window.__timelines["${id}"] = tl;
        })();
      </script>
    </template>
  </body>
</html>
`;
}

/**
 * Shared chrome: the ground, whatever the look puts behind the type, the slate.
 *
 * A look with `bloom: 0` gets **no accent glow and no plate** — it supplies its
 * own backdrop instead. That distinction is the whole reason frame presets look
 * like themselves: every one of them is derived from print, and a radial bloom
 * behind the headline is the single element that says "not this system".
 */
function groundCss(look: Look, accent: string, frame: Frame): string {
  const glow = look.bloom > 0
    ? `      .bg { position: absolute; inset: -30%; pointer-events: none; }
      .b1 { background: radial-gradient(closest-side, ${accent}, transparent 70%);
        filter: blur(${Math.round(frame.height * 0.065)}px) saturate(2); opacity: .85; }
      .b2 { background: radial-gradient(closest-side, ${accent}, transparent 72%);
        filter: blur(${Math.round(frame.height * 0.083)}px) saturate(1.7) hue-rotate(80deg); opacity: .6; }`
    : look.backdrop(accent).css;
  const plate = look.plate > 0
    ? `      .plate { position: absolute; inset: 8% 4%; pointer-events: none;
        background: radial-gradient(ellipse at 50% 50%,
          ${look.dark ? "rgba(0,0,0,.86)" : "rgba(255,255,255,.9)"} 0%, transparent 74%); }`
    : "";
  return `      #root { position: absolute; inset: 0; overflow: hidden; background: ${look.ground};
        font-family: ${look.display}; color: ${look.ink}; }
${glow}
${plate}
      .slate { position: absolute; top: 6%; left: 5%; text-align: left;
        padding-left: 14px; border-left: 3px solid ${accent}; }
      .slate .k { font-family: ${look.label}; font-size: ${look.labelPx ?? Math.round(frame.height * 0.014)}px;
        letter-spacing: .26em; text-transform: uppercase; color: ${look.muted}; }
      .slate .n { color: ${look.ink}; font-size: ${Math.round(frame.height * 0.023)}px;
        font-weight: 650; margin-top: 4px; }
`;
}

/** The layers behind the type — the look's own, or the accent bloom. */
function groundMarkup(look: Look, accent: string): string {
  const layers = look.bloom > 0
    ? `        <div class="bg b1"></div>\n        <div class="bg b2"></div>`
    : `        ${look.backdrop(accent).markup}`;
  return look.plate > 0 ? `${layers}\n        <div class="plate"></div>` : layers;
}

/** A word split for the waterfall cascade. */
function words(text: string): string {
  return esc(text)
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `<span class="w">${w}</span>`)
    .join(" ");
}

/**
 * The waterfall entry, from the animation skill's rule of the same name.
 *
 * Two things in it are counter-intuitive and both matter. Opacity is **binary**
 * — each word is revealed with a zero-duration `set`, never faded, because a
 * fade reads as a slideshow. And it is **fast**: 0.13–0.20s per word rather
 * than the 0.7s that feels right when guessing. The cascade overlaps, so each
 * word starts before the previous settles and the gaps shrink as it runs.
 */
function waterfall(selector: string, from: number): string {
  return `          var t = ${r3(from)};
          gsap.utils.toArray("${selector} .w").forEach(function (w, i) {
            var d = ${WORD_DUR} - Math.min(i, 3) * 0.008;
            tl.set(w, { opacity: 1, y: ${WORD_TRAVEL} - Math.min(i, 3) * 5 }, t);
            tl.to(w, { y: 0, duration: d, ease: "power4.out" }, t);
            t += d - ${r3(F)};
          });`;
}

export interface CardOptions {
  id: string;
  look: Look;
  /** Ready-made @font-face rules for any vendored webfaces. */
  faces?: string;
  accent: string;
  frame: Frame;
  duration: number;
  headline: string;
  subtitle?: string;
  slate?: string;
  slateNote?: string;
}

/** A title, chapter or closing card. */
export function cardScene(o: CardOptions): string {
  const { look, accent, frame } = o;
  const style = `${o.faces || fontFaces(look.display, look.label)}
${groundCss(look, accent, frame)}
      .stack { position: absolute; inset: 0; display: flex; flex-direction: column;
        align-items: center; justify-content: center; text-align: center; padding: 8% 10%; }
      /* A preset carries its own scale; Reel's own looks fall back to a
         proportion of the frame. The presets' numbers are the surprising part —
         display type at 4.6-10.4cqw is roughly twice what feels right when
         guessing, and it is most of what separates their frames from a first
         attempt. */
      .headline { position: relative; font-size: ${displayPx(look, frame)}px;
        font-weight: ${look.displayWeight}; letter-spacing: ${look.tracking};
        line-height: ${look.displayLineHeight ?? 1.04}; text-transform: ${look.transform}; }
      /* Hidden at rest: a waterfall entry reveals instantly rather than fading,
         so the resting state has to be invisible. */
      .headline .w { display: inline-block; opacity: 0; }
      .rule { position: relative; width: ${Math.round(frame.width * 0.075)}px; height: 4px;
        border-radius: 3px; background: ${accent}; margin: ${Math.round(frame.height * 0.03)}px 0; }
      /* Body copy, never the display face: a subtitle set in a condensed
         poster face at 27px is unreadable, and inheriting #root's font-family
         is how it silently becomes one. */
      .sub { position: relative; color: ${look.muted}; opacity: 0;
        font-family: ${look.label}; text-transform: none; letter-spacing: 0;
        font-size: ${Math.round(frame.height * 0.026)}px; max-width: 52ch; line-height: 1.5; }`;

  const markup = `${groundMarkup(look, accent)}
${o.slate ? `        <div class="slate"><div class="k">${esc(o.slate)}</div>${o.slateNote ? `<div class="n">${esc(o.slateNote)}</div>` : ""}</div>` : ""}
        <div class="stack">
          <div class="headline">${words(o.headline)}</div>
          <div class="rule"></div>
${o.subtitle ? `          <div class="sub">${esc(o.subtitle)}</div>` : ""}
        </div>
`;

  const js = [
    waterfall("#root .headline", 0.1),
    `          tl.fromTo("#root .rule", { scaleX: 0 }, { scaleX: 1, duration: .5, ease: "power4.out" }, 0.34);`,
    o.subtitle
      ? `          tl.to("#root .sub", { opacity: 1, y: 0, duration: .5, ease: "power4.out" }, 0.5);`
      : "",
    o.slate
      ? `          tl.fromTo("#root .slate", { opacity: 0, x: -24 }, { opacity: 1, x: 0, duration: .45, ease: "power4.out" }, 0.1);`
      : "",
    // The bloom moves for the card's whole life. One that stops after the
    // entrance is exactly what makes a card read as a slide.
    look.bloom > 0
      ? `          tl.fromTo("#root .b1", { scale: .88 }, { scale: 1.2, duration: ${r3(o.duration)}, ease: "none" }, 0);\n` +
        `          tl.fromTo("#root .b2", { scale: 1.18 }, { scale: .94, duration: ${r3(o.duration)}, ease: "none" }, 0);`
      : `          tl.fromTo("#root .rule-top", { scaleX: 0 }, { scaleX: 1, duration: .7, ease: "power4.out" }, 0.05);\n` +
        `          tl.fromTo("#root .rule-bottom", { scaleX: 0 }, { scaleX: 1, duration: .7, ease: "power4.out" }, 0.12);`,
    // No exit animation. Their rule, and it is not a style preference: "the
    // transition IS the exit — outgoing scene content must be fully visible
    // when the transition starts". A scene that fades itself out and is then
    // followed by a scene fading itself in is a jump cut with a dip, which is
    // what this used to be. The handoff belongs to the index, which is the only
    // layer that can see both scenes at once.
  ]
    .filter(Boolean)
    .join("\n");

  return subComposition(o.id, frame, style, markup, js);
}

export interface ShotOptions {
  id: string;
  look: Look;
  faces?: string;
  /** Narration audio for this shot, relative to the scene file. */
  voice?: { at: number; dur: number; file: string }[];
  accent: string;
  frame: Frame;
  shot: ShotManifest;
  /** Media paths, relative to the project root. */
  footage: string;
  sfx?: string;
  /** Scale the footage sits at: 1 fills the frame, less insets it. */
  fit: number;
  /** Drift and emphasis, from the manifest's beats. */
  drift: number;
  punch: number;
  punchHold: number;
  punchGap: number;
}

/** A footage scene: the app, its lower thirds, and the sound it made. */
export function shotScene(o: ShotOptions): string {
  const { look, accent, frame, shot } = o;

  const style = `${o.faces || fontFaces(look.display, look.label)}
${groundCss(look, accent, frame)}
      /* The ground shows through wherever the footage does not reach. The slow
         push-in eventually scales this past the frame, which is the point of a
         push-in; data-layout-allow-overflow says so rather than leaving the
         layout check to report it as three surprises per render. */
      .shot { position: absolute; inset: 0; }
      /* contain, never cover: cropping a product demo can cut off the thing the
         demo is about, and nobody notices until it has shipped. */
      video { width: 100%; height: 100%; object-fit: contain; }
      /* A band on the bottom edge rather than text floated over the picture.
         The footage moves, so anything laid on it collides with the app
         eventually — and only per demo, after a render. */
      .lower { position: absolute; inset: auto 0 0 0; height: 14%;
        display: flex; align-items: center; gap: ${Math.round(frame.width * 0.014)}px;
        padding: 0 7%; opacity: 0;
        background: linear-gradient(transparent, rgba(6,8,14,.94) 46%); }
      .lt-bar { flex: none; width: ${Math.round(frame.width * 0.035)}px; height: 4px;
        background: ${accent}; transform-origin: left; }
      .lt-text { color: #fff; font-size: ${Math.round(frame.height * 0.033)}px; font-weight: 600;
        letter-spacing: -.02em; text-shadow: 0 2px 16px rgba(0,0,0,.85); }`;

  const thirds = shot.captions.map((c, i) => {
    const next = shot.captions[i + 1]?.t ?? shot.duration;
    const dur = Math.max(1.2, Math.min(3.6, next - c.t));
    return { i, at: r3(c.t), dur: r3(dur), text: c.text };
  });

  const markup = `${groundMarkup(look, accent)}
        <div class="shot" id="shot" data-layout-allow-overflow>
          <video id="${o.id}-v" src="${o.footage}" data-start="0" data-duration="${r3(shot.duration)}"
                 muted playsinline></video>
        </div>
${o.sfx ? `        <audio id="${o.id}-a" src="${o.sfx}" data-start="0" data-duration="${r3(shot.duration)}" data-volume="0.85"></audio>` : ""}
${(o.voice ?? [])
    .map(
      (v, i) =>
        `        <audio id="${o.id}-v${i}" src="${v.file}" data-start="${r3(v.at)}" data-duration="${r3(v.dur)}" data-volume="1"></audio>`,
    )
    .join("\n")}
${thirds
    .map(
      (t) => `        <div class="lower" id="lt${t.i}">
          <div class="lt-bar"></div><div class="lt-text">${esc(t.text)}</div>
        </div>`,
    )
    .join("\n")}
`;

  // Beats worth an emphasis push. Every beat would be a twitch; the first is
  // skipped because the scene has only just arrived.
  const punches: { t: number; label: string }[] = [];
  let last = -Infinity;
  for (const b of shot.beats.slice(1)) {
    if (b.t - last < o.punchGap || b.t > shot.duration - o.punchHold) continue;
    punches.push(b);
    last = b.t;
  }

  const js = [
    // The drift and the punch are both `scale`, and two tweens on one property
    // depend on GSAP's overwrite order, which is not guaranteed. The wrapper
    // drifts, the video punches; nested transforms multiply.
    `          tl.fromTo("#shot", { scale: ${o.fit} }, { scale: ${r3(o.fit * (1 + o.drift))}, duration: ${r3(shot.duration)}, ease: "none" }, 0);`,
    ...punches.flatMap((b) => [
      `          // emphasis on beat "${esc(b.label)}"`,
      `          tl.to("#${o.id}-v", { scale: ${1 + o.punch}, duration: .7, ease: "power2.out" }, ${r3(b.t)});`,
      `          tl.to("#${o.id}-v", { scale: 1, duration: .8, ease: "power2.inOut" }, ${r3(b.t + o.punchHold)});`,
    ]),
    ...thirds.flatMap((t) => [
      `          tl.to("#lt${t.i}", { opacity: 1, duration: .32, ease: "power3.out" }, ${t.at});`,
      `          tl.fromTo("#lt${t.i} .lt-bar", { scaleX: 0 }, { scaleX: 1, duration: .45, ease: "power4.out" }, ${t.at});`,
      `          tl.fromTo("#lt${t.i} .lt-text", { y: 20 }, { y: 0, duration: .4, ease: "power4.out" }, ${t.at});`,
      `          tl.to("#lt${t.i}", { opacity: 0, duration: .28, ease: "power2.in" }, ${r3(t.at + t.dur - 0.28)});`,
    ]),
    look.bloom > 0
      ? `          tl.fromTo("#root .b1", { scale: .95 }, { scale: 1.12, duration: ${r3(shot.duration)}, ease: "none" }, 0);\n` +
        `          tl.fromTo("#root .b2", { scale: 1.1 }, { scale: .97, duration: ${r3(shot.duration)}, ease: "none" }, 0);`
      : "",
    // No exit animation here either — see `cardScene`. The lower thirds do fade
    // out, but they are furniture *inside* the scene and land well before its
    // last frame; the scene itself hands over at full opacity.
  ].join("\n");

  return subComposition(o.id, frame, style, markup, js);
}
