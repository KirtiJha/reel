import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { applyPatch, setStepHidden } from "../src/ui/server.js";
import {
  DEFAULT_PALETTE,
  DEFAULT_THEME,
  TERMINAL_THEMES,
  THEME_NAMES,
} from "../src/terminal/themes.js";
import { TerminalEmulator } from "../src/terminal/emulator.js";
import { specSchema } from "../src/spec/schema.js";
import { checkRequirements } from "../src/terminal/session.js";

/** Parse a spec with a terminal block, returning the resolved terminal config. */
function terminal(cfg: Record<string, unknown>) {
  return specSchema.parse({
    steps: [{ run: "true" }],
    terminal: cfg,
    output: { html: "out/d.html" },
  }).terminal!;
}

/** The foreground colour the emulator assigned to the first span of row 0. */
function firstFg(emu: TerminalEmulator): string | undefined {
  return emu.spans()[0]![0]!.style.fg;
}

describe("theme definitions", () => {
  test("every theme supplies exactly 16 ANSI colours", () => {
    for (const name of THEME_NAMES) {
      assert.equal(
        TERMINAL_THEMES[name].palette.length,
        16,
        `${name} must define 8 normal + 8 bright colours`,
      );
    }
  });

  test("every colour is a hex value the browser will accept", () => {
    for (const name of THEME_NAMES) {
      const t = TERMINAL_THEMES[name];
      for (const c of [...t.palette, t.background, t.foreground]) {
        assert.match(c, /^#[0-9a-f]{6}$/, `${name} has a malformed colour: ${c}`);
      }
    }
  });

  test("a theme's foreground is not its own background", () => {
    // Cheap guard against a copy-paste slip that would render invisible text.
    for (const name of THEME_NAMES) {
      const t = TERMINAL_THEMES[name];
      assert.notEqual(t.foreground, t.background, `${name} is unreadable`);
    }
  });

  test("the default theme exists and is what the emulator falls back to", () => {
    assert.ok(THEME_NAMES.includes(DEFAULT_THEME));
    assert.deepEqual(DEFAULT_PALETTE, TERMINAL_THEMES[DEFAULT_THEME].palette);
  });
});

describe("emulator palette", () => {
  test("SGR 31 resolves through the supplied palette, not a fixed table", () => {
    const custom = Array.from({ length: 16 }, (_, i) => `#0000${i.toString(16)}${i.toString(16)}`);
    const emu = new TerminalEmulator(20, 3, custom);
    emu.write("\x1b[31mred");
    assert.equal(firstFg(emu), custom[1]);
  });

  test("bright colours index the top half of the palette", () => {
    const custom = Array.from({ length: 16 }, (_, i) => `#0000${i.toString(16)}${i.toString(16)}`);
    const emu = new TerminalEmulator(20, 3, custom);
    emu.write("\x1b[91mbright");
    assert.equal(firstFg(emu), custom[9]);
  });

  test("the 256-colour cube stays fixed while its first 16 entries theme", () => {
    const custom = Array.from({ length: 16 }, () => "#abcdef");
    const emu = new TerminalEmulator(20, 3, custom);
    emu.write("\x1b[38;5;1mlow");
    assert.equal(firstFg(emu), "#abcdef", "indices under 16 come from the palette");

    const cube = new TerminalEmulator(20, 3, custom);
    cube.write("\x1b[38;5;196mhigh");
    assert.equal(firstFg(cube), "#ff0000", "the cube is spec-defined, not themeable");
  });

  test("constructing without a palette keeps existing demos byte-identical", () => {
    const emu = new TerminalEmulator(20, 3);
    emu.write("\x1b[32mgreen");
    assert.equal(firstFg(emu), TERMINAL_THEMES.reel.palette[2]);
  });
});

describe("terminal schema", () => {
  test("a named theme supplies background, foreground and palette", () => {
    const t = terminal({ theme: "dracula" });
    assert.equal(t.background, TERMINAL_THEMES.dracula.background);
    assert.equal(t.foreground, TERMINAL_THEMES.dracula.foreground);
    assert.deepEqual(t.palette, TERMINAL_THEMES.dracula.palette);
  });

  test("an explicit background wins over the theme's", () => {
    const t = terminal({ theme: "nord", background: "#000000" });
    assert.equal(t.background, "#000000");
    // …without discarding the rest of the theme.
    assert.equal(t.foreground, TERMINAL_THEMES.nord.foreground);
    assert.deepEqual(t.palette, TERMINAL_THEMES.nord.palette);
  });

  test("an explicit palette replaces the theme's colours outright", () => {
    const custom = Array.from({ length: 16 }, () => "#123456");
    const t = terminal({ theme: "nord", palette: custom });
    assert.deepEqual(t.palette, custom);
  });

  test("a palette of the wrong length is rejected", () => {
    const r = specSchema.safeParse({
      steps: [{ run: "true" }],
      terminal: { palette: ["#000000"] },
      output: { html: "out/d.html" },
    });
    assert.equal(r.success, false);
  });

  test("an unknown theme name is rejected rather than silently ignored", () => {
    const r = specSchema.safeParse({
      steps: [{ run: "true" }],
      terminal: { theme: "no-such-theme" },
      output: { html: "out/d.html" },
    });
    assert.equal(r.success, false);
  });

  test("omitting the terminal block entirely still defaults to Reel's scheme", () => {
    const t = terminal({});
    assert.equal(t.theme, DEFAULT_THEME);
    assert.deepEqual(t.palette, TERMINAL_THEMES.reel.palette);
  });

  test("require defaults to empty and hidden defaults to false", () => {
    assert.deepEqual(terminal({}).require, []);
    const spec = specSchema.parse({
      steps: [{ run: { cmd: "true" } }],
      output: { html: "out/d.html" },
    });
    const step = spec.steps[0] as { run: { hidden: boolean } };
    assert.equal(step.run.hidden, false);
  });

  test("hidden is accepted on the object form of run", () => {
    const spec = specSchema.parse({
      steps: [{ run: { cmd: "true", hidden: true } }],
      output: { html: "out/d.html" },
    });
    const step = spec.steps[0] as { run: { hidden: boolean } };
    assert.equal(step.run.hidden, true);
  });
});

describe("the Studio's copy of the theme list", () => {
  test("matches THEME_NAMES exactly", () => {
    // The dropdown hardcodes the names the way it hardcodes PRESETS and FRAMES,
    // because the Studio is a separate package that can't import from src/.
    // Without this check, adding a scheme to one and not the other produces a
    // dropdown entry the schema rejects — or a theme nobody can select.
    const src = readFileSync(
      new URL("../studio/app/studio/page.tsx", import.meta.url),
      "utf8",
    );
    const block = /const TERMINAL_THEMES = \[([\s\S]*?)\]/.exec(src);
    assert.ok(block, "could not find TERMINAL_THEMES in the Studio page");
    const listed = [...block[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(listed, [...THEME_NAMES]);
  });
});

describe("setStepHidden", () => {
  const spec = [
    "steps:",
    "  - run: ls ..",
    "  - run:",
    "      cmd: npm test",
    "      expectCode: 0",
    "  - caption: hello",
    "",
  ].join("\n");

  test("hiding the shorthand form keeps the command", () => {
    const out = parseYaml(setStepHidden(spec, 0, true));
    assert.deepEqual(out.steps[0].run, { cmd: "ls ..", hidden: true });
  });

  test("hiding the object form leaves its other keys alone", () => {
    const out = parseYaml(setStepHidden(spec, 1, true));
    assert.deepEqual(out.steps[1].run, { cmd: "npm test", expectCode: 0, hidden: true });
  });

  test("un-hiding removes the key rather than writing false", () => {
    const hidden = setStepHidden(spec, 1, true);
    const out = setStepHidden(hidden, 1, false);
    assert.equal(/hidden/.test(out), false, "no `hidden:` should remain");
    assert.deepEqual(parseYaml(out).steps[1].run, { cmd: "npm test", expectCode: 0 });
  });

  test("un-hiding a command with nothing else returns it to the shorthand", () => {
    const out = setStepHidden(setStepHidden(spec, 0, true), 0, false);
    assert.equal(parseYaml(out).steps[0].run, "ls ..");
  });

  test("un-hiding a shorthand step that was never hidden changes nothing", () => {
    assert.equal(setStepHidden(spec, 0, false), spec);
  });

  test("a step that isn't a run step is refused", () => {
    assert.throws(() => setStepHidden(spec, 2, true), /not a run step/);
  });

  test("an out-of-range index is refused rather than silently ignored", () => {
    assert.throws(() => setStepHidden(spec, 99, true), /not a run step/);
  });

  test("a spec with no steps is refused", () => {
    assert.throws(() => setStepHidden("name: x\n", 0, true), /no steps/);
  });
});

describe("editing a spec preserves what the author wrote", () => {
  const commented = [
    "# Why this demo exists.",
    "name: demo",
    "terminal:",
    "  cols: 84 # wide enough for the build output",
    "polish:",
    "  frame: window",
    "steps:",
    "  # setup, deliberately dull",
    "  - run: ls ..",
    "",
  ].join("\n");

  test("applyPatch keeps comments, including trailing ones", () => {
    const out = applyPatch(commented, { polish: { frame: "browser" } });
    assert.match(out, /# Why this demo exists\./);
    assert.match(out, /# wide enough for the build output/);
    assert.match(out, /# setup, deliberately dull/);
    assert.equal(parseYaml(out).polish.frame, "browser");
  });

  test("applyPatch only touches the keys in the patch", () => {
    const out = applyPatch(commented, { polish: { frame: "browser" } });
    assert.equal(parseYaml(out).terminal.cols, 84);
    assert.equal(parseYaml(out).name, "demo");
  });

  test("applyPatch writes a nested key into a block that doesn't exist yet", () => {
    const out = applyPatch(commented, { terminal: { theme: "dracula" } });
    assert.equal(parseYaml(out).terminal.theme, "dracula");
    assert.match(out, /# Why this demo exists\./);
  });

  test("a null in the patch removes the key", () => {
    const out = applyPatch(commented, { polish: { frame: null } });
    assert.equal(parseYaml(out).polish?.frame, undefined);
  });

  test("setStepHidden keeps comments too", () => {
    const out = setStepHidden(commented, 0, true);
    assert.match(out, /# setup, deliberately dull/);
    assert.match(out, /# Why this demo exists\./);
    assert.deepEqual(parseYaml(out).steps[0].run, { cmd: "ls ..", hidden: true });
  });
});

describe("checkRequirements", () => {
  test("an empty list is a no-op", () => {
    assert.doesNotThrow(() => checkRequirements([]));
  });

  test("a program that is obviously present passes", () => {
    // node is running this test, so it is on PATH by construction.
    assert.doesNotThrow(() => checkRequirements(["node"]));
  });

  test("a missing program throws, naming it", () => {
    assert.throws(
      () => checkRequirements(["reel-definitely-not-a-real-binary"]),
      /reel-definitely-not-a-real-binary/,
    );
  });

  test("every missing program is reported at once, not one per run", () => {
    assert.throws(
      () => checkRequirements(["reel-missing-one", "node", "reel-missing-two"]),
      (err: Error) =>
        /reel-missing-one/.test(err.message) &&
        /reel-missing-two/.test(err.message) &&
        !/\bnode\b/.test(err.message),
    );
  });
});
