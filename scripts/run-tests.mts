import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Run the unit tests.
 *
 * `tsx --test test/*.test.ts` looks like it works, and does — on a shell that
 * expands globs. npm runs scripts through cmd/PowerShell on Windows, neither of
 * which does, so the literal pattern reached the test runner and `npm test`
 * failed before running a single test. Nobody noticed because CI was Linux-only.
 *
 * Expanding the list here rather than leaning on the shell also avoids the other
 * half of the problem: Node's own glob support in `--test` landed after the
 * version Reel supports, so quoting the pattern would only move the failure.
 *
 * Discovery is deliberately dumb — every `*.test.ts` directly in `test/`. A
 * clever matcher that silently skipped a file would be worse than no runner.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "test");

const files = (await readdir(dir))
  .filter((f) => f.endsWith(".test.ts"))
  // Sorted so a failure is reported in the same order everywhere, which makes
  // two runs on different machines comparable.
  .sort()
  .map((f) => join(dir, f));

if (files.length === 0) {
  console.error(`No *.test.ts files in ${dir}`);
  process.exit(1);
}

// `process.execPath` with the loader flag, rather than spawning the `tsx`
// binary: that resolves to a shell shim on Windows and would drag the shell —
// the thing that caused this — back into the picture.
const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", ...process.argv.slice(2), ...files],
  { stdio: "inherit", cwd: root },
);

child.on("exit", (code, signal) => {
  // A signalled runner must not report success; npm reads the exit code alone.
  process.exit(signal ? 1 : (code ?? 1));
});
