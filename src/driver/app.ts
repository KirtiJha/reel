import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { RunConfig } from "../spec/schema.js";
import { killTree } from "../util/kill.js";
import { log, ReelError } from "../util/log.js";
import { onCleanup } from "../util/dispose.js";

export interface RunningApp {
  stop(): Promise<void>;
}

/**
 * How long to let the app's command fail after the port answers.
 *
 * `readyOn` proves only that *something* is listening. When a previous run left
 * its server behind, the port answers instantly and the new command dies of
 * EADDRINUSE a few milliseconds later — so the poll and the exit race, and the
 * poll usually wins. Waiting this out is what turns "recorded the wrong app"
 * into an error.
 */
const EXIT_SETTLE_MS = 250;

/** How much of the command's own output to quote back when it fails. */
const OUTPUT_LINES = 8;

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
  // Kept so a failure can quote the command's own words back. EADDRINUSE,
  // "command not found" and a missing build all say exactly what is wrong, and
  // all of it went to `log.debug`, where nobody not already running -v sees it.
  const output: string[] = [];
  const record = (d: Buffer): void => {
    const text = d.toString().trimEnd();
    log.debug(`[app] ${text}`);
    output.push(...text.split("\n"));
    if (output.length > OUTPUT_LINES) output.splice(0, output.length - OUTPUT_LINES);
  };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);

  let exited = false;
  let exitCode: number | null = null;
  // Teardown is not a crash. A killed process reports a non-zero code, and on
  // Windows `taskkill /F` guarantees one — so every successful recording ended
  // by telling the author their app had exited early, immediately after the
  // line saying the run had passed. The warning is only worth printing while
  // the app is still supposed to be running.
  let stopping = false;
  child.on("exit", (code) => {
    exited = true;
    exitCode = code;
    if (!stopping && code && code !== 0) log.warn(`App process exited early (code ${code}).`);
  });

  // The app is spawned into its own process group and is therefore nobody's
  // child once this process dies: Ctrl-C during a render left a dev server
  // holding its port, which broke the next run as well as this one. `killTree`
  // is synchronous, which is what the signal path needs.
  const forget = onCleanup(() => killTree(child, "SIGKILL"));

  const stop = async () => {
    forget();
    if (exited || !child.pid) return;
    stopping = true;
    // The shell plus everything it started — a dev server that outlives the
    // recording keeps its port bound and breaks the *next* run, which is a far
    // more confusing failure than a slow teardown.
    killTree(child, "SIGTERM");
    await sleep(300);
  };

  try {
    if (run.readyOn) {
      await waitForReady(run.readyOn, run.timeout, () => exited);
      log.ok(`App ready at ${run.readyOn}`);
    }

    // `readyOn` proves a port answers, not that it is *this* app answering, and
    // a command that has already given up is the clearest evidence that it is
    // not. Left as a warning, the most common shape of this — a server left
    // behind by an earlier run, the new one dying of EADDRINUSE — recorded
    // someone else's app, at whatever revision it happened to be, and reported
    // a pass. A silent wrong answer is worse than a loud failure.
    await sleep(EXIT_SETTLE_MS);
    if (exited && exitCode !== 0) {
      throw new ReelError(
        `The app's \`run.cmd\` exited with code ${exitCode} before recording started.`,
        [
          run.readyOn
            ? `Something answered at ${run.readyOn} anyway — most likely a server left over from ` +
              "an earlier run, which Reel would have filmed instead of yours."
            : "",
          output.length ? `Its last output was:\n${output.map((l) => `    ${l}`).join("\n")}` : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    }
  } catch (err) {
    await stop();
    throw err;
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
