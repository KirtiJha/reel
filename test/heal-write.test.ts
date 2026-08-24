import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { applyFixes } from "../src/heal/heal.js";

async function healed(spec: string, before: string, after: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "reel-heal-write-"));
  const path = join(dir, "d.reel.yaml");
  await writeFile(path, spec, "utf8");
  await applyFixes(path, [{ index: 1, before, after, label: "step" }]);
  return readFile(path, "utf8");
}

describe("writing a repair back into the spec", () => {
  test("rewrites the step whose selector is the whole value", async () => {
    const out = await healed(
      `steps:\n  - waitFor: "text=Aalu parwal sabji"\n`,
      "text=Aalu parwal sabji",
      "text=Aalu parwal sabzi",
    );
    assert.match(out, /waitFor: "text=Aalu parwal sabzi"/);
  });

  test("leaves a longer value that merely contains the selector alone", async () => {
    // The bug this exists for. A fix for one step used to rewrite the middle of
    // another, producing `""text=P" × 1 · just now"` — not YAML at all. `--write`
    // destroyed the spec it was asked to repair.
    const spec =
      `steps:\n` +
      `  - waitFor: "text=Aalu parwal sabji"\n` +
      `  - waitFor: "text=Aalu parwal sabji × 1 · just now"\n`;
    const out = await healed(spec, "text=Aalu parwal sabji", "text=P");

    assert.match(out, /waitFor: "text=Aalu parwal sabji × 1 · just now"/, "the longer value is untouched");
    assert.doesNotMatch(out, /""/, "no nested quotes anywhere");
  });

  test("whatever it writes still parses as YAML", async () => {
    const spec =
      `steps:\n` +
      `  - waitFor: "text=Aalu parwal sabji"\n` +
      `  - waitFor: "text=Aalu parwal sabji × 1 · just now"\n` +
      `  - expect: { selector: "text=Aalu parwal sabji", count: 1 }\n`;
    const out = await healed(spec, "text=Aalu parwal sabji", "text=Aalu parwal sabzi");
    const doc = parse(out) as { steps: unknown[] };
    assert.equal(doc.steps.length, 3, "the document still parses and keeps every step");
  });

  test("rewrites a selector inside an inline flow map", async () => {
    const out = await healed(
      `steps:\n  - expect: { selector: "text=Add", count: 1 }\n`,
      "text=Add",
      "text=Add task",
    );
    assert.match(out, /selector: "text=Add task", count: 1/);
    assert.equal((parse(out) as { steps: { expect: { count: number } }[] }).steps[0]?.expect.count, 1);
  });

  test("quotes a bare selector that YAML would otherwise misread", async () => {
    // `#add` unquoted is a comment, so the repair has to add quotes.
    const out = await healed(`steps:\n  - click: text=Add\n`, "text=Add", "#add");
    assert.match(out, /click: "#add"/);
    assert.equal((parse(out) as { steps: { click: string }[] }).steps[0]?.click, "#add");
  });
});
