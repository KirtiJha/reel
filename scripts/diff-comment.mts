import { writeFile } from "node:fs/promises";
import { diff, markdownSummary, DIFF_DEFAULTS } from "../src/commands/diff.js";
import { runReview, markdownReview, REVIEW_DEFAULTS } from "../src/commands/review.js";
import { loadLlmConfig } from "../src/ai/llm.js";
import { setVerbose } from "../src/util/log.js";

/**
 * Turn two renders into a pull-request comment.
 *
 * Deliberately a script rather than a block of JavaScript inside the workflow:
 * formatting logic embedded in YAML is typechecked by nothing, tested by
 * nothing, and only ever runs on a machine you cannot debug on. Here the
 * interesting half lives in `markdownSummary` / `markdownReview`, which have
 * unit tests, and this file only moves bytes around.
 *
 * When a model is configured it writes the review — what changed and whether
 * the demo is still true — and otherwise the pixel summary. Which one you get
 * is decided by the environment rather than by a flag, because a workflow that
 * has to be edited to start reviewing is a workflow nobody edits.
 *
 * Usage: tsx scripts/diff-comment.mts <before> <after> <out.md> [label]
 *
 * Exits 0 whatever it finds. A comment is a nicety; failing the build because
 * the nicety could not be produced would be the wrong trade.
 */

const [before, after, out, label] = process.argv.slice(2);

if (!before || !after || !out) {
  console.error("usage: diff-comment.mts <before> <after> <out.md> [label]");
  process.exit(2);
}

setVerbose(false);

let reviewable = false;
try {
  loadLlmConfig();
  reviewable = true;
} catch {
  console.error("No model configured — writing the pixel summary instead of a review.");
}

try {
  if (reviewable) {
    const outcome = await runReview(before, after, {
      ...REVIEW_DEFAULTS,
      // The comment is the deliverable here; the exit code belongs to the
      // `reel review` step in the workflow, which decides whether to fail.
      failOn: "never",
      out: false,
    });
    await writeFile(out, markdownReview(outcome, { file: label ?? after }), "utf8");
    console.error(`Wrote ${out} (${outcome.findings.length} reviewed moments)`);
  } else {
    const report = await diff(before, after, {
      fps: DIFF_DEFAULTS.fps,
      threshold: DIFF_DEFAULTS.threshold,
      // No strips: nothing in a comment can link to them, and writing images
      // nobody reads would just slow the job down.
      out: false,
    });
    await writeFile(out, markdownSummary(report, { file: label ?? after }), "utf8");
    console.error(`Wrote ${out} (${report.ranges.length} changed ranges)`);
  }
} catch (err) {
  console.error(`Could not compare the renders: ${(err as Error).message}`);
  // Leaving the file absent is the signal to the workflow that there is
  // nothing better to say than the generic comment.
  process.exit(0);
}
