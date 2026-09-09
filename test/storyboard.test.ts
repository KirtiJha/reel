import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseStoryboard, setStatus } from "../src/compose/storyboard.js";
import { storyboardMd } from "../src/compose/project.js";
import type { SceneFrame } from "../src/compose/scenes.js";

const SAMPLE = `---
format: 1920x1080
duration: 41.5s
message: Reel films the real app.
arc: Title → Product → Close
mode: autonomous
budget: none of their business
---

# TaskFlow

Prose about the film.

## Frame 1 — Title

- status: animated
- src: compositions/frames/sc00-title.html
- duration: 3.40s
- transition_in: cut
- scene: Opening card
- poster: 1.20
- blueprint: waterfall-hero

Open cold on the promise.

- this bullet is prose, not a field

## Frame 2 — Footage

- status: built
- src: compositions/frames/sc01-shot.html
- duration: 14s
- vo: "Add a task and it lands."
`;

describe("parseStoryboard", () => {
  const sb = parseStoryboard(SAMPLE);

  test("reads the global direction", () => {
    assert.equal(sb.globals.format, "1920x1080");
    assert.equal(sb.globals.message, "Reel films the real app.");
    assert.equal(sb.globals.mode, "autonomous");
  });

  test("keeps unknown frontmatter rather than dropping it", () => {
    assert.equal(sb.globals.extra["budget"], "none of their business");
  });

  test("finds every frame, in order, with its title", () => {
    assert.equal(sb.frames.length, 2);
    assert.deepEqual(sb.frames.map((f) => f.title), ["Title", "Footage"]);
    assert.deepEqual(sb.frames.map((f) => f.index), [1, 2]);
  });

  test("reads the fields the assembler needs", () => {
    const [title] = sb.frames;
    assert.equal(title!.status, "animated");
    assert.equal(title!.src, "compositions/frames/sc00-title.html");
    assert.equal(title!.duration, 3.4);
    assert.equal(title!.transitionIn, "cut");
    assert.equal(title!.poster, 1.2);
  });

  test("accepts the format's aliases", () => {
    // `vo:` is their alias for voiceover, and a quoted value is unquoted.
    assert.equal(sb.frames[1]!.voiceover, "Add a task and it lands.");
  });

  test("keeps a workflow's own per-frame keys", () => {
    assert.equal(sb.frames[0]!.extra["blueprint"], "waterfall-hero");
  });

  test("a bullet after the prose starts is prose", () => {
    // Otherwise a list inside the narrative silently becomes metadata, and an
    // author cannot write "- pick one of these" without inventing a field.
    assert.ok(sb.frames[0]!.narrative.includes("this bullet is prose"));
    assert.equal(sb.frames[0]!.extra["this"], undefined);
  });

  test("keeps the narrative below the metadata", () => {
    assert.ok(sb.frames[0]!.narrative.startsWith("Open cold on the promise."));
  });
});

describe("parseStoryboard is lenient", () => {
  test("never throws on a file that is not a storyboard at all", () => {
    const sb = parseStoryboard("# Hello\n\nJust some notes.\n");
    assert.deepEqual(sb.frames, []);
  });

  test("an unreadable duration is a warning, not a failure", () => {
    const sb = parseStoryboard("## Frame 1 — X\n\n- duration: soon\n");
    assert.equal(sb.frames.length, 1);
    assert.equal(sb.frames[0]!.duration, undefined);
    assert.equal(sb.warnings.length, 1);
  });

  test("an unknown status reads as outline and says so", () => {
    const sb = parseStoryboard("## Frame 1 — X\n\n- status: gorgeous\n");
    assert.equal(sb.frames[0]!.status, "outline");
    assert.match(sb.warnings[0]!.message, /gorgeous/);
  });

  test("misnumbered headings are reported rather than trusted", () => {
    const sb = parseStoryboard("## Frame 1 — A\n\n## Frame 3 — B\n");
    assert.equal(sb.frames.length, 2);
    assert.match(sb.warnings[0]!.message, /out of order/);
  });

  test("a frame with no status at all defaults to outline", () => {
    assert.equal(parseStoryboard("## Frame 1 — X\n").frames[0]!.status, "outline");
  });

  test("accepts Beat and Scene headings at H2 or H3", () => {
    const sb = parseStoryboard("### Beat 1 — A\n\n## Scene 2 — B\n");
    assert.deepEqual(sb.frames.map((f) => f.title), ["A", "B"]);
  });
});

describe("what compose writes, parse reads back", () => {
  // The round trip is the contract: assemble rebuilds the host from this file,
  // so a field compose writes and the parser drops is a scene that silently
  // loses its place in the cut.
  const frames: SceneFrame[] = [
    { id: "sc00", src: "compositions/frames/sc00.html", at: 0, duration: 3.4, scene: "Card", title: "Title", poster: 1.2, transitionIn: "cut" },
    { id: "sc01", src: "compositions/frames/sc01.html", at: 2.9, duration: 14, scene: "Shot", title: "Footage", poster: 2, transitionIn: "crossfade", voiceover: "A line." },
  ];
  const md = storyboardMd(frames, {
    name: "TaskFlow",
    width: 1920,
    height: 1080,
    duration: 20.3,
    message: "Filmed, not drawn.",
  });
  const sb = parseStoryboard(md);

  test("every scene survives the round trip", () => {
    assert.equal(sb.frames.length, frames.length);
    for (const [i, f] of frames.entries()) {
      const got = sb.frames[i]!;
      assert.equal(got.src, f.src);
      assert.equal(got.duration, f.duration);
      assert.equal(got.transitionIn, f.transitionIn);
      assert.equal(got.title, f.title);
      assert.equal(got.poster, f.poster);
    }
  });

  test("it parses without a single warning", () => {
    assert.deepEqual(sb.warnings, []);
  });

  test("a generated scene is built, never animated", () => {
    // `animated` is a claim about authorship. compose generates; it does not
    // author, and marking its own output animated is what let the pass be
    // skipped without anyone noticing.
    assert.deepEqual(sb.frames.map((f) => f.status), ["built", "built"]);
  });
});

describe("setStatus", () => {
  test("promotes one frame and leaves the rest alone", () => {
    const out = parseStoryboard(setStatus(SAMPLE, 2, "animated"));
    assert.deepEqual(out.frames.map((f) => f.status), ["animated", "animated"]);
  });

  test("changes exactly one line and nothing else", () => {
    // The whole point of editing the line rather than regenerating the file:
    // the narrative, the shot sequence and the direction block are the author's.
    const before = SAMPLE.split("\n");
    const after = setStatus(SAMPLE, 2, "animated").split("\n");
    assert.equal(after.length, before.length);
    const changed = before.filter((l, i) => l !== after[i]);
    assert.deepEqual(changed, ["- status: built"]);
  });

  test("adds the bullet when the frame has no status", () => {
    const out = setStatus("## Frame 1 — X\n\n- src: a.html\n", 1, "animated");
    assert.equal(parseStoryboard(out).frames[0]!.status, "animated");
    assert.ok(out.includes("- src: a.html"));
  });

  test("a frame that does not exist changes nothing", () => {
    const src = "## Frame 1 — X\n\n- status: built\n";
    assert.equal(setStatus(src, 9, "animated"), src);
  });
});
