import http from "node:http";
import { readFile, writeFile, stat, readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, dirname, resolve, relative, isAbsolute } from "node:path";
import { parse as parseYaml, parseDocument } from "yaml";
import { loadSpec } from "../spec/load.js";
import { specSchema } from "../spec/schema.js";
import { record, check } from "../driver/run.js";
import { heal } from "../heal/heal.js";
import { authorSpec } from "../ai/author.js";
import { addLogSink, log, ReelError } from "../util/log.js";
import { chat, loadLlmConfig } from "../ai/llm.js";
import { PROVIDERS, findProvider } from "../ai/providers.js";
import { writeEnvFile } from "./env-file.js";
import { summarize } from "./summary.js";

const MIME: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".gif": "image/gif",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".srt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
  ".ico": "image/x-icon",
  // Interactive builds are self-contained pages — serve them as pages so the
  // Studio can preview one in an iframe instead of downloading it.
  ".html": "text/html; charset=utf-8",
};

let busy = false; // one in-process job at a time keeps the log stream clean

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
    return streamJob(res, async () => {
      const loaded = await loadSpec(safePathOrThrow(cwd, body.path));
      const r = await record(loaded, "record");
      return { outputs: r.outputs.map((o) => rel(cwd, o)), frames: r.frames, durationMs: r.durationMs };
    });
  }
  if (path === "/api/check" && req.method === "POST") {
    const body = await readBody(req);
    return streamJob(res, async () => {
      await check(await loadSpec(safePathOrThrow(cwd, body.path)));
      return { passed: true };
    });
  }
  if (path === "/api/heal" && req.method === "POST") {
    const body = await readBody(req);
    return streamJob(res, async () => {
      const r = await heal(await loadSpec(safePathOrThrow(cwd, body.path)), { write: Boolean(body.write) });
      return r;
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
  return { llm, platform: process.platform, providers: PROVIDERS.map((p) => ({ id: p.id, label: p.label })) };
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
  for (const v of variants) {
    for (const [key, kind] of [
      ["mp4", "mp4"],
      ["gif", "gif"],
      ["webm", "webm"],
      ["storyboard", "storyboard"],
      ["html", "html"],
    ] as const) {
      const val = o[key];
      if (val) candidates.push({ p: fill(String(val), v), kind });
    }
  }

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
    });
  }
  sendJson(res, 200, { ok: true });
}

/** Run a job in-process, streaming logs + a final result as NDJSON. */
function streamJob(res: http.ServerResponse, run: () => Promise<unknown>): void {
  if (busy) return void sendJson(res, 409, { error: "A job is already running. Wait for it to finish." });
  busy = true;
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const write = (obj: unknown) => res.write(JSON.stringify(obj) + "\n");
  const unsub = addLogSink((e) => write({ type: "log", ...e }));
  run()
    .then((result) => write({ type: "done", ok: true, result }))
    .catch((err) => {
      const e = err as ReelError;
      write({ type: "done", ok: false, error: e.message, hint: e.hint });
    })
    .finally(() => {
      unsub();
      busy = false;
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
