import http from "node:http";
import { readFile, writeFile, stat, readdir, copyFile, mkdtemp, rm } from "node:fs/promises";
import { createReadStream, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, basename, dirname, resolve, relative, isAbsolute } from "node:path";
import { parse as parseYaml, parseDocument } from "yaml";
import { loadSpec, type LoadedSpec } from "../spec/load.js";
import { specSchema } from "../spec/schema.js";
import { record, check, Cancelled } from "../driver/run.js";
import { heal } from "../heal/heal.js";
import { authorSpec } from "../ai/author.js";
import { addLogSink, log, ReelError } from "../util/log.js";
import { chat, loadLlmConfig } from "../ai/llm.js";
import { PROVIDERS, findProvider } from "../ai/providers.js";
import { THEME_NAMES } from "../terminal/themes.js";
import { doctor } from "../commands/doctor.js";
import { initSpec } from "../commands/init.js";
import { capture } from "../commands/capture.js";
import { writeEnvFile } from "./env-file.js";
import { summarize } from "./summary.js";
import { readScript, draftNarration } from "../commands/narrate.js";
import { say } from "../commands/say.js";
import { runDirect } from "../commands/direct.js";
import { moveStep, verifyReorder } from "../direct/apply.js";
import { addAsset, addAssetFromUrl } from "../media/assets.js";
import { readStamp, stampPath, declaredOutputs } from "../spec/fingerprint.js";
import { beatLabels } from "../polish/preview.js";
import { diff, DIFF_DEFAULTS } from "../commands/diff.js";
import { runReview, REVIEW_DEFAULTS } from "../commands/review.js";
import { reviewable } from "../commands/ci.js";
import { sameFormat, SAME_FORMAT_THRESHOLD } from "../diff/compare.js";
import { silentMoments, applySay } from "./says.js";
import { onCleanup } from "../util/dispose.js";

const MIME: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".gif": "image/gif",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  // The bare narration mix, so the preview can play it rather than download it.
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".srt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
  ".ico": "image/x-icon",
  // Interactive builds are self-contained pages — serve them as pages so the
  // Studio can preview one in an iframe instead of downloading it.
  ".html": "text/html; charset=utf-8",
};

/**
 * The one job this server will run at a time, or null.
 *
 * It used to be a bare boolean, which was enough to refuse a second job and not
 * enough to do anything about the first: a render started by mistake ran its
 * full two minutes and the only way out was to kill `reel ui`. The slot now
 * carries the handle that stops it.
 */
interface Job {
  /** The verb, for saying what is being stopped. */
  label: string;
  controller: AbortController;
  /**
   * Whether aborting actually stops the work.
   *
   * Only `record` and `check` thread the signal down into the driver. For
   * everything else this is false, and the UI offers no button — a Cancel that
   * closes the log while the work carries on is worse than none.
   */
  stoppable: boolean;
}
let current: Job | null = null;

/**
 * Start the in-process API + media server (the Next.js UI proxies to it).
 *
 * Bound to loopback, deliberately. This server reads the workspace, writes
 * spec files and provider credentials, and `record` executes the spec's
 * `run.cmd` in a shell — so an open bind would hand anyone on the same network
 * command execution on this machine. Studio is a local tool; it listens only
 * to this machine.
 */
