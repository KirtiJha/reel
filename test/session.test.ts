import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "../src/terminal/session.js";

const opts = { cols: 80, timeoutMs: 15_000 };

describe("runCommand", () => {
  test("captures stdout and the exit code", async () => {
    const r = await runCommand("echo hello", opts);
    assert.match(r.output, /hello/);
    assert.equal(r.code, 0);
    assert.equal(r.timedOut, false);
  });

  test("captures stderr too — a demo should show failures", async () => {
    const r = await runCommand("node -e \"console.error('to stderr')\"", opts);
    assert.match(r.output, /to stderr/);
  });

  test("reports a non-zero exit rather than throwing", async () => {
    const r = await runCommand("node -e \"process.exit(3)\"", opts);
    assert.equal(r.code, 3);
  });

  test("a missing binary becomes visible output, not a crash", async () => {
    const r = await runCommand("this-command-does-not-exist-xyz", opts);
    assert.notEqual(r.code, 0);
    assert.ok(r.output.length > 0);
  });

  test("pipes stdin to commands that read it", async () => {
    const r = await runCommand("cat", { ...opts, input: "piped input\n" });
    assert.match(r.output, /piped input/);
  });

  test("closes stdin so a reader doesn't hang forever", async () => {
    const r = await runCommand("cat", opts);
    assert.equal(r.code, 0);
  });

  test("kills a command that overruns its budget", async () => {
    const r = await runCommand("sleep 30", { ...opts, timeoutMs: 300 });
    assert.equal(r.timedOut, true);
  });

  test("exports COLUMNS so output wraps to the terminal width", async () => {
    const r = await runCommand("node -e \"process.stdout.write(process.env.COLUMNS||'')\"", {
      ...opts,
      cols: 84,
    });
    assert.match(r.output, /84/);
  });

  test("asks for colour, since a monochrome demo misrepresents the tool", async () => {
    const r = await runCommand("node -e \"process.stdout.write(process.env.FORCE_COLOR||'')\"", opts);
    assert.equal(r.output.trim(), "3");
  });

  test("passes through spec-supplied env", async () => {
    const r = await runCommand("node -e \"process.stdout.write(process.env.DEMO_VAR||'')\"", {
      ...opts,
      env: { DEMO_VAR: "set-by-spec" },
    });
    assert.match(r.output, /set-by-spec/);
  });

  test("refuses to execute when REEL_NO_EXEC is set", async () => {
    process.env.REEL_NO_EXEC = "1";
    try {
      await assert.rejects(() => runCommand("echo nope", opts), /REEL_NO_EXEC/);
    } finally {
      delete process.env.REEL_NO_EXEC;
    }
  });
});
