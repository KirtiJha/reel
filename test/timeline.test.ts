import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Timeline } from "../src/driver/timeline.js";

describe("Timeline", () => {
  test("starts at zero", () => {
    assert.equal(new Timeline().now(), 0);
  });

  test("accumulates authored durations", () => {
    const t = new Timeline();
    t.advance(1000);
    t.advance(450);
    assert.equal(t.now(), 1450);
  });

  test("returns the amount actually consumed", () => {
    assert.equal(new Timeline(2).advance(1000), 500);
  });

  test("speed compresses authored time without touching the ordering", () => {
    const fast = new Timeline(2);
    fast.advance(1000);
    fast.advance(1000);
    assert.equal(fast.now(), 1000, "2× speed halves the demo");

    const slow = new Timeline(0.5);
    slow.advance(1000);
    assert.equal(slow.now(), 2000, "0.5× speed stretches it");
  });

  test("treats a zero or negative duration as no time at all", () => {
    const t = new Timeline();
    t.advance(0);
    t.advance(-500);
    assert.equal(t.now(), 0);
  });

  test("never collapses a real duration to zero at high speed", () => {
    // Frames must stay strictly ordered — a 0ms step would make two frames
    // share a timestamp and produce a zero-length concat entry.
    assert.equal(new Timeline(10).scale(5), 1);
  });

  test("advanceScaled bypasses the multiplier for pre-scaled segments", () => {
    // Synthesized motion (pan, cursor glide) scales its own duration up front
    // and must not be scaled a second time.
    const t = new Timeline(2);
    t.advanceScaled(900);
    assert.equal(t.now(), 900);
  });

  test("is a pure function of its inputs", () => {
    const a = new Timeline(1.5);
    const b = new Timeline(1.5);
    for (const ms of [450, 1300, 60, 950]) {
      a.advance(ms);
      b.advance(ms);
    }
    assert.equal(a.now(), b.now());
  });
});
