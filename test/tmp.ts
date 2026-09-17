import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

/**
 * A scratch directory that goes away when the file's tests do.
 *
 * `npm test` used to leave around seventy `/tmp/reel-*` directories behind on
 * every run: every test that needed a file on disk made one, and none of them
 * removed it. Nothing reads them afterwards — they are fixtures, not artifacts
 * — so on a machine where the suite runs a dozen times a day they simply
 * accumulate, until `ls /tmp` is useless and a test that goes looking for "the
 * newest reel- directory" finds somebody else's.
 *
 * Not a test file itself: the runner discovers `*.test.ts` and nothing else.
 */
const made: string[] = [];

/** `prefix` is the name the directory should carry, e.g. "reel-media". */
export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix.endsWith("-") ? prefix : `${prefix}-`));
  made.push(dir);
  return dir;
}

// Registered on import, which is per test file: `node --test` gives each file
// its own process, so this is that file's own cleanup and cannot race another.
after(async () => {
  await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
