import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import {
  chooseSelector,
  idSelector,
  looksGenerated,
  roleSelector,
  textSelector,
  MAX_ROLE_NAME,
  MAX_TEXT_SELECTOR,
  type Candidate,
} from "../src/authoring/selector.js";
import { relativeUrl, toSteps, type CaptureEvent } from "../src/authoring/steps.js";
import { emitSpec, renderStep, scalar } from "../src/authoring/emit.js";
import { specSchema } from "../src/spec/schema.js";

const c = (kind: Candidate["kind"], selector: string, matches = 1): Candidate => ({
  kind,
  selector,
  matches,
});

describe("choosing a selector", () => {
  test("prefers a test id over everything else", () => {
    // It is the one thing in a page that exists to be selected — a contract,
    // not an accident of the markup.
    assert.equal(
      chooseSelector([c("css", "div > button"), c("role", "role=button[name=Save]"), c("testid", '[data-testid="save"]')]),
      '[data-testid="save"]',
    );
  });

  test("prefers a named role over raw text", () => {
    assert.equal(
      chooseSelector([c("text", "text=Save"), c("role", "role=button[name=Save]")]),
      "role=button[name=Save]",
    );
  });

  test("falls back to a CSS path when nothing names the element", () => {
    assert.equal(chooseSelector([c("css", "main > div:nth-of-type(2)")]), "main > div:nth-of-type(2)");
  });

  test("discards anything that matches more than one element", () => {
    // Not "the first Delete" — a selector matching four rows will act on
    // whichever one the layout puts first tomorrow.
    assert.equal(chooseSelector([c("text", "text=Delete", 4), c("role", "role=button", 4)]), null);
  });

  test("discards a generated id in favour of a worse but stable selector", () => {
    const chosen = chooseSelector([c("id", "#:r3:"), c("text", "text=Continue")]);
    assert.equal(chosen, "text=Continue");
  });

  test("returns null rather than guessing", () => {
    assert.equal(chooseSelector([]), null);
    assert.equal(chooseSelector([c("id", "#a1b2c3d4e5f6")]), null);
  });

  test("rejects a paragraph as a text selector", () => {
    const long = "text=" + "x".repeat(200);
    assert.equal(chooseSelector([c("text", long)]), null);
  });

  test("keeps a wordy accessible name", () => {
    // Docusaurus labels its theme toggle this way. It is long because a screen
    // reader needs the state, not because it is prose — throwing it away left
    // a CSS path through an <svg> as the only thing on offer.
    const label = "Switch between dark and light mode (currently system mode)";
    assert.ok(label.length > MAX_TEXT_SELECTOR, "the name is long enough to matter");
    assert.equal(
      chooseSelector([c("css", "div > button > svg > path"), c("role", roleSelector("button", label))]),
      `role=button[name=${JSON.stringify(label)}]`,
    );
  });

  test("still rejects an accessible name that is a whole paragraph", () => {
    const essay = roleSelector("button", "x".repeat(MAX_ROLE_NAME + 1));
    assert.equal(chooseSelector([c("role", essay)]), null);
  });
});

describe("recognising a generated name", () => {
  test("accepts names a person would write", () => {
    for (const id of ["task-input", "submit", "email_field", "nav2"]) {
      assert.equal(looksGenerated(id), false, id);
    }
  });

  test("rejects framework-minted ids", () => {
    // These are stable within a page load and worthless across one — the worst
    // kind of selector, because it works right up until it doesn't.
    for (const id of [":r3:", "mui-4821", "headlessui-menu-button-7", "a1b2c3d4e5", "css-1x2y3z4a", "row-1029384"]) {
      assert.equal(looksGenerated(id), true, id);
    }
  });
});

describe("selector spelling", () => {
  test("quotes a role name only when it needs it", () => {
    assert.equal(roleSelector("button", "Add"), "role=button[name=Add]");
    assert.equal(roleSelector("button", "Add task"), 'role=button[name="Add task"]');
    assert.equal(roleSelector("button"), "role=button");
  });

  test("normalises whitespace in text selectors", () => {
    assert.equal(textSelector("  Sign   in "), "text=Sign in");
  });

  test("rejects an id that would need escaping", () => {
    assert.equal(idSelector("task-input"), "#task-input");
    assert.equal(idSelector("weird.id"), null);
    assert.equal(idSelector(""), null);
  });
});

/** An observed event with a single unambiguous candidate. */
const on = (type: string, selector: string, extra: Record<string, unknown> = {}): CaptureEvent =>
  ({ type, candidates: [{ kind: "id", selector, matches: 1 }], ...extra }) as CaptureEvent;

