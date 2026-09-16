import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Ajv, type ErrorObject } from "ajv";
import { generate, readSource, serialize, SCHEMA_OUT } from "../scripts/gen-schema.js";
import { SCHEMA_FILE, SCHEMA_URL, schemaDirective } from "../src/commands/schema.js";

type Json = Record<string, any>;

async function committed(): Promise<Json> {
  return JSON.parse(await readFile(SCHEMA_FILE, "utf8"));
}

describe("the committed schema", () => {
  test("matches what the zod schema generates", async () => {
    // The whole point of generating it is that the grammar can't drift. If this
    // fails, the spec schema changed and `npm run schema` hasn't been re-run —
    // an editor would be completing keys the driver rejects.
    const fresh = serialize(generate(await readSource()));
    const onDisk = await readFile(SCHEMA_OUT, "utf8");
    assert.equal(onDisk, fresh, "run `npm run schema` and commit the result");
  });

  test("is where the package says it is", async () => {
    // `reel schema` resolves this from the installed package, which is a
    // different path from the generator's — they have to agree.
    assert.deepEqual(await committed(), JSON.parse(await readFile(SCHEMA_OUT, "utf8")));
  });

  test("identifies itself by the URL editors fetch", async () => {
    assert.equal((await committed()).$id, SCHEMA_URL);
  });
});

describe("what an editor gets", () => {
  test("every top-level spec key is offered", async () => {
    const props = Object.keys((await committed()).properties);
    for (const key of ["name", "url", "viewport", "theme", "steps", "output", "terminal", "polish"]) {
      assert.ok(props.includes(key), `missing ${key}`);
    }
  });

  test("only steps and output are required", async () => {
    // Everything else has a default, and a schema that demanded them would
    // underline a perfectly good spec.
    assert.deepEqual((await committed()).required, ["steps", "output"]);
  });

  test("a spec is closed, so a typo is an error rather than an ignored key", async () => {
    assert.equal((await committed()).additionalProperties, false);
  });

  test("enumerates the step kinds", async () => {
    const kinds = (await committed()).properties.steps.items.anyOf[0].anyOf as Json[];
    const names = kinds.map((k) => Object.keys(k.properties)[0]);
    for (const kind of ["goto", "click", "type", "waitFor", "expect", "caption", "run", "beat"]) {
      assert.ok(names.includes(kind), `missing step kind ${kind}`);
    }
  });

  test("branch steps are part of the grammar", async () => {
    const step = (await committed()).properties.steps.items.anyOf[1] as Json;
    assert.ok(step.properties.branch, "a branch step should be offered alongside the rest");
  });

  test("closed enums are enumerated, so the value is completed too", async () => {
    const c = await committed();
    assert.deepEqual(c.properties.polish.properties.frame.enum, ["none", "browser", "window"]);
    assert.deepEqual(c.properties.theme.enum, ["light", "dark"]);
  });

  test("carries the documentation, not just the shape", async () => {
    // Harvested from the doc comments in src/spec/schema.ts — the description
    // is what turns completion into something you can learn the format from.
    const c = await committed();
    assert.ok(c.properties.url.description, "url should be documented");
    assert.ok(c.properties.polish.properties.zoom.description, "polish.zoom should be documented");
    const kinds = c.properties.steps.items.anyOf[0].anyOf as Json[];
    const undocumented = kinds.filter((k) => !k.description).map((k) => Object.keys(k.properties)[0]);
    assert.deepEqual(undocumented, [], "every step kind should describe itself on hover");
  });

  test("defaults are published, so an editor can show what happens if you omit a key", async () => {
    assert.equal((await committed()).properties.polish.properties.captions.default, true);
  });
});

describe("every shipped spec validates against it", () => {
  // The strongest check available: the specs in the repo are what the docs tell
  // people to copy, so a schema that rejects them would underline working YAML
  // in the editor of everyone who followed the README.
  test("the examples are accepted", async () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(await committed());

    // `readdir` rather than `glob`: glob landed in Node 22 and Reel supports 20,
    // which CI runs — a test that only passes on the newest Node tests nothing
    // about the versions people actually have.
    const specs = (await readdir("examples", { recursive: true }))
      .filter((f) => f.endsWith(".reel.yaml"))
      .map((f) => join("examples", f));
    assert.ok(specs.length >= 3, `expected to find the example specs, found ${specs.length}`);

    for (const file of specs) {
      const doc = parseYaml(await readFile(file, "utf8"));
      const ok = validate(doc);
      const why = (validate.errors ?? [])
        .map((e: ErrorObject) => `${e.instancePath || "/"} ${e.message}`)
        .slice(0, 5)
        .join("; ");
      assert.ok(ok, `${file} should validate: ${why}`);
    }
  });

  test("and a broken one is rejected", async () => {
    // Without this the test above would pass just as happily against a schema
    // that accepts anything.
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(await committed());

    assert.equal(validate({ output: { gif: "a.gif" } }), false, "steps are required");
    assert.equal(
      validate({ steps: [{ clik: "#a" }], output: { gif: "a.gif" } }),
      false,
      "a misspelled step kind should be caught, which is the point of the schema",
    );
    assert.equal(
      validate({ steps: [{ goto: "/" }], output: { gif: "a.gif" }, viewpost: {} }),
      false,
      "a misspelled top-level key should be caught",
    );
    assert.equal(
      validate({ steps: [{ goto: "/" }], output: { gif: "a.gif" }, theme: "sepia" }),
      false,
      "a value outside a closed enum should be caught",
    );
  });
});

describe("the schema directive", () => {
  test("is the line yaml-language-server looks for", () => {
    assert.equal(schemaDirective(), `# yaml-language-server: $schema=${SCHEMA_URL}`);
  });

  test("can point at a vendored copy instead", () => {
    // For an editor with no network access, or a repo pinning the grammar to
    // the Reel version it records with.
    assert.equal(schemaDirective("./reel.schema.json"), "# yaml-language-server: $schema=./reel.schema.json");
  });
});
