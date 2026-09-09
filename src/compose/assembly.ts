import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ReelError, log } from "../util/log.js";
import { indexHtml, type AssemblyLook, type MusicBed } from "./project.js";
import { HANDOFF, type SceneFrame } from "./scenes.js";
import {
  parseStoryboard,
  setStatus,
  type FrameStatus,
  type Storyboard,
  type StoryboardFrame,
} from "./storyboard.js";

/**
 * Rebuilding `index.html` from the storyboard, after somebody has authored.
 *
 * ## Why this is a separate step from `compose`
 *
 * Because `compose` writes the scene files, and re-running it to pick up a
 * timing change would overwrite every scene an author had rewritten. That is
 * the whole reason the authoring pass did not exist: there was exactly one
 * command, it regenerated everything, and so the only safe thing to do with a
 * composed project was to not touch it.
 *
 * `assemble` reads the storyboard and the scene files as they now are, and
 * rebuilds only the host. Author a scene, change its duration in the
 * storyboard, run `reel assemble`, and the running order, the seams and the
 * ducking all move with it — while the scenes themselves are never rewritten.
 *
 * ## The sidecar, and why the storyboard is not enough on its own
 *
 * Their storyboard format has no field for the ground colour, the music bed, or
 * the frame rate — reasonably, since it is a plan layer and those are assembly
 * facts. Rather than smuggle them into the frontmatter as unknown keys and hope
 * the meaning survives, `compose` writes them to `.hyperframes/reel-assembly.json`
 * and `assemble` reads them back. The storyboard stays their file, in their
 * format, edited by hand; the sidecar stays Reel's, and nobody has to edit it.
 */

/** Where the sidecar lives, relative to the project root. */
export const ASSEMBLY_FILE = ".hyperframes/reel-assembly.json";

export interface Assembly {
  version: 1;
  /** Composition id of the host — must stay stable across assemblies. */
  id: string;
  width: number;
  height: number;
  fps: number;
  /** Only what the host paints; see `AssemblyLook`. */
  look: AssemblyLook;
  /** Named for the record — the host does not re-resolve it. */
  lookName: string;
  accent: string;
  music?: MusicBed;
}

export async function writeAssembly(dir: string, a: Assembly): Promise<void> {
  await writeFile(join(dir, ASSEMBLY_FILE), JSON.stringify(a, null, 2) + "\n");
}

export async function readAssembly(dir: string): Promise<Assembly> {
  let raw: string;
  try {
    raw = await readFile(join(dir, ASSEMBLY_FILE), "utf8");
  } catch {
    throw new ReelError(
      `No assembly sidecar at ${ASSEMBLY_FILE}.`,
      "`reel compose` writes it. Run compose once to create the project, then assemble to rebuild its host.",
    );
  }
  const a = JSON.parse(raw) as Assembly;
  if (a.version !== 1) {
    throw new ReelError(
      `That sidecar is version ${String(a.version)}, and this Reel reads version 1.`,
      "Re-run `reel compose` to write the project with this version.",
    );
  }
  return a;
}

export interface AssembleResult {
  dir: string;
  index: string;
  duration: number;
  frames: number;
  /** Scenes still carrying compose's own scaffold. */
  scaffold: number;
  warnings: string[];
}

/**
 * Lay the storyboard's frames out end to end and rebuild the host.
 *
 * Timings are **derived here, not read**. The storyboard carries each scene's
 * duration because that is a plan decision an author may change; where each
 * scene *starts* is arithmetic over those durations and the handoff, and a
 * second copy of it in the file would be one more thing to get out of step.
 */
export async function assemble(dirIn: string): Promise<AssembleResult> {
  const dir = resolve(dirIn);
  const a = await readAssembly(dir);

  let src: string;
  try {
    src = await readFile(join(dir, "STORYBOARD.md"), "utf8");
  } catch {
    throw new ReelError(
      `No STORYBOARD.md in ${dir}.`,
      "The storyboard is the running order; assemble builds the host from it.",
    );
  }
  const board = parseStoryboard(src);
  const warnings = board.warnings.map((w) => (w.line ? `line ${w.line}: ${w.message}` : w.message));

  if (board.frames.length === 0) {
    throw new ReelError(
      "That storyboard has no frames, so there is no running order to assemble.",
      "Every scene is a `## Frame N — Title` heading with a `src:` and a `duration:`.",
    );
  }

  const frames: SceneFrame[] = [];
  let at = 0;
  for (const f of board.frames) {
    const problem = missing(f);
    if (problem) {
      throw new ReelError(
        `Frame ${f.index} (${f.title || "untitled"}) ${problem}.`,
        "A frame the host has to mount needs a `src:` and a `duration:`.",
      );
    }
    frames.push({
      id: idFor(f),
      src: f.src!,
      at: Number(at.toFixed(3)),
      duration: f.duration!,
      scene: f.scene ?? "",
      title: f.title,
      poster: f.poster ?? Math.min(1.2, f.duration! / 2),
      transitionIn: f.transitionIn ?? "crossfade",
      ...(f.voiceover ? { voiceover: f.voiceover } : {}),
    });
    // Scenes overlap by the handoff, so the outgoing one is still on screen as
    // the next arrives — that window is where the crossfade lives. A scene
    // shorter than the handoff would start before the one before it.
    if (f.duration! <= HANDOFF) {
      warnings.push(
        `Frame ${f.index} is ${f.duration!.toFixed(2)}s, at or under the ${HANDOFF}s handoff — its seam has no room.`,
      );
    }
    at += f.duration! - HANDOFF;
  }
  const duration = Number((at + HANDOFF).toFixed(3));

  await writeFile(
    join(dir, "index.html"),
    indexHtml(frames, a.look, {
      id: a.id,
      width: a.width,
      height: a.height,
      fps: a.fps,
      duration,
      ...(a.music ? { music: retime(a.music, duration) } : {}),
    }),
  );

  const scaffold = board.frames.filter((f) => f.status !== "animated").length;
  return { dir, index: join(dir, "index.html"), duration, frames: frames.length, scaffold, warnings };
}