export async function startApiServer(port: number): Promise<http.Server> {
  const cwd = process.cwd();
  const server = http.createServer((req, res) => {
    // Same-origin only: the browser reaches this through the Next.js proxy on
    // the UI port, so no cross-origin caller needs to be allowed in.
    res.setHeader("vary", "origin");
    handle(req, res, cwd).catch((err) => sendJson(res, 500, { error: (err as Error).message }));
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return server;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, cwd: string): Promise<void> {
  const u = new URL(req.url ?? "/", "http://localhost");
  const path = u.pathname;

  // --- Read-only API ---
  if (path === "/api/config" && req.method === "GET") return sendJson(res, 200, await getConfig());
  /**
   * Preflight. Wraps the same `reel doctor` the CLI runs, so the Studio can say
   * "ffmpeg is missing" before a render spends two minutes discovering it and
   * reports it as one red line at the bottom of a failed job.
   */
  if (path === "/api/doctor" && req.method === "GET") return sendJson(res, 200, await doctor());
  if (path === "/api/specs" && req.method === "GET") return sendJson(res, 200, { specs: await listSpecs(cwd) });
  if (path === "/api/gallery" && req.method === "GET") return sendJson(res, 200, { specs: await gallery(cwd) });
  if (path === "/api/patch" && req.method === "POST") {
    const body = await readBody(req);
    try {
      return sendJson(res, 200, { raw: applyPatch(String(body.raw ?? ""), body.patch ?? {}) });
    } catch {
      // Unparseable YAML: hand back what was sent rather than replacing the
      // author's work with an empty document.
      return sendJson(res, 200, { raw: String(body.raw ?? "") });
    }
  }
  /**
   * Summarize YAML that hasn't been saved yet.
   *
   * The options form is built from the summary, so hand-editing the YAML used
   * to leave the two out of step until the next save — and the next thing
   * touched in the form would write the stale value back over the edit. This
   * lets the editor re-derive the form from the buffer, not from disk.
   */
  if (path === "/api/summary" && req.method === "POST") {
    const body = await readBody(req);
    return sendJson(res, 200, { summary: summarize(String(body.raw ?? "")) });
  }
  if (path === "/api/step-hidden" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const raw = setStepHidden(String(body.raw ?? ""), Number(body.index), Boolean(body.hidden));
      // The outline *is* the control here: without a fresh summary the step you
      // just hid would keep rendering as filmed until you saved, which reads as
      // the button having done nothing.
      return sendJson(res, 200, { raw, summary: summarize(raw) });
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
  }
  if (path === "/api/spec" && req.method === "GET") {
    const p = safePath(cwd, u.searchParams.get("path") ?? "");
    if (!p) return sendJson(res, 400, { error: "bad path" });
    try {
      const raw = await readFile(p, "utf8");
      // The summary is derived from the real schema, so the Studio always
      // reflects what the spec actually says rather than a set of defaults.
      return sendJson(res, 200, { raw, summary: summarize(raw) });
    } catch {
      return sendJson(res, 404, { error: "not found" });
    }
  }
  // Already-rendered artifacts for a spec, so opening one in Studio shows the
  // last render instead of an empty panel until you record again.
  if (path === "/api/outputs" && req.method === "GET") {
    const p = safePath(cwd, u.searchParams.get("path") ?? "");
    if (!p) return sendJson(res, 400, { error: "bad path" });
    return sendJson(res, 200, { outputs: await renderedOutputs(p, cwd) });
  }
  if (path === "/media" && req.method === "GET") {
    const p = safePath(cwd, u.searchParams.get("path") ?? "");
    if (!p) return void sendJson(res, 400, { error: "bad path" });
    return serveMedia(req, res, p);
  }

  // --- Mutations / jobs ---
  if (path === "/api/llm-config" && req.method === "POST") return saveLlmConfig(req, res, cwd);
  if (path === "/api/llm-test" && req.method === "POST") return testLlm(res);
  if (path === "/api/spec" && req.method === "POST") return saveSpec(req, res, cwd);
  if (path === "/api/record" && req.method === "POST") {
    const body = await readBody(req);
    const draft = Boolean(body.draft);
    const only = body.only ? String(body.only) : undefined;
    const specPath = safePathOrThrow(cwd, body.path);
    return streamJob(
      res,
      async (signal) => {
        const loaded = await loadSpec(specPath);
        // Neither preview writes over the master — both land on `.preview.*` —
        // so neither rotates the copy "what changed?" compares against.
        const keeping = draft || only ? null : await keepPrevious(loaded);
        // The preview button is `record --draft`, not a second render path. A
        // Studio that previewed differently from the command line would be a
        // second implementation to keep honest.
        const r = await record(loaded, "record", { draft, only }, signal).catch(async (err) => {
          await discardSnapshot(keeping);
          throw err;
        });
        if (keeping) rememberPrevious(specPath, keeping);
        return {
          outputs: r.outputs.map((o) => rel(cwd, o)),
          frames: r.frames,
          durationMs: r.durationMs,
          // What this render actually was, so the preview panel can say so
          // rather than let a one-beat clip pass for the finished demo.
          draft,
          only,
        };
      },
      { label: only ? "beat preview" : draft ? "preview" : "render", stoppable: true },
    );
  }

  /**
   * What the last render replaced, and whether there is anything to compare.
   *
   * Studio keeps a copy of the media each render overwrites, for as long as the
   * server is up. Before there are two renders there is nothing honest to say
   * about what changed, and this endpoint says that rather than offering a
   * button that cannot work.
   */
  if (path === "/api/changed" && req.method === "GET") {
    const p = safePath(cwd, u.searchParams.get("path") ?? "");
    if (!p) return sendJson(res, 400, { error: "bad path" });
    return sendJson(res, 200, await comparable(p, cwd));
  }

  /**
   * The pixel pass, and the judgement on top of it.
   *
   * Both wrap the commands `reel diff` and `reel review` run, including how the
   * threshold is chosen — Studio compares a render with the previous render of
   * the same spec, so the formats always match and the noise floor is the
   * same-format one. A Studio that picked its own threshold would give a
   * different answer to the same question than the command line does.
   */
  if ((path === "/api/diff" || path === "/api/review") && req.method === "POST") {
    const body = await readBody(req);
    const p = safePathOrThrow(cwd, body.path);
    const reviewing = path === "/api/review";
    return streamJob(
      res,
      async () => {
        const pair = await comparable(p, cwd);
        if (!pair.before || !pair.after) throw new ReelError(pair.why ?? "Nothing to compare yet.");
        const before = pair.before;
        const after = pair.after;
        const out = join(dirname(after), ".reel-diff");
        const threshold = sameFormat(before, after) ? SAME_FORMAT_THRESHOLD : DIFF_DEFAULTS.threshold;
        if (!reviewing) {
          const report = await diff(before, after, { fps: DIFF_DEFAULTS.fps, threshold, out });
          return { ...report, strips: report.strips.map((s) => (s ? rel(cwd, s) : "")) };
        }
        const outcome = await runReview(before, after, {
          ...REVIEW_DEFAULTS,
          threshold,
          out,
          // The verdict is shown, not enforced: Studio has no exit code, and
          // failing a button is not a thing a button can do.
          failOn: "never",
        });
        return {
          ...outcome,
          diff: { ...outcome.diff, strips: outcome.diff.strips.map((s) => (s ? rel(cwd, s) : "")) },
        };
      },
      { label: reviewing ? "review" : "comparison" },
    );
  }

  /**
   * Stop the running job.
   *
   * Only `record` and `check` can really be stopped — they are the two that
   * take the signal all the way down to the step loop. For anything else this
   * refuses and says why, because the alternative is a button that closes the
   * log and leaves the work running.
   */
  if (path === "/api/cancel" && req.method === "POST") {
    const job = current;
    if (!job) return sendJson(res, 200, { ok: false, error: "Nothing is running." });
    if (!job.stoppable) {
      return sendJson(res, 200, {
        ok: false,
        error: `A ${job.label} cannot be stopped part-way.`,
        hint: "It will finish on its own; nothing it writes is left half-done.",
      });
    }
    job.controller.abort();
    return sendJson(res, 200, { ok: true, label: job.label });
  }

  // Reading the script is fast and offline, so it answers directly rather than
  // as a streamed job — the panel wants the numbers, not a log.
  if (path === "/api/script" && req.method === "POST") {
    const body = await readBody(req);
    const loaded = await loadSpec(safePathOrThrow(cwd, body.path));
    return sendJson(res, 200, readScript(loaded.spec.steps));
  }

  // The beat strip. Read from the last render's stamp rather than by rendering
  // again: the stamp already records what the beats were and when, so the strip
  // costs a file read. A spec never rendered has no beats yet, and says so.
  if (path === "/api/beats" && req.method === "POST") {
    const body = await readBody(req);
    const file = safePathOrThrow(cwd, body.path);
    const loaded = await loadSpec(file);
    const stamp = await readStamp(stampPath(loaded)).catch(() => null);
    return sendJson(res, 200, {
      beats: stamp?.beats ?? [],
      durationMs: stamp?.durationMs ?? 0,
      rendered: Boolean(stamp?.beats?.length),
      // What `--only` will accept, enumerated by the function `record` itself
      // validates against — so a beat the UI offers is a beat the driver knows.
      labels: beatLabels(loaded.spec.steps),
    });
  }

  /**
   * The moments a draft line can be written to, addressed.
   *
   * `/api/narrate` returns sentences in the order `reel narrate` proposes them
   * and nothing that identifies the step each belongs to. This is that list:
   * same walk, same order, plus the path in the document to write under.
   */
  if (path === "/api/silent" && req.method === "POST") {
    const body = await readBody(req);
    const loaded = await loadSpec(safePathOrThrow(cwd, body.path));
    return sendJson(res, 200, { moments: silentMoments(loaded.spec.steps) });
  }

  /**
   * Accept one proposed line.
   *
   * Writes to the file the same way `reel direct --write` does, rather than
   * handing the YAML back for the editor to hold: the Script tab is not the
   * editor, and a line accepted in one panel that only exists in another is how
   * work gets lost. The response carries the rewritten spec so the editor can
   * catch up without a round trip.
   */
  if (path === "/api/accept-say" && req.method === "POST") {
    const body = await readBody(req);
    const file = safePathOrThrow(cwd, body.path);
    try {
      const loaded = await loadSpec(file);
      const moments = silentMoments(loaded.spec.steps);
      const moment = moments[Number(body.index)];
      // Named as well as numbered. Accepting a line changes the list it was
      // numbered against — the moment just filled drops out of it — so the
      // label is what proves the index still points at what the user read.
      if (!moment || (body.where && moment.where !== String(body.where))) {
        throw new ReelError(
          "That moment has moved — re-read the script and draft again.",
          "The spec changed since these lines were proposed.",
        );
      }
      const next = applySay(await readFile(file, "utf8"), moment, String(body.text ?? ""));
      // Parsed before it goes near disk, exactly as a reorder is: a line is
      // never worth writing an unloadable spec for.
      if (!specSchema.safeParse(parseYaml(next)).success) {
        throw new ReelError(
          "Writing that line would leave the spec invalid, so nothing was written.",
          "Try a shorter line, or add it in the YAML tab.",
        );
      }
      await writeFile(file, next, "utf8");
      return sendJson(res, 200, { ok: true, raw: next, summary: summarize(next), where: moment.where });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: (err as Error).message });
    }
  }

  // Reordering writes the steps in the spec; the file is what changed.
  if (path === "/api/move-step" && req.method === "POST") {
    const body = await readBody(req);
    const file = safePathOrThrow(cwd, body.path);
    const before = (await loadSpec(file)).spec.steps;
    const next = moveStep(await readFile(file, "utf8"), Number(body.from), Number(body.to));
    // Parsed and compared before it goes near disk, exactly as `direct --write`
    // is. A reorder may change the order and nothing else.
    const after = specSchema.parse(parseYaml(next));
    verifyReorder(before, after.steps);
    await writeFile(file, next, "utf8");
    // `summarize` reads YAML, not a path. Handing it the filename parsed as a
    // bare scalar, failed the schema, and every reorder came back
    // `{valid:false}` — the outline emptied itself on a successful move.
    return sendJson(res, 200, { ok: true, raw: next, summary: summarize(next) });
  }

  // The media library. Downloading happens while you edit, never while you
  // render — the file lands in the spec's directory and is committed like any
  // other input.
  if (path === "/api/asset" && req.method === "POST") {
    const body = await readBody(req);
    const file = safePathOrThrow(cwd, body.path);
    const added = body.url
      ? await addAssetFromUrl(file, String(body.url))
      : await addAsset(file, String(body.name ?? "asset.png"), Buffer.from(String(body.data ?? ""), "base64"));
    return sendJson(res, 200, added);
  }

  if (path === "/api/direct" && req.method === "POST") {
    const body = await readBody(req);
    return streamJob(res, async () => {
      const loaded = await loadSpec(safePathOrThrow(cwd, body.path));
      const r = await runDirect(loaded, { write: Boolean(body.write) });
      return { written: r.written, directions: r.directions };
    });
  }

  if (path === "/api/narrate" && req.method === "POST") {
    const body = await readBody(req);
    return streamJob(res, async () => {
      const loaded = await loadSpec(safePathOrThrow(cwd, body.path));
      return { proposed: await draftNarration(loaded) };
    });
  }

  // Hearing one line. Streamed like a job because a cold cache means a network
  // call, and the panel should show that it is waiting rather than hang.
  if (path === "/api/say" && req.method === "POST") {
    const body = await readBody(req);
    return streamJob(res, async () => {
      const spec = body.path ? safePathOrThrow(cwd, body.path) : undefined;
      const r = await say(String(body.text ?? ""), { spec, dryRun: Boolean(body.dryRun) });
      return {
        durationMs: r.durationMs,
        cached: r.cached,
        estimated: Boolean(r.estimated),
        // Relative, so the browser fetches it back through /media like every
        // other artifact rather than being handed a filesystem path.
        file: r.file ? rel(cwd, r.file) : undefined,
      };
    });
  }
  if (path === "/api/check" && req.method === "POST") {
    const body = await readBody(req);
    return streamJob(
      res,
      async (signal) => {
        await check(await loadSpec(safePathOrThrow(cwd, body.path)), signal);
        return { passed: true };
      },
      { label: "drift check", stoppable: true },
    );
  }
  if (path === "/api/heal" && req.method === "POST") {
    const body = await readBody(req);
    return streamJob(res, async () => {
      const r = await heal(await loadSpec(safePathOrThrow(cwd, body.path)), { write: Boolean(body.write) });
      return r;
    });
  }
  /**
   * Scaffold a starter spec — the key-free way to a first demo.
   *
   * `reel init` needs no model and no browser, so it is the one path that works
   * on a machine that has only just installed Reel. Studio had no way to reach
   * it at all, which left "author with an LLM" as the only door in.
   */
  if (path === "/api/init" && req.method === "POST") {
    const body = await readBody(req);
    const dir = safePath(cwd, String(body.dir ?? ".") || ".");
    if (!dir) return sendJson(res, 400, { error: "bad path" });
    try {
      await initSpec(dir, {
        url: String(body.url ?? "http://localhost:3000"),
        name: String(body.name ?? "My demo"),
      });
      const file = join(dir, "demo.reel.yaml");
      return sendJson(res, 200, { ok: true, path: rel(cwd, file), raw: await readFile(file, "utf8") });
    } catch (err) {
      const e = err as ReelError;
      return sendJson(res, 200, { ok: false, error: e.message, hint: e.hint });
    }
  }

  /**
   * Author by doing. Opens a real browser window on this machine and hands back
   * a spec when the person presses Finish.
   *
   * It works from Studio for the same reason Studio exists at all: the server is
   * bound to loopback and runs on the machine in front of the user, so the
   * window it opens is one they can see. On a headless box it fails the way the
   * CLI does — with the message that points at `reel doctor` — rather than
   * hanging, and the UI offers the command line as the fallback.
   */
  if (path === "/api/capture" && req.method === "POST") {
    const body = await readBody(req);
    return streamJob(res, async () => {
      const out = safePathOrThrow(cwd, body.out || "demo.reel.yaml");
      const r = await capture({
        url: String(body.url ?? ""),
        out,
        name: body.name ? String(body.name) : undefined,
        force: Boolean(body.force),
      });
      return { path: rel(cwd, r.file), steps: r.steps, raw: await readFile(r.file, "utf8") };
    });
  }

  if (path === "/api/author" && req.method === "POST") {
    const body = await readBody(req);
    return streamJob(res, async () => {
      const out = safePathOrThrow(cwd, body.out || "demo.reel.yaml");
      await authorSpec(String(body.story ?? ""), { url: String(body.url ?? ""), out, model: body.model || undefined });
      return { path: rel(cwd, out), raw: await readFile(out, "utf8") };
    });
  }

  sendJson(res, 404, { error: "not found" });
}

