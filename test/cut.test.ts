import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCutRange,
  sliceFrames,
  sliceTimeline,
  cutDuration,
} from "../src/encode/cut.js";

const beats = [
  { label: "hero", t: 0 },
  { label: "act1", t: 20_000 },
  { label: "act2", t: 60_000 },
  { label: "outro", t: 100_000 },
];

describe("resolving where a cut starts and ends", () => {
  test("beat labels become times", () => {
    assert.deepEqual(resolveCutRange({ from: "act1", to: "act2" }, beats, 120_000), {
      startMs: 20_000,
      endMs: 60_000,
    });
  });

  test("millisecond offsets are taken literally", () => {
    assert.deepEqual(resolveCutRange({ from: 1500, to: 4500 }, beats, 120_000), {
      startMs: 1500,
      endMs: 4500,
    });
  });

  test("an open end runs to the end of the demo", () => {
    assert.deepEqual(resolveCutRange({ from: "act2" }, beats, 120_000), {
      startMs: 60_000,
      endMs: 120_000,
    });
    assert.deepEqual(resolveCutRange({ to: "act1" }, beats, 120_000), {
      startMs: 0,
      endMs: 20_000,
    });
  });

  test("a misspelled beat says which beats exist", () => {
    // The whole value of naming beats is lost if a typo produces a range of
    // zero and a silently empty video.
    assert.throws(() => resolveCutRange({ from: "acts1" }, beats, 120_000), /names no beat/);
    assert.throws(() => resolveCutRange({ from: "acts1" }, beats, 120_000), /"hero", "act1"/);
  });

  test("a backwards range is refused rather than encoded as nothing", () => {
    assert.throws(() => resolveCutRange({ from: "act2", to: "act1" }, beats, 120_000), /not after/);
  });
});

describe("slicing the frames a cut is made of", () => {
  // Frames land only when the picture changes, which is what makes the opening
  // frame the interesting case.
  const frames = [
    { file: "a.png", t: 0 },
    { file: "b.png", t: 5_000 },
    { file: "c.png", t: 25_000 },
    { file: "d.png", t: 30_000 },
    { file: "e.png", t: 70_000 },
  ];

  test("a cut opens on the frame that was already on screen", () => {
    // The cut starts at 20s. Nothing changed between 5s and 25s, so the picture
    // at 20s is b.png. Keeping only frames inside the range would open the cut
    // on c.png — five seconds of the demo simply missing, and no error to say so.
    const cut = sliceFrames(frames, { startMs: 20_000, endMs: 60_000 });
    assert.equal(cut[0]?.file, "b.png", "should carry in the frame in effect at the in point");
    assert.equal(cut[0]?.t, 0, "and rebase it to the start of the cut");
  });

  test("frames inside the range keep their spacing", () => {
    const cut = sliceFrames(frames, { startMs: 20_000, endMs: 60_000 });
    assert.deepEqual(
      cut.map((f) => [f.file, f.t]),
      [
        ["b.png", 0],
        ["c.png", 5_000],
        ["d.png", 10_000],
      ],
    );
  });

  test("frames after the out point are left behind", () => {
    const cut = sliceFrames(frames, { startMs: 20_000, endMs: 60_000 });
    assert.ok(!cut.some((f) => f.file === "e.png"));
  });

  test("a cut starting exactly on a frame does not duplicate it", () => {
    const cut = sliceFrames(frames, { startMs: 5_000, endMs: 26_000 });
    assert.deepEqual(
      cut.map((f) => [f.file, f.t]),
      [
        ["b.png", 0],
        ["c.png", 20_000],
      ],
    );
  });

  test("a cut from the very start is the frames themselves", () => {
    const cut = sliceFrames(frames, { startMs: 0, endMs: 120_000 });
    assert.deepEqual(cut.map((f) => f.file), ["a.png", "b.png", "c.png", "d.png", "e.png"]);
    assert.deepEqual(cut.map((f) => f.t), [0, 5_000, 25_000, 30_000, 70_000]);
  });

  test("no frames at all is empty rather than a crash", () => {
    assert.deepEqual(sliceFrames([], { startMs: 0, endMs: 1000 }), []);
  });
});

describe("slicing what was on the timeline", () => {
  const captions = [
    { t: 0, text: "one" },
    { t: 10_000, text: "two" },
    { t: 45_000, text: "three" },
    { t: 90_000, text: "four" },
  ];

  test("a caption still on screen when the cut opens comes with it", () => {
    // "two" appeared at 10s and nothing replaced it until 45s, so at 20s it is
    // what the viewer is reading. A cut that dropped it would open silent.
    const kept = sliceTimeline(captions, { startMs: 20_000, endMs: 60_000 });
    assert.deepEqual(
      kept.map((c) => [c.text, c.t]),
      [
        ["two", 0],
        ["three", 25_000],
      ],
    );
  });

  test("carry-in can be refused, for timelines where it would be wrong", () => {
    // Beats are chapter marks, not state: carrying one in would relabel the cut
    // after a chapter that ended before it started.
    const kept = sliceTimeline(captions, { startMs: 20_000, endMs: 60_000 }, { carryIn: false });
    assert.deepEqual(kept.map((c) => [c.text, c.t]), [["three", 25_000]]);
  });

  test("entries past the out point are dropped", () => {
    const kept = sliceTimeline(captions, { startMs: 0, endMs: 50_000 });
    assert.ok(!kept.some((c) => c.text === "four"));
  });
});

describe("how long a cut runs", () => {
  test("is the distance between its ends", () => {
    assert.equal(cutDuration({ startMs: 20_000, endMs: 60_000 }), 40_000);
  });
});
