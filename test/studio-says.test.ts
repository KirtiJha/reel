import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parse as parseYaml } from "yaml";
import { specSchema } from "../src/spec/schema.js";
import { readScript } from "../src/commands/narrate.js";
import { applySay, silentMoments } from "../src/ui/says.js";

/**
 * Accepting a drafted line.
 *
 * `reel narrate --draft` returns bare sentences in the order the silent
 * moments were walked, and nothing that says which step each belongs to. The
 * first test here is the load-bearing one: if this walk ever stops agreeing
 * with `readScript`'s, every accepted line lands under the wrong moment —
 * plausibly, and without an error anywhere.
 */

const SPEC = `name: Tasks
url: http://localhost:3000
steps:
  # An opener nobody has written a line for yet.
  - card: Welcome
  - caption: Adding a task
  - click: "#new"
  - beat: created
  - card:
      title: One more thing
      ms: 2000
  - image: shots/architecture.png
  - branch:
      prompt: Which one?
      paths:
        - label: Keyboard
          steps:
            - card: By keyboard
            - click: "#kb"
        - label: Mouse
          steps:
            - click: "#go"
output:
  gif: out/demo.gif
`;

function parse(raw: string) {
  return specSchema.parse(parseYaml(raw));
}

describe("the silent moments a line can be written under", () => {
  test("they are the ones `reel narrate` proposes for, in that order", () => {
    const spec = parse(SPEC);
    const script = readScript(spec.steps);
    assert.deepEqual(
      silentMoments(spec.steps).map((m) => m.where),
      script.silent,
      "proposal i belongs to moment i — nothing else connects them",
    );
  });

  test("a moment inside a branch path carries the route to it", () => {
    const moments = silentMoments(parse(SPEC).steps);
    const nested = moments.find((m) => m.where.includes("By keyboard"));
    assert.ok(nested, "a card inside a branch path is a moment too");
    assert.deepEqual(nested!.path, ["steps", 6, "branch", "paths", 0, "steps", 0]);
  });

  test("a moment that already speaks is not one", () => {
    const moments = silentMoments(parse(SPEC.replace("- card: Welcome", "- card:\n      title: Welcome\n      say: Here is Tasks.")).steps);
    assert.ok(!moments.some((m) => m.where.includes("Welcome")));
  });
});

describe("writing an accepted line into the spec", () => {
  const moments = silentMoments(parse(SPEC).steps);
  const at = (where: string) => {
    const m = moments.find((x) => x.where.includes(where));
    assert.ok(m, `no silent moment for ${where}`);
    return m!;
  };

  test("a shorthand card grows into the long form rather than losing its title", () => {
    const next = applySay(SPEC, at("Welcome"), "Here is Tasks.");
    const spec = parse(next);
    const card = (spec.steps[0] as { card: { title: string; say?: string } }).card;
    assert.equal(card.title, "Welcome", "the title survives");
    assert.equal(card.say, "Here is Tasks.");
  });

  test("a card already in long form just gains the line", () => {
    const spec = parse(applySay(SPEC, at("One more thing"), "And there is more."));
    const card = (spec.steps[4] as { card: { ms: number; say?: string } }).card;
    assert.equal(card.say, "And there is more.");
    assert.equal(card.ms, 2000, "nothing else about the step moves");
  });

  test("a beat gets a `say:` step of its own, because a beat cannot carry one", () => {
    const next = applySay(SPEC, at("created"), "The task is on the list.");
    const spec = parse(next);
    assert.deepEqual(spec.steps[3], { beat: "created" }, "the beat is untouched");
    assert.deepEqual(spec.steps[4], { say: "The task is on the list." }, "the line follows it");
    assert.equal(spec.steps.length, parse(SPEC).steps.length + 1);
  });

  test("an image keeps its file", () => {
    const spec = parse(applySay(SPEC, at("image"), "This is how it fits together."));
    const image = (spec.steps[5] as { image: { file: string; say?: string } }).image;
    assert.equal(image.file, "shots/architecture.png");
    assert.equal(image.say, "This is how it fits together.");
  });

  test("a line inside a branch path lands inside that path", () => {
    const spec = parse(applySay(SPEC, at("By keyboard"), "The keyboard route."));
    const branch = spec.steps[6] as { branch: { paths: { steps: unknown[] }[] } };
    const card = (branch.branch.paths[0]!.steps[0] as { card: { say?: string } }).card;
    assert.equal(card.say, "The keyboard route.");
  });

  test("the comments in the spec survive it", () => {
    // The reason this edits the document rather than re-serialising: a spec's
    // comments carry the reasoning, and accepting one sentence must not eat
    // them.
    assert.match(applySay(SPEC, at("Welcome"), "Hello."), /# An opener nobody has written/);
  });

  test("a moment that has moved is refused rather than written over", () => {
    const moved = SPEC.replace("- card: Welcome", "- click: \"#gone\"");
    assert.throws(() => applySay(moved, at("Welcome"), "Hello."), /no longer a card/);
  });

  test("an empty line is not a line", () => {
    assert.throws(() => applySay(SPEC, at("Welcome"), "   "), /empty/);
  });
});
