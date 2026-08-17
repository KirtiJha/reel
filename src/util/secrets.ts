import { spawnSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { log } from "./log.js";

/**
 * Warning about a file that holds live credentials.
 *
 * A Playwright storage state is not a config file. It holds the cookies and
 * tokens of a signed-in session — a bearer credential — so anyone who obtains
 * it is that user until the session expires. Committing one is the same
 * mistake as committing an API key, and it is much easier to make, because the
 * file has an innocuous name and appears next to the spec that references it.
 *
 * Reel warns rather than editing anyone's `.gitignore`. A tool that silently
 * rewrites files in a repository it was pointed at is its own kind of surprise,
 * and the useful half of the protection — knowing the file is exposed, and the
 * exact line that fixes it — does not require the edit.
 */

/**
 * Whether git would ignore this path.
 *
 * `git check-ignore` is the only answer that accounts for every source of
 * ignore rules — the repo's `.gitignore`, nested ones, `.git/info/exclude` and
 * the global file. Reimplementing that matching would get a case wrong and
 * report a file as safe when it isn't, which is the one error worth avoiding.
 */
export function isGitIgnored(path: string): boolean | null {
  const file = resolve(path);
  const res = spawnSync("git", ["check-ignore", "-q", "--", file], {
    cwd: dirname(file),
    stdio: "ignore",
  });
  // 0 = ignored, 1 = not ignored, 128 = not a git repository (or no git).
  if (res.error || res.status === 128) return null;
  return res.status === 0;
}

/**
 * Tell the user what they now have on disk, and whether git can see it.
 *
 * Deliberately loud when the file is exposed and quiet when it isn't: a warning
 * that fires every time teaches people to skip warnings.
 */
export function warnAboutCredentials(path: string, kind = "signed-in session"): void {
  const ignored = isGitIgnored(path);
  log.warn(`${path} holds a ${kind} — treat it like a password.`);

  if (ignored === true) {
    log.info("git is already ignoring it.");
    return;
  }
  if (ignored === null) {
    // Not a repository, so there is nothing to be committed to yet — but the
    // file is still a credential, and it may end up in one later.
    log.info("Not in a git repository. Keep it out of version control.");
    return;
  }

  log.error("git is NOT ignoring it. Anyone you share this repo with gets the session.");
  const rel = relative(process.cwd(), resolve(path)) || path;
  log.info("Add this line to .gitignore:");
  console.error(`    ${rel}`);
}
