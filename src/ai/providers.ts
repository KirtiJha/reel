/**
 * Provider registry.
 *
 * Reel talks to whatever model you point it at. Most vendors expose an
 * OpenAI-compatible `/chat/completions` endpoint, so one wire format covers
 * nearly all of them; Anthropic's Messages API is shaped differently and gets
 * its own translation layer (see `anthropic-wire.ts`).
 *
 * A preset exists only to save typing — every field it supplies can be
 * overridden by an environment variable, and `custom` supplies none of them.
 * Nothing here is a gate: an unlisted vendor with an OpenAI-compatible endpoint
 * works today via `REEL_LLM_PROVIDER=custom` plus a base URL.
 */

/** How the API key is presented to the provider. */
export type AuthStyle = "bearer" | "x-api-key" | "azure-key";

/** The request/response shape spoken on the wire. */
export type Protocol = "openai" | "anthropic";

export interface Provider {
  id: string;
  label: string;
  protocol: Protocol;
  auth: AuthStyle;
  /** Default endpoint. Omitted where only the user knows it (proxies, local, custom). */
  baseUrl?: string;
  /** Conventional env vars for this vendor's key, tried in order. */
  keyEnv: string[];
  /** A sensible model to start from, when the vendor has an obvious default. */
  defaultModel?: string;
  /** Local runtimes accept any key, or none. */
  keyOptional?: boolean;
  /**
   * Append `/v1` to a base URL that lacks it.
   *
   * Only for endpoints the user types by hand, where forgetting the suffix is
   * the common mistake. A vendor whose path is fixed must never be rewritten:
   * Gemini's compatibility base already ends in `/openai`, and Azure routes by
   * deployment — appending `/v1` to either produces a 404.
   */
  appendV1?: boolean;
  /** Extra query parameters the endpoint requires (Azure's api-version). */
  query?: Record<string, string>;
  docs: string;
}

/**
 * Ordered for the docs and the Studio picker: the proxy Reel was built against
 * first, then the vendors people name most often, then local runtimes.
 */
export const PROVIDERS: Provider[] = [
  {
    id: "litellm",
    label: "LiteLLM proxy",
    protocol: "openai",
    auth: "bearer",
    keyEnv: ["LITELLM_API_KEY"],
    appendV1: true,
    docs: "https://docs.litellm.ai/docs/simple_proxy",
  },
  {
    id: "openai",
    label: "OpenAI",
    protocol: "openai",
    auth: "bearer",
    baseUrl: "https://api.openai.com/v1",
    keyEnv: ["OPENAI_API_KEY"],
    defaultModel: "gpt-4o",
    docs: "https://platform.openai.com/docs/api-reference/chat",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    protocol: "anthropic",
    auth: "x-api-key",
    baseUrl: "https://api.anthropic.com/v1",
    keyEnv: ["ANTHROPIC_API_KEY"],
    defaultModel: "claude-sonnet-4-5",
    docs: "https://docs.anthropic.com/en/api/messages",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    protocol: "openai", // Gemini ships an OpenAI-compatible surface
    auth: "bearer",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    defaultModel: "gemini-2.5-flash",
    docs: "https://ai.google.dev/gemini-api/docs/openai",
  },
  {
    id: "azure",
    label: "Azure OpenAI",
    protocol: "openai",
    auth: "azure-key",
    keyEnv: ["AZURE_OPENAI_API_KEY"],
    // Azure routes by deployment in the path and requires an API version, so
    // the base URL is per-resource and must be supplied.
    query: { "api-version": "2024-10-21" },
    docs: "https://learn.microsoft.com/azure/ai-services/openai/reference",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    protocol: "openai",
    auth: "bearer",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: ["OPENROUTER_API_KEY"],
    docs: "https://openrouter.ai/docs",
  },
  {
    id: "groq",
    label: "Groq",
    protocol: "openai",
    auth: "bearer",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: ["GROQ_API_KEY"],
    docs: "https://console.groq.com/docs/openai",
  },
  {
    id: "mistral",
    label: "Mistral",
    protocol: "openai",
    auth: "bearer",
    baseUrl: "https://api.mistral.ai/v1",
    keyEnv: ["MISTRAL_API_KEY"],
    docs: "https://docs.mistral.ai/api/",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    protocol: "openai",
    auth: "bearer",
    baseUrl: "https://api.deepseek.com/v1",
    keyEnv: ["DEEPSEEK_API_KEY"],
    docs: "https://api-docs.deepseek.com/",
  },
  {
    id: "together",
    label: "Together AI",
    protocol: "openai",
    auth: "bearer",
    baseUrl: "https://api.together.xyz/v1",
    keyEnv: ["TOGETHER_API_KEY"],
    docs: "https://docs.together.ai/docs/openai-api-compatibility",
  },
  {
    id: "xai",
    label: "xAI",
    protocol: "openai",
    auth: "bearer",
    baseUrl: "https://api.x.ai/v1",
    keyEnv: ["XAI_API_KEY"],
    docs: "https://docs.x.ai/api",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    protocol: "openai",
    auth: "bearer",
    baseUrl: "http://localhost:11434/v1",
    keyEnv: ["OLLAMA_API_KEY"],
    keyOptional: true,
    docs: "https://ollama.com/blog/openai-compatibility",
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    protocol: "openai",
    auth: "bearer",
    baseUrl: "http://localhost:1234/v1",
    keyEnv: ["LMSTUDIO_API_KEY"],
    keyOptional: true,
    docs: "https://lmstudio.ai/docs/api/openai-api",
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    protocol: "openai",
    auth: "bearer",
    keyEnv: [],
    keyOptional: true,
    appendV1: true,
    docs: "https://platform.openai.com/docs/api-reference/chat",
  },
];

export function findProvider(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id.trim().toLowerCase());
}

/**
 * Guess the provider from whichever key is present in the environment.
 *
 * Only used when nothing names a provider explicitly. LiteLLM comes first
 * because a proxy fronts other vendors — someone who set both `LITELLM_API_KEY`
 * and `OPENAI_API_KEY` almost certainly wants the proxy to do the routing.
 */
export function inferProvider(env: NodeJS.ProcessEnv = process.env): Provider | undefined {
  for (const p of PROVIDERS) {
    if (p.id === "custom") continue;
    if (p.keyEnv.some((k) => (env[k] ?? "").trim() !== "")) return p;
  }
  return undefined;
}