/* --------------------------- what changed --------------------------- */

/**
 * The media a spec rendered *last time*, kept so Studio can say what changed.
 *
 * Reel's loudest claim is that it tells you what a change did to your demo, and
 * the comparison needs two files. A render overwrites the only copy of the
 * first one, so the copy has to be taken before it — which is exactly what
 * `reel ci --review` does, one directory per spec, before it re-renders.
 *
 * In memory and for this process only. A snapshot is a review aid, not an
 * artifact: persisting it would leave copies of every render in someone's
 * working tree, and a stale one from last week would answer a question nobody
 * asked. Two renders in one session is the case this serves.
 */
const previousRender = new Map<string, { file: string; at: number; source: string }>();

let snapshotDir: string | null = null;

async function snapshotRoot(): Promise<string> {
  if (snapshotDir) return snapshotDir;
  const dir = await mkdtemp(join(tmpdir(), "reel-studio-"));
  // Synchronous, and registered the way every other temp directory in Reel is:
  // a Ctrl-C on `reel ui` must not leave copies of rendered video behind.
  onCleanup(() => rmSync(dir, { recursive: true, force: true }));
  snapshotDir = dir;
  return dir;
}

interface Snapshot {
  file: string;
  source: string;
}

/** Copy what a render is about to replace, or null when there is nothing yet. */
async function keepPrevious(loaded: LoadedSpec): Promise<Snapshot | null> {
  const target = reviewable(declaredOutputs(loaded));
  if (!target) return null; // a spec that renders only a storyboard or a page
  try {
    if (!(await stat(target)).isFile()) return null;
  } catch {
    return null; // never rendered — this run is the baseline
  }
  const dir = await snapshotRoot();
  // The extension is carried over deliberately: it is what decides the noise
  // floor the comparison is held to.
  const file = join(dir, `${Date.now().toString(36)}-${basename(target)}`);
  await copyFile(target, file);
  return { file, source: target };
}

