import { test, describe } from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";
import { direct, nameIn } from "../src/direct/direct.js";
import {
  findSteps,
  insertSteps,
  moveStep,
  stepLine,
  verifyInsertion,
  verifyReorder,
} from "../src/direct/apply.js";
import { safeName } from "../src/media/assets.js";
import { spokenTextOf } from "../src/narrate/spoken.js";
import { specSchema, type Step } from "../src/spec/schema.js";

const steps = (s: unknown[]) =>
  specSchema.parse({ steps: s, output: { html: "out/d.html" } }).steps as Step[];

describe("nameIn", () => {
  test("reads the words out of a selector", () => {
    // The whole trick: a selector is not opaque. Reading the name back out is
    // what lets a sentence be matched to an element without a model.
    assert.equal(nameIn("text=Ship the Reel demo"), "Ship the Reel demo");
    assert.equal(nameIn("role=button[name=Add]"), "Add");
    assert.equal(nameIn("#task-input"), "task input");
    assert.equal(nameIn("[data-testid=user-menu]"), "user menu");
  });

  test("splits camelCase and snake_case ids into words", () => {
    assert.equal(nameIn("#userMenu"), "user menu");
    assert.equal(nameIn("#user_menu"), "user menu");
  });

  test("a class or a CSS path names nothing anyone would say", () => {
    // Matching on structure produces proposals nobody asked for.
    assert.equal(nameIn(".btn-primary"), null);
    assert.equal(nameIn("div > ul li:nth-child(2)"), null);
  });

  test("takes the last half of a scoped selector", () => {
    assert.equal(nameIn("#sidebar >> text=Settings"), "Settings");
  });
});

describe("direct", () => {
  test("marks the element a line is about", () => {
    const out = direct(
      steps([
        { click: "text=Ship the Reel demo" },
        { say: "Ship the Reel demo is now complete." },
        { beat: "done" },
      ]),
    );
    assert.equal(out.length, 1);
    assert.deepEqual(out[0]!.step, {
      highlight: { selector: "text=Ship the Reel demo", until: "done" },
    });
    assert.match(out[0]!.because, /Ship the Reel demo/);
  });

  test("a caption counts as narration, because the driver speaks it", () => {
    // `runStep` speaks a caption's own text unless told otherwise. A proposal
    // engine that only looked for `say:` had nothing to match against on a spec
    // whose script lives in its captions — which is most of them.
    const out = direct(
      steps([{ click: "role=button[name=Publish]" }, { caption: "Publish sends it live." }]),
    );
    assert.equal(out.length, 1);
    assert.equal((out[0]!.step as { highlight: { selector: string } }).highlight.selector, "role=button[name=Publish]");
  });

  test("a short name has to be a whole word", () => {
    // "Add" matching "additional" is a coincidence often enough to be noise.
    const noise = direct(
      steps([{ click: "role=button[name=Add]" }, { say: "There are additional options here." }]),
    );
    assert.deepEqual(noise, []);
    const real = direct(
      steps([{ click: "role=button[name=Add]" }, { say: "Press Add and it appears." }]),
    );
    assert.equal(real.length, 1);
  });

  test("stays quiet where the author already directed", () => {
    const out = direct(
      steps([
        { click: "text=Ship the Reel demo" },
        { highlight: { selector: "text=Ship the Reel demo" } },
        { say: "Ship the Reel demo is done." },
      ]),
    );
    assert.deepEqual(out, []);
  });

  test("only looks at steps near the line", () => {
    // A selector eight steps away is not what this sentence is about.
    const far = steps([
      { click: "text=Ship the Reel demo" },
      ...Array.from({ length: 8 }, () => ({ click: "#other" })),
      { say: "Ship the Reel demo, at last." },
    ]);
    assert.deepEqual(direct(far), []);
  });

  test("opens a chapter on an establishing shot", () => {
    const out = direct(steps([{ card: "Chapter one" }, { click: "#a" }]));
    assert.equal(out.length, 1);
    assert.deepEqual(out[0]!.step, { zoom: "out" });
    assert.equal(out[0]!.index, 1);
  });

  test("does not add a wide shot where the author set the camera", () => {
    assert.deepEqual(direct(steps([{ card: "Chapter" }, { zoom: "out" }, { click: "#a" }])), []);
  });

  test("proposals come back in the order they apply", () => {
    const out = direct(
      steps([
        { card: "Chapter" },
        { click: "role=button[name=Publish]" },
        { say: "Publish sends it live." },
      ]),
    );
    for (let i = 1; i < out.length; i++) assert.ok(out[i]!.index >= out[i - 1]!.index);
  });

  test("every proposal is a step the schema accepts", () => {
    // A proposal that will not parse is worse than no proposal.
    const out = direct(
      steps([{ card: "Chapter" }, { click: "text=Ship the Reel demo" }, { say: "Ship the Reel demo." }]),
    );
    assert.ok(out.length > 0);
    assert.doesNotThrow(() =>
      specSchema.parse({ steps: out.map((d) => d.step), output: { html: "o/d.html" } }),
    );
  });
});

