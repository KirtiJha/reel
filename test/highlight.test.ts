import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_HIGHLIGHT_MS,
  highlightsAt,
  highlightSvg,
  resolveHighlights,
  type HighlightCue,
} from "../src/polish/highlight.js";
import { sliceSpans } from "../src/encode/cut.js";
import { specSchema, type Step } from "../src/spec/schema.js";
import { describeStep, stepSelector, withStepSelector } from "../src/heal/selectors.js";

const full = { x: 0, y: 0, w: 1000, h: 500 };
const box = { x: 100, y: 100, w: 200, h: 50 };

function cue(over: Partial<HighlightCue> = {}): HighlightCue {
  return { from: 0, to: 4000, rect: box, shape: "box", style: "drawn", ...over };
}

describe("resolveHighlights", () => {
  test("ends the span at the beat it names", () => {
    const [out] = resolveHighlights(
      [cue({ from: 1000, to: 1000 + DEFAULT_HIGHLIGHT_MS, untilBeat: "dish" })],
      [{ label: "dish", t: 9000 }],
      20000,
    );
    assert.equal(out!.to, 9000);
    assert.equal(out!.untilBeat, undefined, "the unresolved marker is dropped");
  });

  test("ignores a beat of the same name that already passed", () => {
    // The annotation cannot end before it began; an earlier beat with the same
    // label belongs to a previous chapter.
    const [out] = resolveHighlights(
      [cue({ from: 5000, to: 7600, untilBeat: "step" })],
      [
        { label: "step", t: 1000 },
        { label: "step", t: 12000 },
      ],
      20000,
    );
    assert.equal(out!.to, 12000);
  });

  test("runs to the end when the beat never happened", () => {
    // A branch not taken, or a typo. Too long is visible and fixable; silently
    // never appearing is not.
    const [out] = resolveHighlights([cue({ untilBeat: "nope" })], [], 15000);
    assert.equal(out!.to, 15000);
  });

  test("leaves a plain `ms` span alone", () => {
    const input = cue({ from: 200, to: 2800 });
    assert.deepEqual(resolveHighlights([input], [{ label: "x", t: 900 }], 9000), [input]);
  });
});

describe("highlightsAt", () => {
  test("is on screen only inside its span", () => {
    const c = [cue({ from: 1000, to: 3000 })];
    assert.equal(highlightsAt(c, 999).length, 0);
    assert.equal(highlightsAt(c, 2000).length, 1);
    assert.equal(highlightsAt(c, 3000).length, 0, "the end is exclusive");
  });

  test("fades in and out rather than hard-cutting", () => {
    const c = [cue({ from: 0, to: 4000 })];
    assert.ok(highlightsAt(c, 10)[0]!.alpha < 0.2);
    assert.equal(highlightsAt(c, 2000)[0]!.alpha, 1);
    assert.ok(highlightsAt(c, 3950)[0]!.alpha < 0.4);
  });

  test("a very short span still fades both ends", () => {
    // Naively subtracting a fixed fade would start the fade-out before the
    // fade-in finished, and the annotation would never reach full opacity in a
    // sensible place.
    const c = [cue({ from: 0, to: 200 })];
    for (const t of [10, 100, 190]) {
      const a = highlightsAt(c, t)[0]!;
      assert.ok(a.alpha >= 0 && a.alpha <= 1, `alpha out of range at ${t}`);
    }
    assert.ok(highlightsAt(c, 100)[0]!.alpha > highlightsAt(c, 10)[0]!.alpha);
  });

  test("draws the stroke on, then holds it", () => {
    const c = [cue({ from: 0, to: 4000 })];
    assert.ok(highlightsAt(c, 100)[0]!.draw < 0.5);
    assert.equal(highlightsAt(c, 3000)[0]!.draw, 1);
  });

  test("several can be on screen at once", () => {
    const c = [cue({ from: 0, to: 4000 }), cue({ from: 500, to: 2000, shape: "circle" })];
    assert.equal(highlightsAt(c, 1000).length, 2);
  });
});

