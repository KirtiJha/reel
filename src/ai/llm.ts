import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { ReelError, log } from "../util/log.js";
import { fromAnthropicResponse, toAnthropicRequest } from "./anthropic-wire.js";
import {
  PROVIDERS,
  findProvider,
  inferProvider,
  type AuthStyle,
  type Protocol,
  type Provider,
} from "./providers.js";

/**
 * The model client.
 *
 * Reel is provider-agnostic: point it at OpenAI, Anthropic, Gemini, a LiteLLM
 * proxy, Ollama on your laptop, or anything else with an OpenAI-compatible
 * endpoint. Configuration resolves in three layers, most specific first:
 *
 *   1. explicit `REEL_LLM_*` variables,
 *   2. the named provider's preset (see `providers.ts`) and its conventional
 *      key variable — `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and so on,
 *   3. the legacy `LITELLM_*` / `OPENAI_*` names, so existing setups keep
 *      working untouched.
 *
 * Messages use one canonical (OpenAI-shaped) format internally regardless of
 * provider; a vendor whose wire format differs is translated at the boundary
 * rather than leaking its shape into the agent, the healer or the translator.
 *
 * TLS verification follows SSL_VERIFY (default true) — set it false for
 * corporate proxies whose certificates don't verify locally. Transient errors
 * (429 / 5xx / timeouts) retry with exponential backoff and jitter.
 */

const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const REQUEST_TIMEOUT_MS = 120_000;