describe("writing direction into the spec", () => {
  const spec = [
    "name: Demo",
    "url: http://localhost:3000",
    "",
    "steps:",
    "  # the opening",
    "  - card: Chapter one",
    "  - click: text=Ship it",
    "  - say: Ship it is the button.",
    "",
    "output:",
    "  mp4: out/d.mp4",
    "",
  ].join("\n");

  test("finds the top-level items of the steps list", () => {
    const block = findSteps(spec.split("\n"))!;
    assert.equal(block.indent, 2);
    assert.equal(block.starts.length, 3);
  });

  test("stops at the next top-level key", () => {
    // Running past `output:` would insert steps into the wrong block entirely.
    const block = findSteps(spec.split("\n"))!;
    const lines = spec.split("\n");
    assert.ok(lines[block.end]!.startsWith("output:") || block.end <= lines.length);
    for (const i of block.starts) assert.match(lines[i]!, /^ {2}- /);
  });

  test("inserts at the right place and changes nothing else", () => {
    const next = insertSteps(spec, [
      { index: 1, step: { zoom: "out" }, because: "test" },
    ]);
    const before = spec.split("\n");
    const after = next.split("\n");
    assert.equal(after.length, before.length + 1);
    assert.match(after[6]!, /zoom: out/);
    // Comments and formatting survive: the point of editing text rather than
    // re-serializing is that the diff stays reviewable.
    assert.ok(next.includes("  # the opening"));
    assert.ok(next.includes("output:\n  mp4: out/d.mp4"));
  });

  test("several insertions all land where they were computed", () => {
    // Applied last-first, or an early insertion shifts every later target down
    // by one — the classic way this edit goes wrong.
    const next = insertSteps(spec, [
      { index: 0, step: { zoom: "out" }, because: "a" },
      { index: 2, step: { beat: "here" }, because: "b" },
    ]);
    const parsed = specSchema.parse(YAML.parse(next));
    assert.deepEqual(parsed.steps[0], { zoom: "out" });
    assert.equal("card" in parsed.steps[1]!, true);
    assert.equal("click" in parsed.steps[2]!, true);
    assert.deepEqual(parsed.steps[3], { beat: "here" });
  });

  test("what it writes still parses", () => {
    const parsed = specSchema.parse(
      YAML.parse(
        insertSteps(spec, [
          {
            index: 2,
            step: { highlight: { selector: "text=Ship it", until: "done" } },
            because: "test",
          },
        ]),
      ),
    );
    assert.equal(parsed.steps.length, 4);
  });

  test("a spec with no steps list is refused, not mangled", () => {
    assert.throws(() => insertSteps("name: Demo\nurl: x\n", [
      { index: 0, step: { zoom: "out" }, because: "test" },
    ]), /steps/);
  });

  test("stepLine quotes what YAML would otherwise misread", () => {
    // `#a` unquoted is a comment, which is exactly how `heal --write` once
    // destroyed a spec.
    assert.match(stepLine({ highlight: { selector: "#a" } }, 2), /"#a"/);
  });
});

describe("verifyInsertion", () => {
  const a = { click: "#a" };
  const b = { click: "#b" };

  test("accepts a clean insertion", () => {
    assert.doesNotThrow(() => verifyInsertion([a, b], [a, { zoom: "out" }, b], 1));
  });

  test("refuses a changed step count", () => {
    assert.throws(() => verifyInsertion([a, b], [a, b], 1), /changed the demo/);
  });

  test("refuses when an original step went missing", () => {
    // The guard that `heal --write` bought: whatever is produced is compared
    // against what was intended before it goes near disk.
    assert.throws(
      () => verifyInsertion([a, b], [a, { zoom: "out" }, { click: "#changed" }], 1),
      /already there/,
    );
  });
});

