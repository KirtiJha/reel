import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS, findProvider, inferProvider } from "../src/ai/providers.js";
import { loadLlmConfig, authHeaders, ensureOpenAiBase } from "../src/ai/llm.js";

/** Every key any test touches, cleared between tests so order can't matter. */
const KEYS = [
  "REEL_LLM_PROVIDER",
  "REEL_LLM_BASE_URL",
  "REEL_LLM_API_KEY",
  "REEL_LLM_MODEL",
  "LITELLM_API_BASE",
  "LITELLM_API_KEY",
  "LITELLM_MODEL",
  "OPENAI_API_BASE",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
];
const saved = new Map(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function only(env: Record<string, string>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
}

describe("provider registry", () => {
  test("every provider has the fields the client depends on", () => {
    for (const p of PROVIDERS) {
      assert.ok(p.id && p.label && p.docs, `${p.id} is missing identity fields`);
      assert.ok(["openai", "anthropic"].includes(p.protocol), `${p.id} has an unknown protocol`);
      assert.ok(["bearer", "x-api-key", "azure-key"].includes(p.auth), `${p.id} has an unknown auth`);
    }
  });

  test("a provider with no default endpoint must be one the user configures", () => {
    // Presets without a baseUrl are per-deployment (proxy, Azure resource,
    // custom). Shipping one with neither a URL nor that excuse strands the user.
    const perDeployment = new Set(["litellm", "azure", "custom"]);
    for (const p of PROVIDERS) {
      if (!p.baseUrl) assert.ok(perDeployment.has(p.id), `${p.id} has no baseUrl and isn't per-deployment`);
    }
  });

  test("looks a provider up case-insensitively", () => {
    assert.equal(findProvider("OpenAI")?.id, "openai");
    assert.equal(findProvider(" anthropic ")?.id, "anthropic");
  });

  test("returns undefined for an unknown id", () => {
    assert.equal(findProvider("not-a-provider"), undefined);
  });
});

describe("provider inference", () => {
  test("picks the vendor whose key is present", () => {
    assert.equal(inferProvider({ GROQ_API_KEY: "k" } as NodeJS.ProcessEnv)?.id, "groq");
    assert.equal(inferProvider({ ANTHROPIC_API_KEY: "k" } as NodeJS.ProcessEnv)?.id, "anthropic");
  });

  test("prefers the proxy when a proxy key and a vendor key are both set", () => {
    // A proxy fronts other vendors, so its key coexisting with OpenAI's means
    // the proxy should route — not that OpenAI should be called directly.
    const env = { LITELLM_API_KEY: "k", OPENAI_API_KEY: "k2" } as NodeJS.ProcessEnv;
    assert.equal(inferProvider(env)?.id, "litellm");
  });

  test("ignores an empty key rather than matching on the variable existing", () => {
    assert.equal(inferProvider({ GROQ_API_KEY: "  " } as NodeJS.ProcessEnv), undefined);
  });
});

describe("loadLlmConfig", () => {
  test("an existing LiteLLM setup keeps working with no new variables", () => {
    only({ LITELLM_API_BASE: "https://proxy.example.com", LITELLM_API_KEY: "k", LITELLM_MODEL: "gpt-4o" });
    const cfg = loadLlmConfig();
    assert.equal(cfg.providerId, "litellm");
    assert.equal(cfg.apiBase, "https://proxy.example.com/v1");
    assert.equal(cfg.protocol, "openai");
  });

  test("strips a routing prefix for a proxy", () => {
    only({ LITELLM_API_BASE: "https://p.example.com", LITELLM_API_KEY: "k", LITELLM_MODEL: "litellm_proxy/gemini-3" });
    assert.equal(loadLlmConfig().model, "gemini-3");
  });

  test("keeps slashes in a real model name from a direct vendor", () => {
    // Several vendors ship slashes in genuine model IDs; stripping to the last
    // segment there would request a model that doesn't exist.
    only({ REEL_LLM_PROVIDER: "together", REEL_LLM_API_KEY: "k", REEL_LLM_MODEL: "meta-llama/Llama-3-70b" });
    assert.equal(loadLlmConfig().model, "meta-llama/Llama-3-70b");
  });

  test("uses the provider's default endpoint and model", () => {
    only({ REEL_LLM_PROVIDER: "openai", REEL_LLM_API_KEY: "k" });
    const cfg = loadLlmConfig();
    assert.equal(cfg.apiBase, "https://api.openai.com/v1");
    assert.equal(cfg.model, "gpt-4o");
  });

  test("reads the vendor's own conventional key variable", () => {
    only({ REEL_LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-x" });
    const cfg = loadLlmConfig();
    assert.equal(cfg.apiKey, "sk-ant-x");
    assert.equal(cfg.protocol, "anthropic");
  });

  test("does not append /v1 to a non-OpenAI endpoint", () => {
    only({ REEL_LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" });
    assert.equal(loadLlmConfig().apiBase, "https://api.anthropic.com/v1");
  });

  test("never rewrites a vendor endpoint whose path shape is fixed", () => {
    // Gemini's compatibility base already ends in /openai and Azure routes by
    // deployment — appending /v1 to either 404s. Only hand-typed endpoints
    // (proxy, custom) get that convenience.
    only({ REEL_LLM_PROVIDER: "gemini", GEMINI_API_KEY: "k" });
    assert.equal(loadLlmConfig().apiBase, "https://generativelanguage.googleapis.com/v1beta/openai");

    only({
      REEL_LLM_PROVIDER: "azure",
      AZURE_OPENAI_API_KEY: "k",
      REEL_LLM_MODEL: "gpt-4o",
      REEL_LLM_BASE_URL: "https://r.openai.azure.com/openai/deployments/d",
    });
    assert.equal(loadLlmConfig().apiBase, "https://r.openai.azure.com/openai/deployments/d");
  });

  test("appends /v1 for endpoints the user types by hand", () => {
    only({ REEL_LLM_PROVIDER: "custom", REEL_LLM_BASE_URL: "http://gw.local", REEL_LLM_MODEL: "m" });
    assert.equal(loadLlmConfig().apiBase, "http://gw.local/v1");
  });

  test("an explicit base URL overrides the preset", () => {
    only({ REEL_LLM_PROVIDER: "openai", REEL_LLM_API_KEY: "k", REEL_LLM_BASE_URL: "https://gw.internal/v1" });
    assert.equal(loadLlmConfig().apiBase, "https://gw.internal/v1");
  });

  test("a local runtime needs no key", () => {
    only({ REEL_LLM_PROVIDER: "ollama", REEL_LLM_MODEL: "llama3" });
    const cfg = loadLlmConfig();
    assert.equal(cfg.apiKey, "");
    assert.equal(cfg.apiBase, "http://localhost:11434/v1");
  });

  test("a --model override beats every environment variable", () => {
    only({ REEL_LLM_PROVIDER: "openai", REEL_LLM_API_KEY: "k", REEL_LLM_MODEL: "gpt-4o" });
    assert.equal(loadLlmConfig("o3-mini").model, "o3-mini");
  });

  test("names the provider when a typo means it can't be resolved", () => {
    only({ REEL_LLM_PROVIDER: "opneai", REEL_LLM_API_KEY: "k" });
    assert.throws(() => loadLlmConfig(), /Unknown LLM provider "opneai"/);
  });

  test("a missing key for a provider that needs one says which provider", () => {
    only({ REEL_LLM_PROVIDER: "openai" });
    assert.throws(() => loadLlmConfig(), /OpenAI/);
  });

  test("custom requires a base URL and says so", () => {
    only({ REEL_LLM_PROVIDER: "custom", REEL_LLM_MODEL: "m" });
    assert.throws(() => loadLlmConfig(), /endpoint/i);
  });
});

describe("authHeaders", () => {
  test("bearer for OpenAI-compatible providers", () => {
    const h = authHeaders({ auth: "bearer", apiKey: "k" } as never);
    assert.equal(h.authorization, "Bearer k");
  });

  test("x-api-key plus a version for Anthropic", () => {
    const h = authHeaders({ auth: "x-api-key", apiKey: "k" } as never);
    assert.equal(h["x-api-key"], "k");
    assert.ok(h["anthropic-version"], "Anthropic rejects a request with no version header");
    assert.equal(h.authorization, undefined);
  });

  test("api-key for Azure", () => {
    const h = authHeaders({ auth: "azure-key", apiKey: "k" } as never);
    assert.equal(h["api-key"], "k");
  });

  test("sends no auth header at all when a local runtime has no key", () => {
    const h = authHeaders({ auth: "bearer", apiKey: "" } as never);
    assert.deepEqual(h, {});
  });
});

describe("ensureOpenAiBase", () => {
  test("appends /v1 when absent", () => {
    assert.equal(ensureOpenAiBase("https://x.example.com"), "https://x.example.com/v1");
  });
  test("leaves an existing /v1 alone", () => {
    assert.equal(ensureOpenAiBase("https://x.example.com/v1"), "https://x.example.com/v1");
  });
  test("tolerates a trailing slash", () => {
    assert.equal(ensureOpenAiBase("https://x.example.com/"), "https://x.example.com/v1");
  });
});