describe("turning events into steps", () => {
  const base = "http://localhost:3000";

  test("a click becomes a click", () => {
    const { steps } = toSteps([on("click", "#save")], base);
    assert.deepEqual(steps, [{ click: "#save" }]);
  });

  test("keystrokes in one field collapse to one type step", () => {
    // Five events, one intention. A spec with a step per character is not one
    // anybody would keep.
    const { steps } = toSteps(
      ["h", "he", "hel", "hell", "hello"].map((v) => on("input", "#name", { value: v })),
      base,
    );
    assert.deepEqual(steps, [{ type: { selector: "#name", text: "hello" } }]);
  });

  test("the click that focuses a field is not a step of its own", () => {
    const { steps } = toSteps([on("click", "#name"), on("input", "#name", { value: "hi" })], base);
    assert.deepEqual(steps, [{ type: { selector: "#name", text: "hi" } }]);
  });

  test("moving to another field commits the first", () => {
    const { steps } = toSteps(
      [on("input", "#a", { value: "one" }), on("input", "#b", { value: "two" })],
      base,
    );
    assert.deepEqual(steps, [
      { type: { selector: "#a", text: "one" } },
      { type: { selector: "#b", text: "two" } },
    ]);
  });

  test("typing then submitting keeps its order", () => {
    // The reason the observer listens on `input` and not `change`: change fires
    // on blur, which would report the submit before the text submitted.
    const { steps } = toSteps(
      [on("input", "#q", { value: "reel" }), { type: "key", key: "Enter", candidates: [{ kind: "id", selector: "#q", matches: 1 }] } as CaptureEvent],
      base,
    );
    assert.deepEqual(steps, [
      { type: { selector: "#q", text: "reel" } },
      { press: { selector: "#q", key: "Enter" } },
    ]);
  });

  test("the opening navigation is the spec's url, not a step", () => {
    const { steps } = toSteps([{ type: "nav", url: base + "/" }, on("click", "#go")], base);
    assert.deepEqual(steps, [{ click: "#go" }]);
  });

  test("a later navigation becomes a wait", () => {
    const { steps } = toSteps(
      [{ type: "nav", url: base + "/" }, on("click", "#go"), { type: "nav", url: base + "/done" }],
      base,
    );
    assert.deepEqual(steps, [{ click: "#go" }, { waitForUrl: "/done" }]);
  });

  test("captions and beats land where the user put them", () => {
    const { steps } = toSteps(
      [on("click", "#a"), { type: "caption", text: "Here we go" } as CaptureEvent, { type: "beat" } as CaptureEvent],
      base,
    );
    assert.deepEqual(steps, [{ click: "#a" }, { caption: "Here we go" }, { beat: true }]);
  });

  test("finish ends the recording, whatever arrives after it", () => {
    const { steps } = toSteps([on("click", "#a"), { type: "finish" } as CaptureEvent, on("click", "#b")], base);
    assert.deepEqual(steps, [{ click: "#a" }]);
  });

  test("an unnameable element is reported rather than dropped in silence", () => {
    // A demo missing a step nobody was told about is discovered when it plays
    // wrong, which is far too late.
    const { steps, skipped } = toSteps(
      [{ type: "click", candidates: [{ kind: "text", selector: "text=Delete", matches: 6 }] } as CaptureEvent],
      base,
    );
    assert.deepEqual(steps, []);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0]!, /no stable selector/);
    assert.match(skipped[0]!, /6 elements/);
  });

  test("a single-page app's boot routing is not a step", () => {
    // Found on Uptime Kuma: it boots through `/` → `/dashboard` → `/setup`
    // before the user touches anything. Dropping only the first navigation left
    // the draft opening with waits for pages the demo had not navigated to, and
    // the spec failed on replay.
    const { steps } = toSteps(
      [
        { type: "nav", url: base + "/" },
        { type: "nav", url: base + "/dashboard" },
        { type: "nav", url: base + "/setup" },
        on("click", "#go"),
      ],
      base,
    );
    assert.deepEqual(steps, [{ click: "#go" }]);
  });

  test("a redirect chain settles into one wait, not three", () => {
    // One click, three navigations. Only where it came to rest is worth
    // waiting for; the intermediate hops are gone before the next step runs.
    const { steps } = toSteps(
      [
        { type: "nav", url: base + "/" },
        on("click", "#login"),
        { type: "nav", url: base + "/setup" },
        { type: "nav", url: base + "/" },
        { type: "nav", url: base + "/dashboard" },
        on("click", "#new"),
      ],
      base,
    );
    assert.deepEqual(steps, [
      { click: "#login" },
      { waitForUrl: "/dashboard" },
      { click: "#new" },
    ]);
  });

  test("a caption does not count as having acted", () => {
    // Annotations come from the toolbar, not the app, so they cannot be what
    // caused a navigation.
    const { steps } = toSteps(
      [
        { type: "nav", url: base + "/" },
        { type: "caption", text: "Watch this" } as CaptureEvent,
        { type: "nav", url: base + "/dashboard" },
        on("click", "#go"),
      ],
      base,
    );
    assert.deepEqual(steps, [{ caption: "Watch this" }, { click: "#go" }]);
  });

  test("an empty field is not written as an empty type step", () => {
    const { steps } = toSteps([on("input", "#a", { value: "" })], base);
    assert.deepEqual(steps, []);
  });
});

