import type { ElementInfo } from "../ai/agent-tools.js";
import { unscope } from "../authoring/selector.js";

/**
 * Deterministic selector repair.
 *
 * Most UI drift is mundane: an id gets renamed, a button's label changes case,
 * a `<div role=button>` becomes a real `<button>`. None of that needs a model —
 * and requiring one meant `reel heal` refused to run at all without a
 * configured API key, in a project whose pitch is that everything runs locally.
 *
 * So the repair is a ladder. These candidates are scored and tried first, each
 * verified by actually re-running the step; the LLM is the fallback for the
 * genuinely ambiguous cases it is good at.
 */

/** What a broken selector was reaching for, however it was written. */
export interface Intent {
  /** Accessible name / visible text, when the selector implies one. */
  name?: string;
  /** ARIA role, when the selector pins one. */
  role?: string;
  /** Element id, for `#foo`. */
  id?: string;
  /** Placeholder text, for `[placeholder="…"]`. */
  placeholder?: string;
}

/** Pull the human-meaningful part out of a selector of any supported flavour. */
export function parseIntent(selector: string): Intent {
  // `nav >> role=link[name=Tutorial]` wanted the Tutorial link; the nav says
  // which one, not what. A repair that finds the element somewhere else is
  // still the repair — heal replaces the whole selector, scope included.
  const s = unscope(selector.trim()).trim();

  // role=button[name=Add] / role=textbox[name="Email address"]
  const role = /^role=([a-z]+)(?:\[name=(?:"([^"]*)"|'([^']*)'|([^\]]*))\])?$/i.exec(s);
  if (role) {
    return {
      role: role[1]!.toLowerCase(),
      name: (role[2] ?? role[3] ?? role[4])?.trim() || undefined,
    };
  }

  // text=Ship the demo  /  text="Ship the demo"
  const text = /^text=\s*(?:"([^"]*)"|'([^']*)'|(.*))$/i.exec(s);
  if (text) return { name: (text[1] ?? text[2] ?? text[3])?.trim() || undefined };

  // [placeholder="What needs doing?"]
  const ph = /^\[placeholder=(?:"([^"]*)"|'([^']*)')\]$/i.exec(s);
  if (ph) return { placeholder: (ph[1] ?? ph[2])!.trim() };

  // #task-input
  const id = /^#([\w-]+)$/.exec(s);
  if (id) return { id: id[1]!, name: humanize(id[1]!) };

  return {};
}

/** "task-input" / "taskInput" → "task input", so an id can match a label. */
function humanize(v: string): string {
  return v
    .replace(/[-_]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
}

const norm = (v: string | undefined): string =>
  (v ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Score how well a snapshot element matches the intent. Higher is better;
 * anything at or below zero is not a plausible repair.
 */
/**
 * How alike two names must be before one containing the other means anything.
 * Half the longer string: enough for "Add" → "Add task", nowhere near enough
 * for a single letter that happens to appear somewhere in a sentence.
 */
const SIMILAR_ENOUGH = 0.5;

/**
 * Below this, a candidate is not a repair — it is a guess.
 *
 * Every repair is verified by re-running the step, which sounds like a
 * sufficient guard and is not: waiting for, or clicking, the *wrong* element
 * usually succeeds. So the score is the only thing standing between drift and
 * a spec quietly rewritten to point somewhere meaningless. A single shared
 * word (15) is not evidence; leaving the step unresolved and saying so is
 * better than a repair nobody asked for and nobody can see.
 */
export const MIN_REPAIR_SCORE = 30;

export function scoreCandidate(intent: Intent, el: ElementInfo): number {
  const name = norm(el.name);
  const want = norm(intent.name);
  const role = norm(el.role);
  let score = 0;

  if (want && name) {
    // How much of the longer string the shorter one accounts for. Prefix and
    // containment are only evidence when the two names are comparable in
    // size: every string contains "a", and without this guard a one-letter
    // avatar scored 40 against "Aalu parwal sabji" purely because the dish
    // name contains a "p". The repair was then "verified" by re-running the
    // step — and waiting for the wrong element succeeds — so a meaningless
    // selector was written into the spec and the demo passed while pointing
    // at an avatar.
    const overlap = Math.min(name.length, want.length) / Math.max(name.length, want.length);

    if (name === want) score += 100;
    else if (name.replace(/[^a-z0-9]/g, "") === want.replace(/[^a-z0-9]/g, "")) score += 80;
    else if (overlap >= SIMILAR_ENOUGH && (name.startsWith(want) || want.startsWith(name))) {
      score += 55;
    } else if (overlap >= SIMILAR_ENOUGH && (name.includes(want) || want.includes(name))) {
      score += 40;
    } else {
      // Word overlap catches "Add" → "Add task" and "Sign in" → "Log in" less
      // well, but cheaply enough to be worth trying before a model call.
      // Single characters are not words: they match far too much to be a signal.
      const a = new Set(want.split(" ").filter((w) => w.length > 1));
      const b = new Set(name.split(" ").filter((w) => w.length > 1));
      const shared = [...a].filter((w) => b.has(w)).length;
      if (shared) score += 15 * shared;
    }
  }

  if (intent.role && role) score += role === intent.role ? 30 : -10;

  // An unchanged id is the strongest signal there is: same element, new label.
  if (intent.id && el.selector === `#${intent.id}`) score += 200;

  if (intent.placeholder && norm(intent.placeholder) === norm(el.name)) score += 90;

  return score;
}

/**
 * Ordered, de-duplicated repair candidates — best first. The broken selector
 * itself is excluded: it has already been proven not to work.
 */
export function deterministicCandidates(
  brokenSelector: string,
  elements: ElementInfo[],
  limit = 4,
): string[] {
  const intent = parseIntent(brokenSelector);
  // With nothing to go on, guessing by position would be worse than deferring.
  if (!intent.name && !intent.id && !intent.placeholder) return [];

  const scored = elements
    .map((el) => ({ el, score: scoreCandidate(intent, el) }))
    .filter((c) => c.score >= MIN_REPAIR_SCORE && c.el.selector && c.el.selector !== brokenSelector)
    .sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const { el } of scored) {
    if (seen.has(el.selector)) continue;
    seen.add(el.selector);
    out.push(el.selector);
    if (out.length >= limit) break;
  }
  return out;
}
