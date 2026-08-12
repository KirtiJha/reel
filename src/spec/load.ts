import { readFile } from "node:fs/promises";
import { resolve, dirname, isAbsolute } from "node:path";
import { parse as parseYaml } from "yaml";
import { specSchema, type Spec } from "./schema.js";
import { ReelError } from "../util/log.js";

export interface LoadedSpec {
  spec: Spec;
  /** Absolute path to the spec file. */
  path: string;
  /** Directory of the spec file — output paths resolve relative to this. */
  dir: string;
}

/**
 * Load and validate a spec from a YAML (or JSON) file. Errors are turned into
 * human-readable messages with the offending field path, because a good spec
 * error is half the DX.
 */
export async function loadSpec(specPath: string): Promise<LoadedSpec> {
  const abs = resolve(process.cwd(), specPath);
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch {
    throw new ReelError(`Spec file not found: ${specPath}`, "Create one with `reel init`.");
  }

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new ReelError(`Could not parse ${specPath} as YAML`, (err as Error).message);
  }

  const result = specSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ReelError(`Invalid spec (${specPath}):\n${issues}`);
  }

  return { spec: result.data, path: abs, dir: dirname(abs) };
}

/** Resolve an output path from the spec file's directory. */
export function resolveOutput(loaded: LoadedSpec, p: string): string {
  return isAbsolute(p) ? p : resolve(loaded.dir, p);
}
