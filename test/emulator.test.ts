import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TerminalEmulator } from "../src/terminal/emulator.js";

const term = (cols = 20, rows = 5) => new TerminalEmulator(cols, rows);

describe("text output", () => {
  test("writes plain text", () => {
    const t = term();
    t.write("hello");
    assert.equal(t.text(), "hello");
  });

  test("newline moves down, carriage return moves to column 0", () => {
    const t = term();
    t.write("one\ntwo");
    assert.equal(t.text(), "one\ntwo");
    t.write("\rTWO");
    assert.equal(t.text(), "one\nTWO");
  });

  test("carriage return alone lets a progress line overwrite itself", () => {
    // The single most common thing a CLI demo does.
    const t = term();
    t.write("Progress:  10%\rProgress: 100%");
    assert.equal(t.text(), "Progress: 100%");
  });

  test("backspace erases leftward", () => {
    const t = term();
    t.write("abc\b\bX");
    assert.equal(t.text(), "aXc");
  });

  test("tab advances to the next 8-column stop", () => {
    const t = term();
    t.write("ab\tc");
    assert.equal(t.text(), "ab      c");
  });

  test("wraps at the right margin", () => {
    const t = term(5, 3);
    t.write("abcdefg");
    assert.equal(t.text(), "abcde\nfg");
  });

  test("scrolls once output passes the last row", () => {
    const t = term(10, 2);
    t.write("one\ntwo\nthree");
    assert.equal(t.text(), "two\nthree");
  });

  test("ignores the bell", () => {
    const t = term();
    t.write("a\x07b");
    assert.equal(t.text(), "ab");
  });
});

describe("colours and attributes", () => {
  test("applies a basic foreground colour to following text", () => {
    const t = term();
    t.write("\x1b[31mred\x1b[0m plain");
    const spans = t.spans()[0]!;
    assert.equal(spans[0]!.text, "red");
    assert.ok(spans[0]!.style.fg);
    assert.equal(spans[1]!.style.fg, undefined);
  });

  test("reset clears every attribute", () => {
    const t = term();
    t.write("\x1b[1;4;31mx\x1b[0my");
    const spans = t.spans()[0]!;
    assert.equal(spans[0]!.style.bold, true);
    assert.equal(spans[0]!.style.underline, true);
    assert.deepEqual(spans[1]!.style, {});
  });

  test("bare ESC[m is a reset", () => {
    const t = term();
    t.write("\x1b[1mbold\x1b[mplain");
    assert.equal(t.spans()[0]![1]!.style.bold, undefined);
  });

  test("supports 256-colour and truecolour", () => {
    const t = term();
    t.write("\x1b[38;5;208mo\x1b[38;2;18;52;86mt");
    const spans = t.spans()[0]!;
    assert.match(spans[0]!.style.fg!, /^#[0-9a-f]{6}$/);
    assert.equal(spans[1]!.style.fg, "#123456");
  });

  test("individual attribute resets don't clear the others", () => {
    const t = term();
    t.write("\x1b[1;4mx\x1b[24my");
    const spans = t.spans()[0]!;
    assert.equal(spans[0]!.style.underline, true);
    assert.equal(spans[1]!.style.bold, true, "bold survives an underline reset");
    assert.equal(spans[1]!.style.underline, false);
  });

  test("groups equal styles into one span", () => {
    const t = term();
    t.write("\x1b[32mabc");
    assert.equal(t.spans()[0]!.length, 1);
  });
});

describe("cursor and erase", () => {
  test("absolute positioning", () => {
    const t = term(10, 3);
    t.write("\x1b[2;3HX");
    assert.equal(t.text(), "\n  X");
  });

  test("relative cursor moves", () => {
    const t = term(10, 3);
    t.write("abc\x1b[2Dx");
    assert.equal(t.text(), "axc");
  });

  test("erase to end of line", () => {
    const t = term();
    t.write("abcdef\x1b[4G\x1b[K");
    assert.equal(t.text(), "abc");
  });

  test("erase whole display resets the cursor home", () => {
    const t = term();
    t.write("junk\neverywhere\x1b[2JX");
    assert.equal(t.text(), "X");
  });

  test("clamps out-of-range positioning instead of corrupting the grid", () => {
    const t = term(5, 2);
    t.write("\x1b[99;99HX");
    assert.equal(t.cursor().y, 1);
    assert.ok(t.cursor().x <= 5);
  });
});

describe("robustness", () => {
  test("an escape split across chunks is not printed as text", () => {
    // Output arrives in arbitrary chunks; a sequence can straddle the boundary.
    const t = term();
    t.write("a\x1b[3");
    t.write("1mred");
    assert.equal(t.text(), "ared");
    assert.ok(t.spans()[0]![1]!.style.fg);
  });

  test("consumes OSC sequences rather than printing them", () => {
    const t = term();
    t.write("\x1b]0;window title\x07done");
    assert.equal(t.text(), "done");
  });

  test("consumes an OSC terminated by ST", () => {
    const t = term();
    t.write("\x1b]8;;http://x\x1b\\link");
    assert.equal(t.text(), "link");
  });

  test("ignores unknown CSI finals without dropping text", () => {
    const t = term();
    t.write("\x1b[?25la\x1b[?25hb");
    assert.equal(t.text(), "ab");
  });

  test("reset clears the screen and the cursor", () => {
    const t = term();
    t.write("\x1b[31mstuff");
    t.reset();
    assert.equal(t.text(), "");
    assert.deepEqual(t.cursor(), { x: 0, y: 0 });
  });
});
