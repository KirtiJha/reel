import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemble, mark, status, writeAssembly, type Assembly } from "../src/compose/assembly.js";
import { frameBlocks, mediaTags, roleMd, writePackets, PACKET_DIR, SHOT_DIR } from "../src/compose/packets.js";
import { parseStoryboard } from "../src/compose/storyboard.js";
import type { ShotManifest } from "../src/shoot/manifest.js";

const ASSEMBLY: Assembly = {
  version: 1,
  id: "taskflow",
  width: 1920,
  height: 1080,
  fps: 30,
  look: { ground: "#f5f1ea", ink: "#141210", dark: false, display: "Bebas Neue", label: "Inter" },
  lookName: "coral",
  accent: "#6d8bff",
  music: { file: "media/bed.wav", level: 0.55, duckAt: [{ at: 1, dur: 2 }, { at: 40, dur: 2 }] },
};

const BOARD = `---
format: 1920x1080
duration: 20.0s
message: Filmed, not drawn.
---

# TaskFlow

## Frame 1 — Title

- status: built
- src: compositions/frames/sc00-title.html
- duration: 3.400s
- transition_in: cut
- scene: Opening card
- poster: 1.20

## Frame 2 — Footage

- status: animated
- src: compositions/frames/sc01-shot.html
- duration: 14.000s
- transition_in: crossfade
- scene: Real footage
- poster: 2.00
- voiceover: Add a task and it lands.

## Frame 3 — Close

- status: built
- src: compositions/frames/sc02-outro.html
- duration: 2.800s
- transition_in: crossfade
- scene: Closing card
- poster: 1.00
`;

const SHOT: ShotManifest = {
  version: 1,
  spec: "demo.reel.yaml",
  name: "TaskFlow",
  footage: "shot.mp4",
  width: 1440,
  height: 900,
  fps: 60,
  duration: 14,
  beats: [{ t: 0.95, label: "hero" }, { t: 10.4, label: "added" }],
  captions: [{ t: 0, text: "Capture work in a snap" }],
  sfx: [{ t: 3.15, kind: "click" }, { t: 3.15, kind: "type", ms: 1.08 }],
  narration: [{ t: 0, text: "Add a task and it lands.", ms: 2.1 }],
};

let dir = "";

async function project(board = BOARD): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "reel-authoring-"));
  await mkdir(join(d, ".hyperframes"), { recursive: true });
  await mkdir(join(d, SHOT_DIR), { recursive: true });
  await mkdir(join(d, "compositions/frames"), { recursive: true });
  await writeAssembly(d, ASSEMBLY);
  await writeFile(join(d, "STORYBOARD.md"), board);
  await writeFile(join(d, SHOT_DIR, "sc01-shot.json"), JSON.stringify(SHOT));
  await writeFile(
    join(d, "compositions/frames/sc01-shot.html"),
    `<template><div id="root" data-composition-id="sc01-shot">
      <video id="sc01-shot-v" src="media/footage-0.mp4" data-start="0" data-duration="14"></video>
      <audio id="sc01-shot-a" src="media/sfx-0.wav" data-start="0" data-duration="14"></audio>
    </div></template>`,
  );
  return d;
}

before(async () => {
  dir = await project();
});

