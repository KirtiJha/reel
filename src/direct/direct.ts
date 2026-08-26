import { isBranch, type BaseStep, type Step, type StepInput } from "../spec/schema.js";
import { spokenTextOf } from "../narrate/spoken.js";

/**
 * Direction, proposed.
 *
 * The primitives — camera, highlight, drift, establishing shots — still have to
 * be *placed*, and placing them is the work most people will not do. But Reel
 * knows more about its own footage than any stock-footage tool knows about a
 * clip: every step, every element it names, every narration line, every beat.
 * That is what lets a proposal be specific enough to be worth reading.
 *
 * Deterministic, and offline. The match that matters — "this line talks about
 * the thing that step points at" — is a text comparison between a narration
 * line and the *name inside a selector*, and a rule you can explain beats a
 * model you cannot. It also means `direct` needs no key, no network and no
 * browser, and runs in milliseconds on a spec you are still editing.
 *
 * Nothing is applied silently. Direction is taste; a tool that quietly
 * restages your film is worse than one that suggests.
 */

export interface Direction {
  /** Where the new step goes: before the step at this index. */
  index: number;
  /** The step to insert. */
  step: StepInput;
  /** Why, in one line, so a proposal can be argued with. */
  because: string;
}

/** Steps around a narration line that could be what it is talking about. */
const NEARBY = 4;

/**
 * A narration line has to be at least this many characters of match to count.
 *
 * "Add" matching a line containing the word "add" is a coincidence often
 * enough to be annoying; "Ship the Reel demo" is not. Short names are still
 * matched, but only as whole words.
 */
const STRONG_MATCH = 8;

export function direct(steps: Step[]): Direction[] {
  const out: Direction[] = [];
  out.push(...proposeHighlights(steps));
  out.push(...proposeEstablishing(steps));
  return out.sort((a, b) => a.index - b.index);
}

/**
 * Highlight the element a line is *about*.
 *
 * Not what was clicked — `zoom: auto` already follows that, and it is often the
 * wrong answer during narration, when nothing is being clicked at all. What a
 * sentence names is a better guide to what the viewer should be looking at.
 */
function proposeHighlights(steps: Step[]): Direction[] {
  const out: Direction[] = [];
  for (const [i, step] of steps.entries()) {
    if (isBranch(step)) continue;
    const line = spokenTextOf(step);
    if (!line) continue;
    // Already directed here: an author who wrote a highlight has answered this.
    if (hasHighlightNear(steps, i)) continue;

    const hit = bestMatch(line, steps, i);
    if (!hit) continue;
    // `until:` only when there is a beat to name. Writing `until: undefined`
    // would not type-check against the step union, and would serialize into the
    // spec as a key with no value.
    const until = nextBeatLabel(steps, i);
    out.push({
      index: i,
      step: { highlight: { selector: hit.selector, ...(until ? { until } : {}) } },
      because: `the line says “${hit.matched}”, and step ${hit.step + 1} names that element`,
    });
  }
  return out;
}

/**
 * Open each chapter on an establishing shot.
 *
 * A title card is a chapter boundary, and cutting from a full-screen card
 * straight into a cropped close-up gives the viewer nowhere to stand. The
 * driver already pulls wide *for* the card; what is missing is staying wide for
 * a moment after it.
 */
function proposeEstablishing(steps: Step[]): Direction[] {
  const out: Direction[] = [];
  for (const [i, step] of steps.entries()) {
    if (isBranch(step) || !("card" in step)) continue;
    const next = steps[i + 1];
    if (!next || isBranch(next)) continue;
    // Only where the very next thing crops in. Anything else already gives the
    // viewer a wide moment to place themselves in.
    if (!cropsIn(next)) continue;
    if ("zoom" in next) continue;
    out.push({
      index: i + 1,
      step: { zoom: "out" },
      because: "a chapter opens here, and the next step crops straight in",
    });
  }
  return out;
}

/** Does this step move the camera somewhere tight? */
function cropsIn(step: Step | BaseStep): boolean {
  return "click" in step || "type" in step || "fill" in step || "callout" in step;
}

