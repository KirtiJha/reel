import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_LOOK, lookFor, type LookName } from "../scene/looks.js";
import { escapeCss } from "../scene/templates.js";
import { renderSfx, toWav, type SfxCue, type SfxKind } from "../encode/sfx.js";
import type { ShotManifest } from "../shoot/manifest.js";
import { log, ReelError } from "../util/log.js";
import { cardScene, shotScene, HANDOFF, type SceneFrame } from "./scenes.js";
import { frameMd, hyperframesJson, indexHtml, storyboardMd } from "./project.js";

/**
 * `reel compose` — assemble footage into a HyperFrames project.
 *
 * ## What it emits, and why the shape matters
 *
 * A canonical HyperFrames project, in the layout their production loop assumes:
 *
 * ```
 * frame.md                       the design spec, tokens in frontmatter
 * STORYBOARD.md                  the plan layer — Studio renders it as a contact sheet
 * hyperframes.json               what makes the directory a project
 * index.html                     assembly only: scenes as sub-compositions on tracks
 * compositions/frames/NN-*.html  one scene per file
 * media/                         footage and its synthesized sound
 * gsap.min.js                    vendored, never linked
 * ```
 *
 * The earlier version emitted one monolithic `index.html`. It rendered
 * correctly and was still wrong: a scene you cannot open, snapshot and rewrite
 * on its own is a scene nobody edits. Splitting them is what lets an agent
 * iterate one card without reading the whole cut, and it is the structure every
 * one of HyperFrames' own skills expects to find.
 *
 * ## What it deliberately is not
 *
 * A finished film. It is the two stages their loop calls Frames and Assembly —
 * real scenes, timed against the shot manifest, verified by their linter. The
 * design work after that belongs in the scene files, where the `reel-compose`
 * skill and HyperFrames' skills do it. Scaffolding further would be building
 * templates again, which is the mistake this whole rescope exists to undo.
 */

export interface ComposeOptions {
  out: string;
  look?: LookName;
  accent: string;
  width: number;
  height: number;
  fps: number;
  title?: string;
  subtitle?: string;
}

/** Seconds. */
const TITLE = 3.4;
const CHAPTER = 2.6;
const OUTRO = 2.8;
/** How far the camera drifts across a shot, and the emphasis push on a beat. */
const DRIFT = 0.05;
const PUNCH = 0.06;
const PUNCH_HOLD = 1.5;
/** Beats closer than this do not each get a push — that reads as a twitch. */
const PUNCH_GAP = 3.5;

interface Chapter {
  shot: ShotManifest;
  i: number;
  footage: string;
  sfx?: string;
  fit: number;
}