describe("highlightSvg", () => {
  const active = (t: number, c = [cue()]) => highlightsAt(c, t);

  test("draws nothing when nothing is up", () => {
    assert.equal(highlightSvg([], full, 1000, 500, "#fff"), "");
  });

  test("maps the box through the camera", () => {
    // The whole point of drawing in content space: a crop half the width puts
    // the annotation at twice the scale.
    const wide = highlightSvg(active(2000), full, 1000, 500, "#6d8bff");
    const tight = highlightSvg(active(2000), { x: 50, y: 50, w: 500, h: 250 }, 1000, 500, "#6d8bff");
    assert.notEqual(wide, tight);
    assert.ok(wide.includes("<path"), "something was actually drawn");
    assert.ok(tight.includes("<path"));
  });

  test("skips an annotation the camera has moved away from", () => {
    const off = highlightSvg(active(2000), { x: 5000, y: 5000, w: 400, h: 200 }, 1000, 500, "#fff");
    assert.equal(off, "");
  });

  test("is a pure function of its input", () => {
    // The one property this file must not lose: the hand-drawn wobble is seeded
    // from the geometry, so two renders of one spec produce identical bytes.
    // Math.random() here would break byte-identical output.
    const once = highlightSvg(active(1200), full, 1000, 500, "#6d8bff");
    const twice = highlightSvg(active(1200), full, 1000, 500, "#6d8bff");
    assert.equal(once, twice);
  });

  test("different geometry wobbles differently", () => {
    const a = highlightSvg(active(2000, [cue()]), full, 1000, 500, "#fff");
    const b = highlightSvg(
      active(2000, [cue({ rect: { x: 400, y: 220, w: 260, h: 90 } })]),
      full,
      1000,
      500,
      "#fff",
    );
    assert.notEqual(a, b);
  });

  test("every shape and style renders a path", () => {
    for (const shape of ["box", "circle", "underline"] as const) {
      for (const style of ["drawn", "clean"] as const) {
        const svg = highlightSvg(active(2000, [cue({ shape, style })]), full, 1000, 500, "#fff");
        assert.ok(svg.includes("<path"), `${shape}/${style} drew nothing`);
        assert.ok(!svg.includes("NaN"), `${shape}/${style} produced NaN geometry`);
      }
    }
  });

  test("a label is escaped, not injected", () => {
    const svg = highlightSvg(
      active(2000, [cue({ label: `a <b> & "c"` })]),
      full,
      1000,
      500,
      "#fff",
    );
    assert.ok(!svg.includes("<b>"), "raw markup reached the SVG");
    assert.ok(svg.includes("&lt;b&gt;"));
  });

  test("the label holds off until the stroke has landed", () => {
    const early = highlightSvg(active(60, [cue({ label: "hi" })]), full, 1000, 500, "#fff");
    const late = highlightSvg(active(2000, [cue({ label: "hi" })]), full, 1000, 500, "#fff");
    assert.ok(!early.includes("hi"), "the words arrive before the shape does");
    assert.ok(late.includes("hi"));
  });
});

describe("the highlight step", () => {
  const parse = (highlight: unknown) =>
    specSchema.parse({ steps: [{ highlight }], output: { html: "out/d.html" } }).steps[0] as {
      highlight: Record<string, unknown>;
    };

  test("a bare selector gets sensible direction", () => {
    const { highlight: h } = parse({ selector: "#count" });
    assert.equal(h.shape, "box");
    assert.equal(h.style, "drawn");
    assert.equal(h.ms, DEFAULT_HIGHLIGHT_MS);
  });

  test("`until` is carried through", () => {
    const { highlight: h } = parse({ selector: "#count", until: "pricing", shape: "circle" });
    assert.equal(h.until, "pricing");
    assert.equal(h.shape, "circle");
  });

  test("an unknown shape or style is refused rather than guessed at", () => {
    // `arrow` and `pointer` are in the design but not implemented, and a schema
    // that accepted a value the renderer cannot draw would be worse than one
    // that says so.
    assert.throws(() => parse({ selector: "#a", shape: "arrow" }));
    assert.throws(() => parse({ selector: "#a", style: "sketchy" }));
  });

  test("a selector is required", () => {
    assert.throws(() => parse({ shape: "box" }));
    assert.throws(() => parse({ selector: "" }));
  });

  test("self-healing can read and repair it", () => {
    // A highlight targets an element, so UI drift breaks it exactly as it
    // breaks a click — and `reel heal` has to be able to swap the selector.
    const step = parse({ selector: "#old", label: "here" }) as unknown as Step;
    assert.equal(stepSelector(step), "#old");
    const fixed = withStepSelector(step, "#new") as { highlight: { selector: string } };
    assert.equal(fixed.highlight.selector, "#new");
    assert.match(describeStep(step), /#old/);
  });
});

describe("sliceSpans", () => {
  const range = { startMs: 1000, endMs: 5000 };

  test("keeps a span that straddles the in point", () => {
    // The case `sliceTimeline` cannot express: an annotation that went up
    // before the cut opens and comes down after it has no `t` inside the range
    // at all, yet is on screen for every frame of the cut.
    const [out] = sliceSpans([cue({ from: 200, to: 9000 })], range);
    assert.equal(out!.from, 0);
    assert.equal(out!.to, 4000, "clipped to the out point and rebased");
  });

  test("rebases a span fully inside", () => {
    const [out] = sliceSpans([cue({ from: 2000, to: 3000 })], range);
    assert.deepEqual([out!.from, out!.to], [1000, 2000]);
  });

  test("drops spans that do not overlap", () => {
    assert.equal(sliceSpans([cue({ from: 0, to: 900 })], range).length, 0);
    assert.equal(sliceSpans([cue({ from: 5000, to: 6000 })], range).length, 0);
  });
});
