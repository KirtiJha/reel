import { readFile } from "node:fs/promises";
import { resolve, dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { specSchema, stepBranches, stepKinds, type Spec } from "./schema.js";
import type { z } from "zod";
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
      .map((i) => `  • ${i.path.join(".") || "(root)"}: ${explain(i, data)}`)
      .join("\n");
    throw new ReelError(`Invalid spec (${specPath}):\n${issues}`);
  }

  return { spec: result.data, path: abs, dir: dirname(abs) };
}

/**
 * Say what is actually wrong with a step, rather than what the union thinks.
 *
 * A step is a union of one-key objects, so zod reports whichever branch lost —
 * and for a step whose *kind* is right but whose *options* are wrong, the
 * complaint names the kind. `expect: { contains: "Hi" }` reported
 * "Unrecognized key(s) in object: 'expect'", which is doubly misleading:
 * `expect` is a perfectly good step, and the real mistake is that the field is
 * called `text`.
 *
 * So when a step has exactly one key and that key names a real step kind, we
 * re-parse it against that branch alone and report what *it* says.
 */
function explain(issue: z.ZodIssue, data: unknown): string {
  const known = stepKinds();
  const onStep = issue.path[0] === "steps" && typeof issue.path[1] === "number";
  if (!onStep) return suggest(issue, known);

  const steps = (data as { steps?: unknown[] } | undefined)?.steps;
  const step = Array.isArray(steps) ? steps[issue.path[1] as number] : undefined;
  if (!step || typeof step !== "object" || Array.isArray(step)) return suggest(issue, known);

  const keys = Object.keys(step);
  if (keys.length !== 1) return suggest(issue, known);
  const kind = keys[0]!;
  if (!known.includes(kind)) return suggest(issue, known);

  // The kind is real; re-parse against just that branch so the message is about
  // the options rather than about the union.
  const branch = stepBranches().find((b) => branchHandles(b, kind));
  if (!branch) return suggest(issue, known);
  const got = branch.safeParse(step);
  if (got.success) return issue.message; // a different step was the problem

  const inner = got.error.issues[0];
  if (!inner) return issue.message;
  // Drop the leading step-kind segment: the reader already knows which step.
  const where = inner.path.slice(1).join(".");
  const detail = suggest(inner, optionKeys(branch, kind));
  return where ? `\`${kind}.${where}\`: ${detail}` : `\`${kind}\`: ${detail}`;
}

/** Does this union branch describe the given step kind? */
function branchHandles(branch: z.ZodTypeAny, kind: string): boolean {
  const shape = (branch as { _def?: { shape?: () => Record<string, unknown> } })._def?.shape?.();
  return Boolean(shape && kind in shape);
}

/** The option names a step kind accepts, for "did you mean" inside a step. */
function optionKeys(branch: z.ZodTypeAny, kind: string): string[] {
  const shape = (branch as { _def?: { shape?: () => Record<string, unknown> } })._def?.shape?.();
  const inner = shape?.[kind] as { _def?: { shape?: () => Record<string, unknown> } } | undefined;
  return Object.keys(inner?._def?.shape?.() ?? {});
}

/** "Unrecognized key 'clik'" is much more useful with a candidate attached. */
function suggest(issue: z.ZodIssue, known: string[]): string {
  const m = /Unrecognized key\(s\) in object: '([^']+)'/.exec(issue.message);
  if (!m) return issue.message;
  const near = closest(m[1]!, known);
  return near ? `${issue.message} — did you mean \`${near}\`?` : issue.message;
}

function closest(word: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = distance(word.toLowerCase(), c.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  // Two edits on a short word is a typo; more than that is a different word.
  return bestD <= Math.max(1, Math.min(3, Math.floor(word.length / 3))) ? best : null;
}

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let corner = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = prev[j]!;
      prev[j] = Math.min(
        prev[j]! + 1,
        prev[j - 1]! + 1,
        corner + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      corner = t;
    }
  }
  return prev[b.length]!;
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
