import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_LOOK, isLook, lookFor, type Look } from "../scene/looks.js";
import { fontRequests, loadPreset, presetToLook } from "../scene/presets.js";
import { faceRules, reportFonts, vendorFonts } from "./fonts.js";
import { escapeCss } from "../scene/templates.js";
import { renderSfx, toWav, type SfxCue, type SfxKind } from "../encode/sfx.js";
import { renderMusic } from "./music.js";
import type { ShotManifest } from "../shoot/manifest.js";
import { log, ReelError } from "../util/log.js";
import { cardScene, shotScene, HANDOFF, type SceneFrame } from "./scenes.js";
import { frameMd, hyperframesJson, indexHtml, storyboardMd, type MusicBed } from "./project.js";
import { writeAssembly } from "./assembly.js";
import { SHOT_DIR } from "./packets.js";
import { parseStoryboard } from "./storyboard.js";
import { cardWindows, renderSequence, shotWindows, videoDirection } from "./sequence.js";

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
 * A finished film — and it now says so rather than implying otherwise. Every
 * scene is written as `status: built`, their middle rung: the HTML exists and
 * the layout is real, but nobody has authored it. What comes out is the same
 * five scenes for every film Reel has ever composed.
 *
 * That is the correct output for a generator. It stops being correct the moment
 * it is mistaken for the film, which is what `status: animated` on its own
 * output used to do. The pass that turns a scaffold into this product's film is
 * `reel packets` → author each scene → `reel assemble`, and `reel status`
 * reports how far it got.
 *
 * Three things follow, and they are why this file no longer owns the whole
 * pipeline:
 *
 *  - **`STORYBOARD.md` is read back.** It is the running order, not a report.
 *  - **`assemble` rebuilds the host without it.** Compose never has to run
 *    twice, which matters because it overwrites scenes.
 *  - **Compose refuses to clobber.** A project holding an authored scene is not
 *    something to regenerate by accident.
 */

export interface ComposeOptions {
  out: string;
  /** A Reel look, or a HyperFrames frame preset. */
  look?: string;
  /** Skip fetching webfonts; presets then fall back to local() faces. */
  noFonts?: boolean;
  accent: string;
  width: number;
  height: number;
  fps: number;
  title?: string;
  subtitle?: string;
  /**
   * A music bed: a path to a track, `"none"`, or omitted for a synthesized one.
   *
   * Synthesized is the default because a recording needs a licence and a
   * generated pad does not, and because a render must not fetch. Give it a real
   * track whenever you have one cleared.
   */
  music?: string;
  /**
   * Regenerate every scene even if the project holds authored ones.
   *
   * Compose overwrites scene files. That is fine for its own scaffold and
   * destructive for a scene somebody passed over, so a project with any
   * `status: animated` frame refuses unless this is set. `reel assemble`
   * rebuilds the host without touching the scenes, and is almost always what
   * was wanted instead.
   */
  force?: boolean;
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
  /** Narration clips, in the scene's own time. */
  voice: { at: number; dur: number; file: string }[];
  /** Where this shot's scene starts on the film's timeline. Filled in below. */
  at?: number;
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

  // A name is a Reel look if the catalogue has it, and a frame preset
  // otherwise. Presets win nothing by being checked first: the built-ins are a
  // closed set and a preset install can add names at any time.
  const name0 = opts.look ?? DEFAULT_LOOK;
  const look: Look = isLook(name0) ? lookFor(name0) : presetToLook(await loadPreset(name0));
  const isPreset = !isLook(name0);
  const accent = escapeCss(opts.accent);
  const frame = { width: opts.width, height: opts.height };
  const shots = await Promise.all(manifestPaths.map(readManifest));
  const dir = resolve(opts.out);

  await refuseToClobber(dir, opts);
  await mkdir(join(dir, FRAMES, "media"), { recursive: true });
  await mkdir(join(dir, SHOT_DIR), { recursive: true });
  await vendorGsap(dir);

