import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startApiServer } from "../src/ui/server.js";
import { loadSpec } from "../src/spec/load.js";
import { record, Cancelled } from "../src/driver/run.js";
import { tempDir } from "./tmp.js";

/**
 * The parts of Studio that are jobs rather than documents.
 *
 * Rendering one beat, saying what changed, accepting a drafted line and
 * stopping a run all cross the API, so they are tested there — against the same
 * in-process server the Next UI proxies to.
 */

const SPEC = `name: Tasks
url: http://localhost:1/
steps:
  - card: Welcome
  - goto: /
  - beat: created
output:
  gif: out/demo.gif
`;

let dir: string;
let port: number;
let close: (() => void) | undefined;
const prevCwd = process.cwd();

before(async () => {
  dir = await tempDir("reel-studio-jobs");
  process.chdir(dir);
  await writeFile(join(dir, "d.reel.yaml"), SPEC, "utf8");
  port = 5300 + Math.floor(process.pid % 150);
  const srv = (await startApiServer(port)) as unknown as { close?: () => void } | undefined;
  close = srv?.close?.bind(srv);
});

after(() => {
  close?.();
  process.chdir(prevCwd);
});

const post = <T>(path: string, body: unknown) =>
  fetch(`http://localhost:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json() as Promise<T>);

const get = <T>(path: string) =>
  fetch(`http://localhost:${port}${path}`).then((r) => r.json() as Promise<T>);

/** Drain a streamed job and hand back its final line. */
async function job(path: string, body: unknown): Promise<any> {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return lines.find((l) => l.type === "done");
}

describe("rendering one beat", () => {
  test("the beats endpoint names every beat `--only` would accept", async () => {
    const r = await post<{ labels: string[]; rendered: boolean }>("/api/beats", {
      path: "d.reel.yaml",
    });
    // A card is a beat as far as `--only` is concerned, which is why the list
    // comes from the driver's own enumerator rather than from the outline.
    assert.deepEqual(r.labels, ["Welcome", "created"]);
    assert.equal(r.rendered, false, "nothing has been rendered yet");
  });
});

describe("accepting a drafted line", () => {
  test("the silent moments are addressed, and a line can be written under one", async () => {
    await writeFile(join(dir, "s.reel.yaml"), SPEC, "utf8");
    const { moments } = await post<{ moments: { where: string }[] }>("/api/silent", {
      path: "s.reel.yaml",
    });
    assert.deepEqual(
      moments.map((m) => m.where),
      ["card “Welcome”", "beat “created”"],
    );

    const r = await post<{ ok: boolean; raw?: string; error?: string }>("/api/accept-say", {
      path: "s.reel.yaml",
      index: 0,
      where: "card “Welcome”",
      text: "This is Tasks.",
    });
    assert.equal(r.ok, true, r.error);
    const onDisk = await readFile(join(dir, "s.reel.yaml"), "utf8");
    assert.match(onDisk, /say: This is Tasks\./);
    assert.match(onDisk, /title: Welcome/, "the shorthand grew rather than being replaced");

    // And the moment it filled is no longer offered.
    const after = await post<{ moments: { where: string }[] }>("/api/silent", {
      path: "s.reel.yaml",
    });
    assert.deepEqual(
      after.moments.map((m) => m.where),
      ["beat “created”"],
    );
  });

  test("an index that no longer means what it did is refused", async () => {
    await writeFile(join(dir, "m.reel.yaml"), SPEC, "utf8");
    const r = await post<{ ok: boolean; error?: string }>("/api/accept-say", {
      path: "m.reel.yaml",
      index: 0,
      where: "card “Something else”",
      text: "Nope.",
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /moved/i);
    assert.equal(await readFile(join(dir, "m.reel.yaml"), "utf8"), SPEC, "the file is untouched");
  });
});

describe("what changed", () => {
  test("says why there is nothing to compare rather than offering a broken button", async () => {
    const r = await get<{ before?: string; why?: string }>(
      "/api/changed?path=" + encodeURIComponent("d.reel.yaml"),
    );
    assert.equal(r.before, undefined);
    assert.match(r.why ?? "", /two renders/i);
  });

  test("and the comparison itself fails with that reason rather than a stack trace", async () => {
    const done = await job("/api/diff", { path: "d.reel.yaml" });
    assert.equal(done.ok, false);
    assert.match(done.error, /two renders/i);
  });
});

describe("cancelling", () => {
  test("with nothing running, it says so", async () => {
    const r = await post<{ ok: boolean; error?: string }>("/api/cancel", {});
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Nothing is running/);
  });

  test("an already-aborted render stops before it boots anything", async () => {
    // The honest half of the feature: the signal reaches the driver, and the
    // driver stops. If this only closed the log stream, the app and the
    // browser would still be coming up right now.
    const loaded = await loadSpec(join(dir, "d.reel.yaml"));
    await assert.rejects(
      () => record(loaded, "record", {}, AbortSignal.abort()),
      (err: Error) => {
        assert.ok(err instanceof Cancelled, "cancelling is its own kind of error, not a failure");
        assert.match(err.message, /Cancelled/);
        return true;
      },
    );
  });
});
