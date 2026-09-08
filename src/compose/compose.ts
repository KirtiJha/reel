import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_LOOK, lookFor, type Look, type LookName } from "../scene/looks.js";
import { esc, escapeCss } from "../scene/templates.js";
import type { ShotManifest } from "../shoot/manifest.js";
import { log, ReelError } from "../util/log.js";

/**
 * `reel compose` — turn footage into a HyperFrames project.
 *
 * ## What this scaffolds, and what it deliberately does not
 *
 * The output is a real HyperFrames composition: a root carrying
 * `data-composition-id` / `data-width` / `data-height` / `data-duration`, clips
 * carrying `data-start` / `data-duration`, and exactly one paused GSAP timeline
 * at `window.__timelines[id]`. `npx hyperframes render` takes it from there.
 * Nothing here reimplements any of that — the engine is a dependency, and
 * staying on its contract is what keeps it one.
 *
 * What this is *not* is a finished film. It is the boring 80%: footage on the
 * timeline at the right size, a title card, chapter cards, lower thirds already
 * timed to the moments the driver recorded, a closing card. An agent then edits
 * the HTML — that is the whole HyperFrames bet, and `reel-compose` is the skill
 * that teaches it. Scaffolding further would be building templates again, which
 * is the mistake this rescope exists to undo.
 *
 * ## Rules the scaffold never breaks
 *
 * **Nothing is fetched.** GSAP is copied from `node_modules`, not linked from a
 * CDN, and every named font family gets an `@font-face`. A render that reaches
 * the network depends on someone else's uptime and fails outright in a sandbox
 * — which is exactly how the first version of this failed.
 *
 * **Motion is seek-safe.** Every tween goes on the one paused timeline. No
 * clocks, no `requestAnimationFrame`, no infinite repeats: the renderer samples
 * frames out of order and in parallel, so anything that accumulates state
 * across frames desyncs.
 */

export interface ComposeOptions {
  out: string;
  look?: LookName;
  accent: string;
  width: number;
  height: number;
  fps: number;
  /** Opening card headline. Defaults to the first chapter's name. */
  title?: string;
  subtitle?: string;
}

/** Seconds. */
const TITLE = 3.4;
const CHAPTER = 2.6;
const OUTRO = 2.8;
/** Longest a lower third stays up once it arrives. */
const LOWER_THIRD = 3.6;
/** Overlap so a card dissolves into what follows instead of splicing. */
const HANDOFF = 0.5;
/** How far the camera drifts across a chapter. Small on purpose. */
const DRIFT = 0.05;
/** The emphasis push on a beat, and how long it holds. */
const PUNCH = 0.06;
const PUNCH_HOLD = 1.5;
/** Beats closer than this do not each get a push — that reads as a twitch. */
const PUNCH_GAP = 3.5;

/** One chapter of the film: a manifest, placed on the timeline. */
interface Chapter {
  shot: ShotManifest;
  /** Index, for element ids. */
  i: number;
  /** Composition time the footage starts. */
  at: number;
  /** Composition time the chapter card starts, when there is one. */
  cardAt?: number;
  /** Scale the footage sits at, before any drift. */
  fit: number;
  file: string;
}

export async function compose(
  manifestPaths: string[],
  opts: ComposeOptions,
): Promise<{ dir: string; index: string; duration: number; chapters: number }> {
  if (manifestPaths.length === 0) {
    throw new ReelError(
      "`reel compose` needs at least one shot manifest.",
      "`reel shoot <spec>` writes one next to the footage it films.",
    );
  }
  const shots = await Promise.all(manifestPaths.map(readManifest));
  const dir = resolve(opts.out);
  await mkdir(dir, { recursive: true });

  // Several chapters means several footage files in one directory, so they are
  // numbered rather than all called footage.mp4.
  const chapters: Chapter[] = [];
  let t = TITLE - HANDOFF;
  for (const [i, shot] of shots.entries()) {
    const file = shots.length === 1 ? "footage.mp4" : `footage-${i}.mp4`;
    const from = resolve(dirname(manifestPaths[i]!), shot.footage);
    await copyFile(from, join(dir, file)).catch(() => {
      throw new ReelError(
        `The manifest points at footage that is not there: ${from}`,
        "Run `reel shoot` again — the manifest and its footage are written together.",
      );
    });

    // A chapter card between sections, but never before the first: the opening
    // title already introduced it, and two cards back to back is a stall.
    const cardAt = i > 0 ? t : undefined;
    if (cardAt !== undefined) t += CHAPTER - HANDOFF;

    chapters.push({
      shot,
      i,
      at: t,
      fit: fitScale(shot, opts),
      file,
      ...(cardAt === undefined ? {} : { cardAt }),
    });
    t += shot.duration;
  }
  const outroAt = t;
  const duration = Number((outroAt + OUTRO).toFixed(3));

  await vendorGsap(dir);
  const index = join(dir, "index.html");
  await writeFile(index, buildComposition(chapters, duration, outroAt, opts));
  await writeFile(
    join(dir, "hyperframes.json"),
    JSON.stringify({ name: slug(shots[0]!.name), entry: "index.html" }, null, 2) + "\n",
  );

  log.info(`Composition ${index} — ${duration.toFixed(1)}s, ${chapters.length} chapter(s)`);
  log.info(`Render it:   npx hyperframes render --fps ${opts.fps}`);
  return { dir, index, duration, chapters: chapters.length };
}

