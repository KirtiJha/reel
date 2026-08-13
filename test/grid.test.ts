import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  findTextRegion,
  regionToRect,
  tailRegion,
  type CellMetrics,
} from "../src/terminal/grid.js";
import { TerminalEmulator } from "../src/terminal/emulator.js";

/** A grid whose origin is offset, so a bug that ignores padding shows up. */
const m: CellMetrics = { originX: 16, originY: 48, cellW: 9, cellH: 20 };
const COLS = 80;

describe("regionToRect", () => {
  test("a single row is one cell tall, starting at that row", () => {
    const r = regionToRect({ row0: 3, row1: 3 }, m, COLS);
    assert.equal(r.y, 48 + 3 * 20);
    assert.equal(r.h, 20);
  });

  test("an inclusive row range covers every row in it", () => {
    const r = regionToRect({ row0: 2, row1: 5 }, m, COLS);
    assert.equal(r.h, 4 * 20, "rows 2,3,4,5 is four rows tall");
  });

  test("spans the full width when no columns are given", () => {
    const r = regionToRect({ row0: 0, row1: 0 }, m, COLS);
    assert.equal(r.x, 16);
    assert.equal(r.w, COLS * 9);
  });

  test("starts at the grid origin, not the element corner", () => {
    const r = regionToRect({ row0: 0, row1: 0 }, m, COLS);
    assert.equal(r.x, m.originX);
    assert.equal(r.y, m.originY);
  });

  test("a column range narrows the rect without moving the rows", () => {
    const r = regionToRect({ row0: 1, row1: 1, col0: 10, col1: 20 }, m, COLS);
    assert.equal(r.x, 16 + 10 * 9);
    assert.equal(r.w, 10 * 9);
    assert.equal(r.y, 48 + 20);
  });

  test("clamps columns to the grid so an over-wide region can't escape it", () => {
    const r = regionToRect({ row0: 0, row1: 0, col0: 0, col1: 500 }, m, COLS);
    assert.equal(r.w, COLS * 9);
  });

  test("tolerates a reversed row range", () => {
    const r = regionToRect({ row0: 7, row1: 2 }, m, COLS);
    assert.equal(r.y, 48 + 2 * 20);
    assert.equal(r.h, 6 * 20);
  });
});

describe("tailRegion", () => {
  test("leaves a region that already fits alone", () => {
    const r = tailRegion({ row0: 2, row1: 6 }, 12);
    assert.deepEqual(r, { row0: 2, row1: 6 });
  });

  test("keeps the newest rows when output is taller than the shot", () => {
    const r = tailRegion({ row0: 0, row1: 39 }, 10);
    assert.equal(r.row1, 39, "the last line printed stays in frame");
    assert.equal(r.row0, 30);
  });

  test("preserves the column range while trimming rows", () => {
    const r = tailRegion({ row0: 0, row1: 30, col0: 4, col1: 20 }, 5);
    assert.equal(r.col0, 4);
    assert.equal(r.col1, 20);
  });
});

describe("findTextRegion", () => {
  const screen = ["~/reel $ npm test", "", "  ok 202 passing", "  0 failing"].join("\n");

  test("finds the row holding the text", () => {
    assert.deepEqual(findTextRegion(screen, "202 passing"), { row0: 2, row1: 2 });
  });

  test("returns null for text that isn't on screen", () => {
    assert.equal(findTextRegion(screen, "nope"), null);
  });

  test("returns null for an empty needle rather than matching everything", () => {
    assert.equal(findTextRegion(screen, ""), null);
  });

  test("spans the rows a multi-line match covers", () => {
    const r = findTextRegion(screen, "ok 202 passing\n  0 failing");
    assert.deepEqual(r, { row0: 2, row1: 3 });
  });

  test("matches the first occurrence when text repeats", () => {
    const dup = ["done", "working", "done"].join("\n");
    assert.deepEqual(findTextRegion(dup, "done"), { row0: 0, row1: 0 });
  });
});

describe("emulator scroll accounting", () => {
  test("does not scroll while output fits on screen", () => {
    const emu = new TerminalEmulator(20, 5);
    emu.write("a\nb\n");
    assert.equal(emu.scrollCount(), 0);
  });

  test("counts one scroll per row pushed off the top", () => {
    const emu = new TerminalEmulator(20, 3);
    emu.write("1\n2\n3\n4\n5\n");
    // Three rows of capacity, five newlines written: the first two scrolled off.
    assert.equal(emu.scrollCount(), 3);
  });

  test("a row noted before the output can be re-based onto where it is now", () => {
    const emu = new TerminalEmulator(20, 4);
    emu.write("prompt\n"); // command starts on row 0
    const startRow = 0;
    const before = emu.scrollCount();

    emu.write("a\nb\nc\nd\ne\n"); // long enough to scroll

    const shifted = emu.scrollCount() - before;
    const rebased = Math.max(0, startRow - shifted);
    assert.equal(rebased, 0, "a row scrolled off the top clamps to the first visible row");
    assert.ok(shifted > 0, "this output must actually scroll for the test to mean anything");
  });
});