function rememberPrevious(specPath: string, snap: Snapshot): void {
  const old = previousRender.get(specPath);
  previousRender.set(specPath, { ...snap, at: Date.now() });
  // One copy per spec. Anything older has been superseded as "the previous
  // render" and is only taking up disk.
  if (old) void rm(old.file, { force: true }).catch(() => {});
}

async function discardSnapshot(snap: Snapshot | null): Promise<void> {
  if (snap) await rm(snap.file, { force: true }).catch(() => {});
}

/** The two files a comparison would run on, or why there aren't two. */
async function comparable(
  specPath: string,
  cwd: string,
): Promise<{ before?: string; after?: string; at?: number; file?: string; why?: string }> {
  let loaded;
  try {
    loaded = await loadSpec(specPath);
  } catch (err) {
    return { why: (err as Error).message };
  }
  const after = reviewable(declaredOutputs(loaded));
  if (!after) {
    return { why: "This spec renders no video, so there is nothing to compare frame by frame." };
  }
  const kept = previousRender.get(specPath);
  if (!kept) {
    return {
      why: "Studio keeps the media each render replaces, so a comparison needs two renders in this session. Record once to set the baseline.",
    };
  }
  try {
    await stat(after);
  } catch {
    return { why: "The current render is gone from disk — record again." };
  }
  return { before: kept.file, after, at: kept.at, file: rel(cwd, after) };
}

