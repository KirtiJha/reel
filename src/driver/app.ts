import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { RunConfig } from "../spec/schema.js";
import { killTree } from "../util/kill.js";
import { log, ReelError } from "../util/log.js";

export interface RunningApp {
  stop(): Promise<void>;
}

/**
 * Boot the app under test and wait until it responds, so `reel record` works
 * from a cold checkout (and in CI) without a human babysitting a dev server.
 */
export async function startApp(run: RunConfig): Promise<RunningApp> {
  // A spec is executable: `run.cmd` goes to a shell. That's fine for your own
  // repo and dangerous for a spec you didn't write — and the CI story invites
  // running specs from pull requests. This lets a runner refuse outright.
  if (process.env.REEL_NO_EXEC) {
    throw new ReelError(
      "Refusing to run the spec's `run.cmd` because REEL_NO_EXEC is set.",
      "Start the app yourself and point `url` at it, or unset REEL_NO_EXEC if you trust this spec.",
    );
  }
  log.step(`Booting app (shell): ${run.cmd}`);
  const child: ChildProcess = spawn(run.cmd, {
    cwd: run.cwd,
    shell: true,
    // Own process group so we can reliably tear down the shell AND its children
    // (dev servers spawn sub-processes) when recording finishes.
    detached: true,
    env: { ...process.env, ...run.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => log.debug(`[app] ${d.toString().trimEnd()}`));
  child.stderr?.on("data", (d) => log.debug(`[app] ${d.toString().trimEnd()}`));

  let exited = false;
  child.on("exit", (code) => {
    exited = true;
    if (code && code !== 0) log.warn(`App process exited early (code ${code}).`);
  });

  const stop = async () => {
    if (exited || !child.pid) return;
    // The shell plus everything it started — a dev server that outlives the
    // recording keeps its port bound and breaks the *next* run, which is a far
    // more confusing failure than a slow teardown.
    killTree(child, "SIGTERM");
    await sleep(300);
  };

  if (run.readyOn) {
    try {
      await waitForReady(run.readyOn, run.timeout, () => exited);
      log.ok(`App ready at ${run.readyOn}`);
    } catch (err) {
      await stop();
      throw err;
    }
  }

  return { stop };
}

async function waitForReady(
  url: string,
  timeoutMs: number,
  hasExited: () => boolean,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const target = normalizeReadyUrl(url);
  while (Date.now() < deadline) {
    if (hasExited()) throw new ReelError("App process exited before becoming ready.");
    try {
      const res = await fetch(target, { method: "GET" });
      // Any HTTP response (even 404) means the server is up and listening.
      if (res.status >= 0) return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new ReelError(
    `App did not become ready at ${url} within ${timeoutMs}ms`,
    "Check `run.cmd` and `run.readyOn` in your spec.",
  );
}

/** Accept "3000", ":3000", "localhost:3000", or a full URL. */
function normalizeReadyUrl(v: string): string {
  if (/^\d+$/.test(v)) return `http://localhost:${v}`;
  if (v.startsWith(":")) return `http://localhost${v}`;
  if (!/^https?:\/\//.test(v)) return `http://${v}`;
  return v;
}
