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
  type Sample,
} from "../src/diff/compare.js";

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
      formatRange({ startMs: 2400, endMs: 4200, peak: 1, mean: 1, samples: 9, truncated: false, beats: [] }),
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
