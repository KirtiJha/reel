import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { JITTER, typingDelays, typingDurationMs } from "../src/overlay/cadence.js";
import { specSchema } from "../src/spec/schema.js";

const base = { delay: 60, jitter: true, seed: 0 };

describe("typingDelays", () => {
  test("is one delay per character", () => {
    assert.equal(typingDelays("hello", base).length, 5);
    assert.equal(typingDelays("", base).length, 0);
  });

  test("is the same array every time — this is the product's core promise", () => {
    // If this ever fails, two renders of one spec have different frame
    // timestamps, and CI rewrites the committed media on every push.
    const once = typingDelays("Ship the Reel demo.", base);
    for (let i = 0; i < 50; i++) {
      assert.deepEqual(typingDelays("Ship the Reel demo.", base), once);
    }
  });

  test("does not touch Math.random", () => {
    // The jitter has to be derived, not drawn: a spec with no `seedRandom` must
    // still type identically, and nothing here may perturb an app's own PRNG.
    const real = Math.random;
    Math.random = () => {
      throw new Error("typing must not consume randomness");
    };
    try {
      assert.ok(typingDelays("some text to type", base).length > 0);
    } finally {
      Math.random = real;
    }
  });

  test("stays inside ±35% of the base for ordinary characters", () => {
    const text = "abcdefghijklmnopqrstuvwxyz0123456789";
    for (const ms of typingDelays(text, base)) {
      assert.ok(ms >= Math.floor(60 * (1 - JITTER)), `${ms} too fast`);
      assert.ok(ms <= Math.ceil(60 * (1 + JITTER)), `${ms} too slow`);
    }
  });

  test("is not a metronome", () => {
    // The whole point: uniform inter-key timing is the automation tell.
    const delays = typingDelays("the quick brown fox jumps over it", base);
    assert.ok(new Set(delays).size > delays.length / 3, "too many identical intervals");
  });

  test("rests at a word boundary", () => {
    const text = "one two";
    const delays = typingDelays(text, base);
    const space = delays[text.indexOf(" ")]!;
    const letters = [...text]
      .map((ch, i) => (ch === " " ? null : delays[i]!))
      .filter((d): d is number => d !== null);
    assert.ok(
      space > Math.max(...letters),
      `a space (${space}ms) should outlast every letter (max ${Math.max(...letters)}ms)`,
    );
  });

  test("pauses longest after a full stop, less after a comma", () => {
    const text = "a. b, c";
    const d = typingDelays(text, base);
    const stop = d[text.indexOf(".")]!;
    const comma = d[text.indexOf(",")]!;
    const letter = d[0]!;
    assert.ok(stop > comma, `${stop} should outlast ${comma}`);
    assert.ok(comma > letter, `${comma} should outlast ${letter}`);
  });

  test("two fields in one demo do not share a rhythm", () => {
    // The text is part of the seed, so a repeated cadence never reads as a loop.
    const a = typingDelays("first field", base);
    const b = typingDelays("other stuff", base);
    assert.equal(a.length, b.length);
    assert.notDeepEqual(a, b);
  });

  test("the same text always types the same way, wherever it appears", () => {
    assert.deepEqual(typingDelays("hello", base), typingDelays("hello", base));
  });

  test("the seed shifts the pattern without breaking reproducibility", () => {
    const a = typingDelays("a stable sentence", { ...base, seed: 1 });
    const b = typingDelays("a stable sentence", { ...base, seed: 2 });
    assert.notDeepEqual(a, b);
    assert.deepEqual(a, typingDelays("a stable sentence", { ...base, seed: 1 }));
  });

  test("jitter: false is exactly the flat delay Reel typed with before", () => {
    assert.deepEqual(typingDelays("hello there", { ...base, jitter: false }), Array(11).fill(60));
  });

  test("a zero delay stays zero", () => {
    // "type instantly" is an instruction, not a starting point to wander from.
    assert.deepEqual(typingDelays("abc", { delay: 0, jitter: true }), [0, 0, 0]);
  });

  test("never emits a zero-length keystroke", () => {
    // The timeline rounds; a 0ms character would put two keystrokes on one
    // frame timestamp and one of them would never be seen.
    for (const ms of typingDelays("edge case", { delay: 1, jitter: true })) {
      assert.ok(ms >= 1, `${ms}`);
    }
  });

  test("averages close to the base delay over ordinary prose", () => {
    // The wander is symmetric, so jitter alone must not quietly make every demo
    // slower; only the authored pauses add time.
    const text = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz";
    const mean = typingDurationMs(text, base) / text.length;
    assert.ok(Math.abs(mean - 60) < 6, `mean ${mean}ms drifted from 60ms`);
  });

  test("handles text outside the basic plane one character at a time", () => {
    assert.equal(typingDelays("héllo ✅", base).length, [..."héllo ✅"].length);
  });
});

describe("polish.typing", () => {
  const spec = (over: Record<string, unknown> = {}) =>
    specSchema.parse({
      ...over,
      steps: [{ type: { selector: "#a", text: "hi" } }],
      output: { mp4: "o.mp4" },
    });

  test("types like a person unless told otherwise", () => {
    assert.equal(spec().polish.typing, "human");
  });

  test("can be flattened for the whole demo", () => {
    assert.equal(spec({ polish: { typing: "uniform" } }).polish.typing, "uniform");
  });

  test("a single step can opt out", () => {
    const parsed = specSchema.parse({
      steps: [{ type: { selector: "#a", text: "AB-1234", jitter: false } }],
      output: { mp4: "o.mp4" },
    });
    const step = parsed.steps[0]!;
    assert.ok("type" in step);
    assert.equal(step.type.jitter, false);
  });

  test("a step that says nothing inherits the spec's cadence", () => {
    const parsed = spec();
    const step = parsed.steps[0]!;
    assert.ok("type" in step);
    assert.equal(step.type.jitter, undefined, "undefined means `follow polish.typing`");
  });

  test("rejects a cadence that isn't one of the two", () => {
    assert.throws(() => spec({ polish: { typing: "fast" } }));
  });
});
