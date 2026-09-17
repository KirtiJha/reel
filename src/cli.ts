#!/usr/bin/env node
// Load .env (like GridFlow's load_dotenv) so LITELLM_*/SSL_* are available.
try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.();
} catch {
  /* no .env present — fine */
}
import { Command } from "commander";
import pc from "picocolors";
import { loadSpec } from "./spec/load.js";
import { expandMatrix } from "./spec/matrix.js";
import { check } from "./driver/run.js";
import { heal } from "./heal/heal.js";
import { launchStudio } from "./ui/launch.js";
import { initSpec } from "./commands/init.js";
import { doctor, printReport } from "./commands/doctor.js";
import { diff, printDiff, DIFF_DEFAULTS } from "./commands/diff.js";
import { SAME_FORMAT_THRESHOLD, sameFormat } from "./diff/compare.js";
import { runReview, printReview, REVIEW_DEFAULTS } from "./commands/review.js";
import { ci, printCi, writeGithubOutputs, CI_DEFAULTS } from "./commands/ci.js";
import { recordOne } from "./commands/record.js";
import { embedSnippets, formatEmbeds } from "./encode/embed.js";
import type { Verdict } from "./review/review.js";
import { exportSchema, SCHEMA_FILE } from "./commands/schema.js";
import { capture } from "./commands/capture.js";
import { say } from "./commands/say.js";
import { draftNarration, printScript, readScript } from "./commands/narrate.js";
import { runDirect } from "./commands/direct.js";
import { authorSpec } from "./ai/author.js";
import { log, setVerbose, ReelError } from "./util/log.js";
import { emit, useJson } from "./util/report.js";
import { runCleanup } from "./util/dispose.js";
import { StepFailure } from "./driver/run.js";
import { stripAnsi } from "./driver/failure.js";
import { TERMINAL_THEMES, THEME_NAMES } from "./terminal/themes.js";
import { VERSION } from "./version.js";

/**
 * Nothing below this line gets to leave a mess behind.
 *
 * A recording holds three things the OS will not reclaim: a temp directory that
 * grows to tens of gigabytes, a headless Chromium, and the app's own detached
 * process group — which keeps its port bound and so breaks the *next* run too.
 * `record()` releases all three in a `finally`, and there are two ordinary ways
 * for a run to end without ever reaching it.
 *
 * Both are handled here, together, because the answer to both is the same: say
 * what happened in Reel's own voice, run the disposers, exit non-zero.
 */
installProcessGuards();

const program = new Command();

