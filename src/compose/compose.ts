import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_LOOK, lookFor, type LookName } from "../scene/looks.js";
import { esc, escapeCss } from "../scene/templates.js";
import type { ShotManifest } from "../shoot/manifest.js";
import { log, ReelError } from "../util/log.js";

/**
 * `reel compose` — turn footage into a HyperFrames project.
 *
 * ## What this scaffolds, and what it deliberately does not
 *
 * The output is a real HyperFrames composition: an `index.html` whose root
 * carries `data-composition-id` / `data-width` / `data-height` / `data-duration`,
 * whose clips carry `data-start` / `data-duration`, and which registers exactly
 * one paused GSAP timeline at `window.__timelines[id]`. `npx hyperframes render`
 * takes it from there. Nothing here reimplements any of that — the engine is a
 * dependency, and staying on the contract is what keeps it one.
 *
 * What this is *not* is a finished film. It is the boring 80%: the footage on
 * the timeline at the right size, a title card, lower thirds already timed to
 * the moments the driver recorded, and a closing card. An agent then edits the
 * HTML — that is the whole HyperFrames bet, and the `reel-compose` skill is
 * what teaches it to. Scaffolding further would be building templates again,
 * which is the mistake this rescope exists to undo.
 *
 * ## Two rules the scaffold never breaks
 *
 * **Nothing is fetched.** GSAP is copied in from `node_modules`, not linked from
 * a CDN. A render that reaches the network is a render that depends on someone
 * else's uptime, and in a sandboxed or offline environment it simply fails —
 * which is exactly how the first attempt at this failed.
 *
 * **Motion is seek-safe.** Every tween goes on the one paused timeline. No
 * `Date.now()`, no `requestAnimationFrame`, no infinite repeats. The renderer
 * samples frames out of order and in parallel; anything that accumulates state
 * across frames desyncs.
 */

export interface ComposeOptions {
  /** Where to write the project. */
  out: string;
  /** Visual identity for the cards. */
  look?: LookName;
  /** Brand accent every look is built from. */
  accent: string;
  /** Composition frame. Defaults to 1920×1080. */
  width: number;
  height: number;
  fps: number;
  /** Overrides the manifest's name for the title card. */
  title?: string;
  subtitle?: string;
}


/**
 * Families a browser resolves itself, which must not be declared.
 *
 * `-apple-system` and `BlinkMacSystemFont` are keywords rather than font names,
 * and the `ui-*` families plus the bare generics are CSS generics. Emitting an
 * `@font-face` for any of them would be declaring a face that does not exist.
 */
const GENERIC_FAMILIES = new Set([
  "-apple-system",
  "blinkmacsystemfont",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "sans-serif",
  "serif",
  "monospace",
  "cursive",
  "fantasy",
]);

/**
 * Declare every named family a look uses, as a local face.
 *
 * HyperFrames' `check` rejects a family it cannot resolve, and it is right to:
 * a font the renderer silently substitutes produces typography that is not the
 * typography anyone approved. There is nothing to download here — these are
 * system faces — so `src: local(...)` is the documented way to say "this one is
 * expected to be on the machine", which is exactly the truth.
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

/** How long the cards run, in seconds. */
const TITLE = 3.2;
const OUTRO = 2.8;
/** How long a lower third stays up once it arrives. */
const LOWER_THIRD = 3.4;
/** Overlap so the footage is already up behind the title as it leaves. */
const HANDOFF = 0.5;

export async function compose(
  manifestPath: string,
  opts: ComposeOptions,
): Promise<{ dir: string; index: string; duration: number }> {
  const shot = await readManifest(manifestPath);
  const dir = resolve(opts.out);
  await mkdir(dir, { recursive: true });

  const footageSrc = resolve(dirname(manifestPath), shot.footage);
  await copyFile(footageSrc, join(dir, "footage.mp4")).catch(() => {
    throw new ReelError(
      `The manifest points at footage that is not there: ${footageSrc}`,
      "Run `reel shoot` again — the manifest and its footage are written together.",
    );
  });
  await vendorGsap(dir);

  const html = buildComposition(shot, opts);
  const index = join(dir, "index.html");
  await writeFile(index, html);

  // hyperframes.json is what makes the directory a project its CLI recognises.
  await writeFile(
    join(dir, "hyperframes.json"),
    JSON.stringify({ name: slug(shot.name), entry: "index.html" }, null, 2) + "\n",
  );

  const duration = totalDuration(shot);
  log.info(`Composition ${index} — ${duration.toFixed(1)}s`);
  log.info(`Render it:   npx hyperframes render --fps ${opts.fps}`);
  return { dir, index, duration };
}

