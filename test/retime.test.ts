import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildRetime, parseDuration } from "../src/polish/retime.js";

describe("parseDuration", () => {
  test("reads seconds by default", () => {
    assert.equal(parseDuration("30s"), 30_000);
    assert.equal(parseDuration("1.5s"), 1500);
  });

  test("reads explicit units", () => {
    assert.equal(parseDuration("1500ms"), 1500);
    assert.equal(parseDuration("2m"), 120_000);
  });

  test("treats a bare number as milliseconds", () => {
    assert.equal(parseDuration(2500), 2500);
  });

  test("a bare numeric string is seconds, matching the authored form", () => {
    assert.equal(parseDuration("30"), 30_000);
  });

  test("rejects nonsense rather than guessing", () => {
    for (const v of ["", "soon", "-5s", "0s", "abc123"]) {
      assert.equal(parseDuration(v), undefined, `${v} should not parse`);
    }
    assert.equal(parseDuration(undefined), undefined);
  });
});

describe("buildRetime", () => {
  test("is a no-op when nothing is requested", () => {
    const r = buildRetime([0, 1000], 2000, {});
    assert.equal(r.changed, false);
    assert.equal(r.map(750), 750);
    assert.equal(r.endMs, 2000);
  });

  test("caps an idle gap and pulls everything after it earlier", () => {
    // 0 →(5s of dead air)→ 5000 → 6000. Capping at 1s should yield 0,1000,2000.
    const r = buildRetime([0, 5000, 6000], 6000, { maxIdleMs: 1000 });
    assert.equal(r.map(0), 0);
    assert.equal(r.map(5000), 1000);
    assert.equal(r.map(6000), 2000);
    assert.equal(r.endMs, 2000);
  });

  test("leaves gaps shorter than the cap untouched", () => {
    const r = buildRetime([0, 400, 800], 800, { maxIdleMs: 1000 });
    assert.equal(r.changed, false);
  });

  test("scales to an exact target length", () => {
    const r = buildRetime([0, 5000, 10_000], 10_000, { targetMs: 5000 });
    assert.equal(r.endMs, 5000);
    assert.equal(r.map(10_000), 5000);
    assert.equal(r.map(5000), 2500);
  });

  test("stretches a short demo up to the target too", () => {
    const r = buildRetime([0, 1000], 1000, { targetMs: 4000 });
    assert.equal(r.endMs, 4000);
    assert.equal(r.map(500), 2000);
  });

  test("trims before scaling, so the target is still hit exactly", () => {
    const r = buildRetime([0, 9000, 10_000], 10_000, { maxIdleMs: 1000, targetMs: 4000 });
    assert.equal(r.endMs, 4000, "trimmed to 2000ms, then scaled onto 4000ms");
    assert.equal(r.map(10_000), 4000);
  });

  test("preserves ordering — a remap must never reorder frames", () => {
    const src = [0, 200, 5000, 5200, 9000];
    const r = buildRetime(src, 9500, { maxIdleMs: 800, targetMs: 3000 });
    const mapped = src.map((t) => r.map(t));
    for (let i = 1; i < mapped.length; i++) {
      assert.ok(mapped[i]! >= mapped[i - 1]!, `${mapped[i - 1]} → ${mapped[i]} went backwards`);
    }
  });

  test("interpolates positions that fall between frames", () => {
    // Captions and zoom keys are not frame-aligned, so they land mid-segment.
    const r = buildRetime([0, 1000], 1000, { targetMs: 2000 });
    assert.equal(r.map(500), 1000);
  });

  test("survives an empty or single-frame timeline", () => {
    assert.equal(buildRetime([], 1000, { targetMs: 500 }).changed, false);
    assert.equal(buildRetime([0], 0, { targetMs: 500 }).changed, false);
  });

  test("clamps a position past the end instead of extrapolating wildly", () => {
    const r = buildRetime([0, 1000, 2000], 2000, { maxIdleMs: 500 });
    assert.ok(r.map(9999) >= r.endMs);
  });
});
