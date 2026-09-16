import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildBranches } from "../src/encode/html.js";
import type { Scene } from "../src/encode/html.js";

const choice = (id: string, paths: [string, string][], defaultIdx = 0): Partial<Scene> => ({
  branch: {
    id,
    prompt: "Pick",
    paths: paths.map(([pid, label], i) => ({ id: pid, label, isDefault: i === defaultIdx })),
  },
});

describe("buildBranches", () => {
  test("finds nothing in a linear demo", () => {
    assert.deepEqual(buildBranches([{}, {}, {}]), []);
  });

  test("collects the scenes belonging to each path", () => {
    const scenes = [
      {},
      choice("b1", [["b1:a", "A"], ["b1:b", "B"]]),
      { path: "b1:a" },
      { path: "b1:a" },
      { path: "b1:b" },
      {},
    ] as Scene[];
    const [b] = buildBranches(scenes);
    assert.equal(b!.atScene, 1);
    assert.deepEqual(b!.paths[0]!.scenes, [2, 3]);
    assert.deepEqual(b!.paths[1]!.scenes, [4]);
  });

  test("rejoins at the first scene belonging to no path", () => {
    // Every path has to lead back to the shared continuation.
    const scenes = [
      choice("b1", [["b1:a", "A"], ["b1:b", "B"]]),
      { path: "b1:a" },
      { path: "b1:b" },
      { label: "shared ending" },
    ] as Scene[];
    assert.equal(buildBranches(scenes)[0]!.rejoinScene, 3);
  });

  test("a branch at the very end has nothing to rejoin", () => {
    const scenes = [
      choice("b1", [["b1:a", "A"], ["b1:b", "B"]]),
      { path: "b1:a" },
      { path: "b1:b" },
    ] as Scene[];
    assert.equal(buildBranches(scenes)[0]!.rejoinScene, null);
  });

  test("handles two branches in one demo", () => {
    const scenes = [
      choice("b1", [["b1:a", "A"], ["b1:b", "B"]]),
      { path: "b1:a" },
      { path: "b1:b" },
      { label: "middle" },
      choice("b2", [["b2:x", "X"], ["b2:y", "Y"]]),
      { path: "b2:x" },
      { path: "b2:y" },
      { label: "end" },
    ] as Scene[];
    const bs = buildBranches(scenes);
    assert.equal(bs.length, 2);
    assert.equal(bs[0]!.rejoinScene, 3);
    assert.equal(bs[1]!.rejoinScene, 7);
    assert.deepEqual(bs[1]!.paths[0]!.scenes, [5]);
  });

  test("carries the default flag through to the player", () => {
    const scenes = [
      choice("b1", [["b1:a", "A"], ["b1:b", "B"]], 1),
      { path: "b1:a" },
      { path: "b1:b" },
    ] as Scene[];
    const [b] = buildBranches(scenes);
    assert.equal(b!.paths.find((p) => p.isDefault)!.id, "b1:b");
  });

  test("a path with no recorded scenes is reported, not dropped", () => {
    // Better an empty path the player can skip than a silently missing choice.
    const scenes = [
      choice("b1", [["b1:a", "A"], ["b1:b", "B"]]),
      { path: "b1:a" },
    ] as Scene[];
    const [b] = buildBranches(scenes);
    assert.equal(b!.paths.length, 2);
    assert.deepEqual(b!.paths[1]!.scenes, []);
  });
});