/* ------------------------------ helpers ------------------------------ */

async function getConfig() {
  let llm: {
    configured: boolean;
    model?: string;
    host?: string;
    provider?: string;
    protocol?: string;
    /** What the user would have to fix, when nothing resolved. */
    error?: string;
  } = { configured: false };
  try {
    const cfg = loadLlmConfig();
    llm = {
      configured: true,
      model: cfg.model,
      host: new URL(cfg.apiBase).host,
      provider: cfg.providerLabel,
      protocol: cfg.protocol,
    };
  } catch (err) {
    // Studio should say *why* nothing is configured rather than only that
    // nothing is — the message already names the provider and the variable.
    llm = { configured: false, error: err instanceof Error ? err.message : undefined };
  }
  return {
    llm,
    platform: process.platform,
    providers: PROVIDERS.map((p) => ({ id: p.id, label: p.label })),
    // Served rather than hand-copied into the UI: the Studio derives what it
    // offers from the source of truth, so adding a scheme in one place cannot
    // leave a second list behind to go stale.
    terminalThemes: [...THEME_NAMES],
  };
}

async function listSpecs(cwd: string): Promise<string[]> {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".git", "dist", ".reel-cache"]);
  const walk = async (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) await walk(full, depth + 1);
      } else if (e.name.endsWith(".reel.yaml") || e.name.endsWith(".reel.yml")) {
        out.push(rel(cwd, full));
      }
    }
  };
  await walk(cwd, 0);
  return out.sort();
}

export interface GallerySpec {
  path: string;
  name: string;
  url: string;
  outputs: { path: string; kind: string }[];
  /** At-a-glance facts, so the gallery can show what kind of demo this is. */
  kind: "web" | "terminal";
  stepCount: number;
  branchCount: number;
  variants: number;
}

