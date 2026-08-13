import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildCues, toSrt, toVtt } from "../src/narrate/subtitles.js";

describe("buildCues", () => {
  test("runs each caption until the next one", () => {
    const cues = buildCues(
      [
        { t: 0, text: "first" },
        { t: 2000, text: "second" },
      ],
      5000,
    );
    assert.equal(cues[0]!.end, 2000);
    assert.equal(cues[1]!.start, 2000);
  });

  test("clips the final caption to the end of the recording", () => {
    const cues = buildCues([{ t: 1000, text: "only" }], 4000);
    assert.equal(cues[0]!.end, 4000);
  });

  test("enforces a readable minimum duration", () => {
    // Two captions 100ms apart would otherwise flash by unreadably.
    const cues = buildCues(
      [
        { t: 0, text: "a" },
        { t: 100, text: "b" },
      ],
      200,
    );
    assert.ok(cues[0]!.end - cues[0]!.start >= 800);
  });

  test("drops blank captions and trims whitespace", () => {
    const cues = buildCues(
      [
        { t: 0, text: "  hello  " },
        { t: 500, text: "   " },
      ],
      2000,
    );
    assert.equal(cues.length, 1);
    assert.equal(cues[0]!.text, "hello");
  });

  test("sorts out-of-order captions", () => {
    const cues = buildCues(
      [
        { t: 900, text: "late" },
        { t: 100, text: "early" },
      ],
      2000,
    );
    assert.deepEqual(
      cues.map((c) => c.text),
      ["early", "late"],
    );
  });

  test("returns nothing when there are no captions", () => {
    assert.deepEqual(buildCues([], 5000), []);
  });
});

describe("subtitle formats", () => {
  const cues = [{ start: 0, end: 1500, text: "hello" }];

  test("srt uses comma millisecond separators and 1-based indices", () => {
    const srt = toSrt(cues);
    assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,500\nhello/);
  });

  test("vtt uses a WEBVTT header and dot separators", () => {
    const vtt = toVtt(cues);
    assert.match(vtt, /^WEBVTT\n/);
    assert.match(vtt, /00:00:00\.000 --> 00:00:01\.500/);
  });

  test("stamps hours correctly past the one-hour mark", () => {
    const srt = toSrt([{ start: 3_723_004, end: 3_724_000, text: "long" }]);
    assert.match(srt, /01:02:03,004/);
  });
});
