import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { LoadedSpec } from "./load.js";
import { resolveOutput } from "./load.js";
import type { Spec } from "./schema.js";

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
  const parent = first && !first.endsWith("/") ? dirname(dir) : dir;
  return join(parent, ".reel-stamp.json");
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? p : p.slice(0, i);
}

export interface Stamp {
  hash: string;
  version: string;
  epoch: number;
  at: string;
  outputs: string[];
  /**
   * What the render actually produced, which `reel diff` uses to describe a
   * change in the demo's own vocabulary ("beat 3, Create a project") instead of
   * as a bare timecode. Optional: a stamp written by an older Reel, or none at
   * all, costs labels and nothing else.
   */
  beats?: { label: string; t: number }[];
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
  render?: { beats?: { label: string; t: number }[]; durationMs?: number },
): Promise<void> {
  const stamp: Stamp = {
    hash: fp.hash,
    version: fp.version,
    epoch: fp.epoch,
    at: new Date().toISOString(),
    outputs,
    ...(render?.beats?.length ? { beats: render.beats } : {}),
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