describe("urls in a captured spec", () => {
  test("stay relative while the demo is on its own site", () => {
    // Otherwise the spec pins the port the dev server happened to use, and the
    // demo only replays on the machine it was captured on.
    assert.equal(relativeUrl("http://localhost:3000/a/b?c=1", "http://localhost:3000"), "/a/b?c=1");
  });

  test("keep the origin when the demo leaves it", () => {
    assert.equal(
      relativeUrl("https://docs.example.com/x", "http://localhost:3000"),
      "https://docs.example.com/x",
    );
  });

  test("a URL that isn't one is not a wait", () => {
    assert.equal(relativeUrl("about:blank#x", "not a url"), null);
  });
});

describe("the emitted spec", () => {
  const sample = emitSpec({
    name: "My demo",
    url: "http://localhost:3000",
    steps: [
      { click: "role=button[name=Add]" },
      { type: { selector: "#task-input", text: "Ship it" } },
      { caption: "That's it" },
      { beat: true },
    ],
    gif: "out/demo.gif",
    mp4: "out/demo.mp4",
  });

  test("parses, and validates as a real spec", () => {
    // The whole promise of `reel capture` is that what comes out records. A
    // draft the driver rejects would be worse than no draft.
    const parsed = specSchema.parse(parse(sample));
    assert.equal(parsed.name, "My demo");
    assert.equal(parsed.steps.length, 4);
  });

  test("carries the schema line, so the draft completes in an editor", () => {
    assert.match(sample.split("\n")[0]!, /^# yaml-language-server: \$schema=/);
  });

  test("says it is a draft", () => {
    assert.match(sample, /draft/i);
  });

  test("writes one step per line, small maps inline", () => {
    // `#a` unquoted would start a YAML comment, so the value has to carry
    // quotes even though the same string is fine as a bare word elsewhere.
    assert.equal(renderStep({ click: "#a" }), '- click: "#a"');
    assert.equal(renderStep({ click: "role=button[name=Add]" }), "- click: role=button[name=Add]");
    assert.equal(
      renderStep({ type: { selector: "#a", text: "hi" } }),
      '- type: { selector: "#a", text: hi }',
    );
  });

  test("quotes what YAML would otherwise read as something else", () => {
    assert.equal(scalar("#task-input"), '"#task-input"');
    assert.equal(scalar("plain text"), "plain text");
    assert.equal(scalar(true), "true");
    // The invariant that matters is the round trip, not the quoting: the same
    // parser reads the spec back, so what it accepts unquoted is safe unquoted.
    for (const v of ["yes", "no", "on", "null", "3.10", "#a", "- x", "a: b", "*ref", "&anchor", ""]) {
      assert.deepEqual(parse(`v: ${scalar(v)}`), { v }, `round trip failed for ${JSON.stringify(v)}`);
    }
  });

  test("quotes values that would break out of an inline map", () => {
    assert.equal(scalar("a, b", true), '"a, b"');
    assert.equal(scalar("role=button[name=Add]", true), '"role=button[name=Add]"');
    // …and leaves them alone on a line of their own, where they are ordinary.
    assert.equal(scalar("role=button[name=Add]"), "role=button[name=Add]");
  });

  test("a spec captured from nothing is still a valid starting point", () => {
    const empty = emitSpec({ name: "Empty", url: "http://x.test", steps: [], gif: "out/d.gif" });
    assert.doesNotThrow(() => specSchema.parse(parse(empty)));
  });
});

describe("a spec captured from a signed-in session", () => {
  const authed = emitSpec({
    name: "Behind a login",
    url: "https://app.example.com",
    steps: [{ click: "#new" }],
    gif: "out/demo.gif",
    storageState: ".auth/demo.json",
  });

  test("replays from the saved session", () => {
    // Without this the first `record` lands on a login page and every selector
    // in the draft is missing — the draft looks wrong when what is wrong is
    // that it forgot it was authenticated.
    const parsed = specSchema.parse(parse(authed));
    assert.equal(parsed.storageState, ".auth/demo.json");
  });

  test("says in the file itself that the session is a credential", () => {
    assert.match(authed, /live session cookies/);
    assert.match(authed, /never commit|out of version control/i);
  });

  test("a signed-out capture carries no storageState key at all", () => {
    // Not an empty string — an empty path would resolve to the spec's own
    // directory and fail in a way that reads like a Playwright bug.
    const plain = emitSpec({ name: "X", url: "http://x.test", steps: [], gif: "o.gif" });
    assert.doesNotMatch(plain, /storageState/);
    assert.equal(specSchema.parse(parse(plain)).storageState, undefined);
  });
});
