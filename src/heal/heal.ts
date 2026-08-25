import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import type { LoadedSpec } from "../spec/load.js";
import { resolveOutput } from "../spec/load.js";
import type { Step } from "../spec/schema.js";
import { applyDeterminism, DETERMINISTIC_LAUNCH_ARGS } from "../driver/determinism.js";
import { startApp, type RunningApp } from "../driver/app.js";
import { runStep, type StepContext } from "../driver/steps.js";
import { Timeline } from "../driver/timeline.js";
import { Recorder } from "../driver/recorder.js";
import { collectInteractive, formatSnapshot, type Snapshot } from "../ai/agent-tools.js";
import { applyMocks } from "../mock/mock.js";
import { chat, loadLlmConfig, messageText, type LlmConfig } from "../ai/llm.js";
import { stepSelector, withStepSelector, describeStep } from "./selectors.js";
import { deterministicCandidates } from "./candidates.js";
import { log, ReelError } from "../util/log.js";

export interface Fix {
  index: number; // 1-based step number
  before: string;
  after: string;
  label: string;
}
export interface HealResult {
  fixes: Fix[];
  unresolved: { index: number; label: string; reason: string }[];
  healthy: boolean; // true if nothing is broken (with or without repairs)
}

/**
 * Self-healing drift repair. Re-runs the spec headlessly; when a selector-based
 * step breaks (the UI drifted), an LLM re-resolves the equivalent element on the
 * current page, the repair is verified by actually running it, and the flow
 * continues — so one run repairs every broken step. With `write`, the fixes are
 * applied back to the spec file. Turns "your demo broke" into "your demo fixed
 * itself."
 */
