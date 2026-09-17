import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import { log, ReelError } from "../util/log.js";
import { onCleanup } from "../util/dispose.js";

const ffmpegPath = (ffmpegStatic as unknown as string) || "ffmpeg";

/**
 * How much of ffmpeg's stderr to keep for the error message.
 *
 * It was previously all of it. ffmpeg is happy to emit a warning per frame —
 * a deprecated pixel format, a non-monotonic DTS — so a long encode could hold
 * hundreds of megabytes of text in a string that exists only to be the hint on
 * an error that may never happen, and every append reallocates it.
 *
 * The tail is the part worth keeping: ffmpeg says what went wrong last, and the
 * thousandth repetition of a warning adds nothing to the first.
 */
const STDERR_LIMIT = 64 * 1024;

/**
 * Progress reporting for the encodes that take minutes.
 *
 * ffmpeg only knows where it is on the output's timeline, so that is what it
 * reports: `-progress` writes a `key=value` block every period, and `out_time_us`
 * (or `out_time_ms`, which is also microseconds — a naming mistake ffmpeg has
 * kept for compatibility) is the position in it.
 */
export interface FfmpegProgress {
  /** Expected output duration in ms, so a position can become a percentage. */
  totalMs: number;
  /** Called with the output position in ms. Throttling is the caller's job. */
  onProgress(positionMs: number): void;
}

/** Run ffmpeg with args, streaming stderr to debug. Rejects on non-zero exit. */
export function ffmpeg(args: string[], cwd?: string, progress?: FfmpegProgress): Promise<void> {
  return new Promise((resolve, reject) => {
    // `-progress pipe:2` interleaves a machine-readable block into stderr. It
    // changes nothing about the encode itself — the output bytes are identical
    // with and without it, which matters because those bytes are the product.
    const reporting = progress ? ["-progress", "pipe:2", "-stats_period", "1"] : [];
    log.debug(`ffmpeg ${args.join(" ")}`);
    const proc = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", ...reporting, ...args], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    // An ffmpeg that outlives the CLI holds the output file open and keeps
    // writing to a temp directory nobody will collect. Killed on the signal
    // path; released the moment it exits on its own.
    const forget = onCleanup(() => proc.kill("SIGKILL"));

    let stderr = "";
    let pending = "";
    const note = (text: string): void => {
      stderr += text;
      if (stderr.length > STDERR_LIMIT) {
        stderr = `…\n${stderr.slice(-STDERR_LIMIT)}`;
      }
    };

    proc.stderr.on("data", (d: Buffer) => {
      const text = d.toString();
      if (!progress) {
        note(text);
        return;
      }
      // Split the progress block out of the diagnostics, so the hint on a
      // failure stays readable instead of being buried under a thousand
      // `frame=…/fps=…` lines.
      pending += text;
      // The line buffer is bounded for the same reason as the log above: a
      // stream that never emits a newline must not become the memory leak that
      // capping the log was meant to close.
      if (pending.length > STDERR_LIMIT) {
        note(pending);
        pending = "";
        return;
      }
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const position = progressPositionMs(line);
        if (position !== null) progress.onProgress(position);
        else if (!isProgressField(line)) note(`${line}\n`);
      }
    });

    proc.on("error", (err) => {
      forget();
      reject(new ReelError(`Could not run ffmpeg: ${err.message}`));
    });
    proc.on("close", (code) => {
      forget();
      if (pending && !isProgressField(pending)) note(pending);
      if (code === 0) resolve();
      else reject(new ReelError(`ffmpeg exited with code ${code}`, stderr.trim() || undefined));
    });
  });
}

/**
 * The output position a `-progress` line reports, in ms, or null if it isn't
 * one. `out_time_us` is preferred where a build emits it; `out_time_ms` carries
 * microseconds despite its name, so both divide by the same thousand.
 */
export function progressPositionMs(line: string): number | null {
  const m = /^out_time_(?:us|ms)=(-?\d+)$/.exec(line.trim());
  if (!m) return null;
  const micros = Number(m[1]);
  // ffmpeg reports a negative position before the first frame is muxed.
  return Number.isFinite(micros) && micros >= 0 ? Math.round(micros / 1000) : null;
}

/** Whether a line is part of a `-progress` block rather than a diagnostic. */
function isProgressField(line: string): boolean {
  return /^(frame|fps|stream_\S+|bitrate|total_size|out_time\S*|dup_frames|drop_frames|speed|progress)=/.test(
    line.trim(),
  );
}

/**
 * Run ffmpeg for what it says about a file rather than for what it writes.
 *
 * `ffmpeg -i <file>` with no output exits non-zero by design, and the facts
 * worth having (duration, streams) are on stderr at the default log level — the
 * one `ffmpeg()` above deliberately suppresses. So this is a separate function
 * rather than a flag: the caller wants the text, and a failing exit code is the
 * normal case, not an error.
 */
export function ffmpegProbe(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ["-hide_banner", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const forget = onCleanup(() => proc.kill("SIGKILL"));
    // A probe reads a header, so its output is small — but it is the same
    // unbounded `+=` as above, and "small" is a property of the files Reel
    // happens to be given rather than of the code.
    let stderr = "";
    proc.stderr.on("data", (d) => {
      if (stderr.length <= STDERR_LIMIT) stderr += d.toString();
    });
    proc.on("error", (err) => {
      forget();
      reject(new ReelError(`Could not run ffmpeg: ${err.message}`));
    });
    proc.on("close", () => {
      forget();
      resolve(stderr);
    });
  });
}