/**
 * How large the footage sits in the frame.
 *
 * Footage shot at the composition's own aspect fills it. Anything else — a
 * terminal sized from its grid, a mobile viewport — is inset instead, so the
 * mismatch reads as a deliberately framed window rather than as letterboxing
 * somebody forgot to fix. The look's ground shows in the margin.
 */
function fitScale(shot: ShotManifest, opts: ComposeOptions): number {
  const frame = opts.width / opts.height;
  const footage = shot.width / shot.height;
  return Math.abs(frame - footage) < 0.02 ? 1 : 0.86;
}

async function readManifest(path: string): Promise<ShotManifest> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new ReelError(
      `No shot manifest at ${path}.`,
      "`reel shoot <spec>` writes one next to the footage it films.",
    );
  }
  const shot = JSON.parse(raw) as ShotManifest;
  if (shot.version !== 1) {
    throw new ReelError(
      `That manifest is version ${String(shot.version)}, and this Reel reads version 1.`,
      "Re-shoot the footage with this version of Reel.",
    );
  }
  return shot;
}

/**
 * Copy GSAP in rather than linking it.
 *
 * Resolved from Reel's own dependencies, so the composition works the moment it
 * is written — no install step in the project directory, and no network at
 * render time.
 */
async function vendorGsap(dir: string): Promise<void> {
  const require = createRequire(import.meta.url);
  let from: string;
  try {
    from = require.resolve("gsap/dist/gsap.min.js");
  } catch {
    throw new ReelError(
      "GSAP is not installed, so the composition would have nothing to animate with.",
      "Run `npm install gsap` in Reel's own directory.",
    );
  }
  await copyFile(from, join(dir, "gsap.min.js"));
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "demo";
}

const r3 = (n: number): number => Number(n.toFixed(3));

/**
 * Families a browser resolves itself, which must not be declared.
 *
 * `-apple-system` and `BlinkMacSystemFont` are keywords rather than font names,
 * and the `ui-*` families plus the bare generics are CSS generics. An
 * `@font-face` for any of them would declare a face that does not exist.
 */
const GENERIC_FAMILIES = new Set([
  "-apple-system", "blinkmacsystemfont", "system-ui", "ui-sans-serif", "ui-serif",
  "ui-monospace", "ui-rounded", "sans-serif", "serif", "monospace", "cursive", "fantasy",
]);

/**
 * Declare every named family a look uses, as a local face.
 *
 * HyperFrames' `check` rejects a family it cannot resolve, and it is right to: a
 * font the renderer silently substitutes is not the typography anyone approved.
 * Nothing here is downloadable — these are system faces — so `src: local(...)`
 * says "expected to be on the machine", which is exactly the truth.
 */
function fontFaces(...stacks: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const stack of stacks) {
    for (const raw of stack.split(",")) {
      const name = raw.trim().replace(/^["']|["']$/g, "");
      const key = name.toLowerCase();
      if (!name || seen.has(key) || GENERIC_FAMILIES.has(key)) continue;
      seen.add(key);
      out.push(`  @font-face { font-family: "${name}"; src: local("${name}"); }`);
    }
  }
  return out.join("\n");
}

/** A headline split into per-word spans — the difference between a title and a slide. */
function words(text: string): string {
  return esc(text)
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `<span class="w">${w}</span>`)
    .join(" ");
}

