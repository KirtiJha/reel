import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSpec } from "../src/spec/load.js";
import { stepKinds } from "../src/spec/schema.js";
import { tempDir } from "./tmp.js";

async function specFile(steps: string): Promise<string> {
  const d = await tempDir("reel-spec");
  const f = join(d, "demo.reel.yaml");
  await writeFile(
    f,
    `name: probe\nurl: http://localhost:9999\noutput: { gif: out.gif }\nsteps:\n${steps}`,
  );
  return f;
}

async function errorFor(steps: string): Promise<string> {
  try {
    await loadSpec(await specFile(steps));
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the spec to be rejected");
}

describe("a wrong option inside a step names the option, not the step", () => {
  // The union reports whichever branch lost, so a step with the right kind and
  // a wrong option used to blame the kind — the one part that was correct.
  test("an unrecognized option is named", async () => {
    const msg = await errorFor(`  - expect: { selector: "h1", contains: "Hi" }\n`);
    assert.match(msg, /contains/);
    assert.ok(!/Unrecognized key\(s\) in object: 'expect'/.test(msg), msg);
  });

  test("a missing required option names the field", async () => {
    const msg = await errorFor(`  - type: { selector: "#e", value: "hello" }\n`);
    assert.match(msg, /type\.text/);
  });
});

describe("a misspelled step kind suggests the real one", () => {
  for (const [typo, real] of [["clik", "click"], ["captionn", "caption"], ["hovr", "hover"]]) {
    test(`${typo} → ${real}`, async () => {
      assert.match(await errorFor(`  - ${typo}: "#a"\n`), new RegExp(`did you mean \`${real}\``));
    });
  }

  test("a word that is not a typo gets no misleading suggestion", async () => {
    const msg = await errorFor(`  - teleport: "#a"\n`);
    assert.ok(!/did you mean/.test(msg), msg);
  });
});

describe("inner step options are strict", () => {
  // These two steps are what make `reel check` a real smoke test rather than a
  // selector-existence probe. A misspelled key used to drop the assertion and
  // still pass, which is the worst possible direction for the failure.
  test("a dropped `expect` assertion is now an error", async () => {
    const f = await specFile(`  - expect: { selector: "h1", contain: "x" }\n`);
    await assert.rejects(() => loadSpec(f));
  });

  test("a dropped `run` exit-code assertion is now an error", async () => {
    const f = await specFile(`  - run: { cmd: "ls", expectCoded: 1 }\n`);
    await assert.rejects(() => loadSpec(f));
  });

  test("a dropped `highlight` option is now an error", async () => {
    const f = await specFile(`  - highlight: { selector: "#a", shappe: circle }\n`);
    await assert.rejects(() => loadSpec(f));
  });
});

describe("stepKinds", () => {
  test("names the real steps, for suggestions and for docs", () => {
    const kinds = stepKinds();
    for (const k of ["click", "type", "expect", "caption", "beat", "highlight"]) {
      assert.ok(kinds.includes(k), `missing ${k}`);
    }
  });
});
