import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "../src/terminal/session.js";

const opts = { cols: 80, timeoutMs: 15_000 };

// `cat` and `sleep` are POSIX; node is the one interpreter guaranteed present
// wherever Reel runs, so the fixtures are written with it rather than skipping
// the behaviour on Windows — where the process-group kill is weakest and these
// are worth exercising most.
const ECHO_STDIN = 'node -e "process.stdin.pipe(process.stdout)"';
const SLEEP_5S = 'node -e "setTimeout(() => {}, 5000)"';

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
    const r = await runCommand(ECHO_STDIN, { ...opts, input: "piped input\n" });
    assert.match(r.output, /piped input/);
  });

  test("closes stdin so a reader doesn't hang forever", async () => {
    const r = await runCommand(ECHO_STDIN, opts);
    assert.equal(r.code, 0);
  });

  test("kills a command that overruns its budget", async () => {
    // The elapsed assertion is the point. Setting `timedOut` was never the bug:
    // the kill reached the shell and not the command it started, so the call
    // blocked until the command finished on its own and the budget bounded
    // nothing. That failure passed this test for as long as it existed.
    const started = Date.now();
    const r = await runCommand(SLEEP_5S, { ...opts, timeoutMs: 300 });
    const elapsed = Date.now() - started;
    assert.equal(r.timedOut, true);
    assert.ok(elapsed < 3_000, `waited ${elapsed}ms for a 300ms budget`);
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
