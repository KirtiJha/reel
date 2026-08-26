import type { LoadedSpec } from "../spec/load.js";
import { expandMatrix } from "../spec/matrix.js";
import {
  declaredOutputs,
  fingerprint,
  isUpToDate,
  readStamp,
  stampPath,
  writeStamp,
} from "../spec/fingerprint.js";
import { record } from "../driver/run.js";
import { log } from "../util/log.js";

/**
 * Rendering one spec, start to finish.
 *
 * Extracted from the CLI because `reel ci` renders many specs and must do it
 * exactly the same way — the up-to-date check, the matrix expansion and the
 * stamp are not incidental details of the `record` command, they are what
 * rendering *is*. Two copies would drift, and the copy that drifts is the one
 * that runs unattended.
 */

export interface RecordOptions {
  /** Skip when the spec, its inputs and its outputs are all unchanged. */
  ifChanged?: boolean;
  /** Identifies the app being demoed, so a changed app forces a re-render. */
  appRevision?: string;
  /** Reel's own version, which is part of the fingerprint. */
  version: string;
  /** Quick, cheap render for iterating — not a deliverable. */
  draft?: boolean;
  /** Render only the section a named beat labels. */
  only?: string;
}

export interface RecordOutcome {
  outputs: string[];
  /** Set when the render was skipped, saying why it was already current. */
  skipped?: string;
  fingerprint: string;
  variants: {
    variant: string;
    frames: number;
    beats: number;
    durationMs: number;
    outputs: string[];
  }[];
}

export async function recordOne(loaded: LoadedSpec, opts: RecordOptions): Promise<RecordOutcome> {
  // Skipping is only sound because the output is deterministic: identical
  // inputs would produce identical bytes, so the render is pure cost.
  const fp = await fingerprint(loaded, opts.version, opts.appRevision);
  const stamp = stampPath(loaded);
  const declared = declaredOutputs(loaded);

  if (opts.ifChanged) {
    const state = await isUpToDate(await readStamp(stamp), fp, declared);
    if (state.upToDate) {
      log.ok(`Up to date — ${state.reason}. Skipping.`);
      return { outputs: declared, skipped: state.reason, fingerprint: fp.hash, variants: [] };
    }
    log.info(`Re-recording: ${state.reason}.`);
  }

  const variants = expandMatrix(loaded);
  const outputs: string[] = [];
  const rendered: RecordOutcome["variants"] = [];
  let timeline: { label: string; t: number }[] = [];
  let captions: { t: number; text: string }[] = [];
  let durationMs = 0;

  for (const v of variants) {
    if (variants.length > 1) log.phase(`Variant: ${v.label}`);
    const res = await record(v.loaded, "record", { draft: opts.draft, only: opts.only });
    log.ok(`${res.frames} frames · ${res.beats} beats · ${(res.durationMs / 1000).toFixed(1)}s`);
    outputs.push(...res.outputs);
    // The first variant's beats stand for the demo: a matrix renders the same
    // script at several sizes, so its beats are the same beats.
    if (!timeline.length) {
      timeline = res.timeline;
      captions = res.captions;
      durationMs = res.durationMs;
    }
    rendered.push({
      variant: v.label,
      frames: res.frames,
      beats: res.beats,
      durationMs: res.durationMs,
      outputs: res.outputs,
    });
  }

  // Written after a successful render only: a stamp for media that failed to
  // encode would skip the retry that fixes it.
  //
  // And never for a preview. A draft is small, low-fps and partly silent, and a
  // section render is not the film at all — stamping either would tell the next
  // `--if-changed` that the master is current, and the real render would be
  // skipped in favour of media nobody meant to publish.
  const preview = Boolean(opts.draft || opts.only);
  if (preview) log.info("Preview render — the master and its stamp are untouched.");
  else await writeStamp(stamp, fp, outputs, { beats: timeline, captions, durationMs });
  return { outputs, fingerprint: fp.hash, variants: rendered };
}
