import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "../src/ui/server.js";

const SPEC = `name: A demo
url: http://localhost:1/
steps:
  - goto: /
output:
  gif: out/demo.gif
`;

let dir: string;
let port: number;
let close: (() => void) | undefined;
const prevCwd = process.cwd();

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "reel-studio-save-"));
  process.chdir(dir);
  port = 4700 + Math.floor(process.pid % 200);
  const srv = (await startApiServer(port)) as unknown as { close?: () => void } | undefined;
  close = srv?.close?.bind(srv);
});

after(() => {
  close?.();
  process.chdir(prevCwd);
});

const post = (body: unknown) =>
  fetch(`http://localhost:${port}/api/spec`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json() as Promise<{ ok: boolean; error?: string }>);

describe("saving a spec from Studio", () => {
  // Found by destroying a real 118-step spec. Studio saves before every
  // Record, Check and Heal; a spec that had not finished loading posted an
  // empty editor buffer, blank YAML parses cleanly, and the file was written
  // over with nothing. No error, no undo, and the file was the only copy.
  test("an empty buffer does not overwrite a spec that has content", async () => {
    await writeFile(join(dir, "d.reel.yaml"), SPEC, "utf8");
    const r = await post({ path: "d.reel.yaml", raw: "" });
    assert.equal(r.ok, false, "the save must be refused");
    assert.match(r.error ?? "", /empty/i);
    assert.equal(await readFile(join(dir, "d.reel.yaml"), "utf8"), SPEC, "the file is untouched");
  });

  test("whitespace only is just as empty", async () => {
    await writeFile(join(dir, "w.reel.yaml"), SPEC, "utf8");
    const r = await post({ path: "w.reel.yaml", raw: "\n\n   \n" });
    assert.equal(r.ok, false);
    assert.equal(await readFile(join(dir, "w.reel.yaml"), "utf8"), SPEC);
  });

  test("a real edit still saves", async () => {
    await writeFile(join(dir, "e.reel.yaml"), SPEC, "utf8");
    const edited = SPEC.replace("A demo", "A renamed demo");
    const r = await post({ path: "e.reel.yaml", raw: edited });
    assert.equal(r.ok, true, r.error);
    assert.equal(await readFile(join(dir, "e.reel.yaml"), "utf8"), edited);
  });

  test("an incomplete draft still saves — that part was right", async () => {
    // Saving work in progress is deliberate; only *nothing* is refused.
    await writeFile(join(dir, "p.reel.yaml"), SPEC, "utf8");
    const r = await post({ path: "p.reel.yaml", raw: "name: half written\n" });
    assert.equal(r.ok, true, r.error);
    assert.match(await readFile(join(dir, "p.reel.yaml"), "utf8"), /half written/);
  });
});
