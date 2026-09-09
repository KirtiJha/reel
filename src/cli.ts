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
import { recordOne } from "./commands/record.js";
import { exportSchema, SCHEMA_FILE } from "./commands/schema.js";
import { capture } from "./commands/capture.js";
import { say } from "./commands/say.js";
import { draftNarration, printScript, readScript } from "./commands/narrate.js";
import { runDirect } from "./commands/direct.js";
import { lookSheet, previewScene } from "./commands/scene.js";
import { shoot } from "./commands/shoot.js";
import { compose } from "./compose/compose.js";
import { deCdnInstalled } from "./compose/catalog.js";
import { LOOK_NAMES, lookFor } from "./scene/looks.js";
import { authorSpec } from "./ai/author.js";
import { log, setVerbose, ReelError } from "./util/log.js";
import { emit, useJson } from "./util/report.js";
import { StepFailure } from "./driver/run.js";
import { stripAnsi } from "./driver/failure.js";
import { TERMINAL_THEMES, THEME_NAMES } from "./terminal/themes.js";
import { VERSION } from "./version.js";

interface SceneOpts {
  template?: string;
  look?: string;
  accent: string;
  title?: string;
  subtitle?: string;
  eyebrow?: string;
  slate?: string;
  note?: string;
  item: string[];
  frames: string;
  size: string;
  out: string;
}

interface ComposeOpts {
  out: string;
  look?: string;
  /** commander sets this false for --no-fonts. */
  fonts?: boolean;
  accent: string;
  title?: string;
  subtitle?: string;
  music?: string;
  size: string;
  fps: string;
}

interface LooksOpts {
  accent: string;
  title: string;
  size: string;
  at: string;
  out: string;
  list: boolean;
}

