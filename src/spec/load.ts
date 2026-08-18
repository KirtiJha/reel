import { readFile } from "node:fs/promises";
import { resolve, dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
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

/**
 * Resolve a path written in a spec, relative to the spec file.
 *
 * `~` is expanded first. Only a shell does that expansion, so a path written by
 * hand into YAML arrives here literally — and joining it to the spec's own
 * directory produced `…/demos/~/auth.json`, a path that cannot exist and whose
 * error names a directory the author never typed. `~` belongs in a config file
 * that a person edits, and the alternative is an absolute path that stops
 * working on anyone else's machine.
 *
 * `~user` is left alone: resolving it needs a passwd lookup, and quietly
 * treating it as a relative path would be worse than the error you get.
 */
export function resolveOutput(loaded: LoadedSpec, p: string): string {
  return resolveFrom(loaded.dir, p);
}

/**
 * The same rule, given only the directory.
 *
 * A step that resolves a path has the spec's directory but not the loaded spec
 * — and duplicating the tilde handling in a second place is how two answers to
 * "where is this file" start to disagree.
 */
export function resolveFrom(dir: string, p: string): string {
  const expanded = p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
  return isAbsolute(expanded) ? expanded : resolve(dir, expanded);
}
