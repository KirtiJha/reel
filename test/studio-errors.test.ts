import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { locateIssue, summarize } from "../src/ui/summary.js";

/**
 * A schema error has to be findable.
 *
 * Studio printed zod paths — `steps.3.click` — as plain text, which leaves the
 * reader counting steps in their own file. These cover the mapping back to a
 * line, and in particular the cases where there is no honest answer: a jump to
 * the wrong line is worse than no jump, because it says the error is somewhere
 * it isn't.
 */

const SPEC = `# A demo with a mistake in it
name: Tasks
url: http://localhost:3000

steps:
  - goto: /
  - caption: Add one
  - click: "#new"
  - beat: done

output:
  gif: out/demo.gif
`;

describe("finding the line a schema error is on", () => {
  test("a step path lands on that step", () => {
    // `steps.2` is the third step, `- click: "#new"`, on line 8.
    assert.equal(locateIssue(SPEC, ["steps", 2]), 8);
    assert.equal(locateIssue(SPEC, ["steps", 0]), 6);
  });

  test("a key inside a step lands on the key", () => {
    assert.equal(locateIssue(SPEC, ["steps", 1, "caption"]), 7);
  });

  test("a top-level key lands on itself", () => {
    assert.equal(locateIssue(SPEC, ["url"]), 3);
    assert.equal(locateIssue(SPEC, ["output", "gif"]), 12);
  });

  test("a key that does not exist falls back to the nearest thing that does", () => {
    // The commonest schema error of all: something is Required and missing.
    // There is no line for it, so the step it belongs to is the answer.
    assert.equal(locateIssue(SPEC, ["steps", 2, "selector", "text"]), 8);
    assert.equal(locateIssue(SPEC, ["steps", 9]), 6, "past the end of the list → the list");
  });

  test("an empty path is the document, and an empty document has nowhere to point", () => {
    assert.equal(locateIssue(SPEC, []), 2, "the document starts at its first node, not its comment");
    assert.equal(locateIssue("", ["steps", 0]), undefined);
    assert.equal(locateIssue("   \n\n", []), undefined);
  });

  test("a half-typed buffer answers rather than throws", () => {
    // Every keystroke in the editor comes through here, so most of what this
    // ever sees is a document mid-edit.
    for (const half of ["steps: [\n", "name:\n  - :\n", "- - -\n", "\t"]) {
      assert.doesNotThrow(() => locateIssue(half, ["steps", 0, "click"]));
    }
  });
});

describe("the summary carries addressed errors", () => {
  test("every issue that can be placed is", () => {
    const s = summarize(`name: Broken
url: http://localhost:3000
steps:
  - click: 12
output:
  gif: out/d.gif
`);
    assert.equal(s.valid, false);
    assert.ok(s.issues.length > 0, "an invalid spec reports issues");
    const step = s.issues.find((i) => i.path.startsWith("steps.0"));
    assert.ok(step, "the bad step is reported");
    assert.equal(step!.line, 4, "and points at the line it is on");
    // The readable form is unchanged: it is what the outline has always shown.
    assert.ok(s.errors.some((e) => e.startsWith("steps.0")));
  });

  test("a YAML syntax error is reported without a destination", () => {
    const s = summarize("name: [unclosed\n");
    assert.equal(s.valid, false);
    assert.equal(s.issues.length, 1);
    assert.equal(s.issues[0]!.line, undefined);
  });

  test("a valid spec has nothing to report", () => {
    const s = summarize(SPEC);
    assert.equal(s.valid, true);
    assert.deepEqual(s.issues, []);
  });
});
