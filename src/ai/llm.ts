import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { ReelError, log } from "../util/log.js";

/**
 * LiteLLM client — talks to a LiteLLM proxy over its OpenAI-compatible
 * `/chat/completions` endpoint. This mirrors the approach used by the GridFlow
 * service (`litellm_client.py` + `app_config.py`):
 *  - config from env: LITELLM_API_BASE / LITELLM_API_KEY / LITELLM_MODEL
 *    (with the usual OPENAI_* fallbacks),
 *  - the base is normalized to end in `/v1`, and a leading `provider/` prefix is
 *    stripped from the model name for the OpenAI-compatible call,
 *  - TLS verification follows SSL_VERIFY (default true); set SSL_VERIFY=false for
 *    corporate proxies whose certificates don't verify,
 *  - transient errors (429/5xx/timeouts) retry with exponential backoff + jitter.
 *
 * Reel is provider-agnostic: whatever model the proxy routes to (Claude, Gemini,
 * GPT, …) is fine, as long as it supports OpenAI-style tool calling.
 */

const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const REQUEST_TIMEOUT_MS = 120_000;

export interface LlmConfig {
  apiBase: string; // normalized, ends in /v1
  apiKey: string;
  model: string; // provider prefix stripped
  sslVerify: boolean;
  /** Path to a corporate CA bundle to trust (SSL_CERT_FILE / REQUESTS_CA_BUNDLE). */
  caBundle?: string;
  temperature?: number;
  reasoningEffort?: string;
}

/* ---- OpenAI-compatible chat types ---- */

