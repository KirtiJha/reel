import { dirname, join } from "node:path";
import pc from "picocolors";
import { diff, printDiff, DIFF_DEFAULTS } from "./diff.js";
import { formatRange, formatShare, type DiffReport } from "../diff/compare.js";
import { readStamp } from "../spec/fingerprint.js";
import { loadLlmConfig } from "../ai/llm.js";
import {
  atLeast,
  cuesFor,
  review,
  worstVerdict,
  type Finding,
  type ReviewReport,
  type Verdict,
} from "../review/review.js";
import { log } from "../util/log.js";

/**
 * `reel review` — the judgement pass on top of `reel diff`.
 *
 * This command exists because of a gap between two things Reel already does
 * well. `check` proves the steps ran; `diff` proves which pixels moved. A demo
 * can pass both and still be wrong: rename a button and the flow still
 * completes, the diff is two percent, and the caption over it now describes a
 * control that no longer exists.
 *
 * The pixel pass stays in charge of *where*. All this adds is *what*, and
 * whether it matters — which is the one part that needs judgement rather than
 * arithmetic, and the only part a model is used for.
 */

export interface ReviewOptions {
  fps: number;
  threshold: number;
  out: string | false;
  /** The verdict at or above which the command exits non-zero. */
  failOn: Verdict | "never";
  model?: string;
}

export interface ReviewOutcome extends ReviewReport {
  diff: DiffReport & { strips: string[] };
  /** Whether the failOn threshold was met. */
  failed: boolean;
  /** Set when no model was configured and only the pixel pass ran. */
  unconfigured?: string;
}

export async function runReview(
  beforePath: string,
  afterPath: string,
  opts: ReviewOptions,
): Promise<ReviewOutcome> {
  const report = await diff(beforePath, afterPath, {
    fps: opts.fps,
    threshold: opts.threshold,
    // The strips are the model's input, so they are not optional here the way
    // they are for `diff`. `--no-out` still controls where they are kept.
    out: opts.out === false ? join(dirname(afterPath), ".reel-diff") : opts.out,
  });

  // The pixel report is printed before the review runs, not after it returns:
  // the review is the slow part, and a reader who has already been told what
  // changed and where can follow along instead of watching a silent terminal.
  printDiff(report);

  const empty = { findings: [], model: null, skipped: 0, diff: report, failed: false };
  if (report.identical || report.ranges.length === 0) {
    return empty;
  }

  // A model is required to judge, and its absence is a degraded run rather than
  // an error — the same posture `heal` takes. You still get the pixel report.
  let cfg;
  try {
    cfg = loadLlmConfig(opts.model);
  } catch (err) {
    return { ...empty, unconfigured: (err as Error).message.split("\n")[0] };
  }

  log.phase("Reviewing");
  log.info(`${report.ranges.length} changed moments · ${cfg.model} via ${cfg.apiBase}`);

  // Captions come from the *newer* render: the question is whether what the
  // demo says now matches what it now shows.
  const stamp = await readStamp(join(dirname(afterPath), ".reel-stamp.json"));
  if (!stamp?.captions?.length) {
    log.debug("No caption timeline beside the newer render — stale captions can't be detected.");
  }
  const cues = cuesFor(stamp?.captions, stamp?.durationMs ?? report.durationAfterMs);

  const result = await review({ ranges: report.ranges, strips: report.strips, cues, cfg });
  log.info(`Reviewed ${result.findings.length} of ${report.ranges.length} changed moments.`);
  const worst = worstVerdict(result);
  return {
    ...result,
    diff: report,
    failed: opts.failOn !== "never" && atLeast(worst, opts.failOn),
  };
}

const MARK: Record<Verdict, string> = {
  cosmetic: "·",
  unreviewed: "?",
  content: "!",
  "stale-caption": "✗",
};

function paint(v: Verdict, s: string): string {
  if (v === "stale-caption") return pc.red(s);
  if (v === "content") return pc.yellow(s);
  if (v === "unreviewed") return pc.dim(s);
  return pc.dim(s);
}

