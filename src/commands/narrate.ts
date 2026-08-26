import type { LoadedSpec } from "../spec/load.js";
import { isBranch, type BaseStep, type Step } from "../spec/schema.js";
import { chat, loadLlmConfig, messageText } from "../ai/llm.js";
import { spokenTextOf } from "../narrate/spoken.js";
import { log, ReelError } from "../util/log.js";

/**
 * The narration script as a document.
 *
 * A demo's script is scattered through the spec — a `say:` on a card here, a
 * standalone line there — and the one question you actually have about it
 * ("does this run ten minutes?") cannot be answered by reading the file. This
 * gathers every line in order and puts a number on it.
 *
 * The estimate is what makes it useful before a render. Ten minutes of
 * narration is about 1,400 words; knowing that while writing is what prevents
 * the film Reel's own tour became.
 */

/** Speaking rate for the estimate, in words per minute. Matches `reel say`. */
const WORDS_PER_MINUTE = 150;

/** Past this, a single line is a paragraph, and the picture waits for it. */
const LONG_LINE_MS = 9_000;

export interface ScriptLine {
  /** 1-based position in the script. */
  index: number;
  /** Which step it hangs off — a card title, a beat, or the step kind. */
  where: string;
  text: string;
  words: number;
  estimatedMs: number;
}

export interface Script {
  lines: ScriptLine[];
  words: number;
  estimatedMs: number;
  /** Beats and cards with nothing to say — what `--draft` would fill. */
  silent: string[];
}

/** Every spoken line in a spec, in the order it is heard. */
export function readScript(steps: Step[]): Script {
  const lines: ScriptLine[] = [];
  const silent: string[] = [];

  const walk = (list: (Step | BaseStep)[]): void => {
    for (const step of list) {
      if (isBranch(step as Step)) {
        // A branch is one path in the video and every path in the click-through.
        // Reading them all is right: each is narration somebody will hear.
        for (const path of (step as { branch: { paths: { steps: BaseStep[] }[] } }).branch.paths) {
          walk(path.steps);
        }
        continue;
      }
      const said = spokenTextOf(step);
      const label = whereOf(step);
      if (said) {
        const words = said.split(/\s+/).filter(Boolean).length;
        lines.push({
          index: lines.length + 1,
          where: label,
          text: said,
          words,
          estimatedMs: Math.round((words / WORDS_PER_MINUTE) * 60_000),
        });
      } else if (isNarratable(step)) {
        silent.push(label);
      }
    }
  };
  walk(steps);

  return {
    lines,
    words: lines.reduce((n, l) => n + l.words, 0),
    estimatedMs: lines.reduce((n, l) => n + l.estimatedMs, 0),
    silent,
  };
}

/**
 * Moments a narrator would speak over.
 *
 * A card and a beat are the two the author already marked as *a moment* — that
 * is what they are for — so a silent one is the useful thing to point at. A
 * click is not: narrating every click is how a demo becomes a description of
 * itself.
 */
function isNarratable(step: Step | BaseStep): boolean {
  return "card" in step || "beat" in step || "image" in step || "diagram" in step;
}

function whereOf(step: Step | BaseStep): string {
  const v = step as Record<string, unknown>;
  if ("card" in v) {
    const c = v.card;
    return `card “${typeof c === "string" ? c : (c as { title: string }).title}”`;
  }
  if ("beat" in v) return typeof v.beat === "string" ? `beat “${v.beat}”` : "beat";
  if ("caption" in v) return "caption";
  if ("image" in v) return "image";
  if ("diagram" in v) return "diagram";
  if ("say" in v) return "say";
  return Object.keys(v)[0] ?? "step";
}

export function printScript(script: Script, name: string): void {
  log.phase(`Script — ${name}`);
  if (!script.lines.length) {
    log.warn("No spoken lines yet.");
  }
  for (const line of script.lines) {
    const secs = (line.estimatedMs / 1000).toFixed(1);
    const long = line.estimatedMs > LONG_LINE_MS;
    const head = `${String(line.index).padStart(2, "0")}  ${line.where}  ·  ~${secs}s`;
    if (long) log.warn(`${head}  ← long enough that the picture will wait`);
    else log.step(head);
    log.info(`    ${line.text}`);
  }
  const mins = Math.floor(script.estimatedMs / 60_000);
  const secs = Math.round((script.estimatedMs % 60_000) / 1000);
  log.ok(
    `${script.lines.length} lines · ${script.words} words · about ` +
      `${mins ? `${mins}m ` : ""}${secs}s of narration`,
  );
  if (script.silent.length) {
    log.info(
      `${script.silent.length} moment(s) say nothing: ${script.silent.slice(0, 6).join(", ")}` +
        `${script.silent.length > 6 ? ", …" : ""}`,
    );
    log.info("`reel narrate --draft` proposes a line for each.");
  }
}

