import { copyFile, mkdir, mkdtemp, readdir, stat, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { loadSpec } from "../spec/load.js";
import { declaredOutputs } from "../spec/fingerprint.js";
import { check } from "../driver/run.js";
import { recordOne } from "./record.js";
import { runReview, tally, type ReviewOutcome } from "./review.js";
import { atLeast, worstVerdict, type Verdict } from "../review/review.js";
import { REVIEW_DEFAULTS } from "./review.js";
import { formatRange } from "../diff/compare.js";
import { log, ReelError } from "../util/log.js";

/**
 * `reel ci` — every demo in the repository, in one run, with one exit code.
 *
 * The single-spec commands are the right shape for a person at a terminal and
 * the wrong shape for a repository that has grown past one demo. Forty specs
 * means forty invocations, forty exit codes to reconcile, and a shell loop in
 * YAML deciding what "the build failed" means — which is exactly the sort of
 * logic that ends up untested and only ever runs somewhere you cannot debug.
 *
 * So the loop lives here, where it is typechecked and tested, and the GitHub
 * Action is a thin wrapper that installs Reel and calls this. The action then
 * has almost no logic of its own to get wrong, and everything it does can be
 * reproduced locally by running the same command.
 */

export type CiMode = "check" | "record";

export interface CiOptions {
  mode: CiMode;
  /** Compare each re-render against the media it replaced. */
  review: boolean;
  /** The verdict at or above which the run fails. */
  failOn: Verdict | "never";
  ifChanged?: boolean;
  appRevision?: string;
  version: string;
  /** Where to write the pull-request comment, when one is wanted. */
  comment?: string;
}

export interface CiSpecResult {
  spec: string;
  name: string;
  ok: boolean;
  /** Why the render was skipped, when it was already current. */
  skipped?: string;
  error?: string;
  outputs: string[];
  /** Whether this render produced different media from the one it replaced. */
  changed: boolean;
  review?: {
    verdict: Verdict;
    model: string | null;
    findings: { startMs: number; endMs: number; verdict: Verdict; summary: string }[];
    unconfigured?: string;
  };
}

export interface CiReport {
  mode: CiMode;
  results: CiSpecResult[];
  /** The worst verdict across every reviewed spec. */
  verdict: Verdict;
  failed: boolean;
}

/* ------------------------------------------------------------------ *
 * Finding the specs
 * ------------------------------------------------------------------ */

/** Directories never worth walking, and expensive to walk by accident. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", ".next", "coverage"]);

/** Default when the caller names nothing: every spec in the tree. */
export const DEFAULT_PATTERN = "**/*.reel.yaml";

/** Does this string need matching, or is it just a path? */
export function isGlob(pattern: string): boolean {
  return /[*?[\]]/.test(pattern);
}

/**
 * A glob, as a regular expression.
 *
 * `**` crosses directory boundaries and `*` does not — the distinction people
 * expect, and the one that decides whether `examples/*.reel.yaml` quietly
 * matches a spec three levels down.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` may also match nothing at all, so `**/*.yaml` finds `a.yaml`.
        const slash = pattern[i + 2] === "/";
        out += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      continue;
    }
    out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function matchesGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

/**
 * Resolve the patterns a caller gave into spec files that exist.
 *
 * A plain path is taken at its word and a missing one is an error: a typo in a
 * spec path that silently matches nothing would report a green build for a demo
 * nobody ran, which is the one outcome this command exists to prevent.
 */
export async function findSpecs(dir: string, patterns: string[]): Promise<string[]> {
  const found = new Set<string>();
  const globs = patterns.filter(isGlob);

  for (const p of patterns) {
    if (isGlob(p)) continue;
    const abs = resolve(dir, p);
    try {
      await stat(abs);
    } catch {
      throw new ReelError(`No such spec: ${p}`, "Pass a path that exists, or a glob to match many.");
    }
    found.add(abs);
  }

  if (globs.length) {
    // `readdir({recursive})` rather than `fs.glob`, which only exists on Node 22
    // and would make the action's Node version part of its contract.
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      // Resolved, because `parentPath` inherits the form of the directory it
      // was given: a relative `dir` yields relative entries, and mixing those
      // with the absolute paths above would defeat both the sort and the
      // deduplication — a spec named twice would then be recorded twice.
      const abs = resolve(e.parentPath ?? dir, e.name);
      const rel = relative(resolve(dir), abs).split(sep).join("/");
      if (rel.split("/").some((part) => SKIP_DIRS.has(part))) continue;
      if (globs.some((g) => matchesGlob(g, rel))) found.add(abs);
    }
  }

  // Sorted so the report reads the same way twice, and so a failure is always
  // reported against the same spec when several break.
  return [...found].sort();
}

/* ------------------------------------------------------------------ *
 * Running them
 * ------------------------------------------------------------------ */

/**
 * The output a review should compare, when a spec declares several.
 *
 * MP4 before WebM before GIF: a GIF is palette-quantised, so two renders of the
 * same frame can differ in dithering alone. Comparing the lossy copy would
 * report a change nobody made.
 */
export function reviewable(outputs: string[]): string | null {
  for (const ext of [".mp4", ".webm", ".gif"]) {
    const hit = outputs.find((o) => extname(o).toLowerCase() === ext);
    if (hit) return hit;
  }
  return null;
}

/** Copy what already exists, so a re-render can be compared with what it replaced. */
async function snapshot(outputs: string[], dir: string): Promise<Map<string, string>> {
  const saved = new Map<string, string>();
  for (const out of outputs) {
    try {
      // A storyboard is a declared output and a directory. Only files are
      // comparable, and only video files get reviewed in any case.
      if (!(await stat(out)).isFile()) continue;
    } catch {
      continue; // never rendered before — nothing to compare against
    }
    const to = join(dir, `${saved.size}-${basename(out)}`);
    await copyFile(out, to);
    saved.set(out, to);
    // The stamp travels with the media: `reel review` reads the caption
    // timeline from beside the file it is given, and without it a stale
    // caption cannot be detected at all.
    await copyFile(join(dirOf(out), ".reel-stamp.json"), join(dir, ".reel-stamp.json")).catch(
      () => {},
    );
  }
  return saved;
}

function dirOf(file: string): string {
  return resolve(file, "..");
}

export async function ci(dir: string, patterns: string[], opts: CiOptions): Promise<CiReport> {
  const specs = await findSpecs(dir, patterns.length ? patterns : [DEFAULT_PATTERN]);
  if (specs.length === 0) {
    throw new ReelError(
      `No specs matched ${patterns.join(", ") || DEFAULT_PATTERN} under ${dir}.`,
      "Name a spec explicitly, or check the pattern.",
    );
  }
  log.phase(`${specs.length} spec${specs.length === 1 ? "" : "s"}`);
  for (const s of specs) log.info(relative(dir, s));

  const work = await mkdtemp(join(tmpdir(), "reel-ci-"));
  const results: CiSpecResult[] = [];

  for (const spec of specs) {
    const rel = relative(dir, spec);
    log.phase(rel);
    const result: CiSpecResult = { spec: rel, name: rel, ok: false, outputs: [], changed: false };
    try {
      const loaded = await loadSpec(spec);
      result.name = loaded.spec.name;

      if (opts.mode === "check") {
        await check(loaded);
        result.ok = true;
        results.push(result);
        continue;
      }

      const before = opts.review
        ? await snapshot(declaredOutputs(loaded), await mkdtemp(join(work, "before-")))
        : new Map<string, string>();

      const rendered = await recordOne(loaded, opts);
      result.ok = true;
      result.outputs = rendered.outputs.map((o) => relative(dir, o));
      if (rendered.skipped) {
        result.skipped = rendered.skipped;
        results.push(result);
        continue;
      }

      const target = reviewable(rendered.outputs);
      const previous = target ? before.get(target) : undefined;
      if (!opts.review || !target || !previous) {
        // A first render has nothing to compare against. That is not a change
        // and not a failure; it is simply the baseline.
        results.push(result);
        continue;
      }

      const outcome = await runReview(previous, target, {
        ...REVIEW_DEFAULTS,
        // The exit code is decided once, at the end, across every spec — a
        // per-spec one would stop the run before the later demos were seen.
        failOn: "never",
        out: false,
      });
      result.changed = !outcome.diff.identical && outcome.diff.ranges.length > 0;
      result.review = {
        verdict: worstVerdict(outcome),
        model: outcome.model,
        findings: outcome.findings.map((f) => ({
          startMs: f.startMs,
          endMs: f.endMs,
          verdict: f.verdict,
          summary: f.summary,
        })),
        ...(outcome.unconfigured ? { unconfigured: outcome.unconfigured } : {}),
      };
    } catch (err) {
      result.ok = false;
      result.error = (err as Error).message.split("\n")[0] ?? "failed";
      log.error(`${rel}: ${result.error}`);
    }
    results.push(result);
  }

  const verdict = worstOverall(results);
  const failed =
    results.some((r) => !r.ok) || (opts.failOn !== "never" && atLeast(verdict, opts.failOn));

  if (opts.comment) {
    await mkdir(dirOf(opts.comment), { recursive: true }).catch(() => {});
    const { writeFile } = await import("node:fs/promises");
    await writeFile(opts.comment, markdownCi({ mode: opts.mode, results, verdict, failed }), "utf8");
    log.info(`Wrote ${opts.comment}`);
  }

  return { mode: opts.mode, results, verdict, failed };
}

/** The worst verdict any spec came back with. */
export function worstOverall(results: CiSpecResult[]): Verdict {
  let worst: Verdict = "cosmetic";
  for (const r of results) {
    const v = r.review?.verdict;
    if (v && atLeast(v, worst) && v !== worst) worst = v;
  }
  return worst;
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

export function printCi(report: CiReport): void {
  log.phase("Summary");
  for (const r of report.results) {
    const mark = !r.ok ? "✗" : r.skipped ? "–" : r.changed ? "~" : "✓";
    const note = !r.ok
      ? r.error
      : r.skipped
        ? "up to date"
        : r.changed
          ? `changed${r.review ? ` · ${r.review.verdict}` : ""}`
          : "unchanged";
    console.error(`  ${mark} ${r.spec} — ${note}`);
  }

  for (const r of report.results) {
    for (const f of r.review?.findings ?? []) {
      if (f.verdict === "cosmetic") continue;
      console.error(`\n  ${r.spec} ${formatRange(f)}\n    ${f.summary}`);
    }
  }

  const n = report.results.length;
  const demos = `${n} demo${n === 1 ? "" : "s"}`;
  const broken = report.results.filter((x) => !x.ok).length;
  if (broken) log.error(`${broken} of ${demos} failed.`);
  else if (report.failed) log.warn(`Every demo ran, but the review says ${report.verdict}.`);
  else log.ok(`${demos} — all current, all honest.`);
}

const BADGE: Record<Verdict, string> = {
  "stale-caption": "🔴",
  content: "🟡",
  unreviewed: "⚪",
  cosmetic: "⚫",
};

/**
 * Every spec in one comment.
 *
 * One comment rather than one per spec: a pull request that touches a shared
 * component changes a dozen demos, and a dozen bot comments is a thread nobody
 * reads. The table is the state; the list underneath is only the parts that
 * need a decision.
 */
export function markdownCi(report: CiReport, opts: { maxRows?: number } = {}): string {
  const lines: string[] = ["### 🎬 Demos", ""];
  const broken = report.results.filter((r) => !r.ok);
  const changed = report.results.filter((r) => r.ok && r.changed);
  const notable = report.results.flatMap((r) =>
    (r.review?.findings ?? [])
      .filter((f) => f.verdict !== "cosmetic")
      .map((f) => ({ spec: r.spec, ...f })),
  );

  lines.push(
    broken.length
      ? `**${broken.length} of ${report.results.length} demos failed to run.**`
      : notable.length
        ? `**${notable.length} change${notable.length === 1 ? "" : "s"} worth a look** across ${changed.length} regenerated demo${changed.length === 1 ? "" : "s"}.`
        : changed.length
          ? `${changed.length} demo${changed.length === 1 ? "" : "s"} regenerated; nothing but cosmetic changes.`
          : "Every demo is unchanged.",
    "",
    "| | Demo | Result |",
    "|---|---|---|",
  );

  const max = opts.maxRows ?? 20;
  for (const r of report.results.slice(0, max)) {
    const icon = !r.ok ? "❌" : r.skipped ? "⏭️" : r.changed ? (BADGE[r.review?.verdict ?? "cosmetic"]) : "✅";
    const note = !r.ok
      ? `failed — ${escapePipes(r.error ?? "")}`
      : r.skipped
        ? "up to date"
        : r.changed
          ? "regenerated"
          : "unchanged";
    lines.push(`| ${icon} | \`${r.spec}\` | ${note} |`);
  }
  if (report.results.length > max) {
    lines.push(`| … | | ${report.results.length - max} more not listed |`);
  }

  if (notable.length) {
    lines.push("", "**What changed**", "");
    for (const f of notable.slice(0, max)) {
      lines.push(`- ${BADGE[f.verdict]} \`${f.spec}\` ${formatRange(f)} — ${escapePipes(f.summary)}`);
    }
  }

  const unconfigured = report.results.find((r) => r.review?.unconfigured);
  if (unconfigured) {
    lines.push(
      "",
      "<sub>No model is configured, so the changes were located but not judged. " +
        "Set `REEL_LLM_API_KEY` to have them reviewed.</sub>",
    );
  }

  lines.push(
    "",
    "<sub>Reel renders deterministically, so the media only changes when the demo does.</sub>",
  );
  return lines.join("\n");
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