export function printReview(outcome: ReviewOutcome): void {
  log.phase("Review");

  if (outcome.diff.identical || outcome.diff.ranges.length === 0) {
    log.ok("Nothing changed — the demo tells the same story it did before.");
    return;
  }

  if (outcome.unconfigured) {
    log.warn(
      `${outcome.diff.ranges.length} moments changed, but no model is configured, so nothing judged them.`,
    );
    log.info(outcome.unconfigured);
    log.info("The pixel report above still stands — it just can't tell you what changed.");
    return;
  }

  for (const f of outcome.findings) {
    const when = formatRange({ startMs: f.startMs, endMs: f.endMs }).padEnd(14);
    const beats = f.beats.length ? pc.dim(` · ${f.beats.join(", ")}`) : "";
    console.error(`  ${paint(f.verdict, MARK[f.verdict])} ${pc.cyan(when)}${beats}`);
    console.error(`    ${paint(f.verdict, f.summary)}`);
    if (f.verdict === "stale-caption" && f.captions.length) {
      for (const c of f.captions) console.error(pc.dim(`    caption: “${c}”`));
    }
  }

  if (outcome.skipped) {
    // Never let a budget read as "that was all of them".
    log.warn(`${outcome.skipped} further changed moments were not reviewed (budget reached).`);
  }

  const counts = tally(outcome.findings);
  log.info(
    `\n${counts.content} needing a look · ${counts["stale-caption"]} stale captions · ` +
      `${counts.cosmetic} cosmetic${counts.unreviewed ? ` · ${counts.unreviewed} unjudged` : ""}`,
  );
  if (outcome.failed) log.warn("Exiting non-zero: this demo may no longer be telling the truth.");
}

export function tally(findings: Finding[]): Record<Verdict, number> {
  const counts: Record<Verdict, number> = {
    cosmetic: 0,
    content: 0,
    "stale-caption": 0,
    unreviewed: 0,
  };
  for (const f of findings) counts[f.verdict]++;
  return counts;
}

/**
 * The review as a pull-request comment.
 *
 * `reel diff`'s comment says a demo changed and where. This one says what, so
 * the reviewer's decision is "is that right?" rather than "let me go and watch
 * a twenty-second video". Pure, so the wording is testable without a model.
 */
export function markdownReview(
  outcome: ReviewOutcome,
  opts: { file: string; maxRows?: number } = { file: "the demo" },
): string {
  const lines: string[] = ["### 🎬 Demo review", ""];

  if (outcome.diff.identical || outcome.diff.ranges.length === 0) {
    lines.push(`\`${opts.file}\` — nothing visible changed.`, "", FOOTER);
    return lines.join("\n");
  }

  if (outcome.unconfigured) {
    lines.push(
      `\`${opts.file}\` changed at ${outcome.diff.ranges.length} moments, but no model is ` +
        `configured for review, so nothing has judged what changed.`,
      "",
      FOOTER,
    );
    return lines.join("\n");
  }

  const counts = tally(outcome.findings);
  const headline =
    counts["stale-caption"] > 0
      ? counts["stale-caption"] === 1
        ? "**A caption no longer matches the screen.**"
        : `**${counts["stale-caption"]} captions no longer match the screen.**`
      : counts.content > 0
        ? `**${counts.content} change${counts.content === 1 ? "" : "s"} to what the demo shows.**`
        : "Only cosmetic changes.";
  lines.push(`\`${opts.file}\` — ${headline}`, "", "| | When | What changed |", "|---|---|---|");

  const max = opts.maxRows ?? 10;
  // Worst first: a reviewer who reads one row should read the one that matters.
  const sorted = [...outcome.findings].sort((a, b) => ORDER[b.verdict] - ORDER[a.verdict]);
  for (const f of sorted.slice(0, max)) {
    const where = [formatRange({ startMs: f.startMs, endMs: f.endMs }), ...f.beats].join(" · ");
    lines.push(`| ${BADGE[f.verdict]} | \`${where}\` | ${escapePipes(f.summary)} |`);
  }
  if (sorted.length > max) {
    lines.push(`| … | | ${sorted.length - max} further moments not listed |`);
  }
  if (outcome.skipped) {
    lines.push("", `${outcome.skipped} further changed moments were beyond the review budget.`);
  }

  lines.push("", `<sub>Reviewed by \`${outcome.model}\`. ${FOOTER_TEXT}</sub>`);
  return lines.join("\n");
}

const ORDER: Record<Verdict, number> = {
  cosmetic: 0,
  unreviewed: 1,
  content: 2,
  "stale-caption": 3,
};

const BADGE: Record<Verdict, string> = {
  "stale-caption": "🔴",
  content: "🟡",
  unreviewed: "⚪",
  cosmetic: "⚫",
};

/** A summary containing a pipe would break the table row it sits in. */
function escapePipes(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

const FOOTER_TEXT =
  "A model judged what changed; the pixel comparison it judged is deterministic.";
const FOOTER = `<sub>${FOOTER_TEXT}</sub>`;

export const REVIEW_DEFAULTS = {
  ...DIFF_DEFAULTS,
  failOn: "stale-caption" as const,
};

export { formatShare };
