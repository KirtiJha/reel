/**
 * How a demo types.
 *
 * Uniform inter-key timing is the loudest automation tell there is. A person
 * typing "Ship the Reel demo" does not place a character every 60ms — the
 * intervals wander, the hand rests at a word boundary, and a full stop is a
 * beat of its own. A machine that never does any of that reads as a machine
 * from the first two words, whatever else the recording gets right.
 *
 * ## Why this is a pure function
 *
 * The obvious way to add jitter is `Math.random()`, and it is the one thing
 * this codebase cannot do: the same spec against the same app has to render
 * byte-identical media, and a random cadence changes the frame times, which
 * changes the encode, on every single run. So the wander is *derived* — from
 * the character's position, the text itself, and the spec's own
 * `deterministic.seedRandom` — and the result is a plain array of durations.
 * Two runs compute the same array; a different string types differently; the
 * same string always types the same way.
 *
 * ## Where it lives
 *
 * Beside the overlay rather than in the driver, because it is the same kind of
 * thing: presentation the recording performs on top of what the app actually
 * does. It draws nothing, so it holds no DOM — which is what lets both the web
 * `type` step and the terminal share it without either owning it.
 */

/**
 * How far a keystroke wanders from the base delay, as a fraction.
 *
 * ±35% is enough to break the metronome and not enough to read as stuttering.
 * Above roughly half, the slow keys start to look like the app hanging.
 */
export const JITTER = 0.35;

/** Multipliers on the base delay where a person's hands would pause. */
const PAUSE = {
  /** After a space: the word is done and the next one is being thought of. */
  word: 1.9,
  /** After `.`, `!` or `?` — the longest pause in ordinary typing. */
  sentence: 2.8,
  /** After `,`, `;` or `:` — a breath, not a stop. */
  clause: 1.7,
};

export interface CadenceOptions {
  /** The base per-character delay (ms) — `type.delay` or `terminal.typing`. */
  delay: number;
  /** False types at a flat `delay`, exactly as Reel did before this existed. */
  jitter?: boolean;
  /** `deterministic.seedRandom`, so a spec can shift the pattern it gets. */
  seed?: number;
}

/**
 * The dwell after each character of `text`, in ms.
 *
 * One entry per character, in order, matching how both typing loops work: press
 * the character, then let that much demo time pass before the next. A pause
 * lands *after* the space or the full stop that earned it, which is where a
 * person's hands actually stop.
 */
export function typingDelays(text: string, opts: CadenceOptions): number[] {
  const chars = [...text];
  const base = Math.max(0, opts.delay);
  // A zero delay means "type instantly"; jittering it would invent time the
  // author asked not to spend.
  if (opts.jitter === false || base === 0) return chars.map(() => base);

  // The text is part of the seed so that two fields typed in one demo don't
  // share a rhythm, while each of them keeps its own across runs.
  const salt = (hash(text) ^ ((opts.seed ?? 0) >>> 0)) >>> 0;

  return chars.map((ch, i) => {
    const wander = 1 + JITTER * (noise(salt, i) * 2 - 1);
    // Never below 1ms: the timeline rounds, and a 0ms character would collapse
    // two keystrokes onto one frame timestamp.
    return Math.max(1, Math.round(base * pauseAfter(ch) * wander));
  });
}

/** What `text` costs to type, end to end (ms) — for a caption or an sfx span. */
export function typingDurationMs(text: string, opts: CadenceOptions): number {
  return typingDelays(text, opts).reduce((a, b) => a + b, 0);
}

function pauseAfter(ch: string): number {
  if (ch === " " || ch === "\t" || ch === "\n") return PAUSE.word;
  if (ch === "." || ch === "!" || ch === "?") return PAUSE.sentence;
  if (ch === "," || ch === ";" || ch === ":") return PAUSE.clause;
  return 1;
}

/** FNV-1a over the text, so the whole string contributes to its own rhythm. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A value in [0, 1) from a salt and an index — the same mixing function the
 * determinism layer seeds `Math.random` with, used here without the global.
 */
function noise(salt: number, i: number): number {
  let a = (salt + Math.imul(i + 1, 0x9e3779b9)) | 0;
  a = Math.imul(a ^ (a >>> 15), 1 | a);
  a = (a + Math.imul(a ^ (a >>> 7), 61 | a)) ^ a;
  return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
}
