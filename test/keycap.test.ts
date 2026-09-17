import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { keyCaps } from "../src/overlay/keycap.js";
import { isChord, toSteps, type CaptureEvent } from "../src/authoring/steps.js";
import { specSchema } from "../src/spec/schema.js";

describe("keyCaps", () => {
  test("draws a chord the way a keyboard spells it", () => {
    assert.deepEqual(keyCaps("Meta+K"), ["⌘", "K"]);
    assert.deepEqual(keyCaps("Control+Shift+P"), ["Ctrl", "⇧", "P"]);
    assert.deepEqual(keyCaps("Escape"), ["Esc"]);
  });

  test("names every modifier alias the same way", () => {
    // Playwright accepts several spellings of one key; a demo must not show a
    // different cap depending on which one the spec happened to use.
    for (const meta of ["Meta", "meta", "Command", "Cmd", "OS"]) {
      assert.deepEqual(keyCaps(meta), ["⌘"], meta);
    }
    assert.deepEqual(keyCaps("Ctrl+S"), keyCaps("Control+S"));
    assert.deepEqual(keyCaps("Option+F"), keyCaps("Alt+F"));
  });

  test("sorts modifiers into the conventional order", () => {
    // The same chord written two ways is the same chord, and drawing it two
    // ways would make a demo look inconsistent with itself.
    assert.deepEqual(keyCaps("Shift+Meta+P"), ["⇧", "⌘", "P"]);
    assert.deepEqual(keyCaps("Meta+Shift+P"), ["⇧", "⌘", "P"]);
    assert.deepEqual(keyCaps("Alt+Control+Delete"), ["Ctrl", "Alt", "Del"]);
  });

  test("collapses a repeated modifier", () => {
    assert.deepEqual(keyCaps("Control+Control+K"), ["Ctrl", "K"]);
  });

  test("uses the engraved symbol for arrows and backspace", () => {
    assert.deepEqual(keyCaps("ArrowDown"), ["↓"]);
    assert.deepEqual(keyCaps("ArrowUp"), ["↑"]);
    assert.deepEqual(keyCaps("ArrowLeft"), ["←"]);
    assert.deepEqual(keyCaps("ArrowRight"), ["→"]);
    assert.deepEqual(keyCaps("Backspace"), ["⌫"]);
  });

  test("abbreviates the keys that are printed abbreviated", () => {
    assert.deepEqual(keyCaps("PageDown"), ["PgDn"]);
    assert.deepEqual(keyCaps("Delete"), ["Del"]);
    assert.deepEqual(keyCaps("CapsLock"), ["Caps"]);
  });

  test("a single character is a keycap, so it is upper case", () => {
    assert.deepEqual(keyCaps("k"), ["K"]);
    assert.deepEqual(keyCaps("/"), ["/"]);
    assert.deepEqual(keyCaps("7"), ["7"]);
  });

  test("reads the physical-key spellings", () => {
    assert.deepEqual(keyCaps("KeyA"), ["A"]);
    assert.deepEqual(keyCaps("Digit3"), ["3"]);
    assert.deepEqual(keyCaps("Numpad5"), ["5"]);
    assert.deepEqual(keyCaps("F12"), ["F12"]);
  });

  test("a literal plus survives being split on plus", () => {
    // `Control++` is control-and-the-plus-key. Splitting it naively leaves an
    // empty cap, so the demo shows Ctrl pressed with nothing.
    assert.deepEqual(keyCaps("Control++"), ["Ctrl", "+"]);
    assert.deepEqual(keyCaps("+"), ["+"]);
  });

  test("an unknown key is drawn as written rather than dropped", () => {
    // Silently showing no cap would be the worst outcome: the press still
    // happens and the viewer is back to guessing.
    assert.deepEqual(keyCaps("BrowserSearch"), ["BrowserSearch"]);
  });

  test("never returns an empty cap", () => {
    for (const key of ["Meta+K", "Control++", "+", "Escape", "a", "F5"]) {
      assert.ok(
        keyCaps(key).every((c) => c.length > 0),
        key,
      );
    }
  });
});

describe("polish.keys", () => {
  test("defaults to auto, so a press is visible without asking", () => {
    const spec = specSchema.parse({
      steps: [{ press: { key: "Meta+K" } }],
      output: { mp4: "o.mp4" },
    });
    assert.equal(spec.polish.keys, "auto");
  });

  test("can be switched off", () => {
    const spec = specSchema.parse({
      polish: { keys: "none" },
      steps: [{ press: { key: "Escape" } }],
      output: { mp4: "o.mp4" },
    });
    assert.equal(spec.polish.keys, "none");
  });

  test("rejects a value that isn't one of the two", () => {
    assert.throws(() =>
      specSchema.parse({
        polish: { keys: "yes" },
        steps: [{ press: { key: "Escape" } }],
        output: { mp4: "o.mp4" },
      }),
    );
  });
});

/* -------------------- what `reel capture` writes down -------------------- */

const candidates = (selector: string) => [{ kind: "css", selector, matches: 1 }];

/** A capture session always opens with something that counts as acting. */
function captured(events: CaptureEvent[]) {
  return toSteps(
    [{ type: "click", candidates: candidates("#start") } as CaptureEvent, ...events],
    "http://localhost:3000/",
  ).steps;
}

describe("isChord", () => {
  test("Control, Meta and Alt make a chord", () => {
    assert.equal(isChord("Meta+K"), true);
    assert.equal(isChord("Control+Shift+P"), true);
    assert.equal(isChord("Alt+Enter"), true);
  });

  test("Shift alone does not — it is how you type a capital", () => {
    assert.equal(isChord("Shift+ArrowDown"), false);
    assert.equal(isChord("Enter"), false);
    assert.equal(isChord("A"), false);
  });

  test("a modifier in the final position is the key being pressed", () => {
    assert.equal(isChord("Meta"), false);
  });
});

describe("capturing a key press", () => {
  test("a chord is written against the app, not against whatever had focus", () => {
    // The browser reports ⌘K against <body> or against whatever the pointer was
    // over. Recorded with that selector the key cap would be anchored to an
    // unrelated element and the camera would move to it.
    const steps = captured([
      { type: "key", key: "Meta+K", candidates: candidates(".card") } as CaptureEvent,
    ]);
    assert.deepEqual(steps[steps.length - 1], { press: { key: "Meta+K" } });
  });

  test("a plain key keeps the element it was typed into", () => {
    const steps = captured([
      { type: "key", key: "Enter", candidates: candidates("#task-input") } as CaptureEvent,
    ]);
    assert.deepEqual(steps[steps.length - 1], {
      press: { selector: "#task-input", key: "Enter" },
    });
  });

  test("`body` is not an element worth naming", () => {
    const steps = captured([
      { type: "key", key: "Escape", candidates: candidates("body") } as CaptureEvent,
    ]);
    assert.deepEqual(steps[steps.length - 1], { press: { key: "Escape" } });
  });

  test("what it writes is a step the driver accepts", () => {
    const steps = captured([
      { type: "key", key: "Control+Shift+P", candidates: candidates("body") } as CaptureEvent,
      { type: "key", key: "ArrowDown", candidates: candidates("#list") } as CaptureEvent,
    ]);
    const spec = specSchema.parse({ steps, output: { mp4: "o.mp4" } });
    assert.equal(spec.steps.length, steps.length);
  });
});
