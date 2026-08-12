import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import { log, ReelError } from "../util/log.js";

const ffmpegPath = (ffmpegStatic as unknown as string) || "ffmpeg";

/** Run ffmpeg with args, streaming stderr to debug. Rejects on non-zero exit. */
export function ffmpeg(args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    log.debug(`ffmpeg ${args.join(" ")}`);
    const proc = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", ...args], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", (err) =>
      reject(new ReelError(`Could not run ffmpeg: ${err.message}`)),
    );
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new ReelError(`ffmpeg exited with code ${code}`, stderr.trim() || undefined));
    });
  });
}
