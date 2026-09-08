import { readFile } from "node:fs/promises";
import { resolveFrom } from "../spec/load.js";
import { ReelError } from "../util/log.js";
import {
  renderTemplate,
  TEMPLATES,
  type SceneFields,
  type SceneStyle,
  type TemplateName,
} from "./templates.js";

/**
 * A scene: an HTML composition, seeked frame by frame.
 *
 * The idea is borrowed from HyperFrames — write the non-footage parts of a
 * video in HTML and seek a paused timeline once per output frame — and it fits
 * Reel exactly, because `Recorder.motion` is already that primitive: it calls
 * `render(p)` for each frame and captures at an exact timeline position, so the
 * frame count is a function of duration and fps rather than of how fast
 * screenshots come back.
 *
 * What is deliberately *not* borrowed is authoring the whole video this way. A
 * demo is a recording of a real app; an HTML composition can only ever be a
 * drawing of one. Scenes are for the parts that were never footage: the title,
 * the chapter opener, the claim between two sections.
 *
 * ## Why the animation model is what it is
 *
 * HyperFrames seeks GSAP timelines. Reel cannot: the determinism layer
 * suppresses CSS animations and transitions inside every document, on purpose,
 * so an app's own motion cannot make two renders differ. Rather than carve an
 * exception, a scene's motion is a *pure function of the seek position*: Reel
 * writes `--in` and `--out` as CSS custom properties and the composition reads
 * them. There is no clock to freeze, which is a stronger guarantee than pausing
 * one.
 */

/** How much of a scene is spent arriving, and how much leaving. */
const IN_FRACTION = 0.28;
const OUT_FRACTION = 0.16;

export interface SceneSpec {
  template?: TemplateName;
  /** A composition of your own, relative to the spec. */
  file?: string;
  fields: SceneFields;
  style: SceneStyle;
}

/**
 * The full document for a scene, ready to be an iframe's `srcdoc`.
 *
 * Self-contained by construction: no network, no imports, everything inline.
 * A scene that fetched a font or a script would put someone's uptime between a
 * spec and its output, which is the byte-identical promise gone.
 */
export async function buildScene(spec: SceneSpec, specDir: string): Promise<string> {
  const body = spec.file
    ? await readComposition(spec.file, specDir)
    : renderTemplate(spec.template ?? "title", spec.fields, spec.style);

  return `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{height:100%;margin:0;overflow:hidden}</style>
</head><body>${body}
<script>${SEEK_RUNTIME}</script>
</body></html>`;
}

/**
 * The runtime Reel puts in every scene.
 *
 * Kept as a string rather than a function passed through Playwright: the
 * bundler rewrites function declarations, and injected code that depends on the
 * build's output shape breaks in ways that look like the page's fault. This is
 * the same reasoning `src/authoring/observe.ts` records.
 */
const SEEK_RUNTIME = `
(() => {
  var IN = ${IN_FRACTION}, OUT = ${OUT_FRACTION};
  // Ease so an entrance settles rather than stopping dead. Cubic in-out is the
  // same curve the camera uses, so a scene and a zoom feel like one film.
  function ease(t) { return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  window.__reelSeek = function (p) {
    var r = document.documentElement;
    r.style.setProperty('--p', String(p));
    r.style.setProperty('--in', String(ease(clamp01(IN > 0 ? p / IN : 1))));
    // 1 while the scene is up, ramping to 0 as it leaves.
    r.style.setProperty('--out', String(ease(clamp01(OUT > 0 ? (1 - p) / OUT : 1))));
    // A composition of your own can do anything the variables cannot express.
    if (window.__reelScene && typeof window.__reelScene.seek === 'function') {
      window.__reelScene.seek(p);
    }
  };
  window.__reelSeek(0);
})();
`;

/**
 * Read a hand-written composition.
 *
 * Local files only, and the same reasoning as `image:`: a render never fetches.
 * A composition is also *code* — it runs in the page — so it is read from the
 * spec's own directory, where it is committed and reviewed like any other
 * input, rather than pulled from a URL at render time.
 */
async function readComposition(file: string, specDir: string): Promise<string> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(file)) {
    throw new ReelError(
      `\`scene.file: ${file}\` is a URL, and a render never fetches.`,
      "Save the composition next to the spec and reference it by path.",
    );
  }
  const path = resolveFrom(specDir, file);
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new ReelError(
      `\`scene.file: ${file}\` was not found.`,
      `Looked in ${path}. Scene paths are relative to the spec, like every other path in it.`,
    );
  }
}

/** Is this a template Reel can draw? */
export function isTemplate(name: string): name is TemplateName {
  return (TEMPLATES as readonly string[]).includes(name);
}
