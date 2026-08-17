import { readFile } from "node:fs/promises";
import { chat, imagePart, type LlmConfig, type OaiToolSpec } from "../ai/llm.js";
import { buildCues, type Cue } from "../narrate/subtitles.js";
import type { Range } from "../diff/compare.js";
import { log } from "../util/log.js";

/**
 * `reel review` — whether the demo is still *true*.
 *
 * `reel check` proves every step ran. `reel diff` proves pixels moved. Neither
 * answers the question a reviewer actually has, which is whether the demo still
 * says the right thing about the product. Rename a button from "Start free
 * trial" to "Get started" and you get a green check, a two-percent diff, and a
 * demo whose caption now contradicts the screen it is captioning.
 *
 * At one demo a person watches the GIF and catches that. At forty demos
 * regenerated weekly, nobody does — which is exactly the point where a demo
 * quietly becomes a false claim about your product.
 *
 * The split of labour matters. Everything that can be computed is: which
 * captions were on screen during a changed range is arithmetic, not judgement,
 * and doing it in code means the model is never asked to align timelines. What
 * is left for the model is the one thing no assertion can encode — looking at
 * two frames and saying what changed in the product's own words, and whether
 * the caption over them is still honest.
 */

/** What a change turned out to be. */
export type Verdict =
  /** Visual only: spacing, colour, an illustration. The story is unaffected. */
  | "cosmetic"
  /** The UI now says or offers something different. A human should look. */
  | "content"
  /** A caption on screen contradicts what the frame now shows. */
  | "stale-caption"
  /** The model was not asked, or could not answer. Never treated as "fine". */
  | "unreviewed";

/** Ordered by how much they should stop a pipeline. */
const SEVERITY: Record<Verdict, number> = {
  cosmetic: 0,
  unreviewed: 1,
  content: 2,
  "stale-caption": 3,
};

export function atLeast(v: Verdict, floor: Verdict): boolean {
  return SEVERITY[v] >= SEVERITY[floor];
}

export interface Finding {
  startMs: number;
  endMs: number;
  /** Beat labels the range falls in, when the render left a stamp. */
  beats: string[];
  /** Share of pixels that moved, carried through from the pixel pass. */
  mean: number;
  /** Captions that were on screen during this range. */
  captions: string[];
  verdict: Verdict;
  /** One sentence, in the product's terms. */
  summary: string;
}

export interface ReviewReport {
  findings: Finding[];
  /** The model that judged, or null when nothing did. */
  model: string | null;
  /** Ranges the pixel pass found beyond the review budget. Never silent. */
  skipped: number;
}

/**
 * How many changed ranges are sent to the model.
 *
 * A demo that changed everywhere is a demo somebody already knows changed; the
 * value is in catching the one small change nobody noticed. The cap keeps a
 * runaway diff from turning into a hundred vision calls, and whatever it drops
 * is reported rather than quietly omitted.
 */
export const MAX_REVIEWED = 12;

/** The worst verdict in a report — what a pipeline decides on. */
export function worstVerdict(report: ReviewReport): Verdict {
  let worst: Verdict = "cosmetic";
  for (const f of report.findings) if (SEVERITY[f.verdict] > SEVERITY[worst]) worst = f.verdict;
  return worst;
}

/**
 * Captions on screen at any point during a range.
 *
 * Computed, not asked: a caption runs until the next one, so knowing which was
 * showing is a matter of overlapping two intervals. Getting the model to do
 * this would be slower, cost money and be wrong sometimes.
 */
export function captionsInRange(cues: Cue[], startMs: number, endMs: number): string[] {
  return cues.filter((c) => c.start <= endMs && c.end >= startMs).map((c) => c.text);
}

/** Caption cues for a render, from the timeline its stamp recorded. */
export function cuesFor(
  captions: { t: number; text: string }[] | undefined,
  durationMs: number,
): Cue[] {
  return captions?.length ? buildCues(captions, durationMs) : [];
}

const REPORT_TOOL: OaiToolSpec = {
  type: "function",
  function: {
    name: "report",
    description: "Report what changed between the two frames, and whether it matters.",
    parameters: {
      type: "object",
      properties: {
        verdict: {
          type: "string",
          enum: ["cosmetic", "content", "stale-caption"],
          description:
            "cosmetic: only the look changed (spacing, colour, an image) and the demo still says the right thing. " +
            "content: the interface now says or offers something different — different label, different data, a control that came or went. " +
            "stale-caption: one of the captions listed is now contradicted by what the frame shows.",
        },
        summary: {
          type: "string",
          description:
            "One sentence naming the change in the product's own words, quoting any text that changed. " +
            "For stale-caption, say which caption is now wrong and what the screen says instead.",
        },
      },
      required: ["verdict", "summary"],
    },
  },
};