  // --- typography ---------------------------------------------------------
  // Fetched here, at authoring time, and written into the project. A render
  // still never fetches — that rule is what makes the output self-contained —
  // but composing is authoring, and without this step every frame preset would
  // silently render in a system fallback, which is to say as not itself.
  let faces = "";
  if (isPreset && !opts.noFonts) {
    const preset = await loadPreset(name0);
    const requests = fontRequests(preset);
    const vendored = await vendorFonts(join(dir, FRAMES), requests);
    reportFonts(vendored, requests.map((r) => r.family));
    faces = faceRules(vendored, requests.map((r) => r.family));
  }

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
    const voice = await copyVoice(dir, dirname(manifestPaths[i]!), shot);
    chapters.push({ shot, i, footage, fit: fitScale(shot, opts), voice, ...(sfx ? { sfx } : {}) });
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
      ...(f.sequence ? { sequence: f.sequence } : {}),
      ...(f.voiceover ? { voiceover: f.voiceover } : {}),
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
    sequence: renderSequence(cardWindows(TITLE), "card"),
    html: cardScene({
      id: SCENE_ID_PREFIX + "00-title",
      look,
      accent,
      frame,
      duration: TITLE,
      faces,
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
        sequence: renderSequence(cardWindows(CHAPTER), "card"),
        html: cardScene({
          id,
          look,
          accent,
          frame,
          duration: CHAPTER,
          faces,
          headline: ch.shot.name,
          slate: `${pad(ch.i + 1)} · Chapter`,
        }),
      });
      at += CHAPTER - HANDOFF;
    }

    const id = `${SCENE_ID_PREFIX}${pad(frames.length)}-shot-${slug(ch.shot.name)}`;
    // Recorded so the bed knows, in the film's own time, where the voice is.
    ch.at = at;
    await push({
      id,
      at,
      duration: ch.shot.duration,
      title: `Footage — ${ch.shot.name}`,
      scene: `Real footage of ${ch.shot.name}; ${ch.shot.captions.length} lower thirds, ${ch.shot.beats.length} beats.`,
      poster: Math.min(2, ch.shot.duration / 2),
      transitionIn: "crossfade",
      sequence: renderSequence(shotWindows(ch.shot), "shot"),
      ...(ch.shot.narration.length
        ? { voiceover: ch.shot.narration.map((l) => l.text).join(" ") }
        : {}),
      html: shotScene({
        id,
        look,
        accent,
        frame,
        shot: ch.shot,
        faces,
        ...(ch.voice.length ? { voice: ch.voice } : {}),
        footage: ch.footage,
        ...(ch.sfx ? { sfx: ch.sfx } : {}),
        fit: ch.fit,
        drift: DRIFT,
        punch: PUNCH,
        punchHold: PUNCH_HOLD,
        punchGap: PUNCH_GAP,
      }),
    });
    // The packet builder needs the beats, captions and cues later, when the
    // directory the manifest came from may be long gone. Parking a copy is what
    // makes a composed project authorable on its own.
    await writeFile(join(dir, SHOT_DIR, `${id}.json`), JSON.stringify(ch.shot, null, 2) + "\n");
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
    sequence: renderSequence(cardWindows(OUTRO), "card"),
    html: cardScene({
      id: outroId,
      look,
      accent,
      frame,
      duration: OUTRO,
      faces,
      headline: name,
      slate: "Reel",
    }),
  });
  const duration = Number((at + OUTRO).toFixed(3));

  // --- audio bed ----------------------------------------------------------
  const music = await writeMusic(dir, duration, chapters, opts);

  // --- project files ------------------------------------------------------
  const id = slug(name);
  await writeFile(
    join(dir, "index.html"),
    indexHtml(frames, look, { id, ...frame, fps: opts.fps, duration, ...(music ? { music } : {}) }),
  );
  await writeFile(join(dir, "frame.md"), frameMd(look, accent, name, frame));
  await writeFile(
    join(dir, "STORYBOARD.md"),
    storyboardMd(frames, {
      name,
      ...frame,
      duration,
      message: opts.subtitle ?? `${name} — filmed, not drawn.`,
      direction: videoDirection(look, accent),
    }),
  );
  await writeFile(join(dir, "hyperframes.json"), hyperframesJson(id));
  // The assembly facts their storyboard format has no field for. `assemble`
  // reads these back to rebuild the host after a scene has been authored, so
  // only the five scalars the index actually paints travel — a preset this was
  // composed from need not still be installed by then.
  await writeAssembly(dir, {
    version: 1,
    id,
    ...frame,
    fps: opts.fps,
    look: { ground: look.ground, ink: look.ink, dark: look.dark, display: look.display, label: look.label },
    lookName: look.name,
    accent,
    ...(music ? { music } : {}),
  });

  log.info(`Project     ${dir}`);
  log.info(`  ${frames.length} scenes · ${duration.toFixed(1)}s · frame.md + STORYBOARD.md`);
  // Said plainly, because the honest version of this line is the whole point of
  // the authoring pass: what compose emits is a scaffold, and every film it
  // writes is the same one until somebody passes over it scene by scene.
  log.info(`  every scene is \`status: built\` — a scaffold, not an authored film`);
  log.info(`Author it:  reel packets   then author each scene from its packet`);
  log.info(`Rebuild:    reel assemble  (rebuilds index.html, never the scenes)`);
  log.info(`Verify it:  npx hyperframes check && npx hyperframes snapshot`);
  log.info(`Render it:  npx hyperframes render --fps ${opts.fps}`);
  return { dir, index: join(dir, "index.html"), duration, frames: frames.length };
}

