import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { indexHtml } from "../src/compose/project.js";
import { cardScene, shotScene, HANDOFF, type SceneFrame } from "../src/compose/scenes.js";
import { lookFor } from "../src/scene/looks.js";
import type { ShotManifest } from "../src/shoot/manifest.js";

const frame = { width: 1920, height: 1080 };
const accent = "#e2584d";

function frames(): SceneFrame[] {
  // Overlapping exactly as `compose` lays them out: each scene starts a handoff
  // before the previous one ends, which is the window the crossfade lives in.
  const at = [0, 3.4 - HANDOFF, 3.4 - HANDOFF + 2.6 - HANDOFF];
  return [
    { id: "sc00", src: "a.html", at: at[0]!, duration: 3.4, scene: "Title", title: "Title", poster: 1, transitionIn: "cut" },
    { id: "sc01", src: "b.html", at: at[1]!, duration: 2.6, scene: "Chapter", title: "Chapter", poster: 1, transitionIn: "flash" },
    { id: "sc02", src: "c.html", at: at[2]!, duration: 6, scene: "Shot", title: "Shot", poster: 1, transitionIn: "dissolve" },
  ];
}

function index(lookName: "aurora" | "coral" | "swiss" = "swiss"): string {
  const f = frames();
  const last = f[f.length - 1]!;
  return indexHtml(f, lookFor(lookName === "coral" ? "editorial" : lookName), {
    id: "film",
    ...frame,
    fps: 60,
    duration: last.at + last.duration,
  });
}

const manifest: ShotManifest = {
  version: 1,
  spec: "demo.reel.yaml",
  name: "TaskFlow",
  footage: "media/shot.mp4",
  width: 1440,
  height: 900,
  fps: 60,
  duration: 6,
  beats: [
    { t: 0, label: "start" },
    { t: 4, label: "click" },
  ],
  captions: [{ t: 0.5, text: "Add a task" }],
  sfx: [],
  narration: [],
};

describe("scene sub-compositions never animate their own exit", () => {
  // Their rule, quoted in `transitionTweens`: "exit animations are BANNED except
  // on the final scene — the transition IS the exit". A scene that fades itself
  // out and is followed by one fading itself in is a jump cut with a dip, which
  // is what this used to ship.
  const card = cardScene({
    id: "sc00",
    look: lookFor("swiss"),
    accent,
    frame,
    duration: 3.4,
    headline: "Reel",
    subtitle: "Demos as code",
  });
  const shot = shotScene({
    id: "sc02",
    look: lookFor("swiss"),
    accent,
    frame,
    shot: manifest,
    footage: "media/shot.mp4",
    fit: 0.92,
    drift: 0.05,
    punch: 0.06,
    punchHold: 1.5,
    punchGap: 3.5,
  });

  for (const [what, html, life] of [["a card", card, 3.4], ["a shot", shot, 6]] as const) {
    test(`${what} never fades #root`, () => {
      const roots = html.match(/tl\.\w+\("#root"[^)]*\)/g) ?? [];
      assert.deepEqual(roots, [], `${what} animates its own root: ${roots.join(", ")}`);
    });

    test(`${what} holds full opacity at its last frame`, () => {
      // Anything that does fade — the lower thirds are furniture, not the scene
      // — must land before the handoff window opens, or it reads as a self-exit.
      for (const m of html.matchAll(/tl\.to\("([^"]+)", \{ opacity: 0[^}]*duration: ([\d.]+)[^}]*\}, ([\d.]+)\)/g)) {
        const end = Number(m[2]) + Number(m[3]);
        assert.ok(
          end < life - HANDOFF,
          `${m[1]} fades to nothing at ${end.toFixed(2)}s, inside the handoff`,
        );
      }
    });
  }
});

describe("the index writes both halves of every seam", () => {
  test("each scene after the first has a paired handoff", () => {
    const html = index();
    for (const [i, f] of frames().entries()) {
      if (i === 0) continue;
      const prev = frames()[i - 1]!;
      assert.match(
        html,
        new RegExp(`tl\\.to\\("#scene-${prev.id}", \\{ filter: "blur`),
        `${prev.id} never leaves`,
      );
      assert.match(
        html,
        new RegExp(`tl\\.fromTo\\("#scene-${f.id}", \\{ filter: "blur`),
        `${f.id} never arrives`,
      );
    }
  });

  test("the two halves start within a beat of each other", () => {
    // A crossfade whose halves are seconds apart is two fades, not a transition.
    const html = index();
    const at = (kind: string): { at: number }[] =>
      html
        .split("\n")
        .filter((l) => l.includes(`tl.${kind}("#scene-`) && l.includes("blur"))
        // The start time is the last argument on the line.
        .map((l) => ({ at: Number(/,\s*([\d.]+)\);\s*$/.exec(l)?.[1]) }));
    const outs = at("to");
    const ins = at("fromTo");
    assert.equal(outs.length, ins.length);
    assert.ok(outs.length > 0, "no seams at all");
    for (const [i, o] of outs.entries()) {
      assert.ok(Math.abs(o.at - ins[i]!.at) <= 0.2, "the halves drifted apart");
    }
  });

  test("every departure ends with a hard kill on the clip boundary", () => {
    // Without it a seek that lands past the fade gets whatever the tween last
    // wrote rather than the resolved state — their `gsap_exit_missing_hard_kill`.
    const html = index();
    for (const f of frames().slice(0, -1)) {
      assert.match(html, new RegExp(`tl\\.set\\("#scene-${f.id}", \\{ opacity: 0 \\}`));
    }
  });

  test("the last scene is never faded out", () => {
    const html = index();
    const last = frames()[frames().length - 1]!;
    assert.ok(!html.includes(`tl.to("#scene-${last.id}", { filter:`), "the film dips at the end");
  });
});

describe("the seam flash", () => {
  test("only fires where the storyboard asked for one", () => {
    const html = index();
    // Counting the rise only; every flash is a pair, up then back to nothing.
    const flashes = [...html.matchAll(/tl\.to\("#flash", \{ opacity: 0\.\d+,/g)];
    assert.equal(flashes.length, frames().filter((f) => f.transitionIn === "flash").length);
  });

  test("flashes away from the ground rather than into it", () => {
    // White at a cut reads as overexposure on a dark film. On a cream one it has
    // no contrast to spend and only blows the frame out, so a light look dips to
    // its ink instead — the same edit read the other way up.
    assert.match(index("aurora"), /#flash \{[^}]*background: #ffffff/);
    const light = lookFor("swiss");
    assert.equal(light.dark, false);
    assert.match(index("swiss"), new RegExp(`#flash \\{[^}]*background: ${light.ink}`));
  });
});
