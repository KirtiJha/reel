import { spawn, spawnSync } from "node:child_process";
import { log, ReelError } from "../util/log.js";

/**
 * Run a command and capture everything it printed.
 *
 * Reel films a *replay* of this output rather than the live process, for the
 * same reason it synthesizes scrolls instead of capturing them: racing a real
 * process makes the recording depend on how fast the machine is. Capturing
 * first also means a 60-second install replays in three seconds, and that
 * `expectOutput` is a real assertion in `check` mode with nothing rendered.
 *
 * Output goes through a pipe, not a pty. Most CLIs colour their output when
 * asked (FORCE_COLOR), which covers build tools, package managers, git and
 * bespoke CLIs. Full-screen TUIs need a real terminal and are out of scope.
 */

export interface CommandResult {
  /** Combined stdout+stderr, in the order it was written. */
  output: string;
  code: number;
  /** True if the command was killed for exceeding its time budget. */
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  cols: number;
  /** Text piped to stdin, for commands that prompt. */
  input?: string;
  timeoutMs: number;
}

export async function runCommand(cmd: string, opts: RunOptions): Promise<CommandResult> {
  // Terminal steps are the most literal form of "a spec is executable code",
  // so they honour the same opt-out as `run.cmd`.
  if (process.env.REEL_NO_EXEC) {
    throw new ReelError(
      `Refusing to run \`${cmd}\` because REEL_NO_EXEC is set.`,
      "Terminal steps execute real commands; unset REEL_NO_EXEC if you trust this spec.",
    );
  }
  log.debug(`terminal: ${cmd}`);
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(cmd, {
      cwd: opts.cwd,
      shell: true,
      env: {
        ...process.env,
        // Ask for colour explicitly: without a tty most CLIs strip it, and a
        // monochrome demo of a colourful tool misrepresents the tool.
        FORCE_COLOR: "3",
        CLICOLOR_FORCE: "1",
        TERM: "xterm-256color",
        COLUMNS: String(opts.cols),
        ...opts.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    let timedOut = false;
    const cap = (d: Buffer) => {
      output += d.toString("utf8");
    };
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    if (opts.input !== undefined) child.stdin?.write(opts.input);
    child.stdin?.end();

    child.on("error", (err) => {
      clearTimeout(timer);
      // A missing binary is output the viewer should see, not a crash.
      resolve({ output: output + `${err.message}\n`, code: 127, timedOut });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ output, code: code ?? 0, timedOut });
    });
  });
}

/**
 * Fail before recording if a program the demo depends on isn't installed.
 *
 * Without this a missing binary surfaces as `command not found` replayed into
 * the middle of the film — or worse, as a passing `reel check` that recorded a
 * demo of an error. Checking up front names what's absent while the message can
 * still be acted on, and reports every missing program at once rather than one
 * per re-run.
 */
export function checkRequirements(programs: readonly string[]): void {
  if (programs.length === 0) return;
  const missing = programs.filter((p) => !onPath(p));
  if (missing.length === 0) return;
  const one = missing.length === 1;
  throw new ReelError(
    `Missing ${one ? "a program" : "programs"} this demo needs: ${missing.join(", ")}`,
    `Install ${one ? "it" : "them"}, or drop the ${one ? "name" : "names"} from \`terminal.require\` if the demo no longer uses ${one ? "it" : "them"}.`,
  );
}

function onPath(program: string): boolean {
  // `command -v` is the POSIX spelling and handles shell builtins and functions
  // as well as files on PATH; Windows has no equivalent, so fall back to `where`.
  const probe =
    process.platform === "win32" ? `where ${program}` : `command -v ${program}`;
  return spawnSync(probe, { shell: true, stdio: "ignore" }).status === 0;
}
