import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { isGitIgnored } from "../src/util/secrets.js";

/** A throwaway git repo with the given .gitignore. */
async function repo(ignore: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "reel-secrets-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  await writeFile(join(dir, ".gitignore"), ignore, "utf8");
  return dir;
}

describe("spotting an unprotected credential file", () => {
  test("reports a file git would ignore", async () => {
    const dir = await repo(".auth/\n");
    await mkdir(join(dir, ".auth"), { recursive: true });
    const f = join(dir, ".auth", "demo.json");
    await writeFile(f, "{}");
    assert.equal(isGitIgnored(f), true);
  });

  test("reports a file git would happily commit", async () => {
    // The case that matters: the warning exists for exactly this state.
    const dir = await repo("node_modules/\n");
    const f = join(dir, "auth.json");
    await writeFile(f, "{}");
    assert.equal(isGitIgnored(f), false);
  });

  test("honours a nested gitignore, not just the root one", async () => {
    // Why this asks git rather than reading .gitignore itself: matching is a
    // whole language, and a wrong answer here reports an exposed file as safe.
    const dir = await repo("node_modules/\n");
    await mkdir(join(dir, "demos"), { recursive: true });
    await writeFile(join(dir, "demos", ".gitignore"), "*.json\n", "utf8");
    const f = join(dir, "demos", "session.json");
    await writeFile(f, "{}");
    assert.equal(isGitIgnored(f), true);
  });

  test("says 'unknown' outside a repository rather than guessing", async () => {
    // null, not false: there is nothing to be committed to, so warning about
    // an exposed file would be wrong.
    const dir = await mkdtemp(join(tmpdir(), "reel-nogit-"));
    const f = join(dir, "auth.json");
    await writeFile(f, "{}");
    assert.equal(isGitIgnored(f), null);
  });
});