/** The nearest step whose selector names something the line talks about. */
function bestMatch(
  line: string,
  steps: Step[],
  from: number,
): { selector: string; matched: string; step: number } | null {
  const haystack = line.toLowerCase();
  let best: { selector: string; matched: string; step: number; distance: number } | null = null;

  for (let j = Math.max(0, from - NEARBY); j <= Math.min(steps.length - 1, from + NEARBY); j++) {
    const step = steps[j];
    if (!step || isBranch(step)) continue;
    const selector = selectorOf(step);
    if (!selector) continue;
    const name = nameIn(selector);
    if (!name) continue;
    if (!mentions(haystack, name)) continue;

    const distance = Math.abs(j - from);
    if (!best || distance < best.distance) {
      best = { selector, matched: name, step: j, distance };
    }
  }
  return best ? { selector: best.selector, matched: best.matched, step: best.step } : null;
}

/**
 * Does the line talk about this name?
 *
 * A long name is matched as a substring, because narration rarely quotes an
 * element exactly. A short one has to be a whole word, or "Add" matches
 * "additional" and the proposal is noise.
 */
function mentions(haystack: string, name: string): boolean {
  const needle = name.toLowerCase();
  if (needle.length >= STRONG_MATCH) return haystack.includes(needle);
  return new RegExp(`\\b${escapeRegExp(needle)}\\b`).test(haystack);
}

/**
 * The human-readable name inside a selector.
 *
 * This is the whole trick. A selector is not opaque: `text=Ship the Reel demo`
 * carries the words on screen, `role=button[name=Add]` carries the button's
 * label, and `#task-input` carries what somebody called it. Reading the name
 * back out is what lets a sentence be matched to an element without a model.
 */
export function nameIn(selector: string): string | null {
  const sel = selector.split(" >> ")[selector.split(" >> ").length - 1] ?? selector;

  const text = /^text=(.+)$/.exec(sel);
  if (text) return strip(text[1]!);

  const role = /^role=[a-z]+\[name=(.+?)\]$/i.exec(sel);
  if (role) return strip(role[1]!);

  const attr = /\[(?:data-testid|data-test|aria-label|placeholder|name)=["']?([^\]"']+)/.exec(sel);
  if (attr) return words(attr[1]!);

  const id = /^#([A-Za-z][\w-]*)$/.exec(sel);
  if (id) return words(id[1]!);

  // A class or a CSS path names a structure, not a thing anyone would say out
  // loud. Matching on it produces proposals nobody asked for.
  return null;
}

function strip(v: string): string {
  return v.replace(/^["']|["']$/g, "").trim();
}

/** `task-input` → `task input`, so an id can match ordinary prose. */
function words(v: string): string {
  return v.replace(/[-_]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().trim();
}

function selectorOf(step: Step | BaseStep): string | null {
  const v = step as Record<string, unknown>;
  if (typeof v.click === "string") return v.click;
  if (typeof v.dblclick === "string") return v.dblclick;
  if (typeof v.hover === "string") return v.hover;
  if (typeof v.scrollTo === "string") return v.scrollTo;
  if (typeof v.waitFor === "string") return v.waitFor;
  for (const kind of ["type", "fill", "callout", "expect", "highlight"]) {
    const o = v[kind];
    if (o && typeof o === "object" && typeof (o as { selector?: unknown }).selector === "string") {
      return (o as { selector: string }).selector;
    }
  }
  return null;
}

/** Is there already an annotation within a step or two of here? */
function hasHighlightNear(steps: Step[], i: number): boolean {
  for (let j = Math.max(0, i - 2); j <= Math.min(steps.length - 1, i + 2); j++) {
    const step = steps[j];
    if (step && !isBranch(step) && ("highlight" in step || "callout" in step)) return true;
  }
  return false;
}

/**
 * The beat a highlight should live until.
 *
 * A narrated annotation wants to stay up for the line, and the next beat is the
 * closest thing the spec has to "until this moment is over". With no later
 * beat, the default duration applies and the mark simply times out.
 */
function nextBeatLabel(steps: Step[], from: number): string | undefined {
  for (let j = from + 1; j < steps.length; j++) {
    const step = steps[j];
    if (!step || isBranch(step)) continue;
    if ("beat" in step && typeof step.beat === "string") return step.beat;
  }
  return undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