/**
 * Refuse to overwrite scenes somebody authored.
 *
 * Compose rewrites every scene file, which is correct for its own scaffold and
 * destructive the moment one of them has been passed over. Before this check
 * the only safe thing to do with a composed project was to never run compose
 * again — so a timing change meant either losing the authoring or hand-editing
 * the host, and in practice it meant the pass never happened.
 */
async function refuseToClobber(dir: string, opts: ComposeOptions): Promise<void> {
  if (opts.force) return;
  let src: string;
  try {
    src = await readFile(join(dir, "STORYBOARD.md"), "utf8");
  } catch {
    return; // Nothing there yet, which is the ordinary case.
  }
  const authored = parseStoryboard(src).frames.filter((f) => f.status === "animated");
  if (authored.length === 0) return;
  throw new ReelError(
    `${dir} holds ${authored.length} authored scene(s), and compose would overwrite ${authored.length === 1 ? "it" : "them"}: ` +
      authored.map((f) => f.title || `frame ${f.index}`).join(", "),
    "`reel assemble` rebuilds index.html from the storyboard without touching the scenes. Use `--force` only to start the film over.",
  );
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

/**
 * Copy a shot's narration audio in beside its footage.
 *
 * Lines with no audio are skipped here and picked up by the storyboard instead,
 * where they become `voiceover:` guides — their format has a field for exactly
 * this. That is the honest degradation: the words survive even when the voice
 * does not, and the storyboard says which frames are missing a track.
 */
async function copyVoice(
  dir: string,
  from: string,
  shot: ShotManifest,
): Promise<{ at: number; dur: number; file: string }[]> {
  const out: { at: number; dur: number; file: string }[] = [];
  for (const [i, line] of shot.narration.entries()) {
    if (!line.file) continue;
    const rel = `media/voice-${shot.name.replace(/[^a-z0-9]+/gi, "").slice(0, 8)}-${i}.mp3`;
    try {
      await copyFile(resolve(from, line.file), join(dir, FRAMES, rel));
    } catch {
      continue; // The manifest promised audio that is not there; the text still travels.
    }
    out.push({
      at: line.t,
      // A line whose length was never measured still has to occupy time, or the
      // clip is zero-length and the framework never plays it.
      dur: line.ms ?? Math.max(1.5, line.text.split(/\s+/).length / 2.6),
      file: rel,
    });
  }
  return out;
}

/**
 * The music bed, and where it has to get out of the way.
 *
 * `--music none` skips it; `--music <file>` copies a real track in; anything
 * else synthesizes one. The duck spans come from the narration cues rather than
 * from the audio, because the driver knows when each line starts — it scheduled
 * it — and reading the level back off a waveform would only estimate that.
 */
async function writeMusic(
  dir: string,
  duration: number,
  chapters: Chapter[],
  opts: ComposeOptions,
): Promise<MusicBed | undefined> {
  if (opts.music === "none") return undefined;

  const file = "media/bed.wav";
  await mkdir(join(dir, "media"), { recursive: true });
  if (opts.music) {
    const ext = opts.music.slice(opts.music.lastIndexOf("."));
    const rel = `media/bed${ext || ".mp3"}`;
    try {
      await copyFile(resolve(opts.music), join(dir, rel));
      log.info(`Music       ${opts.music}`);
      return { file: rel, level: 0.5, duckAt: duckSpans(chapters) };
    } catch {
      throw new ReelError(
        `No music track at ${opts.music}.`,
        "Pass a path to an audio file, `none` for silence, or omit it for a synthesized bed.",
      );
    }
  }

  await writeFile(join(dir, file), toWav(renderMusic(duration * 1000)));
  log.info(`Music       synthesized bed — no licence to clear, and nothing fetched`);
  return { file, level: 0.55, duckAt: duckSpans(chapters) };
}

/** Where narration speaks, in composition time. */
function duckSpans(chapters: Chapter[]): { at: number; dur: number }[] {
  const out: { at: number; dur: number }[] = [];
  for (const ch of chapters) {
    if (ch.at === undefined) continue;
    for (const v of ch.voice) out.push({ at: Number((ch.at + v.at).toFixed(3)), dur: v.dur });
  }
  return out.sort((a, b) => a.at - b.at);
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
