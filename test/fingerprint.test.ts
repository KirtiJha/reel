import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { fingerprint, isUpToDate, declaredOutputs, RENDER_EPOCH } from "../src/spec/fingerprint.js";
import { specSchema } from "../src/spec/schema.js";
import type { LoadedSpec } from "../src/spec/load.js";

async function fixture(yaml: string): Promise<LoadedSpec> {
  const dir = await mkdtemp(join(tmpdir(), "reel-fp-"));
  const path = join(dir, "demo.reel.yaml");
  await writeFile(path, yaml, "utf8");
  return { spec: specSchema.parse(parse(yaml)), path, dir };
}

const SPEC = `
name: Demo
url: http://localhost:3000
steps:
  - goto: /
output:
  gif: out/demo.gif
`;

const stamp = (over: Record<string, unknown> = {}) => ({
  hash: "h",
  version: "0.1.0",
  epoch: RENDER_EPOCH,
  at: new Date().toISOString(),
  outputs: [],
  ...over,
});

describe("fingerprint", () => {
  test("is stable for the same spec", async () => {
    const f = await fixture(SPEC);
    const a = await fingerprint(f, "0.1.0");
    const b = await fingerprint(f, "0.1.0");
    assert.equal(a.hash, b.hash);
  });

  test("changes when the spec text changes", async () => {
    const a = await fingerprint(await fixture(SPEC), "0.1.0");
    const b = await fingerprint(await fixture(SPEC + "\n# a comment\n"), "0.1.0");
    assert.notEqual(a.hash, b.hash);
  });

  test("changes when Reel's version changes", async () => {
    // A new Reel could render differently; skipping across versions is unsafe.
    const f = await fixture(SPEC);
    assert.notEqual(
      (await fingerprint(f, "0.1.0")).hash,
      (await fingerprint(f, "0.2.0")).hash,
    );
  });

  test("changes when the app revision changes", async () => {
    const f = await fixture(SPEC);
    assert.notEqual(
      (await fingerprint(f, "0.1.0", "abc123")).hash,
      (await fingerprint(f, "0.1.0", "def456")).hash,
    );
  });

  test("an unspecified app revision is not the same as a specified one", async () => {
    const f = await fixture(SPEC);
    assert.notEqual(
      (await fingerprint(f, "0.1.0")).hash,
      (await fingerprint(f, "0.1.0", "abc123")).hash,
    );
  });

  test("covers referenced files, not just the YAML", async () => {
    // A HAR is not part of the spec text but absolutely changes the render.
    const dir = await mkdtemp(join(tmpdir(), "reel-fp-"));
    const har = join(dir, "net.har");
    const yaml = `name: D\nmock: { har: net.har }\nsteps: [{ goto: / }]\noutput: { gif: out/d.gif }\n`;
    const path = join(dir, "demo.reel.yaml");
    await writeFile(path, yaml, "utf8");
    const loaded: LoadedSpec = { spec: specSchema.parse(parse(yaml)), path, dir };

    await writeFile(har, '{"log":{"entries":[]}}');
    const before = await fingerprint(loaded, "0.1.0");
    await writeFile(har, '{"log":{"entries":[1]}}');
    const after = await fingerprint(loaded, "0.1.0");
    assert.notEqual(before.hash, after.hash, "a changed HAR must invalidate the render");
  });

  test("a missing referenced file differs from a present one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reel-fp-"));
    const har = join(dir, "net.har");
    const yaml = `name: D\nmock: { har: net.har }\nsteps: [{ goto: / }]\noutput: { gif: out/d.gif }\n`;
    const path = join(dir, "demo.reel.yaml");
    await writeFile(path, yaml, "utf8");
    const loaded: LoadedSpec = { spec: specSchema.parse(parse(yaml)), path, dir };

    const missing = await fingerprint(loaded, "0.1.0");
    await writeFile(har, "{}");
    const present = await fingerprint(loaded, "0.1.0");
    assert.notEqual(missing.hash, present.hash);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("isUpToDate", () => {
  const fp = { hash: "h", inputs: [], version: "0.1.0", epoch: RENDER_EPOCH };

  test("no stamp means never rendered", async () => {
    const r = await isUpToDate(null, fp, []);
    assert.equal(r.upToDate, false);
    assert.match(r.reason, /no previous render/);
  });

  test("a matching stamp with intact outputs is up to date", async () => {
    const r = await isUpToDate(stamp(), fp, []);
    assert.equal(r.upToDate, true);
  });

  test("a different fingerprint re-renders", async () => {
    const r = await isUpToDate(stamp({ hash: "other" }), fp, []);
    assert.equal(r.upToDate, false);
    assert.match(r.reason, /spec or its inputs/);
  });

  test("a renderer epoch bump re-renders everything", async () => {
    // The escape hatch for 'Reel now draws this differently'.
    const r = await isUpToDate(stamp({ epoch: RENDER_EPOCH - 1 }), fp, []);
    assert.equal(r.upToDate, false);
    assert.match(r.reason, /renderer changed/);
  });

  test("a deleted output re-renders and names the file", async () => {
    const r = await isUpToDate(stamp(), fp, ["/definitely/not/here.gif"]);
    assert.equal(r.upToDate, false);
    assert.match(r.reason, /output missing/);
    assert.match(r.reason, /here\.gif/);
  });
});

describe("declaredOutputs", () => {
  test("lists every declared artifact as an absolute path", async () => {
    const yaml = `name: D\nsteps: [{ goto: / }]\noutput: { gif: out/d.gif, mp4: out/d.mp4, storyboard: out/sb }\n`;
    const f = await fixture(yaml);
    const outs = declaredOutputs(f);
    assert.equal(outs.length, 3);
    assert.ok(outs.every((p) => p.startsWith("/")));
  });
});
