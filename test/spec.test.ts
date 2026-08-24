import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { specSchema, resolveOutputProfile, outputSchema, PRESETS } from "../src/spec/schema.js";
import { resolveOutput } from "../src/spec/load.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
  // Absolute in this platform's own terms. On Windows a bare "/w/demos" has no
  // drive letter, so the resolved answer picks up the current drive and no
  // hand-written POSIX string can match it — which is exactly how these tests
  // passed everywhere except the platform half of Reel's users are on.
  const dir = resolve("/w/demos");
  const loaded = { spec: {} as never, path: join(dir, "d.reel.yaml"), dir };

  test("a relative path resolves against the spec's directory", () => {
    // Built with `join` rather than `resolve`, so this asserts *where* the path
    // was resolved from instead of restating the implementation.
    assert.equal(resolveOutput(loaded, "out/a.mp4"), join(dir, "out", "a.mp4"));
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
    assert.equal(resolveOutput(loaded, "~someone/auth.json"), join(dir, "~someone", "auth.json"));
  });

  test("a tilde anywhere but the start is an ordinary character", () => {
    assert.equal(resolveOutput(loaded, "out/a~b.mp4"), join(dir, "out", "a~b.mp4"));
  });
});

describe("a key Reel does not recognize is an error", () => {
  // This is a version-skew guard as much as a typo guard. A spec written
  // against a newer Reel and run on an older one used to render happily and
  // quietly do less than it said: `cuts:` was dropped, four deliverables
  // became one, and nothing reported it.
  test("an unknown top-level key is rejected, and named", () => {
    // Stands in for a key some future Reel adds: this version has never heard
    // of it, which is exactly the case an older Reel is in when it meets a
    // spec that uses `cuts:`. It must refuse rather than render a lesser demo.
    const r = specSchema.safeParse({ ...minimal, chapters: [{ name: "readme" }] });
    assert.equal(r.success, false, "a spec using a key this version lacks must not parse");
    if (!r.success) {
      assert.match(JSON.stringify(r.error.issues), /chapters/, "the error should name the key");
    }
  });

  test("a misspelled known key is rejected rather than ignored", () => {
    // `polsih:` renders a demo without the polish you asked for and looks
    // like it worked, which is the same failure wearing a different hat.
    const r = specSchema.safeParse({ ...minimal, polsih: { zoom: "auto" } });
    assert.equal(r.success, false);
  });

  test("a spec using only keys this version knows still parses", () => {
    const r = specSchema.safeParse({
      ...minimal,
      polish: { frame: "browser", frameUrl: "example.com" },
      cuts: [{ name: "readme", from: "hero", output: { gif: "out/a.gif" } }],
    });
    assert.equal(r.success, true, r.success ? "" : JSON.stringify(r.error.issues));
  });
});

describe("waiting for something that is legitimately slow", () => {
  // The default wait is short on purpose: a broken selector should fail fast
  // rather than stall a recording. But some waits are real — a build running
  // inside the page, a job whose progress the UI streams — and raising the
  // default globally would trade that away for every step.
  test("a bare selector still works, and takes no timeout", () => {
    const r = specSchema.safeParse({ ...minimal, steps: [{ waitFor: "text=Done" }] });
    assert.equal(r.success, true);
    if (r.success) {
      const step = r.data.steps[0];
      assert.ok(step && "waitFor" in step);
      assert.equal(step.waitFor, "text=Done");
    }
  });

  test("a slow wait can name its own timeout", () => {
    const r = specSchema.safeParse({
      ...minimal,
      steps: [{ waitFor: { selector: "text=Drift check passed", timeout: 180_000 } }],
    });
    assert.equal(r.success, true, r.success ? "" : JSON.stringify(r.error.issues));
    if (r.success) {
      const step = r.data.steps[0];
      assert.ok(step && "waitFor" in step);
      const w = step.waitFor;
      assert.equal(typeof w === "string" ? null : w.timeout, 180_000);
    }
  });

  test("a timeout of zero is refused — it would mean 'never wait'", () => {
    const r = specSchema.safeParse({
      ...minimal,
      steps: [{ waitFor: { selector: "text=Done", timeout: 0 } }],
    });
    assert.equal(r.success, false);
  });
});
