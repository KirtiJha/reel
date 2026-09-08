import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { record } from "../driver/run.js";
import type { LoadedSpec } from "../spec/load.js";
import { buildManifest, type ShotManifest } from "../shoot/manifest.js";
import { PRESETS } from "../spec/schema.js";
import { log } from "../util/log.js";

/**
 * `reel shoot` — film the app, and stop there.
 *
 * ## What this is, and why it is not `reel record`
 *
 * `record` produces a *finished* video: browser chrome, burned-in captions,
 * title cards, fades, the lot. That was the right shape when Reel was the whole
 * pipeline. It is the wrong shape when the film is cut in a composition, because
 * every one of those decisions is now someone else's to make, and a decision
 * baked into a frame cannot be unmade.
 *
 * So `shoot` films the app and nothing else. No frame, no captions in the
 * picture, no title cards, no fade at either end — those become clips in the
 * composition, where they can be restyled, retimed, translated or cut. What
 * comes out is footage plus a manifest of everything the driver knows about
 * what it just filmed.
 *
 * The camera is the one judgement call. Zoom stays on by default: a push-in is
 * a property of the *shot* — it was chosen while the app was being driven, with
 * the element's real box in hand — and it cannot be recovered later from a flat
 * recording without upscaling. `--flat` turns it off for compositions that want
 * to do their own framing.
 */

export interface ShootOptions {
  /** Where the footage and manifest go. */
  out: string;
  /** Film the whole frame with no camera moves at all. */
  flat?: boolean;
  /** Reel's own version, recorded in the manifest's trail. */
  version: string;
}

export interface ShootOutcome {
  dir: string;
  footage: string;
  manifest: string;
  shot: ShotManifest;
}

/**
 * Strip a spec down to footage.
 *
 * This mutates a *copy* of the parsed spec rather than asking authors to
 * maintain two specs. The same `.reel.yaml` should be able to produce a
 * standalone video and footage for a composition; which one you get is the
 * command you ran, not a different file to keep in sync.
 */
function footageSpec(loaded: LoadedSpec, opts: ShootOptions): LoadedSpec {
  const spec = structuredClone(loaded.spec);

  spec.polish = {
    ...spec.polish,
    frame: "none",
    padding: 0,
    radius: 0,
    // Captions ride in the manifest instead of the picture.
    captions: false,
    // A fade belongs to the cut, and the cut is the composition's.
    ...(spec.polish.fadeIn === undefined ? {} : { fadeIn: 0 }),
    ...(spec.polish.fadeOut === undefined ? {} : { fadeOut: 0 }),
    ...(opts.flat ? { zoom: false as const, idleMotion: "none" as const } : {}),
  };

  // One file, and it is the footage. Everything else a spec can emit — gif,
  // webm, the interactive build, the storyboard — is a deliverable, and this
  // is an input.
  spec.output = {
    ...spec.output,
    mp4: join(opts.out, "footage.mp4"),
    gif: undefined,
    webm: undefined,
    html: undefined,
    player: undefined,
    storyboard: undefined,
  } as typeof spec.output;

  return { ...loaded, spec };
}

export async function shoot(loaded: LoadedSpec, opts: ShootOptions): Promise<ShootOutcome> {
  const dir = resolve(loaded.dir, opts.out);
  await mkdir(dir, { recursive: true });

  const prepared = footageSpec(loaded, opts);
  const res = await record(prepared, "record");

  const footage = join(dir, "footage.mp4");
  const spec = prepared.spec;
  const shot = buildManifest({
    spec: relative(dir, loaded.path) || basename(loaded.path),
    name: spec.name,
    footage: "footage.mp4",
    // What the encoder actually wrote. Deriving this from `viewport` was wrong
    // in two ways at once: a preset's `maxWidth` scales the picture down, and a
    // terminal demo sizes from its grid rather than from a viewport at all — a
    // 1000x624 terminal was being reported as 2560x1600.
    width: res.size?.width ?? Math.round(spec.viewport.width * spec.viewport.scale),
    height: res.size?.height ?? Math.round(spec.viewport.height * spec.viewport.scale),
    // The preset supplies an fps when the spec does not name one; falling back
    // to 30 here would put a number in the manifest the footage does not have.
    fps: spec.output.fps ?? PRESETS[spec.output.preset].fps,
    durationMs: res.durationMs,
    beats: res.timeline,
    captions: res.captions,
  });

  const manifest = join(dir, "shots.json");
  await writeFile(manifest, JSON.stringify(shot, null, 2) + "\n");

  log.info(`Footage  ${footage}`);
  log.info(`Manifest ${manifest} — ${shot.beats.length} beats, ${shot.captions.length} captions`);
  return { dir, footage, manifest, shot };
}