export interface OaiToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface OaiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface OaiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OaiToolCall[];
  tool_call_id?: string;
  name?: string;
}
export interface ChatResult {
  message: OaiMessage;
  finishReason: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Read env, tolerating inline `# comments` and stray whitespace in .env values. */
function getEnv(...names: string[]): string | undefined {
  for (const n of names) {
    const raw = process.env[n];
    if (raw === undefined) continue;
    const v = raw.replace(/\s+#.*$/, "").trim();
    if (v !== "") return v;
  }
  return undefined;
}

function getBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

/** Normalize a proxy base URL to the OpenAI-compatible `/v1` root. */
export function ensureOpenAiBase(url: string): string {
  const n = url.replace(/\/+$/, "");
  return n.endsWith("/v1") ? n : `${n}/v1`;
}

/** Strip a leading `provider/` prefix (e.g. `litellm_proxy/gpt-4` → `gpt-4`). */
export function extractModelName(model: string): string {
  const n = model.trim().replace(/^["']|["']$/g, "");
  if (!n.includes("/")) return n;
  return n.slice(n.indexOf("/") + 1) || n;
}

/** Build config from env (+ an optional model override), matching GridFlow's keys. */
export function loadLlmConfig(modelOverride?: string): LlmConfig {
  const apiBase = getEnv("LITELLM_API_BASE", "OPENAI_API_BASE");
  const apiKey = getEnv("LITELLM_API_KEY", "OPENAI_API_KEY");
  const modelRaw =
    modelOverride ??
    getEnv("LITELLM_MODEL", "LLM_MODEL_NAME", "OPENAI_CHAT_MODEL_NAME", "OPENAI_API_MODEL");

  if (!apiBase) {
    throw new ReelError(
      "No LiteLLM endpoint configured.",
      "Set LITELLM_API_BASE (and LITELLM_API_KEY, LITELLM_MODEL). See .env.example.",
    );
  }
  if (!apiKey) throw new ReelError("LITELLM_API_KEY is not set.", "Add it to your environment or .env.");
  if (!modelRaw) throw new ReelError("No model configured.", "Set LITELLM_MODEL or pass --model.");

  const reasoning = getEnv("LITELLM_REASONING_EFFORT");
  const temp = getEnv("LITELLM_TEMPERATURE");
  return {
    apiBase: ensureOpenAiBase(apiBase),
    apiKey,
    model: extractModelName(modelRaw),
    sslVerify: getBool("SSL_VERIFY", true),
    caBundle: getEnv("SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "HTTPX_SSL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS"),
    temperature: temp !== undefined ? Number(temp) : 0.2,
    reasoningEffort: reasoning && reasoning !== "none" ? reasoning : undefined,
  };
}

/**
 * One chat completion with tools. Retries transient failures; on a 400 that
 * complains about an optional param, retries once without temperature/reasoning.
 */
export async function chat(
  cfg: LlmConfig,
  messages: OaiMessage[],
  tools?: OaiToolSpec[],
): Promise<ChatResult> {
  let stripOptional = false;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const body: Record<string, unknown> = { model: cfg.model, messages };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    if (!stripOptional) {
      if (cfg.temperature !== undefined) body.temperature = cfg.temperature;
      if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort;
    }

    try {
      const res = await postJson(`${cfg.apiBase}/chat/completions`, body, cfg);
      const choice = res?.choices?.[0];
      if (!choice) {
        throw new ReelError("LLM returned no choices (possible content filter).");
      }
      return {
        message: choice.message as OaiMessage,
        finishReason: choice.finish_reason ?? null,
        usage: res.usage,
      };
    } catch (err) {
      const e = err as HttpError;
      // 400 about an optional param → drop it and retry once.
      if (e.status === 400 && !stripOptional && /temperature|reasoning_effort|unsupported/i.test(e.body ?? "")) {
        log.debug("LLM 400 on optional param — retrying without temperature/reasoning_effort");
        stripOptional = true;
        continue;
      }
      const retryable = e.status === 429 || (e.status ?? 0) >= 500 || e.transient === true;
      if (!retryable || attempt === MAX_RETRIES) {
        if (e.status === 401 || e.status === 403) {
          throw new ReelError(`LiteLLM auth failed (HTTP ${e.status}).`, "Check LITELLM_API_KEY.");
        }
        throw new ReelError(
          `LiteLLM request failed${e.status ? ` (HTTP ${e.status})` : ""}: ${e.message}`,
          e.body?.slice(0, 300),
        );
      }
      const wait = Math.random() * Math.min(INITIAL_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      log.debug(`LLM attempt ${attempt}/${MAX_RETRIES} failed (${e.message}); retrying in ${Math.round(wait)}ms`);
      await sleep(wait);
    }
  }
  throw new ReelError("LiteLLM request failed after all retries.");
}

interface HttpError extends Error {
  status?: number;
  body?: string;
  transient?: boolean;
}

/**
 * TLS agent for the corporate LiteLLM proxy: trust a CA bundle when provided
 * (SSL_CERT_FILE / REQUESTS_CA_BUNDLE), and/or disable verification entirely
 * when SSL_VERIFY=false.
 */
function buildHttpsAgent(cfg: LlmConfig): https.Agent {
  let ca: Buffer | undefined;
  if (cfg.caBundle) {
    try {
      ca = readFileSync(cfg.caBundle);
    } catch {
      log.warn(`Could not read CA bundle ${cfg.caBundle} — continuing without it.`);
    }
  }
  return new https.Agent({ rejectUnauthorized: cfg.sslVerify, ca });
}

/** POST JSON over http/https, honoring SSL_VERIFY for the corporate-proxy case. */
function postJson(
  endpoint: string,
  body: unknown,
  cfg: LlmConfig,
): Promise<any> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      reject(Object.assign(new Error(`Invalid LITELLM_API_BASE: ${endpoint}`), { transient: false }));
      return;
    }
    const isHttps = url.protocol === "https:";
    const payload = Buffer.from(JSON.stringify(body));
    const opts: https.RequestOptions = {
      method: "POST",
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        "content-type": "application/json",
        "content-length": String(payload.length),
        authorization: `Bearer ${cfg.apiKey}`,
      },
      timeout: REQUEST_TIMEOUT_MS,
    };
    if (isHttps) opts.agent = buildHttpsAgent(cfg);

    const lib = isHttps ? https : http;
    const req = lib.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(Object.assign(new Error("LLM returned non-JSON response"), { status, body: text }));
          }
        } else {
          reject(Object.assign(new Error(`HTTP ${status}`), { status, body: text }));
        }
      });
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("request timed out"), { transient: true })));
    req.on("error", (err) => reject(Object.assign(err, { transient: true })));
    req.write(payload);
    req.end();
  });
}
