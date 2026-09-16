import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atLeast,
  captionsInRange,
  cuesFor,
  parseVerdict,
  rangePrompt,
  review,
  worstVerdict,
  MAX_REVIEWED,
  type Finding,
  type ReviewReport,
} from "../src/review/review.js";
import { markdownReview, tally, type ReviewOutcome } from "../src/commands/review.js";
import { messageText, type ChatResult, type LlmConfig, type OaiMessage } from "../src/ai/llm.js";
import { toAnthropicRequest } from "../src/ai/anthropic-wire.js";
import type { Range } from "../src/diff/compare.js";

const range = (startMs: number, endMs: number, extra: Partial<Range> = {}): Range => ({
  startMs,
  endMs,
  peak: 0.2,
  mean: 0.1,
  samples: 4,
  truncated: false,
  beats: [],
  ...extra,
});

const cfg = { model: "test-model", apiBase: "https://example.invalid/v1" } as LlmConfig;

/** A chat that always answers with the given tool arguments. */
function answering(...replies: (string | Error)[]): (...a: unknown[]) => Promise<ChatResult> {
  let i = 0;
  return async () => {
    const reply = replies[Math.min(i++, replies.length - 1)]!;
    if (reply instanceof Error) throw reply;
    return {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "t1", type: "function", function: { name: "report", arguments: reply } }],
      },
      finishReason: "tool_calls",
    } as ChatResult;
  };
}

async function strip(dir: string, name: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, "not really a png, but it is bytes");
  return p;
}

describe("which captions were on screen", () => {
  const cues = cuesFor(
    [
      { t: 0, text: "Start a project" },
      { t: 4000, text: "Click Start free trial" },
      { t: 9000, text: "Done" },
    ],
    12_000,
  );

  test("a range inside one caption sees only that caption", () => {
    assert.deepEqual(captionsInRange(cues, 5000, 6000), ["Click Start free trial"]);
  });

  test("a range straddling two sees both", () => {
    assert.deepEqual(captionsInRange(cues, 3800, 4200), [
      "Start a project",
      "Click Start free trial",
    ]);
  });

  test("a range past the last caption still sees it", () => {
    // Captions run until the next one or the end, so the tail is covered — the
    // alternative silently exempts the end of every demo from caption checks.
    assert.deepEqual(captionsInRange(cues, 11_000, 11_500), ["Done"]);
  });

  test("no captions recorded is not an error", () => {
    assert.deepEqual(cuesFor(undefined, 10_000), []);
    assert.deepEqual(captionsInRange([], 0, 1000), []);
  });
});

describe("reading a verdict back", () => {
  test("takes a well-formed one", () => {
    assert.deepEqual(parseVerdict('{"verdict":"content","summary":"The button reads Get started."}'), {
      verdict: "content",
      summary: "The button reads Get started.",
    });
  });

  test("an unrecognised verdict is unreviewed, never a pass", () => {
    // The dangerous failure is a garbled reply being filed under "fine": the
    // whole point of the command is that nobody is watching these by hand.
    assert.equal(parseVerdict('{"verdict":"fine"}').verdict, "unreviewed");
    assert.equal(parseVerdict("not json at all").verdict, "unreviewed");
    assert.equal(parseVerdict(undefined).verdict, "unreviewed");
  });

  test("a verdict with no summary still says something", () => {
    assert.ok(parseVerdict('{"verdict":"cosmetic"}').summary.length > 0);
  });
});

