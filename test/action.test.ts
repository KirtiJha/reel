import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { CI_DEFAULTS } from "../src/commands/ci.js";
import { VERSION } from "../src/version.js";

/**
 * The action is YAML, which nothing else in this repository typechecks.
 *
 * These are the mistakes that YAML makes easy and CI makes expensive: an input
 * added to the interface and never wired to a step, a step reading an input
 * nobody declared, a default that drifts from the CLI's. Each one produces an
 * action that runs and quietly does the wrong thing, which is the failure mode
 * worth spending a test on.
 */

const source = readFileSync("action.yml", "utf8");
const action = parse(source) as {
  name: string;
  description: string;
  inputs: Record<string, { description: string; default?: string }>;
  outputs: Record<string, { description: string; value: string }>;
  runs: { using: string; steps: { name?: string; uses?: string; id?: string; run?: string }[] };
};

describe("action.yml", () => {
  test("is a composite action", () => {
    // Not Docker (slow, and a container per run) and not a JS action, which
    // would mean bundling sharp and a browser driver into dist/.
    assert.equal(action.runs.using, "composite");
  });

  test("every declared input is actually used by a step", () => {
    const used = new Set([...source.matchAll(/inputs\.([a-z-]+)/g)].map((m) => m[1]!));
    const unused = Object.keys(action.inputs).filter((i) => !used.has(i));
    assert.deepEqual(unused, [], `declared but never read: ${unused.join(", ")}`);
  });

  test("every input a step reads is declared", () => {
    const used = [...source.matchAll(/inputs\.([a-z-]+)/g)].map((m) => m[1]!);
    const missing = used.filter((u) => !(u in action.inputs));
    assert.deepEqual([...new Set(missing)], [], "a step reads an input nobody declared");
  });

  test("every input and output is documented", () => {
    for (const [name, spec] of Object.entries(action.inputs)) {
      assert.ok(spec.description?.trim(), `input ${name} has no description`);
    }
    for (const [name, spec] of Object.entries(action.outputs)) {
      assert.ok(spec.description?.trim(), `output ${name} has no description`);
    }
  });

  test("every output is wired to the step that produces it", () => {
    const ids = new Set(action.runs.steps.map((s) => s.id).filter(Boolean));
    for (const [name, spec] of Object.entries(action.outputs)) {
      const m = /steps\.([a-z-]+)\.outputs\./.exec(spec.value);
      assert.ok(m, `output ${name} is not read from a step`);
      assert.ok(ids.has(m![1]!), `output ${name} reads step "${m![1]}", which does not exist`);
    }
  });

  test("its defaults are the CLI's defaults", () => {
    // Two sets of defaults is one set of defaults and one bug: a workflow that
    // omits `mode` should do what `reel ci` does when you omit `--mode`.
    assert.equal(action.inputs.mode!.default, CI_DEFAULTS.mode);
    assert.equal(action.inputs["fail-on"]!.default, CI_DEFAULTS.failOn);
  });

  test("boolean inputs default to strings, since that is all YAML gives a step", () => {
    // `default: false` arrives at the step as the string "false", and a step
    // comparing it to 'true' still works — but `if: inputs.x` does not. Keeping
    // them explicit strings makes the comparison the only idiom in the file.
    for (const name of ["review", "if-changed", "comment", "commit", "upload-artifacts"]) {
      assert.equal(typeof action.inputs[name]!.default, "string", `${name} default`);
    }
  });

  test("multi-command shell steps stop at the first error", () => {
    // Without `set -e` a failed npm install is a step that carries on to a
    // confusing error three commands later. A single command needs nothing:
    // its own exit code is already the step's.
    for (const step of action.runs.steps) {
      if (!step.run || step.uses) continue;
      const commands = step.run
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
      if (commands.length < 2) continue;
      assert.match(step.run, /set -euo pipefail/, `step "${step.name}" does not set -e`);
    }
  });

  test("no step uses `cond && append`, which set -e turns into a failure", () => {
    // A real bug this file had: under `set -e`, `[ "$X" = true ] && args+=(…)`
    // as the final statement exits non-zero whenever the condition is false.
    for (const step of action.runs.steps) {
      if (!step.run) continue;
      assert.doesNotMatch(
        step.run,
        /^\s*\[[^\]]*\]\s*&&\s*\w+\+=/m,
        `step "${step.name}" appends conditionally with &&`,
      );
    }
  });

  test("writing back is refused on a fork's pull request", () => {
    // `run.cmd` is executable code from the pull request. A write-back there
    // would be a supply-chain hole, not a convenience.
    const commit = action.runs.steps.find((s) => s.name?.startsWith("Commit"));
    const src = source.slice(source.indexOf("Commit regenerated media"));
    assert.ok(commit, "there is a commit step");
    assert.match(src, /head\.repo\.full_name == github\.repository/);
  });

  test("the comment step is likewise same-repo only", () => {
    const src = source.slice(source.indexOf("Comment on the pull request"));
    assert.match(src, /head\.repo\.full_name == github\.repository/);
  });

  test("the version the CLI reports is the version npm publishes", () => {
    // The action pins the tool by reading this package.json, and the fingerprint
    // that decides whether to skip a render is salted with the CLI's constant.
    // If they drift, the action installs one Reel and claims to be another.
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    assert.equal(VERSION, pkg.version);
  });

  test("the secret is an input, never read from the secrets context", () => {
    // Composite actions cannot see `secrets` at all; a reference would be an
    // empty string at runtime and look like a missing key.
    assert.doesNotMatch(source, /secrets\./);
  });
});
