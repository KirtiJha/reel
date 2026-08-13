import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureFailure, stripAnsi } from "../src/driver/failure.js";
import { specSchema, type Step } from "../src/spec/schema.js";

function step(raw: unknown): Step {
  return specSchema.parse({ steps: [raw], output: { gif: "g" } }).steps[0]!;
}

const ctx = (dir: string, over: Record<string, unknown> = {}) => ({
  stepNumber: 7,
  label: 'click the element "#save"',
  step: step({ click: "#save" }),
  error: new Error("locator.click: Timeout 8000ms exceeded."),
  specPath: join(dir, "demo.reel.yaml"),
  outDir: join(dir, "out"),
  ...over,
});

describe("stripAnsi", () => {
  test("removes terminal colour codes", () => {
    assert.equal(stripAnsi("[2mwaiting[22m"), "waiting");
  });

  test("leaves ordinary text alone", () => {
    assert.equal(stripAnsi("Timeout 8000ms exceeded."), "Timeout 8000ms exceeded.");
  });

  test("handles a multi-line Playwright call log", () => {
    const raw = "locator.click: Timeout\nCall log:\n[2m  - waiting for locator('#a')[22m";
    assert.ok(!stripAnsi(raw).includes(""));
    assert.ok(stripAnsi(raw).includes("waiting for locator"));
  });
});

describe("captureFailure", () => {
  test("writes a report even with no page and no frames", async () => {
    // check mode with a crashed browser is the worst case; it must still leave
    // something behind rather than throwing inside the error path.
    const dir = await mkdtemp(join(tmpdir(), "reel-fail-"));
    const a = await captureFailure(null, ctx(dir));
    assert.ok(a, "returns artifacts");
    const report = JSON.parse(await readFile(a!.report, "utf8"));
    assert.equal(report.step, 7);
    assert.equal(report.kind, "click");
    assert.match(report.label, /#save/);
  });

  test("strips ANSI out of the recorded error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reel-fail-"));
    const a = await captureFailure(
      null,
      ctx(dir, { error: new Error("Timeout\n[2m  - waiting[22m") }),
    );
    const report = JSON.parse(await readFile(a!.report, "utf8"));
    assert.ok(!report.error.includes(""), "no escape codes in the JSON");
    assert.match(report.error, /waiting/);
  });

  test("records the step kind, so a reader knows what broke", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reel-fail-"));
    const a = await captureFailure(null, ctx(dir, { step: step({ expect: { selector: "#c", text: "x" } }) }));
    const report = JSON.parse(await readFile(a!.report, "utf8"));
    assert.equal(report.kind, "expect");
  });

  test("names no artifacts it didn't manage to write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reel-fail-"));
    const a = await captureFailure(null, ctx(dir));
    assert.equal(a!.screenshot, undefined);
    assert.equal(a!.clip, undefined);
    const files = await readdir(a!.dir);
    assert.deepEqual(files, ["failure.json"]);
  });

  test("returns null rather than throwing when the directory can't be made", async () => {
    // Never let the failure reporter become the failure. A file standing where
    // a parent directory should be gives a deterministic ENOTDIR.
    const dir = await mkdtemp(join(tmpdir(), "reel-fail-"));
    const blocker = join(dir, "not-a-dir");
    await writeFile(blocker, "");
    const a = await captureFailure(null, ctx(dir, { outDir: join(blocker, "nested") }));
    assert.equal(a, null);
  });

  test("timestamps the report", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reel-fail-"));
    const a = await captureFailure(null, ctx(dir));
    const report = JSON.parse(await readFile(a!.report, "utf8"));
    assert.ok(!Number.isNaN(Date.parse(report.at)));
  });
});
