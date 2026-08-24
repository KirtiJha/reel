import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseIntent, deterministicCandidates, scoreCandidate } from "../src/heal/candidates.js";
import { toPlaywrightSelector } from "../src/overlay/overlay.js";
import type { ElementInfo } from "../src/ai/agent-tools.js";

const el = (name: string, role: string, selector: string, ref = "e0"): ElementInfo => ({
  ref,
  name,
  role,
  selector,
});

describe("parseIntent", () => {
  test("reads role and name from a role selector", () => {
    assert.deepEqual(parseIntent("role=button[name=Add]"), { role: "button", name: "Add" });
  });

  test("handles a quoted name with spaces", () => {
    assert.deepEqual(parseIntent('role=textbox[name="Email address"]'), {
      role: "textbox",
      name: "Email address",
    });
  });

  test("reads a bare role selector", () => {
    assert.deepEqual(parseIntent("role=button"), { role: "button", name: undefined });
  });

  test("reads text selectors", () => {
    assert.equal(parseIntent("text=Ship the demo").name, "Ship the demo");
    assert.equal(parseIntent('text="Ship the demo"').name, "Ship the demo");
  });

  test("reads a placeholder selector", () => {
    assert.equal(parseIntent('[placeholder="What needs doing?"]').placeholder, "What needs doing?");
  });

  test("turns an id into a searchable phrase", () => {
    // A renamed label with a stable id must still match, and vice versa.
    assert.deepEqual(parseIntent("#task-input"), { id: "task-input", name: "task input" });
    assert.equal(parseIntent("#taskInput").name, "task input");
  });

  test("returns nothing useful for an opaque selector", () => {
    assert.deepEqual(parseIntent("div > span:nth-child(3)"), {});
  });

  test("reads through a scope to what was wanted", () => {
    // The nav says which Tutorial link, not what it was. A repair that finds
    // the link elsewhere is still the repair — heal replaces the selector whole.
    assert.deepEqual(parseIntent("nav >> role=link[name=Tutorial]"), {
      role: "link",
      name: "Tutorial",
    });
    assert.equal(parseIntent('[data-testid="rows"] >> text=Delete').name, "Delete");
  });
});

describe("toPlaywrightSelector", () => {
  test("normalises each half of a scoped selector", () => {
    // Scoping is Playwright's own chaining operator; the role half still needs
    // its name quoting the way an unscoped one would.
    assert.equal(
      toPlaywrightSelector("nav >> role=link[name=Tutorial - Basics]"),
      'nav >> role=link[name="Tutorial - Basics"]',
    );
  });

  test("leaves an unscoped selector exactly as it was", () => {
    assert.equal(toPlaywrightSelector("#add"), "#add");
    assert.equal(toPlaywrightSelector("role=button[name=Add]"), 'role=button[name="Add"]');
  });
});

describe("scoreCandidate", () => {
  test("an exact name and role match outranks a partial one", () => {
    const intent = parseIntent("role=button[name=Add]");
    const exact = scoreCandidate(intent, el("Add", "button", "role=button[name=Add]"));
    const partial = scoreCandidate(intent, el("Add task", "button", "role=button[name=Add task]"));
    assert.ok(exact > partial);
  });

  test("case and punctuation changes still match strongly", () => {
    const intent = parseIntent("text=Sign In");
    assert.ok(scoreCandidate(intent, el("sign in", "link", "text=sign in")) >= 80);
  });

  test("a surviving id beats every name-based signal", () => {
    // The classic drift: same element, relabelled button.
    const intent = parseIntent("#task-input");
    const byId = scoreCandidate(intent, el("Completely different", "textbox", "#task-input"));
    const byName = scoreCandidate(intent, el("task input", "textbox", "role=textbox[name=task input]"));
    assert.ok(byId > byName);
  });

  test("a mismatched role is penalized, not ignored", () => {
    const intent = parseIntent("role=button[name=Save]");
    const wrongRole = scoreCandidate(intent, el("Save", "textbox", "role=textbox[name=Save]"));
    const rightRole = scoreCandidate(intent, el("Save", "button", "role=button[name=Save]"));
    assert.ok(rightRole > wrongRole);
  });

  test("an unrelated element scores nothing", () => {
    assert.equal(scoreCandidate(parseIntent("text=Add"), el("Delete", "button", "#del")), 0);
  });
});

