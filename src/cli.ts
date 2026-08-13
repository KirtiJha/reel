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
import { record, check } from "./driver/run.js";
import { heal } from "./heal/heal.js";
import { launchStudio } from "./ui/launch.js";
import { initSpec } from "./commands/init.js";
import { authorSpec } from "./ai/author.js";
import { log, setVerbose, ReelError } from "./util/log.js";
import { TERMINAL_THEMES, THEME_NAMES } from "./terminal/themes.js";

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
  .version("0.1.0")
  .option("-v, --verbose", "verbose logging", false)
  .hook("preAction", (thisCmd) => {
    if (thisCmd.opts().verbose) setVerbose(true);
  });

program
  .command("record")
  .argument("<spec>", "path to a .reel.yaml spec")
  .description("Drive your app from a spec and render the demo (GIF/MP4/WebM).")
  .action(async (specPath: string) => {
    await withErrors(async () => {
      const loaded = await loadSpec(specPath);
      const variants = expandMatrix(loaded);
      const outputs: string[] = [];
      for (const v of variants) {
        if (variants.length > 1) log.phase(`Variant: ${v.label}`);
        const res = await record(v.loaded, "record");
        log.ok(
          `${res.frames} frames · ${res.beats} beats · ${(res.durationMs / 1000).toFixed(1)}s`,
        );
        outputs.push(...res.outputs);
      }
      log.phase("Done");
      for (const o of outputs) log.info(o);
    });
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
    });
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
    });
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

async function withErrors(fn: () => void | Promise<void>): Promise<void> {
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
    process.exitCode = 1;
  }
}