describe("spokenTextOf", () => {
  test("a caption speaks its own text", () => {
    assert.equal(spokenTextOf({ caption: "On screen." } as never), "On screen.");
    assert.equal(spokenTextOf({ caption: { text: "On screen." } } as never), "On screen.");
  });

  test("an explicit line beats the caption text", () => {
    assert.equal(
      spokenTextOf({ caption: { text: "Short.", say: "Something better for the ear." } } as never),
      "Something better for the ear.",
    );
  });

  test("`say: false` keeps a caption silent", () => {
    assert.equal(spokenTextOf({ caption: { text: "On screen.", say: false } } as never), undefined);
  });

  test("a card is silent unless given a line", () => {
    // A title read aloud sounds like a title.
    assert.equal(spokenTextOf({ card: { title: "Chapter" } } as never), undefined);
    assert.equal(spokenTextOf({ card: { title: "Chapter", say: "Here we go." } } as never), "Here we go.");
  });
});

describe("moveStep", () => {
  const spec = [
    "name: Demo",
    "steps:",
    "  - click: '#one'",
    "  - say: |",
    "      a multi-line",
    "      spoken block",
    "  - click: '#three'",
    "",
    "output:",
    "  mp4: out/d.mp4",
    "",
  ].join("\n");

  const stepsOf = (raw: string) =>
    (YAML.parse(raw) as { steps: Record<string, unknown>[] }).steps;

  test("moves a step down", () => {
    const out = stepsOf(moveStep(spec, 0, 2));
    assert.deepEqual(Object.keys(out[2]!), ["click"]);
    assert.equal(out[2]!.click, "#one");
  });

  test("moves a step up", () => {
    const out = stepsOf(moveStep(spec, 2, 0));
    assert.equal(out[0]!.click, "#three");
  });

  test("carries a multi-line step whole", () => {
    // A step is a *range* of lines, not one line. Moving only the `- ` marker
    // would leave the block behind and produce a spec that means something else.
    const out = stepsOf(moveStep(spec, 1, 0));
    assert.match(String(out[0]!.say), /multi-line/);
    assert.match(String(out[0]!.say), /spoken block/);
    assert.equal(out.length, 3);
  });

  test("a downward move lands where the drag let go", () => {
    // Recomputed against the list with the step already removed. Adjusting the
    // old index by hand lands one place short on every downward move.
    const out = stepsOf(moveStep(spec, 0, 1));
    assert.equal(out[0]!.say !== undefined, true);
    assert.equal(out[1]!.click, "#one");
  });

  test("moving a step to its own place changes nothing", () => {
    assert.equal(moveStep(spec, 1, 1), spec);
  });

  test("keeps the rest of the file intact", () => {
    const out = moveStep(spec, 0, 2);
    assert.ok(out.includes("name: Demo"));
    assert.ok(out.includes("output:\n  mp4: out/d.mp4"));
  });

  test("refuses an index that does not exist", () => {
    assert.throws(() => moveStep(spec, 0, 9), /there are 3/);
    assert.throws(() => moveStep(spec, -1, 0), /there are 3/);
  });
});

describe("verifyReorder", () => {
  const a = { click: "#a" };
  const b = { click: "#b" };

  test("accepts a pure reorder", () => {
    assert.doesNotThrow(() => verifyReorder([a, b], [b, a]));
  });

  test("refuses a step that changed", () => {
    assert.throws(() => verifyReorder([a, b], [b, { click: "#c" }]), /more than the order/);
  });

  test("refuses a step that vanished or doubled", () => {
    assert.throws(() => verifyReorder([a, b], [a]), /more than the order/);
    assert.throws(() => verifyReorder([a, b], [a, b, b]), /more than the order/);
  });
});

describe("safeName", () => {
  test("keeps a sensible name", () => {
    assert.equal(safeName("architecture.png"), "architecture.png");
  });

  test("a dropped name cannot escape the directory", () => {
    // A browser upload carries whatever the file was called, and
    // `../../.ssh/id_rsa` is a file name too.
    assert.equal(safeName("../../etc/passwd.png"), "passwd.png");
    assert.equal(safeName("/abs/path/logo.svg"), "logo.svg");
    assert.equal(safeName("..\\..\\win.png"), "win.png");
  });

  test("refuses what a render could not show anyway", () => {
    assert.throws(() => safeName("payload.exe"), /not an image/);
    assert.throws(() => safeName("script.svg.sh"), /not an image/);
  });

  test("never produces an empty stem", () => {
    // The punctuation strip can eat a whole name; the file still needs one.
    assert.equal(safeName("---.png"), "asset.png");
    assert.equal(safeName("!!!.png"), "asset.png");
  });

  test("a bare dotfile is not an image name", () => {
    // `extname(".png")` is "" — a leading dot makes it a dotfile, not a PNG.
    assert.throws(() => safeName(".png"), /not an image/);
  });
});