const SYSTEM = [
  "You are reviewing a change to a recorded product demo.",
  "",
  "Each message gives you one before/after/difference strip: the same moment in the old",
  "render, the new render, and a mask where changed pixels burn magenta. Use the mask to",
  "find the change, then read the two frames to say what it was.",
  "",
  "You are not judging whether the change is good. You are answering: does the demo still",
  "tell the truth about this product? Report `content` when the interface now says or",
  "offers something different, `stale-caption` when a caption that was on screen is",
  "contradicted by the new frame, and `cosmetic` only when a viewer would learn nothing",
  "different from watching it.",
  "",
  "Anti-aliasing, a shifted cursor, a one-pixel reflow and a changed timestamp are",
  "cosmetic. A changed label, price, count, error, or a control appearing or disappearing",
  "is content. When you cannot tell what changed, say so in the summary and call it",
  "content — a change nobody can explain is one a person should look at.",
].join("\n");

/** What the model is shown for one range, alongside the strip. */
export function rangePrompt(range: Range, captions: string[]): string {
  const when = `${(range.startMs / 1000).toFixed(1)}s–${(range.endMs / 1000).toFixed(1)}s`;
  const lines = [`Moment: ${when} of the demo.`];
  if (range.beats.length) lines.push(`Beat: ${range.beats.join(", ")}.`);
  lines.push(
    captions.length
      ? `Captions on screen here:\n${captions.map((c) => `  - "${c}"`).join("\n")}`
      : "No captions are on screen here, so `stale-caption` does not apply.",
  );
  return lines.join("\n");
}

/** A model's tool call → a verdict, refusing to invent one it didn't give. */
export function parseVerdict(raw: string | undefined): { verdict: Verdict; summary: string } {
  try {
    const parsed = JSON.parse(raw || "{}") as { verdict?: string; summary?: string };
    const verdict = parsed.verdict;
    if (verdict === "cosmetic" || verdict === "content" || verdict === "stale-caption") {
      return { verdict, summary: (parsed.summary ?? "").trim() || "No description given." };
    }
    // An unrecognised verdict is not a pass. Saying "unreviewed" keeps the
    // range visible instead of filing it under "fine".
    return { verdict: "unreviewed", summary: `Model returned an unusable verdict: ${verdict ?? "none"}.` };
  } catch {
    return { verdict: "unreviewed", summary: "Model returned malformed JSON." };
  }
}

export interface ReviewInput {
  ranges: Range[];
  /** Comparison strip per range, aligned by index; "" where none was written. */
  strips: string[];
  cues: Cue[];
  cfg: LlmConfig;
  /** The real one calls the provider; tests inject a fake. */
  chat?: typeof chat;
}

/**
 * Judge each changed range, one call per range.
 *
 * Per range rather than all at once: the input stays small enough that the
 * model is looking at one moment, a failure loses one verdict instead of the
 * report, and the strip images never have to be downscaled to fit together.
 */
export async function review(input: ReviewInput): Promise<ReviewReport> {
  const { ranges, strips, cues, cfg, chat: ask = chat } = input;
  const budget = ranges.slice(0, MAX_REVIEWED);
  const findings: Finding[] = [];

  for (let i = 0; i < budget.length; i++) {
    const range = budget[i]!;
    const captions = captionsInRange(cues, range.startMs, range.endMs);
    const base = {
      startMs: range.startMs,
      endMs: range.endMs,
      beats: range.beats,
      mean: range.mean,
      captions,
    };

    const strip = strips[i];
    if (!strip) {
      // A range present in only one render has no pair to compare.
      findings.push({
        ...base,
        verdict: "unreviewed",
        summary: range.truncated
          ? "Only one render has this moment — the demo got longer or shorter here."
          : "No comparison frame was available for this range.",
      });
      continue;
    }

    log.debug(`review: ${range.startMs}–${range.endMs}ms`);
    try {
      const image = await readFile(strip);
      const res = await ask(
        cfg,
        [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [{ type: "text", text: rangePrompt(range, captions) }, imagePart(image)],
          },
        ],
        [REPORT_TOOL],
      );
      const call = res.message.tool_calls?.[0];
      findings.push({ ...base, ...parseVerdict(call?.function.arguments) });
    } catch (err) {
      // One failed call must not lose the ranges that did get judged — and an
      // unjudged range is reported as unjudged, never as clean.
      findings.push({
        ...base,
        verdict: "unreviewed",
        summary: `Review failed: ${(err as Error).message.split("\n")[0]}`,
      });
    }
  }

  return { findings, model: cfg.model, skipped: ranges.length - budget.length };
}