function totalDuration(shot: ShotManifest): number {
  return Number((TITLE - HANDOFF + shot.duration + OUTRO).toFixed(3));
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
 * Resolved from Reel's own dependencies so the composition works the moment it
 * is written, with no install step in the project directory and no network at
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

/**
 * The composition itself.
 *
 * Laid out as: title card → footage (with lower thirds timed to the manifest)
 * → closing card. The title and the footage overlap by `HANDOFF` so the cut is
 * a dissolve rather than a splice.
 */
function buildComposition(shot: ShotManifest, opts: ComposeOptions): string {
  const look = lookFor(opts.look ?? DEFAULT_LOOK);
  const accent = escapeCss(opts.accent);
  const id = slug(shot.name);
  const footageAt = Number((TITLE - HANDOFF).toFixed(3));
  const outroAt = Number((footageAt + shot.duration).toFixed(3));
  const total = totalDuration(shot);

  // Captions become lower thirds. Each runs until the next one or LOWER_THIRD,
  // whichever is shorter — a caption that outlives the sentence it belongs to
  // is worse than no caption.
  const thirds = shot.captions.map((c, i) => {
    const next = shot.captions[i + 1]?.t ?? shot.duration;
    const dur = Math.max(1.2, Math.min(LOWER_THIRD, next - c.t));
    return { at: Number((footageAt + c.t).toFixed(3)), dur: Number(dur.toFixed(3)), text: c.text };
  });

  const thirdMarkup = thirds
    .map(
      (t, i) => `      <div class="clip lower" id="lt${i}" data-start="${t.at}" data-duration="${t.dur}">
        <div class="lt-bar"></div><div class="lt-text">${esc(t.text)}</div>
      </div>`,
    )
    .join("\n");

  const thirdTweens = thirds
    .map(
      (t, i) =>
        `      tl.fromTo("#lt${i} .lt-text", { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: .45, ease: "power3.out" }, ${t.at});\n` +
        `      tl.fromTo("#lt${i} .lt-bar", { scaleX: 0 }, { scaleX: 1, duration: .5, ease: "power3.out" }, ${t.at});\n` +
        `      tl.to("#lt${i}", { opacity: 0, duration: .3, ease: "power2.in" }, ${Number((t.at + t.dur - 0.3).toFixed(3))});`,
    )
    .join("\n");

  const title = esc(opts.title ?? shot.name);
  const subtitle = opts.subtitle ? esc(opts.subtitle) : "";
  const words = title
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => `<span class="w" data-i="${i}">${w}</span>`)
    .join(" ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<!-- Vendored, never linked: a render that fetches depends on someone's uptime. -->
<script src="./gsap.min.js"></script>
<style>
${fontFaces(look.display, look.label)}
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${opts.width}px; height: ${opts.height}px; overflow: hidden; background: #000; }
  body { font-family: ${look.display}; }
  #root { position: relative; overflow: hidden; background: ${look.ground}; }
  .clip { position: absolute; inset: 0; }

  /* --- the cards ---------------------------------------------------- */
  .card { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 8% 10%; }
  .card .bg { position: absolute; inset: -30%; pointer-events: none; }
  .b1 { background: radial-gradient(closest-side, ${accent}, transparent 70%); filter: blur(70px) saturate(1.9); opacity: .85; }
  .b2 { background: radial-gradient(closest-side, ${accent}, transparent 72%); filter: blur(90px) saturate(1.6) hue-rotate(80deg); opacity: .6; }
  .plate { position: absolute; inset: 8% 4%; background: radial-gradient(ellipse at 50% 50%, ${look.dark ? "rgba(0,0,0,.85)" : "rgba(255,255,255,.9)"} 0%, transparent 74%); }
  .headline {
    position: relative; color: ${look.ink};
    font-size: ${Math.round(opts.height * 0.098)}px; font-weight: ${look.displayWeight};
    letter-spacing: ${look.tracking}; line-height: 1.03; text-transform: ${look.transform};
  }
  .headline .w { display: inline-block; }
  .rule { position: relative; width: ${Math.round(opts.width * 0.08)}px; height: 4px; border-radius: 3px; background: ${accent}; margin: ${Math.round(opts.height * 0.03)}px 0; }
  .sub { position: relative; color: ${look.muted}; font-size: ${Math.round(opts.height * 0.028)}px; max-width: 46ch; line-height: 1.45; }
  .slate { position: absolute; top: 6%; left: 5%; text-align: left; padding-left: 14px; border-left: 3px solid ${accent}; }
  .slate .k { font-family: ${look.label}; font-size: ${Math.round(opts.height * 0.014)}px; letter-spacing: .26em; text-transform: uppercase; color: ${look.muted}; }
  .slate .n { color: ${look.ink}; font-size: ${Math.round(opts.height * 0.024)}px; font-weight: 650; margin-top: 4px; }

  /* --- the footage --------------------------------------------------- */
  /* contain, never cover: cropping a product demo can cut off the thing the
     demo is about, and nobody notices until it ships. */
  #footage { width: 100%; height: 100%; object-fit: contain; background: ${look.ground}; }

  /* --- lower thirds ---------------------------------------------------
     A band anchored to the bottom edge, not text floated over the picture.
     The footage is full-bleed and its content moves, so anything placed *on*
     it collides with the app sooner or later — and you only find out per demo,
     after rendering. A band is deliberate at every frame of every demo. */
  .lower {
    inset: auto 0 0 0; height: 14%;
    display: flex; align-items: center; gap: ${Math.round(opts.width * 0.014)}px;
    padding: 0 7%;
    background: linear-gradient(transparent, rgba(6,8,14,.94) 46%);
  }
  .lt-bar { flex: none; width: ${Math.round(opts.width * 0.035)}px; height: 4px; background: ${accent}; transform-origin: left; }
  .lt-text {
    color: #fff; font-size: ${Math.round(opts.height * 0.034)}px; font-weight: 600; letter-spacing: -.02em;
    text-shadow: 0 2px 16px rgba(0,0,0,.85);
  }
</style>
</head>
<body>
  <div id="root" data-composition-id="${id}" data-start="0" data-duration="${total}"
       data-width="${opts.width}" data-height="${opts.height}" data-fps="${opts.fps}">

    <!-- Opening card -->
    <div class="clip card" id="title" data-start="0" data-duration="${TITLE}">
      <div class="bg b1"></div><div class="bg b2"></div><div class="plate"></div>
      <div class="slate"><div class="k">Reel</div><div class="n">${esc(slug(shot.name))}</div></div>
      <div class="headline">${words}</div>
      <div class="rule"></div>
      ${subtitle ? `<div class="sub">${subtitle}</div>` : ""}
    </div>

    <!-- The app, filmed. Not a drawing of it. -->
    <video id="footage" data-start="${footageAt}" data-duration="${shot.duration}"
           src="./footage.mp4" muted playsinline></video>

${thirdMarkup}

    <!-- Closing card -->
    <div class="clip card" id="outro" data-start="${outroAt}" data-duration="${OUTRO}">
      <div class="bg b1"></div><div class="bg b2"></div><div class="plate"></div>
      <div class="headline" id="outro-h">${esc(shot.name)}</div>
      <div class="rule"></div>
    </div>
  </div>

<script>
  // One paused timeline, registered under the root's composition id. The engine
  // seeks it per frame; nothing here may read a clock.
  const tl = gsap.timeline({ paused: true });

  // Per-word arrival — the difference between a title and a slide.
  gsap.utils.toArray("#title .w").forEach(function (w, i) {
    tl.fromTo(w, { opacity: 0, yPercent: 40, filter: "blur(10px)" },
      { opacity: 1, yPercent: 0, filter: "blur(0px)", duration: .7, ease: "power3.out" },
      i * 0.08);
  });
  tl.fromTo("#title .rule", { scaleX: 0 }, { scaleX: 1, duration: .6, ease: "power3.out" }, .35);
  ${subtitle ? `tl.fromTo("#title .sub", { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: .6, ease: "power3.out" }, .5);` : ""}
  tl.fromTo("#title .slate", { opacity: 0, x: -20 }, { opacity: 1, x: 0, duration: .5, ease: "power3.out" }, .15);
  // The backdrop keeps moving for the whole card, so it never freezes.
  tl.fromTo("#title .b1", { scale: .9 }, { scale: 1.18, duration: ${TITLE}, ease: "none" }, 0);
  tl.fromTo("#title .b2", { scale: 1.15 }, { scale: .95, duration: ${TITLE}, ease: "none" }, 0);
  // Dissolve into the footage rather than cutting.
  tl.to("#title", { opacity: 0, duration: ${HANDOFF}, ease: "power2.inOut" }, ${Number((TITLE - HANDOFF).toFixed(3))});

${thirdTweens}

  tl.fromTo("#outro-h", { opacity: 0, scale: .94 }, { opacity: 1, scale: 1, duration: .8, ease: "power3.out" }, ${outroAt});
  tl.fromTo("#outro .rule", { scaleX: 0 }, { scaleX: 1, duration: .6, ease: "power3.out" }, ${Number((outroAt + 0.3).toFixed(3))});
  tl.fromTo("#outro .b1", { scale: .95 }, { scale: 1.15, duration: ${OUTRO}, ease: "none" }, ${outroAt});

  window.__timelines["${id}"] = tl;
</script>
</body>
</html>
`;
}
