import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  beatsOverlapping,
  formatRange,
  formatShare,
  groupRanges,
  pixelDelta,
  summarize,
  CHANNEL_TOLERANCE,
  DEFAULT_THRESHOLD,
  SAME_FORMAT_THRESHOLD,
  sameFormat,
  type Sample,
  type Range,
  type DiffReport,
} from "../src/diff/compare.js";
import { markdownSummary } from "../src/commands/diff.js";

/** A raw RGB buffer of `n` pixels, all the same colour. */
function flat(n: number, r: number, g = r, b = r): Buffer {
  const buf = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    buf[i * 3] = r;
    buf[i * 3 + 1] = g;
    buf[i * 3 + 2] = b;
  }
  return buf;
}

describe("pixelDelta", () => {
  test("identical images differ nowhere", () => {
    assert.equal(pixelDelta(flat(100, 40), flat(100, 40)), 0);
  });

  test("a wholly different image differs everywhere", () => {
    assert.equal(pixelDelta(flat(100, 0), flat(100, 255)), 1);
  });

  test("reports the share of pixels that moved", () => {
    const a = flat(100, 0);
    const b = flat(100, 0);
    for (let i = 0; i < 25; i++) b[i * 3] = 255;
    assert.equal(pixelDelta(a, b), 0.25);
  });

  test("ignores differences within encoder tolerance", () => {
    // GIF palette quantisation moves flat colour by a value or two; counting it
    // would make every comparison of the same demo look changed.
    assert.equal(pixelDelta(flat(50, 100), flat(50, 100 + CHANNEL_TOLERANCE)), 0);
    assert.equal(pixelDelta(flat(50, 100), flat(50, 100 + CHANNEL_TOLERANCE + 1)), 1);
  });

  test("a change in any single channel counts once", () => {
    // Not three times: the unit is the pixel, and a green-only shift is one
    // changed pixel, not one-third of three.
    const a = flat(10, 0, 0, 0);
    const b = flat(10, 0, 200, 0);
    assert.equal(pixelDelta(a, b), 1);
  });

  test("refuses to compare images of different sizes", () => {
    assert.throws(() => pixelDelta(flat(10, 0), flat(20, 0)), /different sizes/);
  });

  test("an empty buffer is not a difference", () => {
    assert.equal(pixelDelta(Buffer.alloc(0), Buffer.alloc(0)), 0);
  });
});

describe("groupRanges", () => {
  const s = (t: number, score: number): Sample => ({ t, score });

  test("no changed samples means no ranges", () => {
    assert.deepEqual(groupRanges([s(0, 0), s(200, 0.0001)]), []);
  });

  test("consecutive changed samples form one range", () => {
    const r = groupRanges([s(0, 0), s(200, 0.4), s(400, 0.5), s(600, 0)], [], DEFAULT_THRESHOLD, 500, 200);
    assert.equal(r.length, 1);
    assert.equal(r[0]!.startMs, 200);
    assert.equal(r[0]!.endMs, 600, "the range covers the interval its last sample sits in");
    assert.equal(r[0]!.samples, 2);
  });

  test("bridges a brief dip so one visual event stays one range", () => {
    // A dialog fading in dips below the threshold whenever a sample lands
    // mid-fade; reporting that as three changes makes the report unreadable.
    const r = groupRanges(
      [s(0, 0.4), s(200, 0), s(400, 0.4), s(600, 0)],
      [],
      DEFAULT_THRESHOLD,
      500,
      200,
    );
    assert.equal(r.length, 1);
  });

  test("splits changes separated by more than the merge gap", () => {
    const r = groupRanges([s(0, 0.4), s(2000, 0.4)], [], DEFAULT_THRESHOLD, 500, 200);
    assert.equal(r.length, 2);
  });

  test("reports both the worst moment and the average", () => {
    const r = groupRanges([s(0, 0.2), s(200, 0.8)], [], DEFAULT_THRESHOLD, 500, 200);
    assert.equal(r[0]!.peak, 0.8);
    assert.ok(Math.abs(r[0]!.mean - 0.5) < 1e-9);
  });

  test("a sample missing from one render is a change regardless of score", () => {
    const r = groupRanges([{ t: 0, score: 0, missing: "before" }], [], DEFAULT_THRESHOLD, 500, 200);
    assert.equal(r.length, 1);
    assert.equal(r[0]!.truncated, true);
  });

  test("labels a range with the beats it overlaps", () => {
    const beats = [
      { label: "Open the app", t: 0 },
      { label: "Create a project", t: 2000 },
      { label: "Done", t: 5000 },
    ];
    const r = groupRanges([s(2400, 0.3), s(2600, 0.3)], beats, DEFAULT_THRESHOLD, 500, 200);
    assert.deepEqual(r[0]!.beats, ["Create a project"]);
  });
});

