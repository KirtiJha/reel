import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEnvEdits, writeEnvFile } from "../src/ui/env-file.js";

describe("applyEnvEdits", () => {
  test("updates an existing key in place", () => {
    const out = applyEnvEdits("A=1\nB=2\n", { B: "9" });
    assert.equal(out, "A=1\nB=9\n");
  });

  test("appends a key that isn't there yet", () => {
    const out = applyEnvEdits("A=1\n", { B: "2" });
    assert.match(out, /^A=1\n/);
    assert.match(out, /B=2/);
  });

  test("leaves unrelated keys, comments and blank lines alone", () => {
    // `.env` is hand-maintained; a save that reformatted it would quietly
    // destroy someone's notes and ordering.
    const source = "# my notes\n\nKEEP=untouched\n\n# section\nOTHER=also-untouched\n";
    const out = applyEnvEdits(source, { NEW: "x" });
    assert.match(out, /# my notes/);
    assert.match(out, /KEEP=untouched/);
    assert.match(out, /# section/);
    assert.match(out, /OTHER=also-untouched/);
  });

  test("does not resurrect a commented-out setting", () => {
    const out = applyEnvEdits("# B=old\nA=1\n", { B: "new" });
    assert.match(out, /# B=old/, "the comment stays a comment");
    assert.match(out, /\nB=new/, "the real setting is appended separately");
  });

  test("null removes the line rather than blanking the value", () => {
    // An empty value reads as "configured but blank" to some clients, which is
    // a different state from "not configured".
    const out = applyEnvEdits("A=1\nB=2\n", { B: null });
    assert.doesNotMatch(out, /B=/);
    assert.match(out, /A=1/);
  });

  test("removing a key that isn't present is a no-op", () => {
    assert.equal(applyEnvEdits("A=1\n", { B: null }), "A=1\n");
  });

  test("quotes a value containing a comment character so it survives a re-read", () => {
    const out = applyEnvEdits("", { K: "abc#def" });
    assert.match(out, /K="abc#def"/);
  });

  test("quotes a value containing spaces", () => {
    const out = applyEnvEdits("", { K: "two words" });
    assert.match(out, /K="two words"/);
  });

  test("leaves a plain value unquoted", () => {
    assert.match(applyEnvEdits("", { K: "sk-abc123" }), /K=sk-abc123/);
  });

  test("preserves indentation on an indented assignment", () => {
    assert.match(applyEnvEdits("  A=1\n", { A: "2" }), /^ {2}A=2/m);
  });

  test("handles an empty starting file", () => {
    const out = applyEnvEdits("", { A: "1" });
    assert.match(out, /A=1/);
  });

  test("updates several keys in one pass", () => {
    const out = applyEnvEdits("A=1\nB=2\nC=3\n", { A: "x", C: "z" });
    assert.match(out, /A=x/);
    assert.match(out, /B=2/);
    assert.match(out, /C=z/);
  });
});

describe("writeEnvFile", () => {
  async function tmpEnv(contents = ""): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "reel-env-"));
    const p = join(dir, ".env");
    await writeFile(p, contents);
    return p;
  }

  test("writes the values to disk", async () => {
    const p = await tmpEnv("EXISTING=keep\n");
    await writeEnvFile(p, { REEL_LLM_PROVIDER: "openai" });
    const text = await readFile(p, "utf8");
    assert.match(text, /EXISTING=keep/);
    assert.match(text, /REEL_LLM_PROVIDER=openai/);
    delete process.env.REEL_LLM_PROVIDER;
  });

  test("applies the values to this process so a save takes effect immediately", async () => {
    // loadLlmConfig reads the environment on every call, so updating it here
    // is what makes a saved change work without restarting Studio.
    const p = await tmpEnv();
    await writeEnvFile(p, { REEL_TEST_APPLIED: "yes" });
    assert.equal(process.env.REEL_TEST_APPLIED, "yes");
    delete process.env.REEL_TEST_APPLIED;
  });

  test("unsets a removed key in this process too", async () => {
    process.env.REEL_TEST_GONE = "here";
    const p = await tmpEnv("REEL_TEST_GONE=here\n");
    await writeEnvFile(p, { REEL_TEST_GONE: null });
    assert.equal(process.env.REEL_TEST_GONE, undefined);
  });

  test("creates the file when none exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reel-env-"));
    const p = join(dir, ".env");
    await writeEnvFile(p, { REEL_TEST_NEW: "1" });
    assert.match(await readFile(p, "utf8"), /REEL_TEST_NEW=1/);
    delete process.env.REEL_TEST_NEW;
  });

  // Windows has no POSIX mode bits — chmod there only toggles read-only — so
  // this asserts a property the platform doesn't offer rather than one Reel
  // failed to provide.
  test("leaves the file readable only by its owner", { skip: process.platform === "win32" }, async () => {
    // The file holds an API key.
    const p = await tmpEnv();
    await writeEnvFile(p, { REEL_TEST_PERM: "1" });
    const mode = (await stat(p)).mode & 0o777;
    assert.equal(mode & 0o077, 0, `group/other bits set: ${mode.toString(8)}`);
    delete process.env.REEL_TEST_PERM;
  });
});
