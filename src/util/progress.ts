import { log } from "./log.js";
import { jsonEnabled } from "./report.js";

/**
 * Throttled progress for the stages that take minutes and used to say nothing
 * at all.
 *
 * The sharp pass costs ~190ms a frame, so a ten-minute demo spends around
 * twenty minutes in it, and the ffmpeg passes after it add as much again. Both
 * previously logged one line on entry and then went silent, which makes a slow
 * render and a hung one look identical — and the only way to tell them apart
 * was to wait an hour to find out.
 *
 * It prints a rate and an estimate rather than a bare percentage, because the
 * question being asked is never "how far through is it" but "do I have time to
 * go and do something else".
 */

/** How often a running stage is allowed to say something. */
const TICK_MS = 2_000;

export interface Progress {
  /** Advance by `n` units of work (default 1). Safe to call from a worker pool. */
  tick(n?: number): void;
  /** Report an absolute position instead, for a stage that reports its own. */
  at(position: number): void;
  /** Close the stage out, recording how long it took at debug level. */
  done(): void;
}

export interface ProgressOptions {
  /**
   * `frames` counts discrete work items and can therefore quote a per-item
   * cost — the number that tells you whether a render is slow or stuck.
   * `ms` measures a position on the output's own timeline, which is all ffmpeg
   * will tell us, and where a "ms per ms" rate would be meaningless.
   */
  kind?: "frames" | "ms";
}

export function progress(label: string, total: number, opts: ProgressOptions = {}): Progress {
  const kind = opts.kind ?? "frames";
  const started = Date.now();
  let done = 0;
  let lastAt = started;
  // Silent under --json: that mode exists so a caller can parse one object out
  // of a run, and a progress line every two seconds is noise to whoever is
  // reading the log beside it.
  const quiet = jsonEnabled();

  const report = (): void => {
    const now = Date.now();
    if (now - lastAt < TICK_MS) return;
    lastAt = now;
    if (quiet || done <= 0 || total <= 0) return;
    const elapsed = now - started;
    const pct = Math.min(100, Math.round((done / total) * 100));
    const left = total > done ? Math.round((elapsed / done) * (total - done)) : 0;
    const parts =
      kind === "frames"
        ? [`${label} ${Math.round(done)}/${Math.round(total)} frames (${pct}%)`]
        : [`${label} ${(done / 1000).toFixed(1)}s/${(total / 1000).toFixed(1)}s (${pct}%)`];
    if (kind === "frames" && elapsed / done >= 1) {
      parts.push(`${Math.round(elapsed / done)}ms/frame`);
    }
    if (left > 0) parts.push(`~${duration(left)} left`);
    log.info(parts.join(" · "));
  };

  return {
    tick(n = 1) {
      done += n;
      report();
    },
    at(position: number) {
      // Monotonic: ffmpeg's progress block repeats the last position when it
      // has nothing new to say, and a bar that went backwards would be read as
      // a bug in the render rather than in the reporting.
      done = Math.max(done, position);
      report();
    },
    done() {
      if (!quiet) log.debug(`${label} finished in ${duration(Date.now() - started)}`);
    },
  };
}

/**
 * Milliseconds are the wrong unit for a number a human is about to plan around:
 * "~1260000ms left" is not an answer to "should I go and get a coffee".
 */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