/** Specs plus whichever of their declared outputs actually exist on disk. */
/**
 * The artifacts a spec declares that actually exist on disk. Derived from the
 * spec rather than by scanning a directory, so an unrelated file next to the
 * output never shows up as part of the demo. Subtitle sidecars are derived the
 * same way `record` names them.
 */
async function renderedOutputs(
  specPath: string,
  cwd: string,
): Promise<{ path: string; kind: string }[]> {
  let parsed: any;
  try {
    parsed = parseYaml(await readFile(specPath, "utf8"));
  } catch {
    return [];
  }
  const dir = dirname(specPath);
  const o = parsed?.output ?? {};
  const abs = (p: string) => (isAbsolute(p) ? p : join(dir, p));

  // A matrix spec templates {viewport}/{theme} into its output paths, so the
  // literal strings never exist on disk — without expanding them, a matrix demo
  // looks like it rendered nothing at all.
  const variants = matrixVariants(parsed);
  const fill = (p: string, v: { viewport: string; theme: string }) =>
    p.replace(/\{viewport\}/g, v.viewport).replace(/\{theme\}/g, v.theme);

  const candidates: { p?: string; kind: string }[] = [];
  // The spec's own output block, plus every cut taken out of the same
  // recording. Without the cuts, a spec that renders a long master and three
  // shorter deliverables shows one file in Studio and looks like it produced
  // far less than it did.
  const blocks: unknown[] = [o, ...(Array.isArray(parsed?.cuts) ? parsed.cuts.map((c: any) => c?.output) : [])];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    for (const v of variants) {
      for (const [key, kind] of [
        ["mp4", "mp4"],
        ["gif", "gif"],
        ["webm", "webm"],
        ["storyboard", "storyboard"],
        ["html", "html"],
      ] as const) {
        const val = b[key];
        if (val) candidates.push({ p: fill(String(val), v), kind });
      }
    }
  }

  // A language track is derived from the master's name rather than declared, so
  // nothing in the output block names `demo.es.mp4` — without this, a spec that
  // renders three languages shows one video and looks like two of them failed.
  if (o.audio !== false && Array.isArray(o.languages) && o.mp4) {
    for (const lang of o.languages) {
      for (const v of variants) {
        candidates.push({
          p: fill(String(o.mp4), v).replace(/\.mp4$/i, `.${String(lang)}.mp4`),
          kind: "mp4",
        });
      }
    }
  }
  // The bare mixed track, when the spec asked for one to edit elsewhere.
  if (o.audioTrack) candidates.push({ p: String(o.audioTrack), kind: "audio" });

  // Subtitles land beside the video, named after it (or at an explicit base).
  let subBase: string | undefined;
  if (o.subtitles === true) {
    const src = o.mp4 ?? o.webm ?? o.gif;
    if (src) subBase = String(src).replace(/\.[^.]+$/, "");
  } else if (typeof o.subtitles === "string") {
    subBase = o.subtitles.replace(/\.(srt|vtt)$/i, "");
  }
  if (subBase) {
    const langs: string[] = Array.isArray(o.languages) ? o.languages : [];
    for (const v of variants) {
      const b = fill(subBase, v);
      for (const base of [b, ...langs.map((l) => `${b}.${l}`)]) {
        candidates.push({ p: `${base}.srt`, kind: "srt" }, { p: `${base}.vtt`, kind: "vtt" });
      }
    }
  }

  const outputs: { path: string; kind: string }[] = [];
  for (const c of candidates) {
    if (!c.p) continue;
    const fp = abs(String(c.p));
    try {
      await stat(fp);
      outputs.push({ path: rel(cwd, fp), kind: c.kind });
    } catch {
      /* not rendered yet */
    }
  }
  return outputs;
}

/** Every {viewport, theme} pair a spec renders; one neutral entry without a matrix. */
function matrixVariants(parsed: any): { viewport: string; theme: string }[] {
  const m = parsed?.matrix;
  const viewports: string[] = Array.isArray(m?.viewports)
    ? m.viewports.map((v: any) => String(v?.name ?? "default"))
    : ["default"];
  const themes: string[] = Array.isArray(m?.themes)
    ? m.themes.map(String)
    : [String(parsed?.theme ?? "light")];
  const out: { viewport: string; theme: string }[] = [];
  for (const viewport of viewports) for (const theme of themes) out.push({ viewport, theme });
  return out;
}

async function gallery(cwd: string): Promise<GallerySpec[]> {
  const paths = await listSpecs(cwd);
  const out: GallerySpec[] = [];
  for (const rp of paths) {
    const full = join(cwd, rp);
    let raw: string;
    try {
      raw = await readFile(full, "utf8");
    } catch {
      continue;
    }
    const s = summarize(raw);
    out.push({
      path: rp,
      name: s.name || rp,
      url: s.url,
      outputs: await renderedOutputs(full, cwd),
      kind: s.kind,
      stepCount: s.stepCount,
      branchCount: s.branchCount,
      variants: s.variants,
    });
  }
  return out;
}

