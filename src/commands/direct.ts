import { readFile, writeFile } from "node:fs/promises";
import pc from "picocolors";
import YAML from "yaml";
import { loadSpec, type LoadedSpec } from "../spec/load.js";
import { specSchema } from "../spec/schema.js";
import { direct, type Direction } from "../direct/direct.js";
import { insertSteps, stepLine, verifyInsertion } from "../direct/apply.js";
import { log } from "../util/log.js";

export interface DirectResult {
  directions: Direction[];
  written: boolean;
}

/**
 * Propose camera and annotation direction, and optionally write it in.
 *
 * The same shape as `reel heal`: work out what should change, show it, and let
 * a person accept it. Direction is taste, and a tool that quietly restages your
 * film is worse than one that suggests — so the default prints and stops.
 */
export async function runDirect(
  loaded: LoadedSpec,
  opts: { write?: boolean } = {},
): Promise<DirectResult> {
  const directions = direct(loaded.spec.steps);

  log.phase(`Direction — ${loaded.spec.name}`);
  if (!directions.length) {
    log.ok("Nothing to propose. Every narrated line already has something to look at.");
    return { directions, written: false };
  }

  for (const d of directions) {
    log.step(`before step ${d.index + 1} — ${d.because}`);
    console.log(pc.green(stepLine(d.step, 2)));
  }
  log.info("");

  if (!opts.write) {
    log.info(
      `${directions.length} proposal(s). Nothing was written — ` +
        "paste what you want, or re-run with `--write`.",
    );
    return { directions, written: false };
  }

  const raw = await readFile(loaded.path, "utf8");
  const next = insertSteps(raw, directions);

  // Parsed and compared before it goes near the file. `heal --write` once
  // destroyed the spec it was asked to repair; this is the guard that lesson
  // bought.
  let parsed;
  try {
    parsed = specSchema.parse(YAML.parse(next));
  } catch (err) {
    log.error("The direction would not have produced a valid spec — nothing was written.");
    throw err;
  }
  verifyInsertion(loaded.spec.steps, parsed.steps, directions.length);

  await writeFile(loaded.path, next, "utf8");
  log.ok(`Wrote ${directions.length} direction(s) into ${loaded.path}`);
  return { directions, written: true };
}

export async function directSpec(
  specPath: string,
  opts: { write?: boolean } = {},
): Promise<DirectResult> {
  return runDirect(await loadSpec(specPath), opts);
}