describe("severity", () => {
  const finding = (verdict: Finding["verdict"]): Finding => ({
    startMs: 0,
    endMs: 1,
    beats: [],
    mean: 0,
    captions: [],
    verdict,
    summary: "",
  });
  const report = (...v: Finding["verdict"][]): ReviewReport => ({
    findings: v.map(finding),
    model: "m",
    skipped: 0,
  });

  test("the worst verdict is what a pipeline decides on", () => {
    assert.equal(worstVerdict(report("cosmetic", "stale-caption", "content")), "stale-caption");
    assert.equal(worstVerdict(report("cosmetic", "cosmetic")), "cosmetic");
    assert.equal(worstVerdict(report()), "cosmetic");
  });

  test("an unjudged range outranks a cosmetic one", () => {
    // "We could not tell" must not be quieter than "we looked and it was fine".
    assert.equal(worstVerdict(report("cosmetic", "unreviewed")), "unreviewed");
  });

  test("failing at a threshold includes everything worse", () => {
    assert.ok(atLeast("stale-caption", "content"));
    assert.ok(atLeast("content", "content"));
    assert.ok(!atLeast("cosmetic", "content"));
    assert.ok(!atLeast("unreviewed", "content"));
  });
});

describe("what the model is shown", () => {
  test("the captions on screen are named", () => {
    const p = rangePrompt(range(4000, 5000, { beats: ["Sign up"] }), ["Click Start free trial"]);
    assert.match(p, /4\.0s–5\.0s/);
    assert.match(p, /Sign up/);
    assert.match(p, /Click Start free trial/);
  });

  test("with no captions, the verdict is ruled out rather than left open", () => {
    const p = rangePrompt(range(0, 1000), []);
    assert.match(p, /stale-caption. does not apply/);
  });
});

describe("the review pass", () => {
  test("judges every range and keeps the beats and captions with it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reel-review-"));
    const ranges = [range(0, 1000, { beats: ["Open"] }), range(4000, 5000)];
    const strips = [await strip(dir, "a.png"), await strip(dir, "b.png")];
    const cues = cuesFor([{ t: 0, text: "Open the app" }], 6000);

    const report = await review({
      ranges,
      strips,
      cues,
      cfg,
      chat: answering(
        '{"verdict":"cosmetic","summary":"Spacing only."}',
        '{"verdict":"stale-caption","summary":"Caption says trial; the button says Get started."}',
      ) as never,
    });

    assert.equal(report.findings.length, 2);
    assert.deepEqual(report.findings[0]!.beats, ["Open"]);
    assert.deepEqual(report.findings[0]!.captions, ["Open the app"]);
    assert.equal(report.findings[1]!.verdict, "stale-caption");
    assert.equal(worstVerdict(report), "stale-caption");
  });

  test("a range with no comparison frame is reported, not skipped", async () => {
    // These are the ranges that exist in only one render — a demo that got
    // longer. Dropping them would hide the most common real change there is.
    const report = await review({
      ranges: [range(0, 1000, { truncated: true })],
      strips: [""],
      cues: [],
      cfg,
      chat: answering('{"verdict":"cosmetic","summary":"unused"}') as never,
    });
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0]!.verdict, "unreviewed");
    assert.match(report.findings[0]!.summary, /longer or shorter/);
  });

  test("one failed call does not lose the verdicts that succeeded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reel-review-"));
    const strips = [await strip(dir, "a.png"), await strip(dir, "b.png")];
    const report = await review({
      ranges: [range(0, 1000), range(2000, 3000)],
      strips,
      cues: [],
      cfg,
      chat: answering(
        new Error("429 rate limited"),
        '{"verdict":"content","summary":"The count changed."}',
      ) as never,
    });
    assert.equal(report.findings[0]!.verdict, "unreviewed");
    assert.match(report.findings[0]!.summary, /429/);
    assert.equal(report.findings[1]!.verdict, "content");
  });

  test("ranges beyond the budget are counted, not dropped in silence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reel-review-"));
    const one = await strip(dir, "s.png");
    const n = MAX_REVIEWED + 3;
    const report = await review({
      ranges: Array.from({ length: n }, (_, i) => range(i * 1000, i * 1000 + 500)),
      strips: Array.from({ length: n }, () => one),
      cues: [],
      cfg,
      chat: answering('{"verdict":"cosmetic","summary":"ok"}') as never,
    });
    assert.equal(report.findings.length, MAX_REVIEWED);
    assert.equal(report.skipped, 3);
  });
});

