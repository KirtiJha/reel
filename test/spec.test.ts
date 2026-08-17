import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { specSchema, resolveOutputProfile, outputSchema, PRESETS } from "../src/spec/schema.js";
import { resolveOutput } from "../src/spec/load.js";
import { homedir } from "node:os";
import { join } from "node:path";

const minimal = {
  steps: [{ goto: "/" }],
  output: { gif: "out/demo.gif" },
};

describe("specSchema", () => {
  test("fills sensible defaults from a minimal spec", () => {
    const s = specSchema.parse(minimal);
    assert.equal(s.viewport.width, 1280);
    assert.equal(s.viewport.scale, 2);
    assert.equal(s.theme, "light");
    assert.equal(s.polish.zoom, "auto");
    assert.equal(s.polish.cursor, "smooth");
    assert.equal(s.deterministic.disableAnimations, true);
    assert.equal(s.output.preset, "share");
  });

  test("requires at least one output target", () => {
    const r = specSchema.safeParse({ steps: [{ goto: "/" }], output: {} });
    assert.equal(r.success, false);
  });

  test("accepts any output target on its own", () => {
    for (const key of ["gif", "mp4", "webm", "storyboard", "html"]) {
      const r = outputSchema.safeParse({ [key]: "out/x" });
      assert.equal(r.success, true, `${key} should be a valid sole target`);
    }
  });

  test("rejects unknown keys inside a step", () => {
    // Steps are strict so a typo fails loudly instead of being silently ignored.
    const r = specSchema.safeParse({
      steps: [{ click: "#a", ms: 100 }],
      output: { gif: "out/demo.gif" },
    });
    assert.equal(r.success, false);
  });

  test("rejects an empty step list", () => {
    assert.equal(specSchema.safeParse({ steps: [], output: { gif: "g" } }).success, false);
  });

  test("normalizes a bare redact list into the object form", () => {
    const s = specSchema.parse({ ...minimal, redact: ["#email", ".avatar"] });
    assert.deepEqual(s.redact?.selectors, ["#email", ".avatar"]);
    assert.equal(s.redact?.mode, "blur");
  });

  test("defaults the typing delay so text reads on camera", () => {
    const s = specSchema.parse({
      steps: [{ type: { selector: "#a", text: "hi" } }],
      output: { gif: "g" },
    });
    const step = s.steps[0] as { type: { delay: number } };
    assert.equal(step.type.delay, 60);
  });
});

describe("resolveOutputProfile", () => {
  test("takes its defaults from the named preset", () => {
    const p = resolveOutputProfile(outputSchema.parse({ gif: "g", preset: "readme" }));
    assert.deepEqual(p, {
      fps: PRESETS.readme.fps,
      maxWidth: PRESETS.readme.maxWidth,
      gif: { ...PRESETS.readme.gif },
    });
  });

  test("lets explicit fields override the preset", () => {
    const p = resolveOutputProfile(
      outputSchema.parse({ gif: "g", preset: "hq", fps: 12, gifColors: 32 }),
    );
    assert.equal(p.fps, 12);
    assert.equal(p.gif.colors, 32);
    assert.equal(p.maxWidth, PRESETS.hq.maxWidth, "untouched fields keep the preset value");
  });
});

describe("resolveOutput", () => {
  const loaded = { spec: {} as never, path: "/w/demos/d.reel.yaml", dir: "/w/demos" };

  test("a relative path resolves against the spec's directory", () => {
    assert.equal(resolveOutput(loaded, "out/a.mp4"), "/w/demos/out/a.mp4");
  });

  test("an absolute path is left alone", () => {
    assert.equal(resolveOutput(loaded, "/tmp/a.mp4"), "/tmp/a.mp4");
  });

  test("~ expands to the home directory", () => {
    // Without this, `~/auth.json` resolved to `/w/demos/~/auth.json` — a path
    // that cannot exist, reported as a directory the spec's author never wrote.
    assert.equal(resolveOutput(loaded, "~/auth.json"), join(homedir(), "auth.json"));
    assert.equal(resolveOutput(loaded, "~"), homedir());
  });

  test("~user is not expanded — it needs a passwd lookup", () => {
    const out = resolveOutput(loaded, "~someone/auth.json");
    assert.equal(out, "/w/demos/~someone/auth.json");
  });

  test("a tilde anywhere but the start is an ordinary character", () => {
    assert.equal(resolveOutput(loaded, "out/a~b.mp4"), "/w/demos/out/a~b.mp4");
  });
});
