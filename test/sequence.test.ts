import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  cardWindows,
  countTodo,
  hasTodo,
  renderSequence,
  shotWindows,
  videoDirection,
} from "../src/compose/sequence.js";
import { lookFor } from "../src/scene/looks.js";
import type { ShotManifest } from "../src/shoot/manifest.js";

function shot(over: Partial<ShotManifest> = {}): ShotManifest {
  return {
    version: 1,
    spec: "demo.reel.yaml",
    name: "TaskFlow",
    footage: "footage.mp4",
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 15.34,
    beats: [
      { t: 0.95, label: "hero" },
      { t: 10.44, label: "added" },
      { t: 14.04, label: "done" },
    ],
    captions: [
      { t: 0, text: "Capture work in a snap" },
      { t: 5.93, text: "Add as many as you like" },
      { t: 11.74, text: "Click a task to complete it" },
    ],
    sfx: [
      { t: 3.15, kind: "click" },
      { t: 3.15, kind: "type", ms: 1.08 },
      { t: 7.78, kind: "click" },
    ],
    narration: [],
    ...over,
  };
}

describe("shotWindows", () => {
  test("opens a window at each spoken cue", () => {
    const w = shotWindows(shot());
    assert.equal(w.length, 3);
    assert.deepEqual(w.map((x) => [x.from, x.to]), [[0, 5.93], [5.93, 11.74], [11.74, 15.34]]);
  });

  test("the windows tile the whole shot with no gap", () => {
    // A gap is a stretch of film nobody was asked to direct.
    const w = shotWindows(shot());
    assert.equal(w[0]!.from, 0);
    assert.equal(w[w.length - 1]!.to, 15.34);
    for (const [i, x] of w.slice(1).entries()) assert.equal(x.from, w[i]!.to);
  });

  test("each window carries the beats and sounds that land inside it", () => {
    const w = shotWindows(shot());
    assert.deepEqual(w[0]!.beats.map((b) => b.label), ["hero"]);
    assert.deepEqual(w[1]!.beats.map((b) => b.label), ["added"]);
    assert.deepEqual(w[2]!.beats.map((b) => b.label), ["done"]);
    assert.equal(w[0]!.sfx.length, 2);
    assert.equal(w[1]!.sfx.length, 1);
  });

  test("narration wins over captions when the demo actually speaks", () => {
    // Their rule is that reveals are paced to the voiceover, so where a line is
    // spoken beats where a caption was scheduled.
    const w = shotWindows(shot({
      narration: [
        { t: 0, text: "Spoken one" },
        { t: 8, text: "Spoken two" },
      ],
    }));
    assert.equal(w.length, 2);
    assert.equal(w[1]!.from, 8);
    assert.equal(w[0]!.cue, "Spoken one");
  });

  test("a cue at zero names the opening window rather than being dropped", () => {
    assert.equal(shotWindows(shot())[0]!.cue, "Capture work in a snap");
  });

  test("folds cues too close together into one phase", () => {
    // Reel's captions can land a second apart. One window each would be a
    // sequence nobody can direct — a phase has to be long enough to hold an idea.
    const w = shotWindows(shot({
      captions: [
        { t: 0, text: "a" },
        { t: 0.4, text: "b" },
        { t: 0.8, text: "c" },
        { t: 6, text: "d" },
      ],
    }));
    assert.equal(w.length, 2);
    assert.deepEqual(w.map((x) => x.from), [0, 6]);
  });

  test("does not open a window with no room left to be a phase", () => {
    const w = shotWindows(shot({ captions: [{ t: 0, text: "a" }, { t: 15.1, text: "b" }] }));
    assert.equal(w.length, 1);
    assert.equal(w[0]!.to, 15.34);
  });

  test("a silent shot with no captions is still one whole window", () => {
    const w = shotWindows(shot({ captions: [], narration: [] }));
    assert.equal(w.length, 1);
    assert.deepEqual([w[0]!.from, w[0]!.to], [0, 15.34]);
    assert.equal(w[0]!.cue, undefined);
  });
});

describe("cardWindows", () => {
  test("a card long enough gets arrive, develop, hold", () => {
    // Their rule: a shot arrives, develops, and ends on a held read.
    const w = cardWindows(3.4);
    assert.equal(w.length, 3);
    assert.equal(w[0]!.from, 0);
    assert.equal(w[2]!.to, 3.4);
  });

  test("a short card collapses the final reveal and the hold into one window", () => {
    assert.equal(cardWindows(2.6).length, 2);
  });

  test("the windows tile the card with no gap", () => {
    const w = cardWindows(3.4);
    for (const [i, x] of w.slice(1).entries()) assert.equal(x.from, w[i]!.to);
  });
});

describe("renderSequence", () => {
  const seq = renderSequence(shotWindows(shot()), "shot");

  test("writes their shape — one Scene line per window, in real seconds", () => {
    const lines = seq.split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0]!, /^Scene 1 \(0\.00–5\.93s\):/);
    assert.match(lines[2]!, /^Scene 3 \(11\.74–15\.34s\):/);
  });

  test("states the recorded facts rather than guessing at direction", () => {
    // A plausible-sounding line nobody wrote is worse than a blank: it reads as
    // a decision and gets built.
    assert.match(seq, /cue: “Capture work in a snap”/);
    assert.match(seq, /beat `hero` at 0\.95s/);
    assert.match(seq, /type 3\.15–4\.23s/);
  });

  test("leaves every direction unwritten, and says so the same way each time", () => {
    assert.equal(countTodo(seq), 3);
    assert.ok(hasTodo(seq));
  });

  test("the last window asks for a held read, not another reveal", () => {
    const lines = seq.split("\n");
    assert.match(lines[2]!, /what has resolved, and what holds still/);
    assert.match(lines[0]!, /what is on screen, what moves/);
  });

  test("a card sequence says what each window is for", () => {
    const card = renderSequence(cardWindows(3.4), "card");
    assert.match(card, /the arrival/);
    assert.match(card, /the development/);
    assert.match(card, /a held read beats bad motion/);
  });
});

describe("countTodo", () => {
  test("counts only unwritten direction lines, not the word elsewhere", () => {
    const written = "Scene 1 (0.00–2.00s): the strip enters from the left and settles.";
    assert.equal(countTodo(written), 0);
    assert.equal(countTodo(`${written}\n\nA note mentioning TODO in prose.`), 0);
    assert.ok(!hasTodo(written));
  });

  test("counts a partly authored scene honestly", () => {
    const seq = renderSequence(cardWindows(3.4), "card").split("\n");
    seq[0] = "Scene 1 (0.00–0.95s): the band opens from a hairline, centred.";
    assert.equal(countTodo(seq.join("\n")), 2);
  });
});

describe("videoDirection", () => {
  const block = videoDirection(lookFor("swiss"), "#6d8bff");

  test("is written once and names itself as such", () => {
    assert.match(block, /^## Video direction/);
    assert.match(block, /Written once/);
  });

  test("carries the look's own tokens rather than inventing any", () => {
    const look = lookFor("swiss");
    assert.ok(block.includes(look.ground));
    assert.ok(block.includes(look.ink));
    assert.ok(block.includes("#6d8bff"));
  });

  test("states both motion failure modes by name", () => {
    // Their negative list. Naming them is what makes them avoidable.
    assert.match(block, /slideshow \(front-load then freeze\)/);
    assert.match(block, /screensaver/);
  });

  test("states the rules that bind independent scenes into one film", () => {
    for (const rule of [/Palette/, /Motion grammar/, /Reveal model/, /Held reads/, /Seams belong/]) {
      assert.match(block, rule);
    }
  });
});