describe("beatsOverlapping", () => {
  const beats = [
    { label: "one", t: 0 },
    { label: "two", t: 1000 },
    { label: "three", t: 2000 },
  ];

  test("names every beat a range straddles", () => {
    // Attributing a boundary-crossing change to only the first beat would send
    // a reader to the wrong part of the demo.
    assert.deepEqual(beatsOverlapping(900, 1100, beats), ["one", "two"]);
  });

  test("the last beat runs to the end of the demo", () => {
    assert.deepEqual(beatsOverlapping(9000, 9500, beats), ["three"]);
  });

  test("a change before the first beat belongs to it", () => {
    assert.deepEqual(beatsOverlapping(0, 100, beats), ["one"]);
  });

  test("no beats recorded means no labels, not an error", () => {
    assert.deepEqual(beatsOverlapping(0, 100, []), []);
  });

  test("does not depend on the order beats were given in", () => {
    const shuffled = [beats[2]!, beats[0]!, beats[1]!];
    assert.deepEqual(beatsOverlapping(900, 1100, shuffled), ["one", "two"]);
  });
});

describe("summarize", () => {
  test("identical renders of the same length are identical", () => {
    const r = summarize([{ t: 0, score: 0 }], [], 5000, 5000, 5);
    assert.equal(r.identical, true);
  });

  test("the same frames at different lengths are not identical", () => {
    // A demo that got longer changed, even if every compared frame matched.
    const r = summarize([{ t: 0, score: 0 }], [], 5000, 7000, 5);
    assert.equal(r.identical, false);
  });

  test("reports how much of the running time differs", () => {
    const samples: Sample[] = [
      { t: 0, score: 0 },
      { t: 200, score: 0.5 },
      { t: 400, score: 0.5 },
      { t: 600, score: 0 },
    ];
    const r = summarize(samples, groupRanges(samples), 800, 800, 5);
    assert.equal(r.changedSamples, 2);
    assert.equal(r.changedFraction, 0.5);
  });
});

describe("formatting", () => {
  test("ranges print as seconds a viewer can scrub to", () => {
    assert.equal(
      formatRange({ startMs: 2400, endMs: 4200 }),
      "2.4s–4.2s",
    );
  });

  test("small changes keep enough digits to read as non-zero", () => {
    // `0.0%` reads as "nothing changed", which is exactly the wrong impression.
    assert.equal(formatShare(0.0004), "0.04%");
    assert.equal(formatShare(0.032), "3.2%");
    assert.equal(formatShare(0.42), "42%");
  });
});

describe("the pull-request comment", () => {
  const range = (over: Partial<Range> = {}): Range => ({
    startMs: 8000,
    endMs: 9800,
    peak: 0.09,
    mean: 0.024,
    samples: 8,
    truncated: false,
    beats: ["hero"],
    ...over,
  });

  const report = (over: Partial<DiffReport> = {}): DiffReport => ({
    identical: false,
    samples: 77,
    changedSamples: 21,
    changedFraction: 0.27,
    ranges: [range()],
    durationBeforeMs: 15400,
    durationAfterMs: 15200,
    fps: 5,
    ...over,
  });

  test("names the moment, the size and the beat", () => {
    // The three things a reviewer needs to decide whether to look: where in the
    // demo, how much moved, and which part of the story it belongs to.
    const md = markdownSummary(report(), { file: "docs/demo.gif" });
    assert.match(md, /8\.0s–9\.8s/);
    assert.match(md, /2\.4% of pixels/);
    assert.match(md, /hero/);
  });

  test("reports a length change, and says so when there isn't one", () => {
    assert.match(markdownSummary(report(), { file: "d.gif" }), /15\.4s → 15\.2s \(-0\.2s\)/);
    assert.match(
      markdownSummary(report({ durationBeforeMs: 15200 }), { file: "d.gif" }),
      /15\.2s, unchanged/,
    );
  });

  test("is a table GitHub will render", () => {
    const md = markdownSummary(report(), { file: "d.gif" });
    assert.match(md, /\| When \| How much \| Where \|/);
    assert.match(md, /\|---\|---\|---\|/);
  });

  test("counts the changes in the summary line", () => {
    assert.match(markdownSummary(report(), { file: "d.gif" }), /\*\*1 change\*\*/);
    assert.match(
      markdownSummary(report({ ranges: [range(), range()] }), { file: "d.gif" }),
      /\*\*2 changes\*\*/,
    );
  });

  test("says how many rows it left out rather than stopping silently", () => {
    // A table that ends at the cap without saying so reads as the whole story.
    const many = Array.from({ length: 12 }, () => range());
    const md = markdownSummary(report({ ranges: many }), { file: "d.gif", maxRows: 8 });
    assert.match(md, /4 further changes not listed/);
  });

  test("flags a range that exists in only one render", () => {
    const md = markdownSummary(report({ ranges: [range({ truncated: true, beats: [] })] }), {
      file: "d.gif",
    });
    assert.match(md, /only in one render/);
  });

  test("explains a rewrite that changed nothing visible", () => {
    // The bytes can differ while every frame matches — a re-encode, container
    // metadata. Saying that beats an empty table.
    const md = markdownSummary(report({ identical: true, ranges: [] }), { file: "docs/demo.gif" });
    assert.match(md, /nothing visible changed/);
    assert.doesNotMatch(md, /\| When \|/);
  });

  test("always names the file a reviewer should open", () => {
    for (const r of [report(), report({ identical: true, ranges: [] })]) {
      assert.match(markdownSummary(r, { file: "docs/demo.gif" }), /docs\/demo\.gif/);
    }
  });
});

