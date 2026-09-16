import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { slugify, sceneDurations, assignSlugs } from "../src/encode/html.js";

describe("slugify", () => {
  test("makes a URL-safe fragment", () => {
    assert.equal(slugify("Create a project"), "create-a-project");
  });

  test("collapses punctuation and trims separators", () => {
    assert.equal(slugify("  Sign in / up!  "), "sign-in-up");
  });

  test("bounds the length so a link stays readable", () => {
    assert.ok(slugify("x".repeat(200)).length <= 48);
  });

  test("survives a title with nothing sluggable in it", () => {
    assert.equal(slugify("!!!"), "");
  });
});

describe("assignSlugs", () => {
  test("only chapters get slugs", () => {
    assert.deepEqual(assignSlugs(["Intro", undefined, "Outro"]), ["intro", null, "outro"]);
  });

  test("de-duplicates repeated chapter names", () => {
    // Two chapters sharing a name must stay separately addressable.
    assert.deepEqual(assignSlugs(["Setup", "Setup", "Setup"]), ["setup", "setup-2", "setup-3"]);
  });

  test("falls back for a title with no usable characters", () => {
    assert.deepEqual(assignSlugs(["***"]), ["chapter"]);
  });
});

describe("sceneDurations", () => {
  test("each scene runs until the next one", () => {
    assert.deepEqual(sceneDurations([0, 1000, 3000], 4000), [1000, 2000, 1000]);
  });

  test("the last scene runs to the end of the recording", () => {
    assert.deepEqual(sceneDurations([0, 2000], 10_000), [2000, 8000]);
  });

  test("enforces a readable floor", () => {
    // Two scenes 50ms apart would otherwise flash past during autoplay.
    const d = sceneDurations([0, 50], 100);
    assert.ok(d.every((v) => v >= 600));
  });

  test("never returns a negative duration when the end precedes the last scene", () => {
    const d = sceneDurations([0, 5000], 1000);
    assert.ok(d.every((v) => v >= 600));
  });

  test("handles a single scene", () => {
    assert.deepEqual(sceneDurations([0], 3000), [3000]);
  });

  test("handles no scenes", () => {
    assert.deepEqual(sceneDurations([], 3000), []);
  });
});