export async function compose(
  manifestPaths: string[],
  opts: ComposeOptions,
): Promise<{ dir: string; index: string; duration: number; frames: number }> {
  if (manifestPaths.length === 0) {
    throw new ReelError(
      "`reel compose` needs at least one shot manifest.",
      "`reel shoot <spec>` writes one next to the footage it films.",
    );
  }

  const look = lookFor(opts.look ?? DEFAULT_LOOK);
  const accent = escapeCss(opts.accent);
  const frame = { width: opts.width, height: opts.height };
  const shots = await Promise.all(manifestPaths.map(readManifest));
  const dir = resolve(opts.out);

  await mkdir(join(dir, FRAMES, "media"), { recursive: true });
  await vendorGsap(dir);

  // --- media --------------------------------------------------------------
  const chapters: Chapter[] = [];
  for (const [i, shot] of shots.entries()) {
    // Relative to the scene that plays it, and never above the project root:
    // a render rewrites `../` against the sub-composition's own path, but
    // Studio and every other live consumer resolve from the root and 404.
    const footage = `media/footage-${i}.mp4`;
    const from = resolve(dirname(manifestPaths[i]!), shot.footage);
    await copyFile(from, join(dir, FRAMES, footage)).catch(() => {
      throw new ReelError(
        `The manifest points at footage that is not there: ${from}`,
        "Run `reel shoot` again — the manifest and its footage are written together.",
      );
    });
    const sfx = await writeSfx(dir, i, shot);
    chapters.push({ shot, i, footage, fit: fitScale(shot, opts), ...(sfx ? { sfx } : {}) });
  }

  // --- scenes -------------------------------------------------------------
  const frames: SceneFrame[] = [];
  let at = 0;
  const name = shots[0]!.name;

  const push = async (f: Omit<SceneFrame, "src"> & { html: string }): Promise<void> => {
    const src = `${FRAMES}/${f.id}.html`;
    await writeFile(join(dir, src), f.html);
    frames.push({
      id: f.id,
      src,
      at: f.at,
      duration: f.duration,
      scene: f.scene,
      title: f.title,
      poster: f.poster,
      transitionIn: f.transitionIn,
    });
  };

  await push({
    id: SCENE_ID_PREFIX + "00-title",
    at,
    duration: TITLE,
    title: "Title",
    scene: "Opening card — the film's thesis, waterfall entry.",
    poster: 1.2,
    transitionIn: "cut",
    html: cardScene({
      id: SCENE_ID_PREFIX + "00-title",
      look,
      accent,
      frame,
      duration: TITLE,
      headline: opts.title ?? name,
      ...(opts.subtitle ? { subtitle: opts.subtitle } : {}),
      slate: "Reel",
      slateNote: slug(name),
    }),
  });
  // Scenes overlap by the handoff, so the outgoing one is still dissolving as
  // the next arrives. Splicing them end to end is a hard cut, which is a
  // different edit and a much harder one to make read.
  at += TITLE - HANDOFF;

  for (const ch of chapters) {
    if (ch.i > 0) {
      const id = `${SCENE_ID_PREFIX}${pad(frames.length)}-chapter-${slug(ch.shot.name)}`;
      await push({
        id,
        at,
        duration: CHAPTER,
        title: `Chapter — ${ch.shot.name}`,
        scene: `Chapter card introducing ${ch.shot.name}.`,
        poster: 1,
        transitionIn: "flash",
        html: cardScene({
          id,
          look,
          accent,
          frame,
          duration: CHAPTER,
          headline: ch.shot.name,
          slate: `${pad(ch.i + 1)} · Chapter`,
          flashIn: true,
        }),
      });
      at += CHAPTER - HANDOFF;
    }

    const id = `${SCENE_ID_PREFIX}${pad(frames.length)}-shot-${slug(ch.shot.name)}`;
    await push({
      id,
      at,
      duration: ch.shot.duration,
      title: `Footage — ${ch.shot.name}`,
      scene: `Real footage of ${ch.shot.name}; ${ch.shot.captions.length} lower thirds, ${ch.shot.beats.length} beats.`,
      poster: Math.min(2, ch.shot.duration / 2),
      transitionIn: "crossfade",
      html: shotScene({
        id,
        look,
        accent,
        frame,
        shot: ch.shot,
        footage: ch.footage,
        ...(ch.sfx ? { sfx: ch.sfx } : {}),
        fit: ch.fit,
        drift: DRIFT,
        punch: PUNCH,
        punchHold: PUNCH_HOLD,
        punchGap: PUNCH_GAP,
      }),
    });
    at += ch.shot.duration - HANDOFF;
  }

  const outroId = `${SCENE_ID_PREFIX}${pad(frames.length)}-outro`;
  await push({
    id: outroId,
    at,
    duration: OUTRO,
    title: "Close",
    scene: "Closing card.",
    poster: 1,
    transitionIn: "crossfade",
    html: cardScene({
      id: outroId,
      look,
      accent,
      frame,
      duration: OUTRO,
      headline: name,
      slate: "Reel",
    }),
  });
  const duration = Number((at + OUTRO).toFixed(3));

  // --- project files ------------------------------------------------------
  const id = slug(name);
  await writeFile(join(dir, "index.html"), indexHtml(frames, look, { id, ...frame, fps: opts.fps, duration }));
  await writeFile(join(dir, "frame.md"), frameMd(look, accent, name, frame));
  await writeFile(
    join(dir, "STORYBOARD.md"),
    storyboardMd(frames, {
      name,
      ...frame,
      duration,
      message: opts.subtitle ?? `${name} — filmed, not drawn.`,
    }),
  );
  await writeFile(join(dir, "hyperframes.json"), hyperframesJson(id));

  log.info(`Project     ${dir}`);
  log.info(`  ${frames.length} scenes · ${duration.toFixed(1)}s · frame.md + STORYBOARD.md`);
  log.info(`Verify it:  npx hyperframes check && npx hyperframes snapshot`);
  log.info(`Render it:  npx hyperframes render --fps ${opts.fps}`);
  return { dir, index: join(dir, "index.html"), duration, frames: frames.length };
}

/** Where scenes and the media they play live. */
const FRAMES = "compositions/frames";

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * Scene ids start with a letter.
 *
 * `00-title` is a fine filename and an invalid CSS identifier: `#00-title-v`
 * throws a SyntaxError in `querySelector`, which is a runtime failure inside
 * the scene's own timeline script. Their linter flags it (`id_requires_css_escape`).
 */
const SCENE_ID_PREFIX = "sc";

/**
 * How large the footage sits in the frame.
 *
 * Footage shot at the composition's own aspect fills it. Anything else — a
 * terminal sized from its grid, a phone in portrait — is inset instead, so the
 * mismatch reads as a deliberately framed window rather than as letterboxing
 * somebody forgot to fix.
 */
function fitScale(shot: ShotManifest, opts: ComposeOptions): number {
  const f = opts.width / opts.height;
  return Math.abs(f - shot.width / shot.height) < 0.02 ? 1 : 0.86;
}

/**
 * Render one shot's sound bed to a WAV.
 *
 * Synthesized rather than sampled: no licence to honour, no binary vendored,
 * and the click is a tone rather than a recording of somebody's mouse. Reel
 * already owned the synthesis; this only re-points it at a composition. Returns
 * undefined when the shoot was silent, so no empty `<audio>` is emitted — an
 * id-less or contentless audio clip renders as silence with no explanation.
 */
async function writeSfx(dir: string, i: number, shot: ShotManifest): Promise<string | undefined> {
  const cues: SfxCue[] = shot.sfx
    .filter((c): c is typeof c & { kind: SfxKind } =>
      c.kind === "click" || c.kind === "type" || c.kind === "card")
    .map((c) => ({
      t: c.t * 1000,
      kind: c.kind,
      ...(c.ms === undefined ? {} : { durationMs: c.ms * 1000 }),
    }));
  if (cues.length === 0) return undefined;
  const rel = `media/sfx-${i}.wav`;
  await writeFile(join(dir, FRAMES, rel), toWav(renderSfx(cues, shot.duration * 1000, "subtle")));
  return rel;
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
 * Resolved from Reel's own dependencies, so the project works the moment it is
 * written — no install step in the output directory, and no network at render
 * time. The catalog's own blocks link a CDN, which is exactly why they have to
 * be rewritten before they will render in a sandbox.
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
