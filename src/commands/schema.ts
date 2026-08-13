import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log, ReelError } from "../util/log.js";

/**
 * The JSON Schema for a `.reel.yaml`, and how a spec finds it.
 *
 * A spec is the product here — people spend their time in the YAML, not in the
 * CLI — so an editor that completes step kinds and rejects a misspelled key is
 * worth more than most of what could be added to the tool itself.
 *
 * The schema is generated from the same zod schema the driver validates
 * against (`npm run schema`), never written by hand. A second, hand-maintained
 * copy of the grammar drifts, and autocomplete that suggests a key the driver
 * rejects is worse than no autocomplete at all.
 */

/** Fetched by editors from the `# yaml-language-server:` line a spec carries. */
export const SCHEMA_URL =
  "https://raw.githubusercontent.com/KirtiJha/reel/main/schema/reel.schema.json";

/**
 * The copy shipped with the installed package.
 *
 * `../../` lands on the package root from `dist/commands/` and on the repo root
 * from `src/commands/`, so this resolves whether Reel is running built or from
 * source.
 */
export const SCHEMA_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../schema/reel.schema.json",
);

/** The line that points an editor at the schema. */
export function schemaDirective(url = SCHEMA_URL): string {
  return `# yaml-language-server: $schema=${url}`;
}

/**
 * Write the bundled schema somewhere a project can commit it.
 *
 * Worth having as well as the URL: an editor behind a firewall can't fetch
 * anything, and a vendored copy pins the grammar to the Reel version a repo
 * actually records with.
 */
export async function exportSchema(to: string): Promise<string> {
  const target = resolve(process.cwd(), to);
  try {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(SCHEMA_FILE, target);
  } catch (err) {
    throw new ReelError(
      `Could not write the schema to ${target}: ${(err as Error).message}`,
      "Check the directory is writable.",
    );
  }
  log.ok(`Wrote ${target}`);
  log.info("Point your editor at it from a spec:");
  console.error(`    ${schemaDirective(to)}`);
  return target;
}
