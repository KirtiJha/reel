import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { beatLabels, draftProfile, driveThrough, previewRange } from "../src/polish/preview.js";
import { resolveOutputProfile, specSchema, type Step } from "../src/spec/schema.js";

const steps = (s: unknown[]) =>
  specSchema.parse({ steps: s, output: { html: "out/d.html" } }).steps as Step[];

describe("draftProfile", () => {
  test("drops the frame rate and the resolution", () => {
    const hq = resolveOutputProfile({ preset: "hq" } as never);
    const d = draftProfile(hq);
    assert.ok(d.fps < hq.fps, "fps comes down");
    assert.ok(d.maxWidth < hq.maxWidth, "resolution comes down");
  });

  test("never scales a small preset up", () => {
    // A draft is a cheaper render, never a more expensive one. A preset already
    // below the draft ceiling should stay where it is.
    const tiny = { fps: 8, maxWidth: 400, gif: { fps: 6, maxWidth: 300, colors: 64 } };
    const d = draftProfile(tiny);
    assert.equal(d.fps, 8);
    assert.equal(d.maxWidth, 400);
  });
});

describe("previewRange", () => {
  const beats = [
    { label: "hero", t: 0 },
    { label: "adding", t: 4000 },
    { label: "done", t: 9000 },
    { label: "outro", t: 12000 },
  ];

  test("spans from the beat before to the beat after", () => {
    // Both ends, because what you are judging is usually how a moment arrives.
    // Starting exactly at the beat cuts off the run-up that makes it readable.
    assert.deepEqual(previewRange(beats, "done", 15000), { startMs: 4000, endMs: 12000 });
  });

  test("the first beat starts at the beginning", () => {
    assert.deepEqual(previewRange(beats, "hero", 15000), { startMs: 0, endMs: 4000 });
  });

  test("the last beat runs to the end of the demo", () => {
    assert.deepEqual(previewRange(beats, "outro", 15000), { startMs: 9000, endMs: 15000 });
  });

  test("matching a beat is not case-sensitive", () => {
    assert.deepEqual(previewRange(beats, "DONE", 15000), previewRange(beats, "done", 15000));
  });

  test("an unknown beat is null, not the whole film", () => {
    // The caller names the beats that do exist. Silently rendering everything
    // would burn the minutes the flag exists to save.
    assert.equal(previewRange(beats, "nope", 15000), null);
  });

  test("out-of-order beats still produce a forward range", () => {
    const jumbled = [
      { label: "b", t: 5000 },
      { label: "a", t: 1000 },
      { label: "c", t: 9000 },
    ];
    const r = previewRange(jumbled, "b", 12000)!;
    assert.ok(r.startMs < r.endMs);
    assert.deepEqual(r, { startMs: 1000, endMs: 9000 });
  });
});

describe("driveThrough", () => {
  test("stops after the beat that closes the section", () => {
    const s = steps([
      { click: "#a" },
      { beat: "one" },
      { click: "#b" },
      { beat: "two" },
      { click: "#c" },
      { beat: "three" },
    ]);
    // Through "two" — the beat that ends the section "one" labels.
    assert.equal(driveThrough(s, "one"), 4);
  });

  test("runs the whole spec for the last beat", () => {
    const s = steps([{ click: "#a" }, { beat: "one" }, { click: "#b" }, { beat: "two" }]);
    assert.equal(driveThrough(s, "two"), null);
  });

  test("runs the whole spec when the beat is not there", () => {
    const s = steps([{ click: "#a" }, { beat: "one" }]);
    assert.equal(driveThrough(s, "nope"), null);
  });

  test("does not stop inside a branch", () => {
    // A beat inside a path is reachable only by taking that path, and stopping
    // mid-branch would leave the recording in a state the spec never describes.
    const s = steps([
      { beat: "one" },
      {
        branch: {
          paths: [
            { label: "a", steps: [{ beat: "inner" }] },
            { label: "b", steps: [{ click: "#b" }] },
          ],
        },
      },
      { beat: "two" },
    ]);
    assert.equal(driveThrough(s, "inner"), null);
  });
});

describe("beatLabels", () => {
  test("names beats and cards, so an unknown --only can be answered", () => {
    const s = steps([
      { card: { title: "Opening" } },
      { beat: "hero" },
      { click: "#a" },
      { card: "Closing" },
    ]);
    assert.deepEqual(beatLabels(s), ["Opening", "hero", "Closing"]);
  });

  test("reaches into branch paths", () => {
    const s = steps([
      {
        branch: {
          paths: [
            { label: "a", steps: [{ beat: "inner" }] },
            { label: "b", steps: [{ click: "#b" }] },
          ],
        },
      },
    ]);
    assert.deepEqual(beatLabels(s), ["inner"]);
  });
});
