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
  const nextBin = join(studioDir, "node_modules", ".bin", "next");
  if (!existsSync(nextBin)) {
    throw new ReelError(
      "Reel Studio isn't installed yet.",
      `Run:  (cd "${studioDir}" && npm install)   then retry \`reel ui\`.`,
    );
  }

  await startApiServer(opts.apiPort);
  log.phase("Reel Studio");
  log.ok(`API + media on http://localhost:${opts.apiPort}`);
  log.step(`Starting the UI on http://localhost:${opts.uiPort} …`);

  // `-H 127.0.0.1` for the same reason the API server binds to loopback: this
  // UI can write provider credentials and start jobs that run shell commands,
  // so it must not be reachable from the network.
  const child = spawn(nextBin, ["dev", "-p", String(opts.uiPort), "-H", "127.0.0.1"], {
    cwd: studioDir,
    env: { ...process.env, REEL_API_URL: `http://localhost:${opts.apiPort}` },
    stdio: "inherit",
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
