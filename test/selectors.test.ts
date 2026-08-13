import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { stepSelector, withStepSelector, describeStep } from "../src/heal/selectors.js";
import { specSchema, type Step } from "../src/spec/schema.js";

/** Parse through the schema so steps carry the same defaults heal sees. */
function step(raw: unknown): Step {
  return specSchema.parse({ steps: [raw], output: { gif: "g" } }).steps[0]!;
}

const selectorSteps: [string, unknown][] = [
  ["click", { click: "#a" }],
  ["dblclick", { dblclick: "#a" }],
  ["hover", { hover: "#a" }],
  ["scrollTo", { scrollTo: "#a" }],
  ["waitFor", { waitFor: "#a" }],
  ["type", { type: { selector: "#a", text: "hi" } }],
  ["fill", { fill: { selector: "#a", text: "hi" } }],
  ["press", { press: { selector: "#a", key: "Enter" } }],
  ["callout", { callout: { selector: "#a", text: "look" } }],
  ["expect", { expect: { selector: "#a", text: "ok" } }],
  ["scroll", { scroll: { to: "#a" } }],
  ["zoom", { zoom: { to: "#a" } }],
];

describe("stepSelector / withStepSelector", () => {
  for (const [name, raw] of selectorSteps) {
    test(`${name}: reads its selector`, () => {
      assert.equal(stepSelector(step(raw)), "#a");
    });

    test(`${name}: replaces the selector and keeps everything else`, () => {
      const original = step(raw);
      const repaired = withStepSelector(original, "#b");
      assert.equal(stepSelector(repaired), "#b", "selector was swapped");
      // Heal rewrites specs in place — losing a sibling field (typed text, the
      // key to press, a callout label) would silently corrupt the demo.
      const before = JSON.stringify(original).replace(/#a/g, "#b");
      assert.equal(JSON.stringify(repaired), before, "no sibling fields lost");
    });
  }

  test("returns null for steps that target no selector", () => {
    for (const raw of [{ goto: "/" }, { caption: "hi" }, { beat: "hero" }, { hold: 500 }]) {
      assert.equal(stepSelector(step(raw)), null);
    }
  });

  test("a bare press (no selector) targets the page, not an element", () => {
    assert.equal(stepSelector(step({ press: { key: "Enter" } })), null);
  });

  test("a numeric scroll target is an offset, not a selector", () => {
    assert.equal(stepSelector(step({ scroll: { to: 400 } })), null);
  });

  test("zoom: out is a camera direction, not a selector", () => {
    assert.equal(stepSelector(step({ zoom: "out" })), null);
  });

  test("leaves a non-selector step untouched when asked to replace", () => {
    const s = step({ caption: "hi" });
    assert.deepEqual(withStepSelector(s, "#b"), s);
  });
});

describe("describeStep", () => {
  test("describes intent, not syntax, for the repair prompt", () => {
    assert.match(describeStep(step({ click: "#save" })), /click/);
    assert.match(describeStep(step({ type: { selector: "#e", text: "hi" } })), /type "hi"/);
    assert.match(describeStep(step({ waitFor: "#done" })), /wait for/);
  });

  test("always returns something for an unrecognized step", () => {
    assert.ok(describeStep(step({ hold: 100 })).length > 0);
  });
});
