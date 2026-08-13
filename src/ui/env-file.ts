import { readFile, writeFile, chmod } from "node:fs/promises";

/**
 * Minimal `.env` editing.
 *
 * Studio writes provider settings here so `reel author` picks them up on the
 * next run, the same way a hand-edited file would. Two properties matter:
 *
 *  - **Nothing else in the file is disturbed.** People keep unrelated variables,
 *    comments and ordering in `.env`; a rewrite that reformats or drops them
 *    would be a silent data loss for something the user maintains by hand.
 *  - **A written key never comes back out.** Values are write-only from the
 *    API's perspective; callers report that a key is *set*, never what it is.
 */

/** Update or append `KEY=value` pairs, leaving every other line untouched. */
export function applyEnvEdits(source: string, edits: Record<string, string | null>): string {
  const lines = source.split("\n");
  const seen = new Set<string>();

  const out = lines.map((line) => {
    // Only touch real assignments — a commented-out line stays a comment, so
    // someone's notes about an alternative setup survive a save.
    const m = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) return line;
    const key = m[2]!;
    if (!(key in edits)) return line;
    seen.add(key);
    const value = edits[key];
    // null removes the setting rather than writing an empty value, which some
    // clients treat as "configured but blank".
    if (value == null) return null;
    return `${m[1] ?? ""}${key}=${quoteIfNeeded(value)}`;
  }).filter((l): l is string => l !== null);

  const additions = Object.entries(edits)
    .filter(([k, v]) => v !== null && !seen.has(k))
    .map(([k, v]) => `${k}=${quoteIfNeeded(v as string)}`);

  if (additions.length === 0) return out.join("\n");

  const body = out.join("\n").replace(/\n+$/, "");
  return `${body}\n${body ? "\n" : ""}# Written by Reel Studio\n${additions.join("\n")}\n`;
}

/** Values with spaces or `#` would otherwise be truncated when re-read. */
function quoteIfNeeded(v: string): string {
  return /[\s#"']/.test(v) ? JSON.stringify(v) : v;
}

/**
 * Read, edit and write `.env`, then apply the same values to this process.
 *
 * Updating `process.env` too means a saved change takes effect on the next
 * action rather than after a restart — `loadLlmConfig` reads the environment
 * on every call.
 */
export async function writeEnvFile(
  path: string,
  edits: Record<string, string | null>,
): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch {
    /* first write — start from an empty file */
  }
  await writeFile(path, applyEnvEdits(existing, edits), "utf8");
  // The file now holds a credential; keep it owner-only.
  await chmod(path, 0o600).catch(() => {});

  for (const [k, v] of Object.entries(edits)) {
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
}