/**
 * Toggle `hidden` on one terminal `run` step, returning the rewritten YAML.
 *
 * This is its own operation rather than a `/api/patch` call because the step has
 * two spellings. `- run: ls ..` is a bare string, and merging `{hidden: true}`
 * into a string would replace the command with an object that has no `cmd` —
 * silently deleting what the step runs. Normalising to the object form first is
 * the only safe way to set the flag.
 *
 * Turning it back off removes the key rather than writing `hidden: false`, so a
 * spec that never used the feature reads exactly as it did before.
 */
export function setStepHidden(raw: string, index: number, hidden: boolean): string {
  const doc = parseDocument(raw);
  const steps: any = doc.get("steps");
  if (!steps || typeof steps.get !== "function") throw new Error("this spec has no steps");
  const step: any = steps.get(index);
  if (!step || typeof step.has !== "function" || !step.has("run")) {
    throw new Error(`step ${index + 1} is not a run step`);
  }

  const run = step.get("run");
  if (typeof run === "string") {
    // Only pay the cost of the longer form when the flag is actually being set.
    if (!hidden) return raw;
    doc.setIn(["steps", index, "run"], { cmd: run, hidden: true });
  } else if (hidden) {
    doc.setIn(["steps", index, "run", "hidden"], true);
  } else {
    doc.deleteIn(["steps", index, "run", "hidden"]);
    // A lone `cmd` reads better as the shorthand it started as.
    const rest = run?.toJSON?.() ?? {};
    if (Object.keys(rest).length === 1 && "cmd" in rest) {
      doc.setIn(["steps", index, "run"], rest.cmd);
    }
  }
  return doc.toString({ lineWidth: 0 });
}

/**
 * Apply an options patch to a spec's YAML without rewriting the whole file.
 *
 * The obvious implementation — parse to plain objects, merge, re-serialise —
 * silently deletes every comment in the spec. Specs are hand-written and their
 * comments carry the reasoning, so "Apply to spec" would quietly destroy the
 * most valuable part of the file. Editing the parsed *document* instead touches
 * only the keys in the patch and leaves the rest byte-for-byte intact.
 *
 * `null` removes a key, matching the convention the Studio's form already uses
 * to mean "return this to its default".
 */
export function applyPatch(raw: string, patch: unknown): string {
  const doc = parseDocument(raw.trim() ? raw : "{}");
  walk(patch, []);
  return doc.toString({ lineWidth: 0 });

  function walk(node: unknown, path: (string | number)[]): void {
    if (node && typeof node === "object" && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
      return;
    }
    if (path.length === 0) return;
    if (node === null) doc.deleteIn(path);
    else doc.setIn(path, node);
  }
}

/**
 * Persist provider settings to the workspace `.env`.
 *
 * The API key is write-only: it is stored and applied, and no endpoint ever
 * returns it. Sending no key leaves whatever is already configured in place,
 * so someone changing only the model doesn't have to re-enter their secret —
 * and so the UI never has to hold one to round-trip it.
 */
async function saveLlmConfig(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cwd: string,
): Promise<void> {
  const body = await readBody(req);
  const providerId = String(body.provider ?? "").trim();
  const provider = findProvider(providerId);
  if (!provider) {
    return void sendJson(res, 400, {
      error: `Unknown provider "${providerId}".`,
      hint: `Known providers: ${PROVIDERS.map((p) => p.id).join(", ")}.`,
    });
  }

  const model = String(body.model ?? "").trim();
  const baseUrl = String(body.baseUrl ?? "").trim();
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";

  if (!provider.baseUrl && !baseUrl) {
    return void sendJson(res, 400, {
      error: `${provider.label} needs an endpoint URL.`,
      hint: `See ${provider.docs}.`,
    });
  }

  const edits: Record<string, string | null> = {
    REEL_LLM_PROVIDER: provider.id,
    // An empty field clears the override so the provider's own default applies
    // again, rather than pinning an empty string.
    REEL_LLM_MODEL: model || null,
    REEL_LLM_BASE_URL: baseUrl || null,
  };
  if (apiKey) edits.REEL_LLM_API_KEY = apiKey;

  await writeEnvFile(join(cwd, ".env"), edits);
  // Never echo the key back; report only what resolved from it.
  sendJson(res, 200, { ok: true, ...(await getConfig()) });
}

/**
 * Prove the saved settings actually work, with one real round trip.
 *
 * Configuration that merely parses is not configuration that works — a wrong
 * endpoint, a revoked key or a model the account can't reach all look identical
 * until something calls the provider.
 */
async function testLlm(res: http.ServerResponse): Promise<void> {
  try {
    const cfg = loadLlmConfig();
    const started = Date.now();
    const r = await chat(cfg, [{ role: "user", content: "Reply with exactly: OK" }]);
    sendJson(res, 200, {
      ok: true,
      provider: cfg.providerLabel,
      model: cfg.model,
      ms: Date.now() - started,
      reply: (r.message.content ?? "").slice(0, 80),
    });
  } catch (err) {
    const e = err as Error & { hint?: string };
    sendJson(res, 200, { ok: false, error: e.message, hint: e.hint });
  }
}

