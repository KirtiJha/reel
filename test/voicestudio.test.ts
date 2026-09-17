import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { findVoiceProvider, resolveVoice, VOICE_PROVIDERS } from "../src/narrate/voice.js";
import { specSchema } from "../src/spec/schema.js";

/** Run `fn` with the voice-key env vars cleared, then put them back. */
function withoutKeys<T>(fn: () => T): T {
  const names = ["REEL_VOICE_API_KEY", "OPENAI_API_KEY", "ELEVENLABS_API_KEY", "ELEVEN_API_KEY"];
  const saved = names.map((n) => [n, process.env[n]] as const);
  for (const n of names) delete process.env[n];
  try {
    return fn();
  } finally {
    for (const [n, v] of saved) if (v !== undefined) process.env[n] = v;
  }
}

const voice = (over: Record<string, unknown> = {}) =>
  ({ provider: "voicestudio", speed: 1, ...over }) as never;

describe("the local provider needs no key", () => {
  // The whole point: a synthesizer on this machine has no account behind it.
  // Demanding a key would mean setting a fake one to satisfy a check that does
  // not apply — and the error when the server is simply not running would then
  // say "no API key", sending you after the wrong thing.
  test("resolves with every key env var unset", () => {
    const v = withoutKeys(() => resolveVoice(voice()));
    assert.equal(v.providerId, "voicestudio");
    assert.equal(v.apiKey, "");
  });

  test("the cloud providers still demand one", () => {
    for (const id of ["openai", "elevenlabs"]) {
      assert.throws(() => withoutKeys(() => resolveVoice(voice({ provider: id }))), /No API key/);
    }
  });

  test("defaults to loopback, where it binds itself", () => {
    assert.match(withoutKeys(() => resolveVoice(voice())).baseUrl, /^http:\/\/127\.0\.0\.1:3900\/v1$/);
  });

  test("a key is still honoured, for a remote worker", () => {
    const v = withoutKeys(() => {
      process.env["REEL_VOICE_API_KEY"] = "bearer-token";
      return resolveVoice(voice());
    });
    assert.equal(v.apiKey, "bearer-token");
  });
});

describe("it speaks the OpenAI request shape", () => {
  const p = findVoiceProvider("voicestudio");
  const v = withoutKeys(() => resolveVoice(voice({ id: "narrator", model: "kokoro", speed: 1.1 })));

  test("posts to /audio/speech", () => {
    assert.equal(p.request("hi", v).url, "http://127.0.0.1:3900/v1/audio/speech");
  });

  test("sends the fields OpenAI's endpoint names", () => {
    const body = p.request("hello", v).body as Record<string, unknown>;
    assert.equal(body["input"], "hello");
    assert.equal(body["voice"], "narrator");
    assert.equal(body["model"], "kokoro");
    assert.equal(body["speed"], 1.1);
    assert.equal(body["response_format"], "mp3");
  });

  test("sends no credential when there is none", () => {
    // A loopback server wants no header at all; sending `Bearer undefined`
    // would be a 401 from a server that never needed one.
    assert.deepEqual(p.request("hi", v).headers, {});
  });

  test("sends a bearer token when one exists", () => {
    const keyed = { ...v, apiKey: "tok" };
    assert.deepEqual(p.request("hi", keyed).headers, { authorization: "Bearer tok" });
  });
});

describe("the spec accepts it", () => {
  test("`provider: voicestudio` validates", () => {
    const parsed = specSchema.parse({
      name: "d",
      url: "http://localhost:3000",
      output: { mp4: "o.mp4" },
      audio: { voice: { provider: "voicestudio" } },
      steps: [{ say: "hello" }],
    });
    assert.equal(parsed.audio?.voice.provider, "voicestudio");
  });

  test("an unknown provider is still refused", () => {
    assert.throws(() =>
      specSchema.parse({
        name: "d",
        url: "http://localhost:3000",
        output: { mp4: "o.mp4" },
        audio: { voice: { provider: "acme-tts" } },
        steps: [{ say: "hello" }],
      }),
    );
  });
});

describe("no cloud provider was disturbed", () => {
  test("every provider still has the fields the request path reads", () => {
    for (const p of VOICE_PROVIDERS) {
      assert.ok(p.id && p.label && p.baseUrl, `${p.id} is incomplete`);
      assert.ok(p.defaultVoice && p.defaultModel, `${p.id} has no defaults`);
      assert.equal(typeof p.request, "function");
    }
  });

  test("only the local one is marked local", () => {
    assert.deepEqual(
      VOICE_PROVIDERS.filter((p) => p.local).map((p) => p.id),
      ["voicestudio"],
    );
  });
});
