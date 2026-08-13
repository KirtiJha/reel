/**
 * Machine-readable command results.
 *
 * A CI step that wants to know *what* a run produced currently has to scrape
 * the log — which changes whenever the wording does. `--json` prints one JSON
 * object instead.
 *
 * The human log already goes to stderr, so nothing needs muting: `reel record
 * --json > result.json` keeps the progress output visible on the terminal while
 * stdout stays parseable.
 *
 * Every command reports the same envelope, so a caller can branch on `ok` and
 * `command` before it knows anything else.
 */

export interface ReportEnvelope {
  /** Always "reel", so a stray object in a pipeline is identifiable. */
  tool: "reel";
  /** Schema version for this envelope; bumped only on a breaking change. */
  version: 1;
  command: string;
  ok: boolean;
  /** Seconds the command took, wall-clock. */
  elapsedMs: number;
  /** Command-specific payload. */
  result?: unknown;
  error?: {
    message: string;
    hint?: string;
    /** Where the failing step's diagnostics were written, when there are any. */
    artifacts?: Record<string, string | undefined>;
    step?: { number: number; label: string };
  };
}

let enabled = false;
let started = 0;

/** Turn on JSON mode and start the clock. */
export function useJson(on: boolean): void {
  enabled = on;
  started = Date.now();
}

export function jsonEnabled(): boolean {
  return enabled;
}

/** Emit the envelope. A no-op unless --json was passed. */
export function emit(command: string, ok: boolean, body: Partial<ReportEnvelope> = {}): void {
  if (!enabled) return;
  const envelope: ReportEnvelope = {
    tool: "reel",
    version: 1,
    command,
    ok,
    elapsedMs: Date.now() - started,
    ...body,
  };
  // stdout, deliberately: the logger uses stderr, so the two never interleave
  // and `> result.json` captures exactly the envelope.
  process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
}