/** Truecolour background escape, for printing a theme's palette as swatches. */
const RESET = "\x1b[0m";
function bgHex(hex: string): string {
  const [r, g, b] = rgbOf(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
}
function fgHex(hex: string): string {
  const [r, g, b] = rgbOf(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}
function rgbOf(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

program
  .name("reel")
  .description("Open-source demos-as-code for web apps.")
  .version(VERSION)
  .option("-v, --verbose", "verbose logging", false)
  .option("--json", "print a machine-readable result on stdout (logs stay on stderr)", false)
  .hook("preAction", (thisCmd) => {
    if (thisCmd.opts().verbose) setVerbose(true);
    useJson(Boolean(thisCmd.opts().json));
  });

program
  .command("record")
  .argument("<spec>", "path to a .reel.yaml spec")
  .option(
    "--if-changed",
    "skip the render when the spec, its inputs and its outputs are all unchanged",
    false,
  )
  .option(
    "--app-revision <id>",
    "identifier for the app being demoed (a commit SHA), so a changed app forces a re-render",
  )
  .option(
    "--draft",
    "quick preview: small, low frame rate, video only, and only narration already in the cache",
    false,
  )
  .option(
    "--only <beat>",
    "render just the section a named beat labels, at full quality",
  )
  .description("Drive your app from a spec and render the demo (GIF/MP4/WebM).")
  .action(async (
    specPath: string,
    opts: { ifChanged: boolean; appRevision?: string; draft: boolean; only?: string },
  ) => {
    await withErrors(async () => {
      const loaded = await loadSpec(specPath);
      const res = await recordOne(loaded, { ...opts, version: VERSION });
      const embeds = res.skipped ? [] : embedSnippets(res.outputs, {
        from: process.cwd(),
        title: loaded.spec.name,
      });
      if (!res.skipped) {
        log.phase("Done");
        for (const o of res.outputs) log.info(o);
        // The last step of getting a demo in front of anyone is pasting it
        // somewhere, and that step is different for every format — Markdown has
        // no video tag, and the interactive build wants a query parameter you
        // would have to go and read about. Printing the line costs nothing and
        // is the difference between finishing and almost finishing.
        if (embeds.length > 0) {
          log.phase("Paste this");
          for (const line of formatEmbeds(embeds)) log.info(line);
        }
      }
      emit("record", true, {
        result: {
          spec: loaded.path,
          name: loaded.spec.name,
          skipped: Boolean(res.skipped),
          ...(res.skipped ? { reason: res.skipped } : {}),
          fingerprint: res.fingerprint,
          variants: res.variants,
          outputs: res.outputs,
          embeds,
        },
      });
    }, "record");
  });

program
  .command("check")
  .argument("<spec>", "path to a .reel.yaml spec")
  .description("Re-run the spec headlessly and fail if any step can't complete (CI drift).")
  .action(async (specPath: string) => {
    await withErrors(async () => {
      const loaded = await loadSpec(specPath);
      // Every variant is checked: a responsive layout can hide an element at
      // one width and not another, which is exactly the drift worth catching.
      const variants = expandMatrix(loaded);
      for (const v of variants) {
        if (variants.length > 1) log.phase(`Variant: ${v.label}`);
        await check(v.loaded);
      }
      emit("check", true, {
        result: {
          spec: loaded.path,
          name: loaded.spec.name,
          steps: loaded.spec.steps.length,
          variants: variants.map((v) => v.label),
        },
      });
    }, "check");
  });

program
  .command("heal")
  .argument("<spec>", "path to a .reel.yaml spec")
  .option("--write", "apply the repaired selectors back to the spec file", false)
  .description("Re-run the spec; when a step breaks (UI drift), an agent re-resolves it and repairs the spec.")
  .action(async (specPath: string, opts: { write: boolean }) => {
    await withErrors(async () => {
      const loaded = await loadSpec(specPath);
      const res = await heal(loaded, { write: opts.write });
      log.phase("Repair summary");
      if (res.fixes.length === 0 && res.unresolved.length === 0) {
        log.ok("No drift — every step still works.");
      }
      for (const f of res.fixes) log.info(`step ${f.index}: ${f.before} → ${f.after}`);
      for (const u of res.unresolved) log.error(`step ${u.index}: unrepairable (${u.reason}) — ${u.label}`);
      if (res.fixes.length && !opts.write) {
        log.info("Re-run with --write to apply these fixes to the spec.");
      }
      if (!res.healthy) process.exitCode = 1; // genuine breakage a human must resolve
      emit("heal", res.healthy, {
        result: { spec: loaded.path, fixes: res.fixes, unresolved: res.unresolved, written: opts.write },
      });
    }, "heal");
  });

program
  .command("init")
  .argument("[dir]", "directory to write the spec into", ".")
  .option("--url <url>", "app URL", "http://localhost:3000")
  .option("--name <name>", "demo name", "My demo")
  .description("Scaffold a starter demo.reel.yaml.")
  .action(async (dir: string, opts: { url: string; name: string }) => {
    await withErrors(() => initSpec(dir, opts));
  });

program
  .command("capture")
  .requiredOption("--url <url>", "URL of the running app")
  .option("-o, --out <file>", "spec output path", "demo.reel.yaml")
  .option("--name <name>", "demo name", "Captured demo")
  .option("--force", "overwrite the output file if it exists", false)
  .option("--auth <file>", "start signed in, from a session saved by --save-auth")
  .option("--save-auth <file>", "write the signed-in session out, so `record` can replay it")
  .description("Author by doing — drive your app in a browser and get a spec back.")
  .action(async (opts: { url: string; out: string; name: string; force: boolean; auth?: string; saveAuth?: string }) => {
    await withErrors(async () => {
      const res = await capture(opts);
      emit("capture", true, { result: { spec: res.file, steps: res.steps } });
    }, "capture");
  });

program
  .command("schema")
  .description("Print the JSON Schema for a .reel.yaml — editor autocomplete and validation.")
  .option("-o, --out <file>", "write it to a file instead of stdout, to vendor it in your repo")
  .action(async (opts: { out?: string }) => {
    await withErrors(async () => {
      if (opts.out) {
        await exportSchema(opts.out);
        return;
      }
      const { readFile } = await import("node:fs/promises");
      process.stdout.write(await readFile(SCHEMA_FILE, "utf8"));
    }, "schema");
  });

program
  .command("doctor")
  .description("Check that this machine can record: browser, ffmpeg, image pipeline, temp space.")
  .action(async () => {
    await withErrors(async () => {
      const report = await doctor();
      printReport(report);
      emit("doctor", report.ok, { result: { checks: report.checks } });
      // Non-zero so a CI setup step fails here, where the message is clear,
      // rather than three minutes later inside Playwright.
      if (!report.ok) process.exitCode = 1;
    }, "doctor");
  });

program
  .command("diff")
  .argument("<before>", "the earlier render (gif, mp4 or webm)")
  .argument("<after>", "the newer render")
  .description("Compare two renders and report which parts of the demo changed.")
  .option("--fps <n>", "samples per second to compare at", String(DIFF_DEFAULTS.fps))
  .option(
    "--threshold <pct>",
    "percentage of changed pixels before a moment counts as changed " +
      `(default: ${SAME_FORMAT_THRESHOLD * 100} comparing one format with itself, ` +
      `${DIFF_DEFAULTS.threshold * 100} across formats)`,
  )
  .option("-o, --out <dir>", "where to write before/after/difference strips", ".reel-diff")
  .option("--no-out", "skip the comparison images")
  .option("--exit-code", "exit 1 when the renders differ, like git diff --exit-code", false)
  .action(
    async (
      before: string,
      after: string,
      opts: { fps: string; threshold?: string; out: string | false; exitCode: boolean },
    ) => {
      await withErrors(async () => {
        // Two renders in the same format have a floor of literally zero — the
        // output is deterministic — so holding them to a threshold sized for
        // GIF palette quantisation throws away real detections. An explicit
        // --threshold always wins.
        const threshold =
          opts.threshold !== undefined
            ? Number(opts.threshold) / 100
            : sameFormat(before, after)
              ? SAME_FORMAT_THRESHOLD
              : DIFF_DEFAULTS.threshold;
        const report = await diff(before, after, {
          fps: Number(opts.fps),
          threshold,
          out: opts.out,
        });
        printDiff(report);
        emit("diff", true, { result: report });
        // Opt-in, because two renders differing is the expected outcome of
        // changing the app — it is a result, not a failure.
        if (opts.exitCode && !report.identical) process.exitCode = 1;
      }, "diff");
    },
  );

program
  .command("ci")
  .argument("[specs...]", "spec paths or globs (default: **/*.reel.yaml)")
  .description("Run every demo in the repository and report one result — what the Action calls.")
  .option("--mode <mode>", "check (drift only) or record (regenerate media)", CI_DEFAULTS.mode)
  .option("--review", "compare each re-render against the media it replaced", false)
  .option(
    "--fail-on <verdict>",
    "exit 1 at this review verdict or worse: cosmetic, content, stale-caption, never",
    CI_DEFAULTS.failOn,
  )
  .option("--if-changed", "skip a render when its spec, inputs and outputs are unchanged", false)
  .option("--app-revision <id>", "identifier for the app being demoed (a commit SHA)")
  .option("-C, --dir <dir>", "directory to resolve specs from", ".")
  .option("--comment <file>", "write a pull-request comment for the whole run")
  .action(
    async (
      specs: string[],
      opts: {
        mode: string;
        review: boolean;
        failOn: string;
        ifChanged: boolean;
        appRevision?: string;
        dir: string;
        comment?: string;
      },
    ) => {
      await withErrors(async () => {
        if (opts.mode !== "check" && opts.mode !== "record") {
          throw new ReelError(`Unknown --mode: ${opts.mode}`, "One of: check, record.");
        }
        const failOn = opts.failOn as Verdict | "never";
        if (!["cosmetic", "content", "stale-caption", "unreviewed", "never"].includes(failOn)) {
          throw new ReelError(
            `Unknown --fail-on value: ${opts.failOn}`,
            "One of: cosmetic, content, stale-caption, never.",
          );
        }
        if (opts.review && opts.mode !== "record") {
          throw new ReelError(
            "--review needs --mode record.",
            "A drift check renders nothing, so there is no new media to compare.",
          );
        }
        const report = await ci(opts.dir, specs, {
          mode: opts.mode,
          review: opts.review,
          failOn,
          ifChanged: opts.ifChanged,
          appRevision: opts.appRevision,
          version: VERSION,
          comment: opts.comment,
        });
        printCi(report);
        await writeGithubOutputs(report);
        emit("ci", !report.failed, { result: report });
        if (report.failed) process.exitCode = 1;
      }, "ci");
    },
  );

program
  .command("review")
  .argument("<before>", "the earlier render (gif, mp4 or webm)")
  .argument("<after>", "the newer render")
  .description("Say what changed between two renders, and whether the demo is still true.")
  .option("--fps <n>", "samples per second to compare at", String(REVIEW_DEFAULTS.fps))
  .option(
    "--threshold <pct>",
    "percentage of changed pixels before a moment counts as changed " +
      `(default: ${SAME_FORMAT_THRESHOLD * 100} comparing one format with itself, ` +
      `${REVIEW_DEFAULTS.threshold * 100} across formats)`,
  )
  .option("-o, --out <dir>", "where to write before/after/difference strips", ".reel-diff")
  .option(
    "--fail-on <verdict>",
    "exit 1 at this verdict or worse: cosmetic, content, stale-caption, never",
    REVIEW_DEFAULTS.failOn,
  )
  .option("--model <name>", "model to review with (defaults to the configured one)")
  .action(
    async (
      before: string,
      after: string,
      opts: {
        fps: string;
        threshold?: string;
        out: string | false;
        failOn: string;
        model?: string;
      },
    ) => {
      await withErrors(async () => {
        const failOn = opts.failOn as Verdict | "never";
        if (!["cosmetic", "content", "stale-caption", "unreviewed", "never"].includes(failOn)) {
          throw new ReelError(
            `Unknown --fail-on value: ${opts.failOn}`,
            "One of: cosmetic, content, stale-caption, never.",
          );
        }
        const outcome = await runReview(before, after, {
          fps: Number(opts.fps),
          // The same choice `reel diff` and `reel ci` make, and for the same
          // reason: two renders in one format have a noise floor of zero, so
          // holding them to a threshold sized for GIF palette quantisation they
          // cannot contain throws away real detections — a two-digit price edit
          // moves 0.02% of pixels, above the same-format floor and below the
          // cross-format one. This command was the last one still hard-wired to
          // the cross-format number, which meant `reel review` and `reel diff`
          // gave different answers about the same pair of files.
          threshold:
            opts.threshold !== undefined
              ? Number(opts.threshold) / 100
              : sameFormat(before, after)
                ? SAME_FORMAT_THRESHOLD
                : REVIEW_DEFAULTS.threshold,
          out: opts.out,
          failOn,
          model: opts.model,
        });
        printReview(outcome);
        emit("review", !outcome.failed, { result: outcome });
        if (outcome.failed) process.exitCode = 1;
      }, "review");
    },
  );

program
  .command("themes")
  .description("List the colour schemes available to terminal demos.")
  .action(() => {
    // Printed as a swatch of the scheme's own colours: a list of names tells you
    // nothing about what you are choosing between.
    for (const name of THEME_NAMES) {
      const t = TERMINAL_THEMES[name];
      // Base tones first: Solarized's light and dark variants share every accent
      // colour and differ only here, so a palette-only swatch would show them as
      // the same theme.
      const base = bgHex(t.background) + fgHex(t.foreground) + " Aa " + RESET;
      const swatch = t.palette
        .slice(0, 8)
        .map((hex) => bgHex(hex) + "  " + RESET)
        .join("");
      process.stdout.write(`  ${base} ${swatch}  ${name}\n`);
    }
  });

program
  .command("ui")
  .description("Launch Reel Studio — the local web UI (Next.js).")
  .option("-p, --port <n>", "UI port", "4488")
  .option("--api-port <n>", "API port", "4499")
  .option("--no-open", "don't open the browser automatically")
  .action(async (opts: { port: string; apiPort: string; open: boolean }) => {
    await withErrors(() =>
      launchStudio({ uiPort: Number(opts.port), apiPort: Number(opts.apiPort), open: opts.open }),
    );
  });

program
  .command("direct")
  .argument("<spec>", "path to a .reel.yaml spec")
  .option("--write", "insert the proposed direction into the spec", false)
  .description("Propose camera and annotation direction for a spec, from what it already says.")
  .action(async (specPath: string, opts: { write: boolean }) => {
    await withErrors(async () => {
      const loaded = await loadSpec(specPath);
      const res = await runDirect(loaded, opts);
      emit("direct", true, {
        result: {
          spec: loaded.path,
          written: res.written,
          directions: res.directions.map((d) => ({
            index: d.index,
            because: d.because,
            step: d.step,
          })),
        },
      });
    }, "direct");
  });

program
  .command("narrate")
  .argument("<spec>", "path to a .reel.yaml spec")
  .option("--draft", "propose a line for every card and beat that says nothing", false)
  .description("Read the demo's narration as a script — every line, its length, and the total.")
  .action(async (specPath: string, opts: { draft: boolean }) => {
    await withErrors(async () => {
      const loaded = await loadSpec(specPath);
      const script = readScript(loaded.spec.steps);
      printScript(script, loaded.spec.name);
      const proposed = opts.draft ? await draftNarration(loaded) : [];
      emit("narrate", true, {
        result: {
          spec: loaded.path,
          lines: script.lines.length,
          words: script.words,
          estimatedMs: script.estimatedMs,
          silent: script.silent,
          proposed,
        },
      });
    }, "narrate");
  });

program
  .command("say")
  .argument("<text>", "the line to hear")
  .option("--spec <file>", "borrow the voice (and the cache) from this spec")
  .option("-o, --out <file>", "copy the audio here instead of leaving it in the cache")
  .option("--dry-run", "estimate the length from the word count — no key, no network", false)
  .description("Speak one line and say how long it runs, without rendering anything.")
  .action(async (text: string, opts: { spec?: string; out?: string; dryRun: boolean }) => {
    await withErrors(async () => {
      const res = await say(text, opts);
      emit("say", true, {
        result: {
          text: res.text,
          durationMs: res.durationMs,
          cached: res.cached,
          estimated: Boolean(res.estimated),
          file: res.file,
        },
      });
    }, "say");
  });

program
  .command("author")
  .argument("<story>", 'plain-English story, e.g. "sign up and create a project"')
  .requiredOption("--url <url>", "URL of the running app")
  .option("-o, --out <file>", "spec output path", "demo.reel.yaml")
  .option("--model <model>", "model id (BYO-key, provider-agnostic)")
  .description("AI authoring: an agent drives your app and emits a spec you own. (v0.3)")
  .action(async (story: string, opts: { url: string; out: string; model?: string }) => {
    await withErrors(() => authorSpec(story, opts));
  });

program.parseAsync(process.argv);

/**
 * How long to wait for Playwright to close the browser before exiting anyway.
 * Long enough for a healthy shutdown, short enough that Ctrl-C still feels like
 * Ctrl-C when it isn't.
 */
const SHUTDOWN_GRACE_MS = 5_000;

function installProcessGuards(): void {
  let leaving = false;

  const teardown = (code: number, signal?: NodeJS.Signals): void => {
    if (leaving) return; // a second Ctrl-C is impatience, not a new event
    leaving = true;
    runCleanup();
    process.exitCode = code;
    // Playwright installs its own SIGINT/SIGTERM handler while a browser is
    // open: it closes Chromium and then exits the process itself. Calling
    // `process.exit` here would pre-empt that and orphan the browser, so hand
    // over when it is listening — with a bounded backstop, because its SIGTERM
    // handler closes the browser without ever exiting.
    if (signal && process.listenerCount(signal) > 0) {
      setTimeout(() => process.exit(code), SHUTDOWN_GRACE_MS).unref();
      return;
    }
    process.exit(code);
  };

  // `once`, so the handler unregisters itself: a second Ctrl-C then reaches
  // Playwright's handler, which kills the browser outright instead of asking.
  process.once("SIGINT", () => {
    log.warn("Interrupted — cleaning up.");
    teardown(130, "SIGINT"); // 128 + SIGINT, the shell convention
  });
  process.once("SIGTERM", () => {
    log.warn("Terminated — cleaning up.");
    teardown(143, "SIGTERM");
  });

  // The other way out of `record()`'s try: a promise nobody is awaiting. The
  // capture loop is one (`this.loop = this.run()`), and a rejection from it
  // used to print a raw Node stack and exit before any `finally` ran. Whatever
  // the cause, it is a Reel failure and it reports like one.
  process.once("unhandledRejection", (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    report(err, "reel");
    if (!(err instanceof ReelError)) {
      // `report` has already printed the message, and the stack under
      // REEL_DEBUG. What it cannot say is that reaching here at all is a bug:
      // every failure Reel knows about travels as a ReelError.
      console.error(pc.dim("  This is a bug in Reel — please report it, with REEL_DEBUG=1 output."));
    }
    teardown(1);
  });
}

/** The error half of a command's output: message, hint, and the JSON envelope. */
function report(err: unknown, command: string): void {
  if (err instanceof ReelError) {
    log.error(err.message);
    if (err.hint) console.error(pc.dim(`  ${err.hint}`));
  } else {
    log.error((err as Error).message);
    if (process.env.REEL_DEBUG) console.error(err);
  }
  // A failed step already wrote its diagnostics; naming them here is what
  // lets a CI job surface them without knowing where Reel puts things.
  const failure = err instanceof StepFailure ? err : null;
  emit(command, false, {
    error: {
      // Same reasoning as the failure report: colour codes are for a terminal,
      // not for whatever parses this.
      message: stripAnsi((err as Error).message),
      hint: err instanceof ReelError ? err.hint : undefined,
      step: failure?.step,
      artifacts: failure?.artifacts
        ? {
            dir: failure.artifacts.dir,
            screenshot: failure.artifacts.screenshot,
            clip: failure.artifacts.clip,
            html: failure.artifacts.html,
            report: failure.artifacts.report,
          }
        : undefined,
    },
  });
}

async function withErrors(fn: () => void | Promise<void>, command = "reel"): Promise<void> {
  try {
    await fn();
  } catch (err) {
    report(err, command);
    process.exitCode = 1;
  }
}