/**
 * Beats worth pushing in on.
 *
 * Every beat would be a twitch. The first is skipped because the chapter has
 * only just arrived, and anything within `PUNCH_GAP` of the last push is
 * dropped so the camera settles between emphases.
 */
function punchBeats(shot: ShotManifest): { t: number; label: string }[] {
  const out: { t: number; label: string }[] = [];
  let last = -Infinity;
  for (const b of shot.beats.slice(1)) {
    if (b.t - last < PUNCH_GAP) continue;
    if (b.t > shot.duration - PUNCH_HOLD) continue;
    out.push({ t: b.t, label: b.label });
    last = b.t;
  }
  return out;
}

function cardMarkup(
  id: string,
  at: number,
  dur: number,
  headline: string,
  sub: string,
  slate: string,
): string {
  // The fade lives on `.in`, never on the clip itself: HyperFrames owns a
  // clip's visibility, and an opacity tween that ends on the clip boundary
  // leaves stale state when the renderer seeks out of order. Its linter catches
  // this (`gsap_exit_missing_hard_kill`), and it is right to.
  return `    <div class="clip card" id="${id}" data-start="${r3(at)}" data-duration="${r3(dur)}">
      <div class="in">
        <div class="bg b1"></div><div class="bg b2"></div><div class="plate"></div>
        ${slate ? `<div class="slate"><div class="k">Reel</div><div class="n">${esc(slate)}</div></div>` : ""}
        <div class="headline">${words(headline)}</div>
        <div class="rule"></div>
        ${sub ? `<div class="sub">${esc(sub)}</div>` : ""}
      </div>
    </div>`;
}

