import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { specSchema, isBranch, defaultPath, trunkSteps, type Step } from "../src/spec/schema.js";

function parse(steps: unknown[]) {
  return specSchema.parse({ steps, output: { html: "out/d.html" } }).steps;
}

const twoPaths = {
  branch: {
    prompt: "What do you want to see?",
    paths: [
      { label: "Add a task", steps: [{ click: "#add" }] },
      { label: "Complete one", steps: [{ click: "#done" }, { caption: "done" }] },
    ],
  },
};

describe("branch grammar", () => {
  test("parses a branch with labelled paths", () => {
    const steps = parse([{ goto: "/" }, twoPaths]);
    const b = steps[1]!;
    assert.ok(isBranch(b));
    assert.equal(b.branch.paths.length, 2);
    assert.equal(b.branch.paths[0]!.label, "Add a task");
  });

  test("requires at least two paths — one path is not a choice", () => {
    const r = specSchema.safeParse({
      steps: [{ branch: { paths: [{ label: "only", steps: [{ click: "#a" }] }] } }],
      output: { html: "d.html" },
    });
    assert.equal(r.success, false);
  });

  test("requires each path to do something", () => {
    const r = specSchema.safeParse({
      steps: [{ branch: { paths: [{ label: "a", steps: [] }, { label: "b", steps: [] }] } }],
      output: { html: "d.html" },
    });
    assert.equal(r.success, false);
  });

  test("rejects a nested branch rather than silently ignoring it", () => {
    // v1 records a tree one level deep; nesting would multiply trunk replays.
    const r = specSchema.safeParse({
      steps: [
        {
          branch: {
            paths: [
              { label: "a", steps: [twoPaths] },
              { label: "b", steps: [{ click: "#b" }] },
            ],
          },
        },
      ],
      output: { html: "d.html" },
    });
    assert.equal(r.success, false);
  });

  test("supplies a default prompt", () => {
    const steps = parse([{ branch: { paths: twoPaths.branch.paths } }]);
    assert.ok(isBranch(steps[0]!));
    assert.equal((steps[0] as any).branch.prompt, "Choose a path");
  });
});

describe("defaultPath", () => {
  test("falls back to the first path", () => {
    const steps = parse([twoPaths]);
    const b = steps[0]!;
    assert.ok(isBranch(b));
    assert.equal(defaultPath(b.branch).label, "Add a task");
  });

  test("honours an explicit default", () => {
    const steps = parse([
      {
        branch: {
          paths: [
            { label: "first", steps: [{ click: "#a" }] },
            { label: "second", default: true, steps: [{ click: "#b" }] },
          ],
        },
      },
    ]);
    const b = steps[0]!;
    assert.ok(isBranch(b));
    assert.equal(defaultPath(b.branch).label, "second");
  });
});

describe("trunkSteps", () => {
  test("returns the steps before the index", () => {
    const steps = parse([{ goto: "/" }, { caption: "hi" }, { click: "#a" }]);
    assert.equal(trunkSteps(steps, 2).length, 2);
  });

  test("collapses an earlier branch to its default path", () => {
    // A later branch's alternates must sit on the same trunk the video shows.
    const steps = parse([{ goto: "/" }, twoPaths, { caption: "after" }]);
    const trunk = trunkSteps(steps, 2);
    assert.deepEqual(trunk, [{ goto: "/" }, { click: "#add" }]);
  });

  test("is empty at the very start", () => {
    assert.deepEqual(trunkSteps(parse([{ goto: "/" }]), 0), []);
  });

  test("never contains a branch", () => {
    const steps = parse([twoPaths, twoPaths, { caption: "end" }]) as Step[];
    assert.ok(!trunkSteps(steps, 3).some((s) => isBranch(s as Step)));
  });
});
