import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { LoadedSpec } from "./load.js";
import { resolveOutput } from "./load.js";
import type { Spec, Step } from "./schema.js";
import { isBranch } from "./schema.js";

/**
 * Deciding whether a demo needs re-recording.
 *
 * Only worth doing because output is deterministic: if the inputs are identical
 * the media would be byte-identical, so re-rendering is pure cost. Recording is
 * the slowest thing Reel does, and CI regenerates on every push.
 *
 * The fingerprint has to cover everything that can change a frame. Getting that
 * wrong in the safe direction means a needless re-record; getting it wrong the
 * other way means shipping stale media, so anything uncertain is included.
 */

/** Bumped when a change to Reel itself could alter rendered output. */
export const RENDER_EPOCH = 1;

export interface Fingerprint {
  /** Hash over the spec and every local input it names. */
  hash: string;
  /** What went into it, so a mismatch can be explained rather than guessed at. */
  inputs: string[];
  version: string;
  epoch: number;
}

/**
 * Local files a spec depends on. A spec that replays a HAR or restores a
 * storageState renders differently when those change, and neither is part of
 * the YAML.
 */
function referencedFiles(spec: Spec, loaded: LoadedSpec): string[] {
  const out: string[] = [];
  if (spec.storageState) out.push(resolveOutput(loaded, spec.storageState));
  if (spec.mock?.har) out.push(resolveOutput(loaded, spec.mock.har));
  for (const p of signInStates(spec.steps)) out.push(resolveOutput(loaded, p));
  return out;
}

/**
 * Every session a `signIn` step restores, branches included.
 *
 * A `signIn` file decides what the app renders from that step onward, exactly
 * as `storageState` does for the whole run — so a re-saved session is a changed
 * input, and `--if-changed` must not skip past one.
 */
export function signInStates(steps: Step[]): string[] {
  const out: string[] = [];
  for (const step of steps) {
    if (isBranch(step)) {
      // Alternate paths are recorded too, so their sign-ins are inputs as well.
      for (const path of step.branch.paths) out.push(...signInStates(path.steps as Step[]));
      continue;
    }
    if ("signIn" in step) {
      out.push(typeof step.signIn === "string" ? step.signIn : step.signIn.state);
    }
  }
  return out;
}

/**
 * The app itself is deliberately *not* fingerprinted: Reel can't know what a
 * URL will serve, and pretending otherwise would make skipping unsafe. Callers
 * that can determine it (a commit SHA, a build id) pass it in.
 */
export async function fingerprint(
  loaded: LoadedSpec,
  reelVersion: string,
  appRevision?: string,
): Promise<Fingerprint> {
  const h = createHash("sha256");
  const inputs: string[] = [];

  // The spec's own bytes, not the parsed object: a comment change is harmless
  // but a reordered key is not, and hashing text avoids having to know which.
  const raw = await readFile(loaded.path, "utf8");
  h.update("spec\0").update(raw);
  inputs.push(loaded.path);

  for (const file of referencedFiles(loaded.spec, loaded)) {
    inputs.push(file);
    try {
      h.update("file\0").update(file).update(await readFile(file));
    } catch {
      // Missing now is itself a state worth distinguishing from present.
      h.update("missing\0").update(file);
    }
  }

  h.update("reel\0").update(reelVersion);
  h.update("epoch\0").update(String(RENDER_EPOCH));
  if (appRevision) {
    h.update("app\0").update(appRevision);
    inputs.push(`app:${appRevision}`);
  }

  return { hash: h.digest("hex").slice(0, 32), inputs, version: reelVersion, epoch: RENDER_EPOCH };
}

/** Where the stamp for a spec lives: beside its outputs, not in the source tree. */
export function stampPath(loaded: LoadedSpec): string {
  const o = loaded.spec.output;
  const first = o.gif ?? o.mp4 ?? o.webm ?? o.html ?? o.storyboard;
  const dir = first ? resolveOutput(loaded, first) : loaded.dir;
  // The first output may be a file or a directory; either way the stamp sits
  // alongside it rather than inside a directory that gets wiped.
  const parent = first && !endsWithSep(first) ? dirname(dir) : dir;
  return join(parent, ".reel-stamp.json");
}

/** A trailing separator is how a spec says an output is a directory. */
function endsWithSep(p: string): boolean {
  return p.endsWith("/") || p.endsWith("\\");
}

/**
 * An output path as the stamp should record it: relative to the stamp itself,
 * with forward slashes so a stamp written on Windows reads the same elsewhere.
 */