describe("assemble rebuilds the host from the storyboard", () => {
  test("lays the scenes out overlapping by the handoff", async () => {
    const res = await assemble(dir);
    const html = await readFile(res.index, "utf8");
    // 3.4 + 14 + 2.8, less two 0.5s handoffs.
    assert.equal(res.duration, 19.2);
    assert.equal(res.frames, 3);
    assert.match(html, /data-start="0\.000" data-duration="3\.400"/);
    assert.match(html, /data-start="2\.900" data-duration="14\.000"/);
    assert.match(html, /data-start="16\.400" data-duration="2\.800"/);
  });

  test("a retimed scene moves everything after it", async () => {
    // The point of the whole layer: an author changes one duration in the plan
    // and the running order, the seams and the bed all follow.
    const d = await project(BOARD.replace("duration: 3.400s", "duration: 5.000s"));
    const res = await assemble(d);
    assert.equal(res.duration, 20.8);
    const html = await readFile(res.index, "utf8");
    assert.match(html, /data-start="4\.500" data-duration="14\.000"/);
  });

  test("derives each scene's id from its filename, not a second field", async () => {
    // Their contract makes the id, the timeline key and the file name one
    // string; storing it twice is how they drift apart.
    const html = await readFile(join(dir, "index.html"), "utf8");
    assert.match(html, /id="scene-sc00-title" data-composition-id="sc00-title"/);
  });

  test("counts the scenes still awaiting a pass", async () => {
    assert.equal((await assemble(dir)).scaffold, 2);
  });

  test("drops ducking that fell off the end of a shortened cut", async () => {
    // The spans were measured in the old cut's time. One past the new end would
    // duck the bed and never bring it back, which is audible.
    const html = await readFile(join(dir, "index.html"), "utf8");
    assert.match(html, /tl\.to\("#bed", \{ volume: 0\.138/); // the 1s span survives
    assert.ok(!html.includes(", 39.65)"), "the 40s duck outlived the 19.2s cut");
  });

  test("refuses a frame with no src rather than mounting nothing", async () => {
    const d = await project("## Frame 1 — X\n\n- duration: 3s\n");
    await assert.rejects(() => assemble(d), /has no .src:./);
  });

  test("refuses a frame with no duration", async () => {
    const d = await project("## Frame 1 — X\n\n- src: a.html\n");
    await assert.rejects(() => assemble(d), /has no .duration:./);
  });

  test("warns about a scene too short to hold its own seam", async () => {
    const d = await project(BOARD.replace("duration: 3.400s", "duration: 0.400s"));
    const res = await assemble(d);
    assert.ok(res.warnings.some((w) => /handoff/.test(w)), res.warnings.join("; "));
  });

  test("says so plainly when there is no project", async () => {
    const d = await mkdtemp(join(tmpdir(), "reel-empty-"));
    await assert.rejects(() => assemble(d), /No assembly sidecar/);
  });
});

describe("status reports the pass", () => {
  test("counts what has been authored against the total", async () => {
    const s = await status(dir);
    assert.equal(s.total, 3);
    assert.equal(s.animated, 1);
    assert.deepEqual(s.frames.map((f) => f.authored), [false, true, false]);
  });
});

describe("mark promotes scenes as their authors return", () => {
  test("promotes the frames named and reports one that is not there", async () => {
    const d = await project();
    const res = await mark(d, [1, 9], "animated");
    assert.deepEqual(res.marked, [1]);
    assert.deepEqual(res.missing, [9]);
    assert.equal((await status(d)).animated, 2); // frame 2 was already animated
  });

  test("demotes too, for a scene sent back for another pass", async () => {
    const d = await project();
    await mark(d, [2], "built");
    assert.equal((await status(d)).animated, 0);
  });

  test("leaves the author's own writing untouched", async () => {
    // The reason it edits one bullet rather than regenerating: by the time the
    // pass runs, the prose in a frame block is the most valuable thing in it.
    const d = await project(BOARD.replace("- poster: 1.20", "- poster: 1.20\n\nCut hard on the beat."));
    await mark(d, [1], "animated");
    assert.match(await readFile(join(d, "STORYBOARD.md"), "utf8"), /Cut hard on the beat\./);
  });

  test("says so plainly when there is no project", async () => {
    const d = await mkdtemp(join(tmpdir(), "reel-empty-"));
    await assert.rejects(() => mark(d, [1], "animated"), /No STORYBOARD\.md/);
  });
});

describe("packets", () => {
  test("cuts one per scene still awaiting a pass, and skips the rest", async () => {
    const res = await writePackets(dir);
    assert.deepEqual(res.packets, [
      `${PACKET_DIR}/sc00-title.md`,
      `${PACKET_DIR}/sc02-outro.md`,
    ]);
    assert.equal(res.skipped, 1);
  });

  test("--all re-cuts an authored scene too", async () => {
    assert.equal((await writePackets(dir, { all: true })).packets.length, 3);
  });

  test("a footage packet carries the driver's exact timings", async () => {
    // The half no HyperFrames workflow can write: these were recorded at the
    // instant the driver caused them, and cannot be recovered by eye.
    await writePackets(dir, { all: true });
    const p = await readFile(join(dir, PACKET_DIR, "sc01-shot.md"), "utf8");
    assert.match(p, /`0\.95s` — hero/);
    assert.match(p, /`10\.40s` — added/);
    assert.match(p, /`3\.15s` — type over 1\.08s/);
    assert.match(p, /Capture work in a snap/);
  });

  test("a footage packet inlines the media tags verbatim", async () => {
    // The one mistake in the pass that fails silently: a re-typed src renders a
    // black rectangle and passes lint.
    await writePackets(dir, { all: true });
    const p = await readFile(join(dir, PACKET_DIR, "sc01-shot.md"), "utf8");
    assert.match(p, /<video id="sc01-shot-v" src="media\/footage-0\.mp4"/);
    assert.match(p, /<audio id="sc01-shot-a" src="media\/sfx-0\.wav"/);
  });

  test("a card packet says it is a card and carries no shot facts", async () => {
    await writePackets(dir, { all: true });
    const p = await readFile(join(dir, PACKET_DIR, "sc00-title.md"), "utf8");
    assert.match(p, /A card, not footage/);
    assert.ok(!p.includes("what the driver recorded"));
  });

  test("every packet carries its own block and no sibling's", async () => {
    // The bound is the point: N authors work at once, and a packet that leaked
    // the whole storyboard would let each one redesign the others' scenes.
    await writePackets(dir, { all: true });
    const p = await readFile(join(dir, PACKET_DIR, "sc00-title.md"), "utf8");
    assert.match(p, /## Frame 1 — Title/);
    assert.ok(!p.includes("## Frame 2 — Footage"));
    assert.ok(!p.includes("## Frame 3 — Close"));
  });

  test("the packet states the duration as fixed", async () => {
    await writePackets(dir, { all: true });
    const p = await readFile(join(dir, PACKET_DIR, "sc00-title.md"), "utf8");
    assert.match(p, /3\.40s — \*\*fixed\*\*/);
  });

  test("writes the role beside them", async () => {
    const res = await writePackets(dir, { all: true });
    assert.equal(res.role, `${PACKET_DIR}/_role.md`);
    assert.equal(await readFile(join(dir, res.role), "utf8"), roleMd());
  });
});

describe("the role states the rules that fail silently", () => {
  const role = roleMd();
  // Each of these was a real render failure before it was a rule. A worker that
  // breaks one gets no error — just a scene that is wrong in the MP4.
  for (const [what, pattern] of [
    ["the template transport rule", /only the contents of `<template>`/],
    ["styling the root by #root", /never a class on it/],
    ["the id being one string in three places", /One string, three places/],
    ["the ban on exits", /Never author an exit/],
    ["the ban on fetching", /Never fetch/],
    ["one tween per property", /One tween per property per element/],
    ["never fading an arrival", /Never fade an arrival/],
    ["not cropping the footage", /object-fit: contain/],
  ] as const) {
    test(what, () => assert.match(role, pattern));
  }
});

describe("frameBlocks", () => {
  test("slices the storyboard into one verbatim block per frame", () => {
    const blocks = frameBlocks(BOARD, 3);
    assert.equal(blocks.length, 3);
    assert.ok(blocks[0]!.startsWith("## Frame 1 — Title"));
    assert.ok(blocks[1]!.includes("voiceover: Add a task and it lands."));
    assert.ok(!blocks[0]!.includes("Frame 2"));
  });

  test("keeps prose an author added below the metadata", () => {
    // Verbatim rather than re-rendered from the parse: by the time the pass
    // runs, the prose is the most valuable thing in the block.
    const blocks = frameBlocks("## Frame 1 — X\n\n- src: a.html\n\nThe idea here is a hard cut.\n", 1);
    assert.ok(blocks[0]!.includes("The idea here is a hard cut."));
  });
});

describe("mediaTags", () => {
  test("returns nothing for a file that is not there", async () => {
    assert.deepEqual(await mediaTags(join(dir, "nope.html")), []);
  });
});