/** commander's repeatable-option accumulator. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** `1280x720` → `[1280, 720]`. */
function parseSize(s: string): [number, number] {
  const m = /^(\d+)x(\d+)$/.exec(s.trim());
  if (!m) throw new ReelError(`\`--size ${s}\` is not a size.`, "Write it as WIDTHxHEIGHT, like 1280x720.");
  return [Number(m[1]), Number(m[2])];
}


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
    opts: { draft: boolean; only?: string },
  ) => {
    await withErrors(async () => {
      const loaded = await loadSpec(specPath);
      const res = await recordOne(loaded, { ...opts, version: VERSION });
      log.phase("Done");
      for (const o of res.outputs) log.info(o);
      emit("record", true, {
        result: {
          spec: loaded.path,
          name: loaded.spec.name,
          variants: res.variants,
          outputs: res.outputs,
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
  .command("shoot")
  .argument("<spec>", "path to a .reel.yaml spec")
  .description("Film the app as raw footage plus a shot manifest, for a composition to cut.")
  .option("-o, --out <dir>", "where the footage and manifest go", "shot")
  .option("--flat", "no camera moves at all — the composition does its own framing", false)
  .action(async (specPath: string, opts: { out: string; flat: boolean }) => {
    await withErrors(async () => {
      const loaded = await loadSpec(specPath);
      const res = await shoot(loaded, { out: opts.out, flat: opts.flat, version: VERSION });
      emit("shoot", true, {
        result: {
          dir: res.dir,
          footage: res.footage,
          manifest: res.manifest,
          duration: res.shot.duration,
          beats: res.shot.beats.length,
          captions: res.shot.captions.length,
        },
      });
    });
  });

program
  .command("compose")
  .argument("<manifest...>", "one or more shots.json files — each becomes a chapter, in order")
  .description("Assemble that footage into a HyperFrames project — scenes, storyboard, design spec.")
  .option("-o, --out <dir>", "where the project goes", "film")
  .option("--look <name>", `a Reel look (${LOOK_NAMES.join(", ")}) or an installed HyperFrames frame preset`)
  .option("--no-fonts", "skip fetching a preset's webfonts; declare them local() instead")
  .option("--accent <color>", "brand accent the cards are built from", "#6d8bff")
  .option("--title <text>", "opening card headline (defaults to the spec's name)")
  .option("--subtitle <text>", "opening card subtitle")
  .option("--music <file>", "music bed: a path to a track, or `none`. Omit for a synthesized bed.")
  .option("--size <WxH>", "composition frame", "1920x1080")
  .option("--fps <n>", "frame rate", "30")
  .action(async (manifest: string[], opts: ComposeOpts) => {
    await withErrors(async () => {
      const [width, height] = parseSize(opts.size);
      const res = await compose(manifest, {
        out: opts.out,
        ...(opts.look ? { look: opts.look } : {}),
        ...(opts.fonts === false ? { noFonts: true } : {}),
        accent: opts.accent,
        width,
        height,
        fps: Math.max(1, Number(opts.fps) || 30),
        ...(opts.title === undefined ? {} : { title: opts.title }),
        ...(opts.subtitle === undefined ? {} : { subtitle: opts.subtitle }),
        ...(opts.music === undefined ? {} : { music: opts.music }),
      });
      emit("compose", true, {
        result: { dir: res.dir, index: res.index, duration: res.duration, frames: res.frames },
      });
    });
  });

program
  .command("blocks")
  .argument("<project>", "a project directory written by `reel compose`")
  .description("Make installed catalog blocks renderable offline (rewrite their CDN references).")
  .action(async (project: string) => {
    await withErrors(async () => {
      const touched = await deCdnInstalled(project);
      if (touched.length === 0) log.info("Nothing to rewrite — no installed block links a CDN.");
      emit("blocks", true, { result: { project, rewritten: touched } });
    });
  });

program
  .command("scene")
  .argument("[file]", "a composition of your own (.html), relative to the cwd")
  .description("Shoot a scene across its seek range into one contact sheet.")
  .option("--template <name>", "draw a built-in template instead: title, chapter, statement, bullets")
  .option("--look <name>", `visual identity: ${LOOK_NAMES.join(", ")}`)
  .option("--accent <color>", "brand accent the look is built from", "#6d8bff")
  .option("--title <text>", "template field")
  .option("--subtitle <text>", "template field")
  .option("--eyebrow <text>", "template field")
  .option("--slate <text>", "corner slate, top line")
  .option("--note <text>", "corner slate, second line")
  .option("--item <text>", "a `bullets` line; repeat for more", collect, [])
  .option("--frames <n>", "how many positions to shoot", "6")
  .option("--size <WxH>", "frame size", "1280x720")
  .option("-o, --out <path>", "where to write the sheet", ".reel/scene.png")
  .action(async (file: string | undefined, opts: SceneOpts) => {
    await withErrors(async () => {
      const [width, height] = parseSize(opts.size);
      const res = await previewScene(
        {
          ...(file ? { file } : {}),
          ...(opts.template ? { template: opts.template } : {}),
          ...(opts.look ? { look: opts.look } : {}),
          accent: opts.accent,
          fields: {
            ...(opts.title === undefined ? {} : { title: opts.title }),
            ...(opts.subtitle === undefined ? {} : { subtitle: opts.subtitle }),
            ...(opts.eyebrow === undefined ? {} : { eyebrow: opts.eyebrow }),
            ...(opts.slate === undefined ? {} : { slate: opts.slate }),
            ...(opts.note === undefined ? {} : { slateNote: opts.note }),
            ...(opts.item.length ? { items: opts.item } : {}),
          },
          width,
          height,
          frames: Math.max(1, Number(opts.frames) || 6),
          out: opts.out,
        },
        process.cwd(),
      );
      log.info(`Wrote ${res.out}`);
      emit("scene", true, { result: { out: res.out, points: res.points } });
    });
  });

program
  .command("looks")
  .description("Show every visual identity a scene can be drawn in, side by side.")
  .option("--accent <color>", "brand accent the looks are built from", "#6d8bff")
  .option("--title <text>", "what to set in each tile", "The same words")
  .option("--size <WxH>", "frame size", "960x540")
  .option("--at <p>", "where in the scene to shoot, 0-1", "0.5")
  .option("-o, --out <path>", "where to write the sheet", ".reel/looks.png")
  .option("--list", "print the catalogue as text instead of rendering it", false)
  .action(async (opts: LooksOpts) => {
    await withErrors(async () => {
      if (opts.list) {
        for (const name of LOOK_NAMES) {
          process.stdout.write(`  ${pc.bold(name.padEnd(11))} ${pc.dim(lookFor(name).mood)}\n`);
        }
        return;
      }
      const [width, height] = parseSize(opts.size);
      const res = await lookSheet({
        accent: opts.accent,
        title: opts.title,
        width,
        height,
        frames: 1,
        at: Math.min(1, Math.max(0, Number(opts.at) || 0.5)),
        out: opts.out,
      });
      emit("looks", true, { result: { out: res.out, looks: res.looks } });
    });
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