async function saveSpec(req: http.IncomingMessage, res: http.ServerResponse, cwd: string): Promise<void> {
  const body = await readBody(req);
  const p = safePath(cwd, String(body.path ?? ""));
  if (!p) return sendJson(res, 400, { error: "bad path" });
  const raw = String(body.raw ?? "");

  // An empty buffer is not an incomplete draft — it is deletion, and it is
  // never what someone meant. Studio saves before every Record, Check and Heal,
  // so a spec that had not finished loading when a button was pressed was
  // written over with nothing: 118 steps replaced by a zero-byte file, no
  // error, no undo. Blank YAML also parses cleanly, so nothing below catches it.
  if (!raw.trim()) {
    const existing = await readFile(p, "utf8").catch(() => "");
    if (existing.trim()) {
      return sendJson(res, 200, {
        ok: false,
        error: "Refusing to save an empty document over a spec that has content.",
      });
    }
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    return sendJson(res, 200, { ok: false, error: `YAML: ${(e as Error).message}` });
  }
  const check = specSchema.safeParse(parsed);
  await writeFile(p, raw, "utf8"); // the user owns the file; save even if incomplete
  if (!check.success) {
    return sendJson(res, 200, {
      ok: true,
      warnings: check.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      // The same list, addressed, so the editor can offer to go there. Derived
      // from the summary rather than located a second time here.
      issues: summarize(raw).issues,
    });
  }
  sendJson(res, 200, { ok: true });
}

/**
 * How often to write something — anything — while a job is running.
 *
 * The UI reaches this server through Next's dev rewrite, and a proxy will drop
 * a stream it believes has gone idle. Rendering is exactly that: several
 * silent minutes of compositing between one log line and the next. The job
 * would finish, write its files, and the page would sit on “working…” forever,
 * because the connection carrying the answer had already been severed.
 *
 * Well under any proxy's idle timeout, and cheap — one short line.
 */
const KEEPALIVE_MS = 5_000;

/** Run a job in-process, streaming logs + a final result as NDJSON. */
function streamJob(
  res: http.ServerResponse,
  run: (signal: AbortSignal) => Promise<unknown>,
  opts: { label: string; stoppable?: boolean } = { label: "job" },
): void {
  if (current) {
    return void sendJson(res, 409, {
      error: `A ${current.label} is already running. Wait for it to finish.`,
      // So the UI can offer to stop the job in its way rather than telling the
      // user to wait for something they no longer want.
      stoppable: current.stoppable,
    });
  }
  const job: Job = { label: opts.label, controller: new AbortController(), stoppable: Boolean(opts.stoppable) };
  current = job;
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    // `no-transform` asks intermediaries not to buffer this up for compression;
    // `x-accel-buffering` is the same request in the dialect nginx speaks.
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
    connection: "keep-alive",
  });
  const write = (obj: unknown) => res.write(JSON.stringify(obj) + "\n");
  const unsub = addLogSink((e) => write({ type: "log", ...e }));
  // Unref'd: a heartbeat must never be the reason the process stays alive.
  const beat = setInterval(() => write({ type: "ping" }), KEEPALIVE_MS);
  beat.unref();
  run(job.controller.signal)
    .then((result) => write({ type: "done", ok: true, result }))
    .catch((err) => {
      const e = err as ReelError;
      // A cancelled job is flagged rather than described, so the UI can report
      // "you stopped this" without matching on the wording of a message.
      write({
        type: "done",
        ok: false,
        error: e.message,
        hint: e.hint,
        ...(err instanceof Cancelled ? { cancelled: true } : {}),
      });
    })
    .finally(() => {
      clearInterval(beat);
      unsub();
      if (current === job) current = null;
      res.end();
    });
}

async function serveMedia(req: http.IncomingMessage, res: http.ServerResponse, p: string): Promise<void> {
  let s;
  try {
    s = await stat(p);
  } catch {
    return void sendJson(res, 404, { error: "not found" });
  }
  const type = MIME[extname(p).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : s.size - 1;
    res.writeHead(206, {
      "content-type": type,
      "content-range": `bytes ${start}-${end}/${s.size}`,
      "accept-ranges": "bytes",
      "content-length": end - start + 1,
    });
    createReadStream(p, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "content-type": type, "content-length": s.size, "accept-ranges": "bytes" });
    createReadStream(p).pipe(res);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Resolve a user path within cwd; returns null on traversal outside cwd. */
function safePath(cwd: string, p: string): string | null {
  if (!p) return null;
  const full = isAbsolute(p) ? p : resolve(cwd, p);
  const r = relative(cwd, full);
  if (r.startsWith("..") || isAbsolute(r)) return null;
  return full;
}
function safePathOrThrow(cwd: string, p: string): string {
  const s = safePath(cwd, String(p ?? ""));
  if (!s) throw new ReelError(`Invalid path: ${p}`);
  return s;
}
function rel(cwd: string, p: string): string {
  return isAbsolute(p) ? relative(cwd, p) : p;
}