/**
 * Propose a line for every moment that has none.
 *
 * Proposes, and stops there. Direction is taste, and a tool that quietly
 * rewrites your script is worse than one that suggests — so this prints YAML
 * you can read, argue with and paste. It writes prose and never selectors,
 * which is the safer half of what `reel author` does.
 */
export async function draftNarration(loaded: LoadedSpec): Promise<string[]> {
  const script = readScript(loaded.spec.steps);
  if (!script.silent.length) {
    log.ok("Every card and beat already says something.");
    return [];
  }

  let cfg;
  try {
    cfg = loadLlmConfig();
  } catch {
    throw new ReelError(
      "Drafting narration needs a model, and none is configured.",
      "See SECURITY.md and the README for the environment variables. " +
        "`reel narrate` without `--draft` reads the script you already have and needs nothing.",
    );
  }
  log.info(`Drafting with ${cfg.model}`);

  const outline = outlineFor(loaded.spec.steps);
  const system =
    "You write narration for short product demos. Given the demo's steps, write one spoken " +
    "sentence for each moment listed as SILENT. Rules: one sentence each; under 20 words; " +
    "say what the viewer is seeing and why it matters; never describe the mouse or the UI " +
    "mechanics (\"click the button\"); no marketing language; plain spoken English. " +
    "Answer as a numbered list matching the SILENT list, and nothing else.";
  const user =
    `Demo: ${loaded.spec.name}\n\nSteps:\n${outline}\n\n` +
    `SILENT moments needing a line:\n` +
    script.silent.map((s, i) => `${i + 1}. ${s}`).join("\n");

  const res = await chat(cfg, [
    { role: "system", content: system },
    { role: "user", content: user },
  ]);
  const proposed = parseNumbered(messageText(res.message), script.silent.length);

  log.phase("Proposed narration");
  for (const [i, where] of script.silent.entries()) {
    const line = proposed[i];
    if (!line) continue;
    log.step(where);
    log.info(`    say: >-`);
    log.info(`      ${line}`);
  }
  log.info("");
  log.info("Nothing was written. Paste the lines you want into the spec.");
  return proposed;
}

/** A compact outline of the demo, so the model knows what is on screen. */
function outlineFor(steps: Step[]): string {
  const out: string[] = [];
  const walk = (list: (Step | BaseStep)[], depth = 0): void => {
    for (const step of list) {
      if (isBranch(step as Step)) {
        const b = (step as { branch: { prompt: string; paths: { label: string; steps: BaseStep[] }[] } }).branch;
        out.push(`${"  ".repeat(depth)}- branch: ${b.prompt}`);
        for (const path of b.paths) {
          out.push(`${"  ".repeat(depth + 1)}- path: ${path.label}`);
          walk(path.steps, depth + 2);
        }
        continue;
      }
      out.push(`${"  ".repeat(depth)}- ${whereOf(step)}${describeValue(step)}`);
    }
  };
  walk(steps);
  return out.join("\n");
}

function describeValue(step: Step | BaseStep): string {
  const v = step as Record<string, unknown>;
  for (const kind of ["click", "type", "run", "caption", "expect"]) {
    if (!(kind in v)) continue;
    const value = v[kind];
    if (typeof value === "string") return `: ${value}`;
    if (value && typeof value === "object") {
      const o = value as Record<string, unknown>;
      return `: ${String(o.cmd ?? o.text ?? o.selector ?? "")}`;
    }
  }
  return "";
}

/**
 * Pull `1. …` lines out of the model's answer.
 *
 * Tolerant on purpose: a model asked for a numbered list will sometimes add a
 * preamble, and refusing the whole draft over a stray sentence would waste a
 * call the user paid for.
 */
export function parseNumbered(text: string, expected: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const m = /^\s*(\d+)[.)]\s+(.*\S)\s*$/.exec(raw);
    if (!m) continue;
    const i = Number(m[1]) - 1;
    if (i < 0 || i >= expected) continue;
    out[i] = m[2]!.replace(/^["“]|["”]$/g, "");
  }
  return out;
}