export async function heal(loaded: LoadedSpec, opts: { write: boolean }): Promise<HealResult> {
  const { spec } = loaded;
  // The model is a fallback, not a prerequisite: most drift is a renamed id or
  // a relabelled button, which the deterministic ladder resolves offline.
  let cfg: LlmConfig | null = null;
  try {
    cfg = loadLlmConfig();
    log.info(`Repair model: ${cfg.model} · via ${cfg.apiBase} (fallback)`);
  } catch {
    log.info("No model configured — repairing with the deterministic ladder only.");
  }

  let app: RunningApp | null = null;
  let browser: Browser | null = null;
  const workDir = await mkdtemp(join(tmpdir(), "reel-heal-"));

  const fixes: Fix[] = [];
  const unresolved: HealResult["unresolved"] = [];

  try {
    if (spec.run) {
      const cwd = spec.run.cwd ? resolveOutput(loaded, spec.run.cwd) : loaded.dir;
      app = await startApp({ ...spec.run, cwd });
    }

    browser = await chromium.launch({ headless: true, args: DETERMINISTIC_LAUNCH_ARGS });
    const context = await browser.newContext({
      viewport: { width: spec.viewport.width, height: spec.viewport.height },
      deviceScaleFactor: spec.viewport.scale,
      colorScheme: spec.theme,
      storageState: spec.storageState ? resolveOutput(loaded, spec.storageState) : undefined,
    });
    await applyDeterminism(context, spec.deterministic);
    if (spec.mock) await applyMocks(context, spec.mock, loaded);
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    await page.goto(spec.url, { waitUntil: "domcontentloaded" }).catch(() => {});

    const timeline = new Timeline(spec.polish.speed);
    const ctx: StepContext = {
      page,
      spec,
      mode: "check",
      fps: spec.output.fps ?? 30,
      now: () => timeline.now(),
      beats: [],
      zoom: [],
      captions: [],
      say: [],
      scenes: [],
      // Healing replays the flow without filming it, so nothing cosmetic runs.
      rec: new Recorder(page, null, timeline, {
        fps: spec.output.fps ?? 30,
        deterministic: true,
        cinematic: false,
        animationsDisabled: spec.deterministic.disableAnimations,
      }),
          specDir: loaded.dir,
    };

    log.phase(`Healing “${spec.name}” (${spec.steps.length} steps)`);
    for (let i = 0; i < spec.steps.length; i++) {
      const step = spec.steps[i]!;
      try {
        await runStep(step, ctx, i);
        continue; // step still works
      } catch (err) {
        const sel = stepSelector(step);
        if (!sel) {
          unresolved.push({ index: i + 1, label: describeStep(step), reason: "not a selector-based step" });
          log.error(`Step ${i + 1} broke and can't be auto-repaired: ${describeStep(step)}`);
          continue;
        }
        log.warn(`Step ${i + 1} broke — repairing: ${describeStep(step)}`);
        const snapshot = await collectInteractive(page);

        // Try the cheap, offline candidates first; each is proven by actually
        // running the step, so a wrong guess costs a retry, never a bad fix.
        const tried: string[] = [];
        let repaired: string | null = null;
        for (const candidate of deterministicCandidates(sel, snapshot.elements)) {
          tried.push(candidate);
          if (await stepWorks(step, candidate, ctx, i)) {
            repaired = candidate;
            log.debug(`resolved offline: ${sel} → ${candidate}`);
            break;
          }
        }

        // Only ask the model about what the ladder couldn't settle.
        if (!repaired && cfg) {
          const proposed = await resolveSelector(cfg, step, sel, snapshot);
          if (proposed && !tried.includes(proposed)) {
            tried.push(proposed);
            if (await stepWorks(step, proposed, ctx, i)) repaired = proposed;
            else log.error(`Proposed fix for step ${i + 1} failed to run: ${proposed}`);
          }
        }

        if (!repaired) {
          const reason = tried.length
            ? `no working replacement (tried ${tried.length}: ${tried.join(", ")})`
            : cfg
              ? "no matching element on the current page"
              : "no matching element offline — configure a model for harder cases";
          unresolved.push({ index: i + 1, label: describeStep(step), reason });
          log.error(`Could not find a replacement for step ${i + 1}.`);
          continue;
        }
        fixes.push({ index: i + 1, before: sel, after: repaired, label: describeStep(step) });
        log.ok(`Repaired step ${i + 1}: ${sel}  →  ${repaired}`);
      }
    }

    if (opts.write && fixes.length) await applyFixes(loaded.path, fixes);

    return { fixes, unresolved, healthy: unresolved.length === 0 };
  } finally {
    await browser?.close().catch(() => {});
    await app?.stop().catch(() => {});
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Does the step work with this selector? A repair is only ever accepted after
 * it has actually run, so neither the ladder nor the model can write a
 * plausible-looking selector that doesn't resolve.
 */
async function stepWorks(
  step: Step,
  selector: string,
  ctx: StepContext,
  i: number,
): Promise<boolean> {
  try {
    await runStep(withStepSelector(step, selector), ctx, i);
    return true;
  } catch {
    return false;
  }
}

/** Ask the model which current element the broken step should now target. */
async function resolveSelector(
  cfg: LlmConfig,
  step: Step,
  brokenSelector: string,
  snapshot: Snapshot,
): Promise<string | null> {
  const system =
    "You maintain automated UI demo scripts. A demo step stopped working because the app's UI changed. " +
    "Given the interactive elements currently on the page, pick the single element the step should now target. " +
    "Respond with ONLY the element ref (like e4). If no element plausibly matches the step's original intent, respond with NONE.";
  const user =
    `Broken step: ${describeStep(step)}\n` +
    `Original selector: ${brokenSelector}\n\n` +
    `${formatSnapshot(snapshot)}\n\n` +
    `Which ref should this step target now? Answer with just the ref, or NONE.`;

  const res = await chat(cfg, [
    { role: "system", content: system },
    { role: "user", content: user },
  ]);
  const text = messageText(res.message).trim();
  const m = /\be(\d+)\b/i.exec(text);
  if (!m) return null; // NONE or unparseable
  const ref = `e${m[1]}`;
  return snapshot.elements.find((e) => e.ref === ref)?.selector ?? null;
}

/** Apply repaired selectors back to the spec file, preserving formatting. */
export async function applyFixes(specPath: string, fixes: Fix[]): Promise<void> {
  let raw = await readFile(specPath, "utf8");
  const applied = new Map<string, string>(); // before → after already written
  let count = 0;
  for (const fix of fixes) {
    const prior = applied.get(fix.before);
    if (prior !== undefined) {
      if (prior !== fix.after) {
        log.warn(`Selector "${fix.before}" maps to different fixes (${prior} vs ${fix.after}); step ${fix.index} may need manual review.`);
      }
      continue;
    }
    // Replace the old selector whether it's bare or wrapped in quotes, and
    // always emit a YAML-safe double-quoted value (e.g. "#add" — a bare #add
    // would be parsed as a comment).
    //
    // The match has to be a *whole* scalar, not a substring of one. Replacing
    // every occurrence anywhere in the file meant a fix for one step rewrote
    // the middle of another step that merely contained the same text:
    //
    //   - waitFor: "text=Aalu parwal sabji × 1 · just now"
    //
    // became `""text=P" × 1 · just now"`, which is not YAML at all. `--write`
    // destroyed the spec it was asked to repair, and the next command could
    // not even parse it. So the value must start after a `:`/`-`/`,`/`{` and
    // end at a quote, comma, brace, comment or end of line — anything else is
    // a longer string that happens to contain this selector, and is left for
    // its own fix or for a human.
    const re = () =>
      new RegExp(
        `(?<=(?::|-|,|\\{)\\s*)(["']?)${escapeRegExp(fix.before)}\\1(?=\\s*(?:[,}]|#|$))`,
        "gm",
      );
    if (re().test(raw)) {
      raw = raw.replace(re(), yamlDoubleQuote(fix.after));
      applied.set(fix.before, fix.after);
      count++;
    } else {
      log.warn(`Could not locate "${fix.before}" in the spec to rewrite — apply step ${fix.index} manually.`);
    }
  }
  await writeFile(specPath, raw, "utf8");
  log.ok(`Applied ${count} fix(es) to ${specPath}`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function yamlDoubleQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
