import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parse } from "yaml";
import {
  fingerprint,
  isUpToDate,
  declaredOutputs,
  readStamp,
  relativeToStamp,
  writeStamp,
  RENDER_EPOCH,
} from "../src/spec/fingerprint.js";
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
    // `isAbsolute`, not a leading slash: an absolute path on Windows is `C:\…`.
    assert.ok(outs.every((p) => isAbsolute(p)));
  });
});

describe("the stamp is committed, so it has to be reproducible", () => {
  async function written(outputs: string[]): Promise<{ path: string; raw: string }> {
    const dir = await mkdtemp(join(tmpdir(), "reel-stamp-"));
    const path = join(dir, "docs", ".reel-stamp.json");
    await writeStamp(path, { hash: "h", inputs: [], version: "0.2.0", epoch: RENDER_EPOCH }, outputs);
    return { path, raw: await readFile(path, "utf8") };
  }

  test("carries no timestamp", async () => {
    // An `at` field meant a demo whose media was byte-identical still showed up
    // as a change — destroying the one signal committed media is there to give.
    const { raw } = await written([]);
    assert.doesNotMatch(raw, /"at"/);
    assert.doesNotMatch(raw, /\d{4}-\d{2}-\d{2}T/);
  });

  test("records outputs relative to itself, never absolute", async () => {
    // These used to be absolute: somebody's home directory, in a public repo,
    // different on every machine.
    const dir = await mkdtemp(join(tmpdir(), "reel-stamp-"));
    const path = join(dir, "docs", ".reel-stamp.json");
    await writeStamp(path, { hash: "h", inputs: [], version: "0.2.0", epoch: RENDER_EPOCH }, [
      join(dir, "docs", "demo.gif"),
      join(dir, "examples", "out", "showcase.html"),
    ]);
    const read = await readStamp(path);
    assert.deepEqual(read?.outputs, ["../examples/out/showcase.html", "demo.gif"]);
    assert.ok(!read!.outputs.some((o) => isAbsolute(o)), read!.outputs.join(", "));
  });

  test("orders them, so a reshuffle is not a change", async () => {
    // Encoders finish in whatever order they finish. That is not a change to
    // the demo, and it should not read as one in a diff.
    const fp = { hash: "h", inputs: [], version: "0.2.0", epoch: RENDER_EPOCH };
    const write = async (names: string[]): Promise<string> => {
      const dir = await mkdtemp(join(tmpdir(), "reel-stamp-"));
      const path = join(dir, "docs", ".reel-stamp.json");
      await writeStamp(path, fp, names.map((n) => join(dir, "docs", n)));
      return readFile(path, "utf8");
    };
    assert.equal(await write(["b.gif", "a.gif"]), await write(["a.gif", "b.gif"]));
  });

  test("two writes of the same render are byte-identical", async () => {
    const first = await written([]);
    const again = await written([]);
    assert.equal(first.raw, again.raw);
  });
});

describe("relativeToStamp", () => {
  test("a sibling is just its name", () => {
    assert.equal(relativeToStamp("/w/docs/.reel-stamp.json", "/w/docs/demo.gif"), "demo.gif");
  });

  test("somewhere else climbs out", () => {
    assert.equal(relativeToStamp("/w/docs/.reel-stamp.json", "/w/out/x.html"), "../out/x.html");
  });

  test("always forward slashes, so Windows writes what everyone else reads", () => {
    assert.doesNotMatch(relativeToStamp("/w/docs/.reel-stamp.json", "/w/a/b/c.gif"), /\\/);
  });
});