export interface LlmConfig {
  /** Which preset resolved — surfaced in errors and in Studio. */
  providerId: string;
  providerLabel: string;
  protocol: Protocol;
  auth: AuthStyle;
  apiBase: string;
  apiKey: string;
  model: string;
  sslVerify: boolean;
  /** Path to a corporate CA bundle to trust (SSL_CERT_FILE / REQUESTS_CA_BUNDLE). */
  caBundle?: string;
  /** Query parameters the endpoint requires (Azure's api-version). */
  query?: Record<string, string>;
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
/**
 * A message part, for turns that carry an image as well as text.
 *
 * The OpenAI multipart shape, because it is what nearly every provider already
 * accepts; Anthropic's block form is translated in `anthropic-wire.ts` like the
 * rest of its differences. Reel only ever sends images it just produced, so the
 * URL is always a `data:` one — nothing here fetches from the network.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface OaiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: OaiToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** An image part from raw bytes, inlined as a data URL. */
export function imagePart(image: Buffer, mime = "image/png"): ContentPart {
  return { type: "image_url", image_url: { url: `data:${mime};base64,${image.toString("base64")}` } };
}

/**
 * The text of a message, whichever shape it arrived in.
 *
 * Requests can now be multipart; replies are still text, but the type says
 * "either" and callers reading `.content` directly would be reading a union.
 */
export function messageText(m: Pick<OaiMessage, "content">): string {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return m.content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
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

/**
 * Which provider to talk to.
 *
 * An explicit name always wins, and a wrong one is an error rather than a
 * silent fallback — a typo in `REEL_LLM_PROVIDER` should say so, not quietly
 * send the request somewhere else. Otherwise: an existing `LITELLM_API_BASE`
 * means an existing LiteLLM setup, then whichever vendor's key is present, and
 * finally LiteLLM, whose error message names what to set.
 */
export function resolveProvider(): Provider {
  const named = getEnv("REEL_LLM_PROVIDER");
  if (named) {
    const found = findProvider(named);
    if (found) return found;
    throw new ReelError(
      `Unknown LLM provider "${named}".`,
      `Known providers: ${PROVIDERS.map((p) => p.id).join(", ")}. ` +
        "Use `custom` with REEL_LLM_BASE_URL for any other OpenAI-compatible endpoint.",
    );
  }
  if (getEnv("LITELLM_API_BASE") !== undefined) return findProvider("litellm")!;
  return inferProvider() ?? findProvider("litellm")!;
}

/**
 * Resolve the provider, endpoint, key and model from the environment.
 *
 * The three layers are ordered so that adding an explicit setting always wins
 * over a guess, and so an existing LiteLLM setup keeps working with no edits.
 */
export function loadLlmConfig(modelOverride?: string): LlmConfig {
  const provider = resolveProvider();

  const apiBase =
    getEnv("REEL_LLM_BASE_URL", "LITELLM_API_BASE", "OPENAI_API_BASE") ?? provider.baseUrl;
  const apiKey = getEnv("REEL_LLM_API_KEY", ...provider.keyEnv, "LITELLM_API_KEY", "OPENAI_API_KEY");
  const modelRaw =
    modelOverride ??
    getEnv(
      "REEL_LLM_MODEL",
      "LITELLM_MODEL",
      "LLM_MODEL_NAME",
      "OPENAI_CHAT_MODEL_NAME",
      "OPENAI_API_MODEL",
    ) ??
    provider.defaultModel;

  if (!apiBase) {
    throw new ReelError(
      `No endpoint configured for ${provider.label}.`,
      `Set REEL_LLM_BASE_URL to the ${provider.label} endpoint. See .env.example, or ${provider.docs}.`,
    );
  }
  if (!apiKey && !provider.keyOptional) {
    throw new ReelError(
      `No API key configured for ${provider.label}.`,
      `Set REEL_LLM_API_KEY${provider.keyEnv.length ? ` or ${provider.keyEnv[0]}` : ""} in your environment or .env.`,
    );
  }
  if (!modelRaw) {
    throw new ReelError(
      `No model configured for ${provider.label}.`,
      "Set REEL_LLM_MODEL, or pass --model.",
    );
  }

  const reasoning = getEnv("REEL_LLM_REASONING_EFFORT", "LITELLM_REASONING_EFFORT");
  const temp = getEnv("REEL_LLM_TEMPERATURE", "LITELLM_TEMPERATURE");
  return {
    providerId: provider.id,
    providerLabel: provider.label,
    protocol: provider.protocol,
    auth: provider.auth,
    // Only endpoints the user types by hand get the /v1 convenience — a
    // vendor with a fixed path shape 404s if it is rewritten.
    apiBase: provider.appendV1 ? ensureOpenAiBase(apiBase) : apiBase.replace(/\/+$/, ""),
    apiKey: apiKey ?? "",
    // A `provider/model` prefix is a proxy-routing convention; strip it only
    // where a proxy is what's being addressed. Vendors use slashes in real
    // model names (`accounts/fireworks/...`, `meta-llama/...`).
    model: provider.id === "litellm" ? extractModelName(modelRaw) : modelRaw.trim(),
    sslVerify: getBool("SSL_VERIFY", true),
    caBundle: getEnv("SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "HTTPX_SSL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS"),
    query: provider.query,
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
      if (cfg.protocol === "anthropic") {
        const res = await postJson(
          `${cfg.apiBase}/messages`,
          toAnthropicRequest(cfg.model, messages, tools, {
            temperature: stripOptional ? undefined : cfg.temperature,
          }),
          cfg,
        );
        return fromAnthropicResponse(res);
      }
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
          throw new ReelError(
            `${cfg.providerLabel} rejected the API key (HTTP ${e.status}).`,
            `Check REEL_LLM_API_KEY${cfg.providerId !== "custom" ? ` (or the provider's own key variable)` : ""}.`,
          );
        }
        if (e.status === 404) {
          throw new ReelError(
            `${cfg.providerLabel} returned 404 for ${cfg.apiBase}.`,
            `Check REEL_LLM_BASE_URL and that "${cfg.model}" exists on this provider.`,
          );
        }
        throw new ReelError(
          `${cfg.providerLabel} request failed${e.status ? ` (HTTP ${e.status})` : ""}: ${e.message}`,
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
 * Vendors disagree about how a key is presented: most take a bearer token,
 * Anthropic takes `x-api-key` alongside a required API version, and Azure takes
 * `api-key`. Getting this wrong reads as an auth failure, so it's explicit.
 */
export function authHeaders(cfg: LlmConfig): Record<string, string> {
  switch (cfg.auth) {
    case "x-api-key":
      return { "x-api-key": cfg.apiKey, "anthropic-version": ANTHROPIC_VERSION };
    case "azure-key":
      return { "api-key": cfg.apiKey };
    default:
      // A local runtime with no key shouldn't send an empty bearer token.
      return cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {};
  }
}

/** Anthropic requires an explicit API version on every request. */
const ANTHROPIC_VERSION = "2023-06-01";

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
    // Endpoints that route by query parameter (Azure's api-version) need them
    // merged in rather than appended, so a base URL that already carries one
    // isn't corrupted.
    for (const [k, v] of Object.entries(cfg.query ?? {})) {
      if (!url.searchParams.has(k)) url.searchParams.set(k, v);
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
        ...authHeaders(cfg),
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