describe("the pull-request comment", () => {
  const outcome = (over: Partial<ReviewOutcome>): ReviewOutcome =>
    ({
      findings: [],
      model: "test-model",
      skipped: 0,
      failed: false,
      diff: { identical: false, ranges: [range(0, 1)], strips: [] },
      ...over,
    }) as ReviewOutcome;

  const finding = (over: Partial<Finding>): Finding => ({
    startMs: 3200,
    endMs: 4800,
    beats: ["Sign up"],
    mean: 0.1,
    captions: [],
    verdict: "content",
    summary: "The button reads “Get started”.",
    ...over,
  });

  test("leads with stale captions when there are any", () => {
    const md = markdownReview(
      outcome({ findings: [finding({}), finding({ verdict: "stale-caption" })] }),
      { file: "demo.gif" },
    );
    assert.match(md, /A caption no longer matches the screen/);
    // Worst first, so a reviewer who reads one row reads the one that matters.
    const rows = md.split("\n").filter((l) => l.startsWith("| 🔴") || l.startsWith("| 🟡"));
    assert.ok(rows[0]!.startsWith("| 🔴"), rows.join("\n"));
  });

  test("counts more than one stale caption in the plural", () => {
    const md = markdownReview(
      outcome({ findings: [finding({ verdict: "stale-caption" }), finding({ verdict: "stale-caption" })] }),
    );
    assert.match(md, /2 captions no longer match the screen/);
  });

  test("says plainly when only the look changed", () => {
    const md = markdownReview(outcome({ findings: [finding({ verdict: "cosmetic" })] }));
    assert.match(md, /Only cosmetic changes/);
  });

  test("names the model that judged", () => {
    assert.match(markdownReview(outcome({ findings: [finding({})] })), /test-model/);
  });

  test("a summary containing a pipe cannot break the table", () => {
    const md = markdownReview(outcome({ findings: [finding({ summary: "a | b" })] }));
    assert.match(md, /a \\\| b/);
  });

  test("says how many rows it left out", () => {
    const md = markdownReview(
      outcome({ findings: Array.from({ length: 5 }, () => finding({})) }),
      { file: "demo.gif", maxRows: 2 },
    );
    assert.match(md, /3 further moments not listed/);
  });

  test("an unconfigured run says so rather than implying it passed", () => {
    const md = markdownReview(outcome({ unconfigured: "No API key set." }));
    assert.match(md, /no model is[\s\S]*configured/);
    assert.doesNotMatch(md, /cosmetic/);
  });

  test("an unchanged demo needs no table", () => {
    const md = markdownReview(
      outcome({ diff: { identical: true, ranges: [], strips: [] } as never }),
      { file: "demo.gif" },
    );
    assert.match(md, /nothing visible changed/);
    assert.doesNotMatch(md, /\|---\|/);
  });

  test("tally counts every verdict, including the ones with none", () => {
    assert.deepEqual(tally([finding({ verdict: "content" }), finding({ verdict: "content" })]), {
      cosmetic: 0,
      content: 2,
      "stale-caption": 0,
      unreviewed: 0,
    });
  });
});

describe("sending an image", () => {
  const image: OaiMessage = {
    role: "user",
    content: [
      { type: "text", text: "what changed?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAB" } },
    ],
  };

  test("Anthropic gets the media type and payload as separate fields", () => {
    const req = toAnthropicRequest("claude", [image], undefined);
    assert.deepEqual(req.messages[0]!.content, [
      { type: "text", text: "what changed?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAB" } },
    ]);
  });

  test("a URL Anthropic could not fetch is dropped, not forwarded", () => {
    // Half a request that looks whole is worse than an obviously missing image.
    const req = toAnthropicRequest(
      "claude",
      [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }],
      undefined,
    );
    assert.deepEqual(req.messages[0]!.content, [{ type: "text", text: "" }]);
  });

  test("messageText reads either shape", () => {
    assert.equal(messageText({ content: "plain" }), "plain");
    assert.equal(messageText(image), "what changed?");
    assert.equal(messageText({ content: null }), "");
  });
});
