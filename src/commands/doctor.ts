import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../util/log.js";

const run = promisify(execFile);

/**
 * Preflight, so the first failure isn't a cryptic one.
 *
 * Reel leans on two heavy external things — a Chromium build and an ffmpeg
 * binary — and when either is missing or mismatched the error arrives from deep
 * inside a library, phrased for that library's maintainers. The worst of them:
 * `playwright-core` floats within its semver range, so a fresh install can want
 * a browser revision the machine doesn't have, and the message is a wall of
 * Playwright text that never names the version mismatch.
 *
 * Each check answers "can Reel do its job", and says what to run when it can't.
 */

export type Status = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: Status;
  detail: string;
  /** The command that fixes it, when there is one. */
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: CheckResult[];
}

export async function doctor(): Promise<DoctorReport> {
  const checks: CheckResult[] = [];
  checks.push(nodeVersion());
  checks.push(await chromium());
  checks.push(await ffmpegBinary());
  checks.push(await sharpNative());
  checks.push(await tempWritable());
  checks.push(model());

  return { ok: isHealthy(checks), checks };
}

/**
 * Warnings are things you may not need — an unconfigured model doesn't stop a
 * recording — so only a hard failure makes the machine unhealthy.
 */
export function isHealthy(checks: CheckResult[]): boolean {
  return !checks.some((c) => c.status === "fail");
}

function nodeVersion(): CheckResult {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) {
    return { name: "Node", status: "ok", detail: `v${process.versions.node}` };
  }
  return {
    name: "Node",
    status: "fail",
    detail: `v${process.versions.node} — Reel needs 20 or newer`,
    fix: "Upgrade Node (nvm install 20)",
  };
}

/**
 * The check that earns this command.
 *
 * `executablePath()` reports where Playwright *expects* the browser for the
 * version currently installed, so comparing it against the filesystem catches
 * both "never installed" and the far more confusing "installed, but a different
 * revision than this playwright-core wants".
 */
async function chromium(): Promise<CheckResult> {
  let expected: string;
  try {
    const { chromium: browser } = await import("playwright-core");
    expected = browser.executablePath();
  } catch (err) {
    return {
      name: "Chromium",
      status: "fail",
      detail: `playwright-core could not resolve a browser path: ${(err as Error).message}`,
      fix: "npx playwright install chromium",
    };
  }

  try {
    await access(expected, constants.X_OK);
  } catch {
    return {
      name: "Chromium",
      status: "fail",
      detail: `playwright-core expects a browser at ${expected}, which isn't there`,
      fix: "npx playwright install chromium",
    };
  }

  // Present — confirm it actually launches. A binary can exist and still fail
  // on missing system libraries, which is a different fix entirely.
  try {
    const { chromium: browser } = await import("playwright-core");
    const b = await browser.launch({ headless: true });
    const version = b.version();
    await b.close();
    return { name: "Chromium", status: "ok", detail: `${version} — launches headless` };
  } catch (err) {
    const message = (err as Error).message;
    return {
      name: "Chromium",
      status: "fail",
      detail: `found at ${expected} but wouldn't launch: ${message.split("\n")[0]}`,
      fix: /host system is missing dependencies|libnss|shared librar/i.test(message)
        ? "npx playwright install-deps chromium"
        : "npx playwright install chromium",
    };
  }
}

async function ffmpegBinary(): Promise<CheckResult> {
  let bin: string | undefined;
  try {
    const mod = (await import("ffmpeg-static")) as unknown as { default?: string };
    bin = mod.default ?? (mod as unknown as string);
  } catch {
    return {
      name: "ffmpeg",
      status: "fail",
      detail: "ffmpeg-static isn't installed",
      fix: "npm install",
    };
  }
  if (!bin) {
    return {
      name: "ffmpeg",
      status: "fail",
      detail: "ffmpeg-static resolved to nothing on this platform",
      fix: "Install ffmpeg and set FFMPEG_PATH",
    };
  }
  try {
    const { stdout } = await run(bin, ["-version"]);
    const first = stdout.split("\n")[0] ?? "";
    return { name: "ffmpeg", status: "ok", detail: first.replace(/ Copyright.*/, "").trim() };
  } catch (err) {
    return {
      name: "ffmpeg",
      status: "fail",
      detail: `${bin} wouldn't run: ${(err as Error).message.split("\n")[0]}`,
      fix: "npm rebuild ffmpeg-static",
    };
  }
}

/** sharp ships platform-specific native code — a common cause of a broken install. */
async function sharpNative(): Promise<CheckResult> {
  try {
    const sharp = (await import("sharp")).default;
    // Exercise it rather than just importing: a bad binary often imports fine.
    await sharp({ create: { width: 2, height: 2, channels: 3, background: "#000" } })
      .png()
      .toBuffer();
    return { name: "sharp", status: "ok", detail: "native image pipeline works" };
  } catch (err) {
    return {
      name: "sharp",
      status: "fail",
      detail: `sharp couldn't process an image: ${(err as Error).message.split("\n")[0]}`,
      fix: "npm rebuild sharp",
    };
  }
}

/** Recording writes every frame to a temp directory before encoding. */
async function tempWritable(): Promise<CheckResult> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "reel-doctor-"));
    await writeFile(join(dir, "probe"), "ok");
    return { name: "Temp space", status: "ok", detail: tmpdir() };
  } catch (err) {
    return {
      name: "Temp space",
      status: "fail",
      detail: `can't write to ${tmpdir()}: ${(err as Error).message}`,
      fix: "Set TMPDIR to a writable directory",
    };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Optional: only `author` and subtitle localization need it. */
function model(): CheckResult {
  const base = process.env.LITELLM_API_BASE ?? process.env.OPENAI_API_BASE;
  const key = process.env.LITELLM_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (base && key) {
    return { name: "Model", status: "ok", detail: `configured (${new URL(base).host})` };
  }
  return {
    name: "Model",
    status: "warn",
    detail: "not configured — only `reel author` and subtitle localization need one",
    fix: "See SECURITY.md and the README for the environment variables",
  };
}

const MARK: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗" };

export function printReport(report: DoctorReport): void {
  for (const c of report.checks) {
    const line = `${MARK[c.status]} ${c.name.padEnd(12)} ${c.detail}`;
    if (c.status === "ok") log.ok(line.slice(2));
    else if (c.status === "warn") log.warn(line.slice(2));
    else log.error(line.slice(2));
    if (c.fix && c.status !== "ok") log.info(`  fix: ${c.fix}`);
  }
  if (report.ok) log.ok("Ready to record.");
  else log.error("Recording will fail until the items above are fixed.");
}
