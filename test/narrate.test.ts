import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseNumbered, readScript } from "../src/commands/narrate.js";
import { specSchema, type Step } from "../src/spec/schema.js";
import { toSteps, type CaptureEvent } from "../src/authoring/steps.js";
import { OBSERVER_SCRIPT } from "../src/authoring/observe.js";

const steps = (s: unknown[]) =>
  specSchema.parse({ steps: s, output: { html: "out/d.html" } }).steps as Step[];

describe("readScript", () => {
  test("gathers every spoken line, whatever step it hangs off", () => {
    // A script is scattered through the spec by design — a line on a card here,
    // a standalone one there — and reading it as a document is the only way to
    // answer "how long is this".
    const s = steps([
      { card: { title: "Open", say: "Here is the idea." } },
      { caption: { text: "on screen", say: "A caption can speak too." } },
      { say: "A line with nothing on screen." },
      { image: { file: "a.png", say: "And a picture." } },
    ]);
    const script = readScript(s);
    assert.deepEqual(
      script.lines.map((l) => l.text),
      [
        "Here is the idea.",
        "A caption can speak too.",
        "A line with nothing on screen.",
        "And a picture.",
      ],
    );
  });

  test("counts words and estimates a duration", () => {
    const script = readScript(steps([{ say: "one two three four five six" }]));
    assert.equal(script.words, 6);
    // 6 words at 150wpm is 2.4s. The exact rate matters less than the estimate
    // moving with the text.
    assert.ok(script.estimatedMs > 2000 && script.estimatedMs < 3000);
  });

  test("a longer line estimates longer", () => {
    const short = readScript(steps([{ say: "Short." }]));
    const long = readScript(
      steps([{ say: "A considerably longer sentence with a great many more words than the first." }]),
    );
    assert.ok(long.estimatedMs > short.estimatedMs);
  });

  test("names the cards and beats that say nothing", () => {
    // Cards and beats are the moments the author already marked as moments —
    // a silent one is the useful thing to point at.
    const script = readScript(
      steps([{ card: "Opening" }, { beat: "hero" }, { click: "#a" }, { say: "Spoken." }]),
    );
    assert.deepEqual(script.silent, ["card “Opening”", "beat “hero”"]);
  });

  test("a click is never counted as needing narration", () => {
    // Narrating every click is how a demo becomes a description of itself.
    const script = readScript(steps([{ click: "#a" }, { type: { selector: "#b", text: "x" } }]));
    assert.deepEqual(script.silent, []);
  });

  test("reads narration inside branch paths", () => {
    // Every path is narration somebody will hear in the click-through.
    const script = readScript(
      steps([
        {
          branch: {
            paths: [
              { label: "a", steps: [{ say: "Down this path." }] },
              { label: "b", steps: [{ say: "Or this one." }] },
            ],
          },
        },
      ]),
    );
    assert.equal(script.lines.length, 2);
  });

  test("an empty spec is an empty script, not a crash", () => {
    const script = readScript(steps([{ click: "#a" }]));
    assert.deepEqual(script.lines, []);
    assert.equal(script.words, 0);
    assert.equal(script.estimatedMs, 0);
  });
});

describe("parseNumbered", () => {
  test("pulls the lines out in order", () => {
    assert.deepEqual(parseNumbered("1. First line.\n2. Second line.", 2), [
      "First line.",
      "Second line.",
    ]);
  });

  test("tolerates a preamble, which models add", () => {
    // Refusing the whole draft over a stray sentence would waste a call the
    // user paid for.
    assert.deepEqual(parseNumbered("Sure! Here you go:\n\n1. A line.\n", 1), ["A line."]);
  });

  test("accepts `1)` as well as `1.`", () => {
    assert.deepEqual(parseNumbered("1) A line.", 1), ["A line."]);
  });

  test("strips surrounding quotes", () => {
    assert.deepEqual(parseNumbered('1. "A quoted line."', 1), ["A quoted line."]);
  });

  test("ignores numbers past what was asked for", () => {
    assert.deepEqual(parseNumbered("1. One.\n2. Two.\n3. Three.", 2), ["One.", "Two."]);
  });
});

describe("capture writes the new step kinds", () => {
  const run = (events: CaptureEvent[]) => toSteps(events, "http://localhost:3000");

  test("a narration line becomes a `say` step", () => {
    const { steps: out } = run([
      { type: "click", candidates: [{ kind: "id", selector: "#a", matches: 1 }] },
      { type: "say", text: "This is what just happened." },
    ]);
    assert.deepEqual(out[1], { say: "This is what just happened." });
  });

  test("marking an element becomes a `highlight`, not a `click`", () => {
    // The gesture is pointing, not pressing: the click is swallowed in the page
    // so the app never acts on it.
    const { steps: out } = run([
      { type: "mark", candidates: [{ kind: "id", selector: "#count", matches: 1 }] },
    ]);
    assert.deepEqual(out, [{ highlight: { selector: "#count" } }]);
  });

  test("a mark with no nameable element is reported, not guessed at", () => {
    const { steps: out, skipped } = run([{ type: "mark", candidates: [] }]);
    assert.deepEqual(out, []);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0]!, /highlight/);
  });

  test("a mark does not count as the user having started", () => {
    // `acted` gates navigation recording. If a mark set it, the app's own boot
    // redirects would land in the spec as waits for pages the demo has not
    // navigated to yet.
    const { steps: out } = run([
      { type: "mark", candidates: [{ kind: "id", selector: "#a", matches: 1 }] },
      { type: "nav", url: "http://localhost:3000/dashboard" },
      { type: "click", candidates: [{ kind: "id", selector: "#b", matches: 1 }] },
    ]);
    assert.deepEqual(out, [{ highlight: { selector: "#a" } }, { click: "#b" }]);
  });

  test("narration flushes pending typing, so the order is what happened", () => {
    const { steps: out } = run([
      { type: "input", candidates: [{ kind: "id", selector: "#f", matches: 1 }], value: "hello" },
      { type: "say", text: "Then this." },
    ]);
    assert.deepEqual(out, [{ type: { selector: "#f", text: "hello" } }, { say: "Then this." }]);
  });

  test("the steps it writes are valid spec steps", () => {
    // The whole point of teaching capture a step kind is that what it emits
    // parses. A draft the schema rejects is worse than no draft.
    const { steps: out } = run([
      { type: "mark", candidates: [{ kind: "id", selector: "#count", matches: 1 }] },
      { type: "say", text: "A spoken line." },
    ]);
    assert.doesNotThrow(() => specSchema.parse({ steps: out, output: { html: "out/d.html" } }));
  });
});

describe("the injected observer", () => {
  test("parses as JavaScript", () => {
    // It is a string, so nothing else in the build type-checks it. A syntax
    // error here breaks `reel capture` in the browser, where — as the module's
    // own comment warns — it looks like the page's fault rather than ours.
    assert.doesNotThrow(() => new Function(OBSERVER_SCRIPT));
  });

  test("still offers every gesture the spec grammar has a step for", () => {
    for (const gesture of ['type: "click"', 'type: "caption"', 'type: "say"', 'type: "mark"', 'type: "beat"']) {
      assert.ok(OBSERVER_SCRIPT.includes(gesture), `the toolbar cannot record ${gesture}`);
    }
  });
});