/** Tweens shared by every card: words ripple in, rule draws, backdrop never stops. */
function cardTweens(id: string, at: number, dur: number, hasSub: boolean, hasSlate: boolean): string {
  return [
    `  gsap.utils.toArray("#${id} .w").forEach(function (w, i) {`,
    `    tl.fromTo(w, { opacity: 0, yPercent: 45, filter: "blur(12px)" },`,
    `      { opacity: 1, yPercent: 0, filter: "blur(0px)", duration: .7, ease: "power3.out" }, ${r3(at)} + i * 0.075);`,
    `  });`,
    `  tl.fromTo("#${id} .rule", { scaleX: 0 }, { scaleX: 1, duration: .6, ease: "power3.out" }, ${r3(at + 0.3)});`,
    hasSlate
      ? `  tl.fromTo("#${id} .slate", { opacity: 0, x: -24 }, { opacity: 1, x: 0, duration: .5, ease: "power3.out" }, ${r3(at + 0.1)});`
      : "",
    hasSub
      ? `  tl.fromTo("#${id} .sub", { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: .6, ease: "power3.out" }, ${r3(at + 0.45)});`
      : "",
    // The backdrop moves for the card's whole life. One that stops after the
    // entrance is what makes a card read as a slide.
    `  tl.fromTo("#${id} .b1", { scale: .88 }, { scale: 1.2, duration: ${r3(dur)}, ease: "none" }, ${r3(at)});`,
    `  tl.fromTo("#${id} .b2", { scale: 1.18 }, { scale: .94, duration: ${r3(dur)}, ease: "none" }, ${r3(at)});`,
    `  tl.to("#${id} .in", { opacity: 0, duration: ${HANDOFF}, ease: "power2.inOut" }, ${r3(at + dur - HANDOFF)});`,
    // A zero-duration set on the boundary, so a seek landing past the fade gets
    // the resolved state rather than whatever the tween last wrote.
    `  tl.set("#${id} .in", { opacity: 0 }, ${r3(at + dur)});`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildComposition(
  chapters: Chapter[],
  duration: number,
  outroAt: number,
  opts: ComposeOptions,
): string {
  const look: Look = lookFor(opts.look ?? DEFAULT_LOOK);
  const accent = escapeCss(opts.accent);
  const first = chapters[0]!.shot;
  const id = slug(first.name);
  const title = opts.title ?? first.name;
  const sub = opts.subtitle ?? "";

  const footage: string[] = [];
  const thirds: string[] = [];
  const cards: string[] = [];
  const tweens: string[] = [];

  for (const ch of chapters) {
    const fid = `f${ch.i}`;
    // The video sits inside an untimed wrapper, and the two carry one move
    // each: the wrapper drifts, the video punches. Both on the same element
    // would be two tweens fighting over `scale`, and GSAP's overwrite order is
    // not guaranteed — HyperFrames' linter flags exactly that
    // (`overlapping_gsap_tweens`). Nested transforms multiply, so the effect
    // composes correctly anyway. The wrapper carries no `data-start`, which
    // also keeps it clear of the rule against nesting a timed video in a timed
    // element.
    const sid = `s${ch.i}`;
    footage.push(
      `    <div class="shot" id="${sid}">` +
        `<video id="${fid}" class="footage" data-start="${r3(ch.at)}" data-duration="${r3(ch.shot.duration)}"` +
        ` src="./${ch.file}" muted playsinline></video></div>`,
    );

    // A slow drift across the chapter. Costs nothing — the frames are already
    // on disk — and it is the difference between footage and a held still.
    tweens.push(
      `  tl.fromTo("#${sid}", { scale: ${ch.fit} }, { scale: ${r3(ch.fit * (1 + DRIFT))}, duration: ${r3(ch.shot.duration)}, ease: "none" }, ${r3(ch.at)});`,
    );

    for (const b of punchBeats(ch.shot)) {
      const at = r3(ch.at + b.t);
      tweens.push(
        `  // emphasis on beat "${esc(b.label)}"`,
        `  tl.to("#${fid}", { scale: ${1 + PUNCH}, duration: .7, ease: "power2.out" }, ${at});`,
        `  tl.to("#${fid}", { scale: 1, duration: .8, ease: "power2.inOut" }, ${r3(at + PUNCH_HOLD)});`,
      );
    }

    for (const [n, c] of ch.shot.captions.entries()) {
      const next = ch.shot.captions[n + 1]?.t ?? ch.shot.duration;
      const dur = Math.max(1.2, Math.min(LOWER_THIRD, next - c.t));
      const at = r3(ch.at + c.t);
      const lid = `lt${ch.i}_${n}`;
      thirds.push(
        `    <div class="clip lower" id="${lid}" data-start="${at}" data-duration="${r3(dur)}">` +
          `<div class="in"><div class="lt-bar"></div><div class="lt-text">${esc(c.text)}</div></div></div>`,
      );
      tweens.push(
        `  tl.fromTo("#${lid} .lt-text", { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: .45, ease: "power3.out" }, ${at});`,
        `  tl.fromTo("#${lid} .lt-bar", { scaleX: 0 }, { scaleX: 1, duration: .5, ease: "power3.out" }, ${at});`,
        `  tl.to("#${lid} .in", { opacity: 0, duration: .3, ease: "power2.in" }, ${r3(at + dur - 0.3)});`,
        `  tl.set("#${lid} .in", { opacity: 0 }, ${r3(at + dur)});`,
      );
    }

    if (ch.cardAt !== undefined) {
      const cid = `ch${ch.i}`;
      const slate = `${String(ch.i + 1).padStart(2, "0")} · Chapter`;
      cards.push(cardMarkup(cid, ch.cardAt, CHAPTER, ch.shot.name, "", slate));
      tweens.push(cardTweens(cid, ch.cardAt, CHAPTER, false, true));
    }
  }

  cards.unshift(cardMarkup("title", 0, TITLE, title, sub, slug(first.name)));
  tweens.push(cardTweens("title", 0, TITLE, Boolean(sub), true));

  cards.push(cardMarkup("outro", outroAt, OUTRO, first.name, "", ""));
  tweens.push(cardTweens("outro", outroAt, OUTRO, false, false));

  const H = opts.height;
  const W = opts.width;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<!-- Vendored, never linked: a render that fetches depends on someone's uptime. -->
<script src="./gsap.min.js"></script>
<style>
${fontFaces(look.display, look.label)}
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
  body { font-family: ${look.display}; }
  #root { position: relative; overflow: hidden; background: ${look.ground}; }
  .clip { position: absolute; inset: 0; }

  /* The ground every chapter sits on. Untimed, so it needs its own layout —
     the runtime only lays out elements that carry data-start. */
  #ground { position: absolute; inset: 0; background: ${look.ground}; }
  #ground i { position: absolute; inset: -30%; display: block; }
  #ground .g1 { background: radial-gradient(closest-side, ${accent}, transparent 70%); filter: blur(120px) saturate(1.6); opacity: .3; }
  #ground .g2 { background: radial-gradient(closest-side, ${accent}, transparent 72%); filter: blur(140px) saturate(1.4) hue-rotate(90deg); opacity: .22; }

  /* --- footage -------------------------------------------------------
     contain, never cover: cropping a product demo can cut off the thing the
     demo is about, and nobody notices until it has shipped. Footage that is
     not the frame's aspect is scaled down instead, so the margin reads as a
     framed window rather than as letterboxing left in by mistake. */
  .shot { position: absolute; inset: 0; }
  .footage { width: 100%; height: 100%; object-fit: contain; }

  /* --- cards ---------------------------------------------------------- */
  .card .in { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 8% 10%; }
  .card .bg { position: absolute; inset: -30%; pointer-events: none; }
  .b1 { background: radial-gradient(closest-side, ${accent}, transparent 70%); filter: blur(70px) saturate(2); opacity: .85; }
  .b2 { background: radial-gradient(closest-side, ${accent}, transparent 72%); filter: blur(90px) saturate(1.7) hue-rotate(80deg); opacity: .6; }
  .plate { position: absolute; inset: 8% 4%; background: radial-gradient(ellipse at 50% 50%, ${look.dark ? "rgba(0,0,0,.86)" : "rgba(255,255,255,.9)"} 0%, transparent 74%); }
  .headline {
    position: relative; color: ${look.ink};
    font-size: ${Math.round(H * 0.09)}px; font-weight: ${look.displayWeight};
    letter-spacing: ${look.tracking}; line-height: 1.04; text-transform: ${look.transform};
  }
  .headline .w { display: inline-block; }
  .rule { position: relative; width: ${Math.round(W * 0.075)}px; height: 4px; border-radius: 3px; background: ${accent}; margin: ${Math.round(H * 0.03)}px 0; }
  .sub { position: relative; color: ${look.muted}; font-size: ${Math.round(H * 0.027)}px; max-width: 46ch; line-height: 1.45; }
  .slate { position: absolute; top: 6%; left: 5%; text-align: left; padding-left: 14px; border-left: 3px solid ${accent}; }
  .slate .k { font-family: ${look.label}; font-size: ${Math.round(H * 0.014)}px; letter-spacing: .26em; text-transform: uppercase; color: ${look.muted}; }
  .slate .n { color: ${look.ink}; font-size: ${Math.round(H * 0.023)}px; font-weight: 650; margin-top: 4px; }

  /* --- lower thirds ---------------------------------------------------
     A band on the bottom edge, not text floated over the picture. The footage
     moves, so anything placed on it collides with the app eventually — and you
     only find that out per demo, after a render. A band is right at every
     frame of every demo. */
  .lower .in {
    position: absolute; inset: auto 0 0 0; height: 14%;
    display: flex; align-items: center; gap: ${Math.round(W * 0.014)}px; padding: 0 7%;
    background: linear-gradient(transparent, rgba(6,8,14,.94) 46%);
  }
  .lt-bar { flex: none; width: ${Math.round(W * 0.035)}px; height: 4px; background: ${accent}; transform-origin: left; }
  .lt-text { color: #fff; font-size: ${Math.round(H * 0.033)}px; font-weight: 600; letter-spacing: -.02em; text-shadow: 0 2px 16px rgba(0,0,0,.85); }
</style>
</head>
<body>
  <div id="root" data-composition-id="${id}" data-start="0" data-duration="${duration}"
       data-width="${W}" data-height="${H}" data-fps="${opts.fps}">

    <div id="ground"><i class="g1"></i><i class="g2"></i></div>

${footage.join("\n")}

${thirds.join("\n")}

${cards.join("\n")}
  </div>

<script>
  // One paused timeline, keyed by the root's composition id. The engine seeks
  // it per frame; nothing in here may read a clock.
  const tl = gsap.timeline({ paused: true });

  tl.fromTo("#ground .g1", { scale: .9, xPercent: -4 }, { scale: 1.15, xPercent: 4, duration: ${duration}, ease: "none" }, 0);
  tl.fromTo("#ground .g2", { scale: 1.15 }, { scale: .92, duration: ${duration}, ease: "none" }, 0);

${tweens.join("\n")}

  window.__timelines["${id}"] = tl;
</script>
</body>
</html>
`;
}
