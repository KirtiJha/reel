import type { LoadedSpec } from "../spec/load.js";
import { expandMatrix } from "../spec/matrix.js";
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
  /** Reel's own version, for the report. */
  version: string;
  /** Quick, cheap render for iterating — not a deliverable. */
  draft?: boolean;
  /** Render only the section a named beat labels. */
  only?: string;
}

export interface RecordOutcome {
  outputs: string[];
  /** Set when the render was skipped, saying why it was already current. */
  variants: {
    variant: string;
    frames: number;
    beats: number;
    durationMs: number;
    outputs: string[];
  }[];
}

export async function recordOne(loaded: LoadedSpec, opts: RecordOptions): Promise<RecordOutcome> {
  const variants = expandMatrix(loaded);
  const outputs: string[] = [];
  const rendered: RecordOutcome["variants"] = [];
  for (const v of variants) {
    if (variants.length > 1) log.phase(`Variant: ${v.label}`);
    const res = await record(v.loaded, "record", { draft: opts.draft, only: opts.only });
    log.ok(`${res.frames} frames · ${res.beats} beats · ${(res.durationMs / 1000).toFixed(1)}s`);
    outputs.push(...res.outputs);
    rendered.push({
      variant: v.label,
      frames: res.frames,
      beats: res.beats,
      durationMs: res.durationMs,
      outputs: res.outputs,
    });
  }

  return { outputs, variants: rendered };
}