/**
 * A scene's composition id is its filename stem.
 *
 * Their frame-worker contract makes this identity load-bearing: the id in the
 * mounted file, the `window.__timelines` key, the host's `data-composition-id`
 * and the file name are all one string. Deriving it from `src` rather than
 * storing it separately means the storyboard cannot name a scene one thing and
 * mount another.
 */
function idFor(f: StoryboardFrame): string {
  const stem = (f.src ?? "").split("/").pop()?.replace(/\.html?$/i, "") ?? "";
  return stem || `frame-${f.index}`;
}

function missing(f: StoryboardFrame): string | undefined {
  if (!f.src) return "has no `src:`, so there is no file to mount";
  if (f.duration === undefined) return "has no `duration:`, so it has no length in the cut";
  if (f.duration <= 0) return "has a duration of zero or less";
  return undefined;
}

/**
 * Keep the bed the length of the cut, and drop ducking that fell off the end.
 *
 * A scene retimed by an author moves everything after it. The duck spans were
 * measured in the original cut's time, so a span past the new end would tween
 * a volume the film never reaches — harmless, but it means the bed never comes
 * back up, and that is audible.
 */
function retime(music: MusicBed, duration: number): MusicBed {
  return { ...music, duckAt: music.duckAt.filter((d) => d.at < duration) };
}

/** What `reel status` reports: where the authoring pass has got to. */
export interface Status {
  frames: { index: number; title: string; status: string; src?: string; authored: boolean }[];
  animated: number;
  total: number;
  warnings: string[];
}

export async function status(dirIn: string): Promise<Status> {
  const dir = resolve(dirIn);
  let src: string;
  try {
    src = await readFile(join(dir, "STORYBOARD.md"), "utf8");
  } catch {
    throw new ReelError(
      `No STORYBOARD.md in ${dir}.`,
      "`reel compose <manifest>` writes the project the pass works on.",
    );
  }
  const board: Storyboard = parseStoryboard(src);
  const frames = board.frames.map((f) => ({
    index: f.index,
    title: f.title,
    status: f.status,
    ...(f.src ? { src: f.src } : {}),
    authored: f.status === "animated",
  }));
  return {
    frames,
    animated: frames.filter((f) => f.authored).length,
    total: frames.length,
    warnings: board.warnings.map((w) => (w.line ? `line ${w.line}: ${w.message}` : w.message)),
  };
}

/**
 * Promote (or demote) scenes in the storyboard.
 *
 * The orchestrator's own step, and it needs to be a command rather than a
 * hand-edit: an author returns, the orchestrator marks the frame, and doing
 * that by hand-editing markdown in the middle of a dispatch loop is how a
 * status ends up on the wrong frame. `setStatus` rewrites the one bullet, so
 * everything else in the file — the narrative, the shot sequence, the direction
 * — survives untouched.
 */
export async function mark(
  dirIn: string,
  frames: number[],
  to: FrameStatus,
): Promise<{ marked: number[]; missing: number[] }> {
  const dir = resolve(dirIn);
  const path = join(dir, "STORYBOARD.md");
  let src: string;
  try {
    src = await readFile(path, "utf8");
  } catch {
    throw new ReelError(
      `No STORYBOARD.md in ${dir}.`,
      "`reel compose <manifest>` writes the project the pass works on.",
    );
  }
  const known = new Set(parseStoryboard(src).frames.map((f) => f.index));
  const marked: number[] = [];
  const missing: number[] = [];
  for (const n of frames) {
    if (!known.has(n)) {
      missing.push(n);
      continue;
    }
    src = setStatus(src, n, to);
    marked.push(n);
  }
  if (marked.length > 0) await writeFile(path, src);
  return { marked, missing };
}

/** Print a status the way the rest of the CLI prints things. */
export function reportStatus(s: Status): void {
  for (const f of s.frames) {
    const mark = f.authored ? "✓" : "·";
    log.info(`  ${mark} ${String(f.index).padStart(2)} ${f.title.padEnd(28)} ${f.status}`);
  }
  log.info(`  ${s.animated} of ${s.total} scenes authored`);
  if (s.animated < s.total) {
    log.info(`Next        reel packets, then author each scene still marked \`built\``);
  }
}