describe("the threshold is set from measurements, not from a guess", () => {
  // Every number here was measured on a 1100×700 app compared at 480 wide. The
  // threshold that shipped was 0.2%, above the signal — so a demo whose price
  // changed from £9 to USD 29 was reported identical, frame for frame.
  const MEASURED = {
    unchangedRerender: 0,
    sameRenderMp4VsWebm: 0,
    sameRenderMp4VsGif: 0.000728, // palette quantisation, the real noise ceiling
    aChangedPrice: 0.001682, // the smallest real change measured
  };

  test("a change that small is still a change", () => {
    assert.ok(
      MEASURED.aChangedPrice > DEFAULT_THRESHOLD,
      `a changed price (${MEASURED.aChangedPrice}) must exceed the threshold (${DEFAULT_THRESHOLD})`,
    );
  });

  test("and cross-format quantisation still is not", () => {
    // The floor is not "a moving cursor": two renders of one spec are
    // byte-identical. It is GIF palette quantisation, and only across formats.
    assert.ok(
      MEASURED.sameRenderMp4VsGif < DEFAULT_THRESHOLD,
      `gif quantisation (${MEASURED.sameRenderMp4VsGif}) must stay below ${DEFAULT_THRESHOLD}`,
    );
    assert.equal(MEASURED.unchangedRerender, 0);
    assert.equal(MEASURED.sameRenderMp4VsWebm, 0);
  });

  test("with room on both sides, so neither is a coin flip", () => {
    assert.ok(DEFAULT_THRESHOLD / MEASURED.sameRenderMp4VsGif > 1.3, "headroom over noise");
    assert.ok(MEASURED.aChangedPrice / DEFAULT_THRESHOLD > 1.6, "margin below the signal");
  });
});

describe("comparing one format with itself", () => {
  // The 0.073% floor the default threshold is built around is GIF palette
  // quantisation, and it only exists across formats. mp4 against mp4 — which
  // is what CI does on every run, the previous render against the new one —
  // has a floor of nothing at all, because two renders of one spec are
  // byte-identical. Holding it to the cross-format number cost real
  // detections: a ₹80 → ₹95 price change moves 0.02% of pixels and was
  // reported as identical.
  test("the same extension is the same format", () => {
    assert.equal(sameFormat("a/before.mp4", "b/after.mp4"), true);
    assert.equal(sameFormat("BEFORE.MP4", "after.mp4"), true, "extension case does not matter");
  });

  test("different extensions are not", () => {
    assert.equal(sameFormat("demo.mp4", "demo.gif"), false);
    assert.equal(sameFormat("demo.webm", "demo.mp4"), false);
  });

  test("the same-format threshold catches a change the cross-format one misses", () => {
    const priceChange = 0.0002; // measured: two digits on a 1280-wide app
    assert.ok(priceChange > SAME_FORMAT_THRESHOLD, "must be caught comparing mp4 with mp4");
    assert.ok(priceChange < DEFAULT_THRESHOLD, "and is what the cross-format threshold misses");
  });

  test("it is not zero — a single stray pixel is not a report", () => {
    assert.ok(SAME_FORMAT_THRESHOLD > 0);
  });
});
