import { parseDocument } from "yaml";
import { spokenTextOf } from "../narrate/spoken.js";
import { isBranch, type BaseStep, type Step } from "../spec/schema.js";

/**
 * Turning a proposed line into an edit.
 *
 * `reel narrate --draft` proposes prose and stops there, and on the command
 * line that is right: the terminal has nowhere to put the line except in front
 * of you. Studio has the file open, so the last step — find the moment, write
 * the line under it — is one it can do, and copying a sentence out of a log and
 * hunting for the step it belongs to is not a feature.
 *
 * Everything here is a document edit rather than a re-serialisation, for the
 * same reason `applyPatch` is: specs are hand-written and their comments carry
 * the reasoning. Accepting one line must not reformat the file around it.
 */

/** A moment a narrator would speak over that currently says nothing. */
export interface SilentMoment {
  /**
   * Where the step lives in the document, for `getIn`/`setIn`. Top-level steps
   * are `["steps", n]`; one inside a branch path carries the whole route.
   */
  path: (string | number)[];
  /** The step's single key: card, beat, image or diagram. */
  kind: string;
  /** The label `reel narrate` prints, so proposals line up with it by index. */
  where: string;
}

/**
 * The silent moments of a spec, in the order `readScript` reports them.
 *
 * The order is the contract: `draftNarration` returns a bare list of sentences
 * aligned with `readScript(...).silent`, so proposal *i* belongs to moment *i*
 * and nothing else identifies it. A test pins the two lists together; if this
 * walk ever stops matching that one, lines would be written under the wrong
 * moments, silently and plausibly.
 */
export function silentMoments(steps: Step[]): SilentMoment[] {
  const out: SilentMoment[] = [];
  const walk = (list: (Step | BaseStep)[], at: (string | number)[]): void => {
    for (const [i, step] of list.entries()) {
      if (isBranch(step as Step)) {
        const paths = (step as { branch: { paths: { steps: BaseStep[] }[] } }).branch.paths;
        for (const [j, path] of paths.entries()) {
          walk(path.steps, [...at, i, "branch", "paths", j, "steps"]);
        }
        continue;
      }
      if (spokenTextOf(step)) continue;
      if (!narratable(step)) continue;
      out.push({ path: [...at, i], kind: kindOf(step), where: whereOf(step) });
    }
  };
  walk(steps, ["steps"]);
  return out;
}

/**
 * Mirrors `isNarratable` in commands/narrate.ts: a card, a beat, a picture or a
 * diagram is a moment the author already marked as one. A click is not.
 */
function narratable(step: Step | BaseStep): boolean {
  return "card" in step || "beat" in step || "image" in step || "diagram" in step;
}

function kindOf(step: Step | BaseStep): string {
  return Object.keys(step)[0] ?? "step";
}

/** Mirrors `whereOf` in commands/narrate.ts, for the kinds that reach here. */
function whereOf(step: Step | BaseStep): string {
  const v = step as Record<string, unknown>;
  if ("card" in v) {
    const c = v.card;
    return `card “${typeof c === "string" ? c : (c as { title: string }).title}”`;
  }
  if ("beat" in v) return typeof v.beat === "string" ? `beat “${v.beat}”` : "beat";
  if ("image" in v) return "image";
  if ("diagram" in v) return "diagram";
  return kindOf(step);
}

/** The key a shorthand string stands for, per step kind. */
const SHORTHAND: Record<string, string> = {
  card: "title",
  image: "file",
  diagram: "mermaid",
};

/**
 * Write one line into the spec, under the moment it was proposed for.
 *
 * Two shapes, because the grammar has two. A card, an image and a diagram carry
 * their own `say:`, so the line goes inside the step — and the shorthand form
 * (`card: Welcome`) has to grow into the object form first, or the line would
 * replace the title. A `beat` cannot carry one: it is a marker, `beat: <string
 * | boolean>` and nothing else, so the line becomes its own `say:` step
 * immediately after the beat, which is where it is heard.
 *
 * Returns the rewritten YAML. Nothing is written to disk here, and nothing is
 * accepted that was not asked for by name.
 */
export function applySay(raw: string, moment: SilentMoment, text: string): string {
  const line = text.trim();
  if (!line) throw new Error("Nothing to write — the line is empty.");

  const doc = parseDocument(raw);
  const step: any = doc.getIn(moment.path, true);
  if (!step || typeof step.has !== "function" || !step.has(moment.kind)) {
    // The spec moved under the proposal — a reorder, a hand edit, a different
    // file. Refusing is the only safe answer: the alternative is writing the
    // line onto whatever happens to be at that index now.
    throw new Error(
      `Step ${describe(moment.path)} is no longer a ${moment.kind} step — re-read the script and try again.`,
    );
  }

  if (moment.kind === "beat") {
    const parent: any = doc.getIn(moment.path.slice(0, -1), true);
    const index = Number(moment.path[moment.path.length - 1]);
    if (!parent || !Array.isArray(parent.items)) {
      throw new Error("Could not find the step list this beat belongs to.");
    }
    // After the beat, not before it: the beat is the moment arriving, and the
    // narration is about what is now on screen.
    parent.items.splice(index + 1, 0, doc.createNode({ say: line }));
    return doc.toString({ lineWidth: 0 });
  }

  const value = step.get(moment.kind);
  if (typeof value === "string") {
    const key = SHORTHAND[moment.kind];
    if (!key) throw new Error(`Don't know how to give a ${moment.kind} step a line.`);
    doc.setIn([...moment.path, moment.kind], { [key]: value, say: line });
  } else {
    doc.setIn([...moment.path, moment.kind, "say"], line);
  }
  return doc.toString({ lineWidth: 0 });
}

/** `steps.4`, for an error message about a path nobody wants to read as JSON. */
function describe(path: (string | number)[]): string {
  return path.join(".");
}
