import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startApiServer } from "./server.js";
import { log, ReelError } from "../util/log.js";

export interface StudioOptions {
  uiPort: number;
  apiPort: number;
  open: boolean;
}

/**
 * Launch Reel Studio: start the in-process API/media server, then spawn the
 * Next.js UI (which proxies /api and /media back to it). One `reel ui` process
 * from the user's project directory.
 */
export async function launchStudio(opts: StudioOptions): Promise<void> {
  const studioDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "studio");
  // Next's own entry point, not the `.bin/next` shim npm writes beside it.
  //
  // That shim is a POSIX shell script; Windows gets `next.cmd` instead, and
  // spawning either without a shell fails — the extensionless one with ENOENT,
  // the `.cmd` with EINVAL, since Node stopped executing batch files directly.
  // Handing the script to `process.execPath` sidesteps the whole question, the
  // same way `scripts/run-tests.mts` refuses to spawn the `tsx` shim.
  const nextBin = join(studioDir, "node_modules", "next", "dist", "bin", "next");
  if (!existsSync(nextBin)) {
    throw new ReelError(
      "Reel Studio isn't installed yet.",
      `Run:  npm run studio:install   then retry \`reel ui\`.`,
    );
  }

  await startApiServer(opts.apiPort);
  log.phase("Reel Studio");
  log.ok(`API + media on http://localhost:${opts.apiPort}`);
  log.step(`Starting the UI on http://localhost:${opts.uiPort} …`);

  // `-H 127.0.0.1` for the same reason the API server binds to loopback: this
  // UI can write provider credentials and start jobs that run shell commands,
  // so it must not be reachable from the network.
  const child = spawn(
    process.execPath,
    [nextBin, "dev", "-p", String(opts.uiPort), "-H", "127.0.0.1"],
    {
      cwd: studioDir,
      env: { ...process.env, REEL_API_URL: `http://localhost:${opts.apiPort}` },
      stdio: "inherit",
    },
  );
  // Without this the failure arrives as an unhandled 'error' event, which kills
  // `reel ui` with a raw Node stack trace instead of something a reader can act
  // on — and takes the API server down with it.
  child.on("error", (err) => {
    log.error(`Could not start the Studio UI: ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  process.on("SIGINT", () => child.kill("SIGINT"));

  if (opts.open) {
    const url = `http://localhost:${opts.uiPort}`;
    waitForPort(url).then((ready) => {
      if (ready) {
        log.ok(`Studio ready — opening ${url}`);
        openBrowser(url);
      }
    });
  }
}

async function waitForPort(url: string, timeoutMs = 40_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status > 0) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}