export function relativeToStamp(stampPath: string, output: string): string {
  const rel = relative(dirname(stampPath), output);
  return rel.split(sep).join("/") || output;
}

/**
 * The stamp is committed, so it has to be a pure function of the render.
 *
 * It used to carry `at`, an ISO timestamp nothing ever read, and `outputs` as
 * absolute paths — `/home/user/you/repo/docs/demo.gif`. Both were harmless
 * while the file was ignored and neither survives being checked in: the
 * timestamp changes on every render, so a demo that produced byte-identical
 * media would still show up as a change, which is the exact signal this project
 * exists to keep meaningful. The absolute paths would be somebody's home
 * directory, in a public repository, differing per machine.
 *
 * What is left is the fingerprint, what it rendered, and where the beats and
 * captions fell. Two machines running the same spec write the same bytes.
 */
export interface Stamp {
  hash: string;
  version: string;
  epoch: number;
  /** Relative to this file, so the stamp means the same thing anywhere. */
  outputs: string[];
  /**
   * What the render actually produced, which `reel diff` uses to describe a
   * change in the demo's own vocabulary ("beat 3, Create a project") instead of
   * as a bare timecode. Optional: a stamp written by an older Reel, or none at
   * all, costs labels and nothing else.
   */
  beats?: { label: string; t: number }[];
  /**
   * What the demo was claiming, and when. `reel review` needs this to tell a
   * changed frame from a changed frame the captions no longer match; deriving
   * it any other way would mean re-running the spec against the old build.
   */
  captions?: { t: number; text: string }[];
  durationMs?: number;
}

export async function readStamp(path: string): Promise<Stamp | null> {
  try {
    const d = JSON.parse(await readFile(path, "utf8")) as Stamp;
    return typeof d?.hash === "string" ? d : null;
  } catch {
    return null;
  }
}

/**
 * Would re-recording produce what is already on disk?
 *
 * Both halves matter: a matching fingerprint means the inputs are unchanged,
 * and the outputs still existing means nobody deleted the media the stamp
 * claims to describe.
 */
export async function isUpToDate(
  stamp: Stamp | null,
  fp: Fingerprint,
  expectedOutputs: string[],
): Promise<{ upToDate: boolean; reason: string }> {
  if (!stamp) return { upToDate: false, reason: "no previous render recorded" };
  if (stamp.epoch !== fp.epoch) return { upToDate: false, reason: "Reel's renderer changed" };
  if (stamp.version !== fp.version) return { upToDate: false, reason: `Reel version changed (${stamp.version} → ${fp.version})` };
  if (stamp.hash !== fp.hash) return { upToDate: false, reason: "the spec or its inputs changed" };

  for (const out of expectedOutputs) {
    try {
      await stat(out);
    } catch {
      return { upToDate: false, reason: `output missing: ${out}` };
    }
  }
  return { upToDate: true, reason: "spec, inputs and outputs all unchanged" };
}

/** Absolute paths of everything a spec declares it will write. */
export function declaredOutputs(loaded: LoadedSpec): string[] {
  const o = loaded.spec.output;
  const paths = [o.gif, o.mp4, o.webm, o.html, o.storyboard].filter(
    (p): p is string => typeof p === "string",
  );
  return paths.map((p) => (isAbsolute(p) ? p : resolveOutput(loaded, p)));
}

/** Record what was rendered, so the next run can decide whether to repeat it. */
export async function writeStamp(
  path: string,
  fp: Fingerprint,
  outputs: string[],
  render?: {
    beats?: { label: string; t: number }[];
    captions?: { t: number; text: string }[];
    durationMs?: number;
  },
): Promise<void> {
  const stamp: Stamp = {
    hash: fp.hash,
    version: fp.version,
    epoch: fp.epoch,
    // Sorted as well as relative: the order they were encoded in is an
    // implementation detail, and a reordering would read as a change.
    outputs: outputs.map((o) => relativeToStamp(path, o)).sort(),
    ...(render?.beats?.length ? { beats: render.beats } : {}),
    // Only the text and the timing: a CaptionCue also carries measured word
    // advances, which are large, meaningless outside the renderer, and would
    // churn the stamp on every font change.
    ...(render?.captions?.length
      ? { captions: render.captions.map((c) => ({ t: c.t, text: c.text })) }
      : {}),
    ...(render?.durationMs ? { durationMs: render.durationMs } : {}),
  };
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(stamp, null, 2) + "\n", "utf8");
  } catch {
    // A missing stamp costs a re-render next time; failing the build over it
    // would be worse.
  }
}
