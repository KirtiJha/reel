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
import {
  declaredOutputs,
  fingerprint,
  isUpToDate,
  readStamp,
  stampPath,
  writeStamp,
} from "./spec/fingerprint.js";
import { record, check } from "./driver/run.js";
import { heal } from "./heal/heal.js";
import { launchStudio } from "./ui/launch.js";
import { initSpec } from "./commands/init.js";
import { doctor, printReport } from "./commands/doctor.js";
import { diff, printDiff, DIFF_DEFAULTS } from "./commands/diff.js";
import { authorSpec } from "./ai/author.js";
import { log, setVerbose, ReelError } from "./util/log.js";
import { emit, useJson } from "./util/report.js";
import { StepFailure } from "./driver/run.js";
import { stripAnsi } from "./driver/failure.js";
import { TERMINAL_THEMES, THEME_NAMES } from "./terminal/themes.js";

const VERSION = "0.1.0";
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
  .description("Drive your app from a spec and render the demo (GIF/MP4/WebM).")
  .action(async (specPath: string, opts: { ifChanged: boolean; appRevision?: string }) => {
    await withErrors(async () => {
      const loaded = await loadSpec(specPath);

      // Skipping is only sound because the output is deterministic: identical
      // inputs would produce identical bytes, so the render is pure cost.
      const fp = await fingerprint(loaded, VERSION, opts.appRevision);
      const stamp = stampPath(loaded);
      const outputs0 = declaredOutputs(loaded);
      if (opts.ifChanged) {
        const state = await isUpToDate(await readStamp(stamp), fp, outputs0);
        if (state.upToDate) {
          log.ok(`Up to date — ${state.reason}. Skipping.`);
          emit("record", true, {
            result: { spec: loaded.path, skipped: true, reason: state.reason, outputs: outputs0 },
          });
          return;
        }
        log.info(`Re-recording: ${state.reason}.`);
      }

      const variants = expandMatrix(loaded);
      const outputs: string[] = [];
      const rendered: Record<string, unknown>[] = [];
      let timeline: { label: string; t: number }[] = [];
      let durationMs = 0;
      for (const v of variants) {
        if (variants.length > 1) log.phase(`Variant: ${v.label}`);
        const res = await record(v.loaded, "record");
        log.ok(
          `${res.frames} frames · ${res.beats} beats · ${(res.durationMs / 1000).toFixed(1)}s`,
        );
        outputs.push(...res.outputs);
        // The first variant's beats stand for the demo: a matrix renders the
        // same script at several sizes, so its beats are the same beats.
        if (!timeline.length) {
          timeline = res.timeline;
          durationMs = res.durationMs;
        }
        rendered.push({
          variant: v.label,
          frames: res.frames,
          beats: res.beats,
          durationMs: res.durationMs,
          outputs: res.outputs,
        });
      }
      log.phase("Done");
      for (const o of outputs) log.info(o);
      // Written after a successful render only: a stamp for media that failed
      // to encode would skip the retry that fixes it.
      await writeStamp(stamp, fp, outputs, { beats: timeline, durationMs });
      emit("record", true, {
        result: {
          spec: loaded.path,
          name: loaded.spec.name,
          skipped: false,
          fingerprint: fp.hash,
          variants: rendered,
          outputs,
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
    "percentage of changed pixels before a moment counts as changed",
    String(DIFF_DEFAULTS.threshold * 100),
  )
  .option("-o, --out <dir>", "where to write before/after/difference strips", ".reel-diff")
  .option("--no-out", "skip the comparison images")
  .option("--exit-code", "exit 1 when the renders differ, like git diff --exit-code", false)
  .action(
    async (
      before: string,
      after: string,
      opts: { fps: string; threshold: string; out: string | false; exitCode: boolean },
    ) => {
      await withErrors(async () => {
        const report = await diff(before, after, {
          fps: Number(opts.fps),
          threshold: Number(opts.threshold) / 100,
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

async function withErrors(fn: () => void | Promise<void>, command = "reel"): Promise<void> {
  try {
    await fn();
  } catch (err) {
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
    process.exitCode = 1;
  }
}
