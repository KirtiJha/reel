import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { dipColor, endFades, fadeAt, fadeSvg, type FadeCue } from "../src/polish/fade.js";
import { sliceSpans } from "../src/encode/cut.js";
import { specSchema } from "../src/spec/schema.js";

const cue = (over: Partial<FadeCue> = {}): FadeCue => ({
  from: 0,
  to: 1000,
  color: "#101010",
  kind: "dip",
  ...over,
});

describe("fadeAt", () => {
  test("a dip goes down and back up inside its window", () => {
    const c = [cue({ from: 1000, to: 2000 })];
    assert.equal(fadeAt(c, 1000), null, "starts clear");
    assert.ok(Math.abs(fadeAt(c, 1500)!.alpha - 1) < 0.001, "fully covered in the middle");
    assert.equal(fadeAt(c, 2000), null, "ends clear");
  });

  test("a dip is clear outside its window", () => {
    const c = [cue({ from: 1000, to: 2000 })];
    assert.equal(fadeAt(c, 500), null);
    assert.equal(fadeAt(c, 3000), null);
  });

  test("a fade-in starts covered and clears", () => {
    const c = [cue({ from: 0, to: 700, kind: "in" })];
    assert.ok(Math.abs(fadeAt(c, 0)!.alpha - 1) < 0.001);
    assert.ok(Math.abs(fadeAt(c, 350)!.alpha - 0.5) < 0.01);
    assert.equal(fadeAt(c, 700), null);
  });

  test("a fade-out ends covered and stays that way", () => {
    // The regression: past its end a fade-out stopped applying, so the picture
    // popped back on the very last frame — the encoder holds a closing tail
    // past the demo's own duration, which no mid-film measurement catches.
    const c = [cue({ from: 1000, to: 1900, kind: "out" })];
    assert.equal(fadeAt(c, 900), null);
    assert.ok(Math.abs(fadeAt(c, 1450)!.alpha - 0.5) < 0.01);
    assert.equal(fadeAt(c, 1900)!.alpha, 1);
    assert.equal(fadeAt(c, 5000)!.alpha, 1, "still out, long after");
  });

  test("a fade-in holds covered before it begins", () => {
    const c = [cue({ from: 500, to: 1000, kind: "in" })];
    assert.equal(fadeAt(c, 0)!.alpha, 1);
  });

  test("the darkest of overlapping fades wins", () => {
    // A dip running into a closing fade-out must never brighten in the middle
    // of going dark.
    const c = [
      cue({ from: 0, to: 1000, kind: "dip" }),
      cue({ from: 400, to: 1400, kind: "out" }),
    ];
    const at = fadeAt(c, 900)!;
    const dip = 1 - Math.abs(900 / 1000 - 0.5) * 2;
    assert.ok(at.alpha >= dip);
  });

  test("a zero-length cue is ignored rather than dividing by zero", () => {
    assert.equal(fadeAt([cue({ from: 500, to: 500 })], 500), null);
  });

  test("nothing on screen means nothing composited", () => {
    assert.equal(fadeAt([], 100), null);
  });
});

describe("endFades", () => {
  test("ramps up at the start and down at the end", () => {
    const out = endFades({ fadeIn: 700, fadeOut: 900, color: "#000" }, 10_000);
    assert.deepEqual(out.map((f) => f.kind), ["in", "out"]);
    assert.deepEqual([out[0]!.from, out[0]!.to], [0, 700]);
    assert.deepEqual([out[1]!.from, out[1]!.to], [9100, 10_000]);
  });

  test("asks for nothing when nothing was asked for", () => {
    assert.deepEqual(endFades({ color: "#000" }, 10_000), []);
    assert.deepEqual(endFades({ fadeIn: 0, fadeOut: 0, color: "#000" }, 10_000), []);
  });

  test("a fade longer than the demo is clamped, not started before it", () => {
    const out = endFades({ fadeIn: 5000, fadeOut: 9000, color: "#000" }, 2000);
    assert.equal(out[0]!.to, 2000);
    assert.equal(out[1]!.from, 0);
  });
});

describe("dipColor", () => {
  test("a solid background is used as-is", () => {
    assert.equal(dipColor("#0b0b0f"), "#0b0b0f");
  });

  test("a gradient dips to its first colour", () => {
    // A gradient is not a valid SVG fill: librsvg quietly falls back to black,
    // so this worked by accident until somebody set a solid background.
    assert.equal(dipColor("linear-gradient(135deg, #2b3a67, #1a1f36)"), "#2b3a67");
  });

  test("a gradient with no parseable colour still yields something valid", () => {
    assert.equal(dipColor("linear-gradient(in oklch, foo, bar)"), "#000000");
  });
});

describe("fadeSvg", () => {
  test("covers the whole canvas at the given opacity", () => {
    const svg = fadeSvg({ color: "#101010", alpha: 0.5 }, 800, 600);
    assert.match(svg, /width="800"/);
    assert.match(svg, /fill="#101010"/);
    assert.match(svg, /fill-opacity="0\.5000"/);
  });

  test("a colour cannot break out of the attribute", () => {
    assert.ok(!fadeSvg({ color: '"/><script>x', alpha: 1 }, 10, 10).includes("<script>"));
  });
});

describe("fades through a cut", () => {
  test("a fade is a span, so a cut clips it like any other", () => {
    const [out] = sliceSpans([cue({ from: 500, to: 3000, kind: "out" })], {
      startMs: 1000,
      endMs: 2000,
    });
    assert.deepEqual([out!.from, out!.to], [0, 1000]);
  });
});

describe("the transition step", () => {
  const parse = (transition: unknown) =>
    specSchema.parse({ steps: [{ transition }], output: { html: "o/d.html" } }).steps[0] as {
      transition: Record<string, unknown> | number;
    };

  test("a bare number is the duration", () => {
    assert.equal(parse(600).transition, 600);
  });

  test("the object form defaults to a fade", () => {
    const t = parse({}) as { transition: Record<string, unknown> };
    assert.equal(t.transition.kind, "fade");
    assert.equal(t.transition.ms, 500);
  });

  test("kinds that need two shots are refused, not accepted and ignored", () => {
    // A wipe or a push has to move between two pictures, and a recording is one
    // continuous stream. Accepting the word and rendering a fade would be worse
    // than saying so.
    assert.throws(() => parse({ kind: "wipe" }));
    assert.throws(() => parse({ kind: "push" }));
  });
});

describe("the fade options", () => {
  test("default to off, so no existing demo changes", () => {
    const spec = specSchema.parse({ steps: [{ click: "#a" }], output: { html: "o/d.html" } });
    assert.equal(spec.polish.fadeIn, 0);
    assert.equal(spec.polish.fadeOut, 0);
  });
});