/* ------------------------------------------------------------------ *
 * Talking to the runner
 * ------------------------------------------------------------------ */

/**
 * What the action exposes to the steps after it.
 *
 * Written here rather than parsed out of the log by the action, because a
 * workflow that greps stdout breaks the first time a message is reworded.
 */
export function githubOutputs(report: CiReport): Record<string, string> {
  return {
    specs: String(report.results.length),
    failed: String(report.failed),
    changed: String(report.results.some((r) => r.changed)),
    verdict: report.verdict,
    outputs: JSON.stringify(report.results.flatMap((r) => r.outputs)),
  };
}

/**
 * `key=value` lines for `$GITHUB_OUTPUT`.
 *
 * Every value is JSON-encoded onto one line first: a summary containing a
 * newline would otherwise be read as the start of another output, which is the
 * shape of a real command-injection bug rather than a formatting nit.
 */
export function encodeOutputs(values: Record<string, string>): string {
  return (
    Object.entries(values)
      .map(([k, v]) => `${k}=${v.includes("\n") ? JSON.stringify(v) : v}`)
      .join("\n") + "\n"
  );
}

export async function writeGithubOutputs(report: CiReport): Promise<void> {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  await appendFile(file, encodeOutputs(githubOutputs(report)), "utf8");
}

export const CI_DEFAULTS = {
  mode: "check" as CiMode,
  failOn: "stale-caption" as const,
};
