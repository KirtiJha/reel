import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildConcatManifest } from "../src/encode/encode.js";
import type { CapturedFrame } from "../src/capture/frames.js";

/** Sum every `duration` directive — the playback length ffmpeg will produce. */
function totalMs(manifest: string): number {
  return manifest
    .split("\n")
    .filter((l) => l.startsWith("duration "))
    .reduce((acc, l) => acc + Number(l.slice(9)) * 1000, 0);
}

function fileLines(manifest: string): string[] {
  return manifest
    .split("\n")
    .filter((l) => l.startsWith("file "))
    .map((l) => l.slice(6, -1));
}

const frames = (ts: number[]): CapturedFrame[] =>
  ts.map((t, i) => ({ file: `frame-${String(i).padStart(6, "0")}.jpg`, t }));

describe("buildConcatManifest", () => {
  test("anchors the timeline at t=0 when the first frame lands late", () => {
    // Regression: the lead-in before the first screenshot used to be dropped,
    // shifting the whole sequence earlier by first.t. The render pass maps
    // frame index to recording time as `i / fps`, so that offset desynced
    // captions, zoom keys and storyboard beats — and truncated the tail.
    const m = buildConcatManifest(frames([3800, 9000, 14230]), 900, 18900);
    assert.equal(Math.round(totalMs(m)), 18900);
    const files = fileLines(m);
    assert.equal(files[0], "frame-000000.jpg", "leads with the first frame");
    assert.equal(Number(m.split("\n")[2]!.slice(9)) * 1000, 3800, "held across the lead-in");
  });

  test("adds no lead-in when the first frame is already at t=0", () => {
    const m = buildConcatManifest(frames([0, 500, 1000]), 900, 2000);
    assert.equal(Math.round(totalMs(m)), 2000);
    // 3 frames → 3 duration directives, no extra anchor entry.
    assert.equal(m.split("\n").filter((l) => l.startsWith("duration ")).length, 3);
  });

  test("holds the final frame until the true end of the recording", () => {
    // Trailing captions/beats produce no new frames (dedup), so the last frame
    // has to stretch to endMs or the ending is lost.
    const m = buildConcatManifest(frames([0, 1000]), 900, 10_000);
    assert.equal(Math.round(totalMs(m)), 10_000);
  });

  test("never drops below the minimum tail", () => {
    // endMs earlier than the last frame must not produce a zero/negative hold.
    const m = buildConcatManifest(frames([0, 5000]), 900, 4000);
    assert.equal(Math.round(totalMs(m)), 5900);
  });

  test("falls back to the tail when no endMs is given", () => {
    const m = buildConcatManifest(frames([0, 1000]), 900);
    assert.equal(Math.round(totalMs(m)), 1900);
  });

  test("repeats the final file so its duration sticks", () => {
    // The concat demuxer ignores the last entry's duration unless the file is
    // listed once more after it.
    const m = buildConcatManifest(frames([0, 1000]), 900, 3000);
    const files = fileLines(m);
    assert.equal(files.at(-1), files.at(-2));
  });

  test("never emits a zero-length frame", () => {
    // Two screenshots in the same millisecond would otherwise produce
    // `duration 0`, which ffmpeg treats as a malformed entry.
    const m = buildConcatManifest(frames([0, 0, 10]), 900, 1000);
    for (const line of m.split("\n").filter((l) => l.startsWith("duration "))) {
      assert.ok(Number(line.slice(9)) > 0, `non-positive duration: ${line}`);
    }
  });

  test("is a pure function of the frame timeline", () => {
    const a = buildConcatManifest(frames([200, 900, 1500]), 900, 4000);
    const b = buildConcatManifest(frames([200, 900, 1500]), 900, 4000);
    assert.equal(a, b);
  });
});