describe("deterministicCandidates", () => {
  const page = [
    el("Create", "button", "role=button[name=Create]", "e1"),
    el("Delete", "button", "role=button[name=Delete]", "e2"),
    el("Add task", "button", "role=button[name=Add task]", "e3"),
  ];

  test("ranks the closest label first", () => {
    const out = deterministicCandidates("role=button[name=Add]", page);
    assert.equal(out[0], "role=button[name=Add task]");
  });

  test("never proposes the selector that just failed", () => {
    const out = deterministicCandidates("role=button[name=Delete]", page);
    assert.ok(!out.includes("role=button[name=Delete]"));
  });

  test("defers instead of guessing when the selector carries no intent", () => {
    // Positional guessing would produce confident nonsense; better to let the
    // model (or a human) handle it.
    assert.deepEqual(deterministicCandidates("div > span:nth-child(3)", page), []);
  });

  test("returns nothing when nothing on the page is plausible", () => {
    assert.deepEqual(deterministicCandidates("text=Wildly Unrelated", page), []);
  });

  test("caps how many candidates are tried", () => {
    const many = Array.from({ length: 20 }, (_, i) => el(`Add ${i}`, "button", `#b${i}`, `e${i}`));
    assert.ok(deterministicCandidates("role=button[name=Add]", many, 3).length <= 3);
  });

  test("de-duplicates identical selectors", () => {
    const dupes = [el("Add", "button", "#same", "e1"), el("Add", "button", "#same", "e2")];
    assert.equal(deterministicCandidates("role=button[name=Add]", dupes).length, 1);
  });
});

describe("a repair has to be a repair, not a guess", () => {
  // Found by breaking a real demo: a dish was renamed, and heal rewrote the
  // step to `text=P` — the single-letter avatar beside the chef's name. It
  // scored 40 because "aalu parwal sabji" happens to contain a "p", and the
  // repair passed verification because waiting for the *wrong* element
  // succeeds. The spec would have been rewritten to point at an avatar and
  // the demo would have gone on passing.
  test("a single letter is not a match for a sentence", () => {
    const intent = parseIntent("text=Aalu parwal sabji");
    assert.equal(scoreCandidate(intent, el("P", "img", "text=P")), 0);
  });

  test("nor is one short word buried in a long name", () => {
    const intent = parseIntent("text=Aalu parwal sabji");
    assert.ok(scoreCandidate(intent, el("ab", "generic", "text=ab")) < 30);
  });

  test("and such a candidate is not even offered", () => {
    const cands = deterministicCandidates("text=Aalu parwal sabji", [
      el("P", "img", "text=P"),
      el("Pratibha", "link", "text=Pratibha"),
    ]);
    assert.ok(!cands.includes("text=P"), `should not offer text=P, got ${JSON.stringify(cands)}`);
  });

  test("a genuine relabel still repairs", () => {
    // The case heal exists for: same element, longer label.
    const intent = parseIntent("text=Aalu parwal sabji");
    const better = scoreCandidate(intent, el("Aalu parwal sabji (family recipe)", "heading", "text=Aalu parwal sabji (family recipe)"));
    assert.ok(better >= 30, `a real relabel should still score, got ${better}`);
  });

  test("and 'Add' → 'Add task' is still comfortably a match", () => {
    const intent = parseIntent("role=button[name=Add]");
    assert.ok(scoreCandidate(intent, el("Add task", "button", "role=button[name=Add task]")) >= 30);
  });
});
