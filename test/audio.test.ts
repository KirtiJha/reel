import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildAudioRetime } from "../src/polish/retime.js";
import { voiceKey, resolveVoice, findVoiceProvider, type ResolvedVoice } from "../src/narrate/voice.js";
import { audioEnabled } from "../src/narrate/audio.js";
import { duckEnvelope } from "../src/encode/audio.js";
import { audioSchema, specSchema } from "../src/spec/schema.js";

/* ------------------------- Fitting the timeline ------------------------- */

/** A voice long enough to need more room than the caption was given. */
const frames = [0, 1000, 2000, 3000, 4000];

describe("buildAudioRetime", () => {
  test("leaves a timeline alone when every line already fits", () => {
    const r = buildAudioRetime(frames, [{ t: 0, durationMs: 800 }], 4000, { breathMs: 0 });
    assert.equal(r.changed, false);
    assert.equal(r.endMs, 4000);
    assert.equal(r.map(2000), 2000);
  });

  test("stretches the interval a spoken line starts in", () => {
    // The line starts at 1000 and runs 2500ms, but the next frame is at 2000 —
    // so the gap has to grow from 1000ms to 2500ms.
    const r = buildAudioRetime(frames, [{ t: 1000, durationMs: 2500 }], 4000, { breathMs: 0 });
    assert.equal(r.changed, true);
    // Everything before the line is untouched.
    assert.equal(r.map(0), 0);
    assert.equal(r.map(1000), 1000);
    // The line now has its full length before the next mark.
    assert.equal(r.map(2000), 3500);
    // And the tail is carried along by the same amount, not rescaled.
    assert.equal(r.endMs, 4000 + 1500);
  });

  test("adds a breath after the line", () => {
    const r = buildAudioRetime(frames, [{ t: 1000, durationMs: 1200 }], 4000, { breathMs: 300 });
    // 1200 of speech + 300 of silence = 1500 needed, against a 1000ms gap.
    assert.equal(r.map(2000), 2500);
  });

  test("carries a line that outlasts several segments", () => {
    // 3.5s of speech starting at 0, across gaps of 1000 each.
    const r = buildAudioRetime(frames, [{ t: 0, durationMs: 3500 }], 4000, { breathMs: 0 });
    // The requirement is satisfied by the segments it spans rather than being
    // dumped entirely on the first one, so intermediate marks keep their order.
    const marks = [0, 1000, 2000, 3000, 4000].map((t) => r.map(t));
    for (let i = 1; i < marks.length; i++) {
      assert.ok(marks[i]! > marks[i - 1]!, `mark ${i} must stay after ${i - 1}`);
    }
    // And the whole 3.5s is covered by the time the line's span ends.
    assert.ok(marks[4]! >= 3500);
  });

  test("keeps later cues on their own cues rather than smearing the stretch", () => {
    const r = buildAudioRetime(frames, [
      { t: 0, durationMs: 2500 },
      { t: 3000, durationMs: 500 },
    ], 4000, { breathMs: 0 });
    // The second line starts at 3000 and needs no extra room; the distance from
    // it to the end must be unchanged.
    assert.equal(r.endMs - r.map(3000), 1000);
  });

  test("is monotonic", () => {
    const r = buildAudioRetime(frames, [{ t: 1000, durationMs: 4000 }], 4000, { breathMs: 200 });
    let prev = -1;
    for (let t = 0; t <= 4000; t += 50) {
      const v = r.map(t);
      assert.ok(v >= prev, `map(${t}) = ${v} went backwards from ${prev}`);
      prev = v;
    }
  });

  test("does nothing without lines, or with zero-length audio", () => {
    assert.equal(buildAudioRetime(frames, [], 4000).changed, false);
    assert.equal(buildAudioRetime(frames, [{ t: 0, durationMs: 0 }], 4000).changed, false);
  });

  test("survives a recording with no frames but a line to speak", () => {
    const r = buildAudioRetime([], [{ t: 0, durationMs: 2000 }], 500, { breathMs: 0 });
    assert.ok(r.endMs >= 2000, "the video must last at least as long as the narration");
  });
});

/* ------------------------------ The cache ------------------------------- */

const base: ResolvedVoice = {
  providerId: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-not-a-real-key",
  id: "alloy",
  model: "gpt-4o-mini-tts",
  speed: 1,
  sslVerify: true,
};

describe("voiceKey", () => {
  test("is stable for the same inputs", () => {
    assert.equal(voiceKey("Hello there", base), voiceKey("Hello there", base));
  });

  test("ignores the API key, so a rotated key doesn't invalidate the cache", () => {
    assert.equal(
      voiceKey("Hello there", base),
      voiceKey("Hello there", { ...base, apiKey: "sk-a-completely-different-key" }),
    );
  });

  test("changes with anything that changes the waveform", () => {
    const k = voiceKey("Hello there", base);
    assert.notEqual(k, voiceKey("Hello there!", base), "text");
    assert.notEqual(k, voiceKey("Hello there", { ...base, id: "nova" }), "voice");
    assert.notEqual(k, voiceKey("Hello there", { ...base, model: "tts-1" }), "model");
    assert.notEqual(k, voiceKey("Hello there", { ...base, speed: 1.1 }), "speed");
    assert.notEqual(k, voiceKey("Hello there", { ...base, style: "cheerful" }), "style");
    assert.notEqual(k, voiceKey("Hello there", { ...base, providerId: "elevenlabs" }), "provider");
  });

  test("does not collide across field boundaries", () => {
    // Naive concatenation would hash these two identically.
    assert.notEqual(
      voiceKey("b", { ...base, id: "a" }),
      voiceKey("", { ...base, id: "a b" }),
    );
  });
});

/* ---------------------------- Provider config --------------------------- */

describe("resolveVoice", () => {
  const KEYS = ["REEL_VOICE_API_KEY", "OPENAI_API_KEY", "ELEVENLABS_API_KEY", "ELEVEN_API_KEY"];
  function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    try {
      for (const k of KEYS) delete process.env[k];
      for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
      return fn();
    } finally {
      for (const k of KEYS) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  test("refuses without a key, and says which one to set", () => {
    withEnv({}, () => {
      // The message says what is wrong; the hint says what to do about it. A
      // regex over `assert.throws` only ever sees the message, so checking the
      // hint has to be explicit — and the hint is the half that helps.
      assert.throws(
        () => resolveVoice(audioSchema.parse({}).voice),
        (err: unknown) => {
          const e = err as { message: string; hint?: string };
          assert.match(e.message, /No API key for OpenAI/);
          assert.match(e.hint ?? "", /REEL_VOICE_API_KEY/);
          return true;
        },
      );
    });
  });

  test("prefers Reel's own env var over the vendor's", () => {
    withEnv({ REEL_VOICE_API_KEY: "reel-key", OPENAI_API_KEY: "openai-key" }, () => {
      assert.equal(resolveVoice(audioSchema.parse({}).voice).apiKey, "reel-key");
    });
  });

  test("falls back to the provider's own defaults", () => {
    withEnv({ OPENAI_API_KEY: "k" }, () => {
      const v = resolveVoice(audioSchema.parse({}).voice);
      const p = findVoiceProvider("openai");
      assert.equal(v.id, p.defaultVoice);
      assert.equal(v.model, p.defaultModel);
    });
  });

  test("drops a style the provider cannot honour rather than sending it", () => {
    withEnv({ ELEVENLABS_API_KEY: "k" }, () => {
      const voice = audioSchema.parse({ voice: { provider: "elevenlabs", style: "excited" } }).voice;
      assert.equal(resolveVoice(voice).style, undefined);
    });
  });

  test("names the providers it knows when given one it doesn't", () => {
    assert.throws(
      () => findVoiceProvider("nope"),
      (err: unknown) => {
        const e = err as { message: string; hint?: string };
        assert.match(e.message, /Unknown voice provider/);
        assert.match(e.hint ?? "", /openai[\s\S]*elevenlabs/);
        return true;
      },
    );
  });
});

/* ------------------------------- Grammar -------------------------------- */

describe("the audio grammar", () => {
  const minimal = {
    name: "t",
    url: "http://localhost:3000",
    steps: [{ caption: { text: "hi" } }],
    output: { mp4: "out.mp4" },
  };

  test("a caption can carry its own spoken line", () => {
    const spec = specSchema.parse({
      ...minimal,
      audio: {},
      steps: [{ caption: { text: "Short", say: "Something longer, for the ear." } }],
    });
    const step = spec.steps[0]! as { caption: { say?: string | false } };
    assert.equal(step.caption.say, "Something longer, for the ear.");
  });

  test("a caption can be marked silent", () => {
    const spec = specSchema.parse({ ...minimal, steps: [{ caption: { text: "8 — Studio", say: false } }] });
    const step = spec.steps[0]! as { caption: { say?: string | false } };
    assert.equal(step.caption.say, false);
  });

  test("narration can stand on its own without a caption", () => {
    const spec = specSchema.parse({ ...minimal, steps: [{ say: "Between two things you can see." }] });
    assert.deepEqual(spec.steps[0], { say: "Between two things you can see." });
  });

  test("an empty spoken line is rejected rather than synthesized as silence", () => {
    assert.throws(() => specSchema.parse({ ...minimal, steps: [{ caption: { text: "x", say: "" } }] }));
  });

  test("defaults: stretch to fit, with a breath", () => {
    const a = audioSchema.parse({});
    assert.equal(a.fit, "stretch");
    assert.ok(a.breathMs > 0);
    assert.equal(a.voice.provider, "openai");
    assert.equal(a.voice.speed, 1);
  });

  test("refuses a speed that would be unlistenable", () => {
    assert.throws(() => audioSchema.parse({ voice: { speed: 4 } }));
  });

  test("audio is off unless the spec asks for it", () => {
    const spec = specSchema.parse(minimal);
    assert.equal(spec.audio, undefined);
  });
});

describe("audioEnabled", () => {
  const cfg = audioSchema.parse({});
  const cues = [{ t: 0, text: "hello" }];

  test("needs a block, a line, and no explicit opt-out", () => {
    assert.equal(audioEnabled(cfg, undefined, cues), true);
    assert.equal(audioEnabled(cfg, true, cues), true);
    assert.equal(audioEnabled(undefined, true, cues), false, "no audio block");
    assert.equal(audioEnabled(cfg, false, cues), false, "explicitly disabled");
    assert.equal(audioEnabled(cfg, true, []), false, "nothing to say");
  });
});

/* ------------------------- The music bed envelope ----------------------- */

describe("duckEnvelope", () => {
  const line = (t: number) => ({ t, file: "x.mp3" });

  test("is flat when nobody speaks", () => {
    assert.equal(duckEnvelope([], [], -12), "1");
    // A line with no audio behind it must not duck either.
    assert.equal(duckEnvelope([line(0)], [0], -12), "1");
  });

  test("uses the requested depth as a linear floor", () => {
    // -6dB is half amplitude, so the envelope bottoms out at 0.5: 1 - 0.5*D.
    assert.match(duckEnvelope([line(1000)], [2000], -6), /^1-0\.4988\*/);
    // -20dB is a tenth: 1 - 0.9*D.
    assert.match(duckEnvelope([line(1000)], [2000], -20), /^1-0\.9000\*/);
  });

  test("0dB asks for no duck at all", () => {
    assert.match(duckEnvelope([line(1000)], [2000], 0), /^1-0\.0000\*/);
  });

  test("ramps in before the line and out after it", () => {
    // A line at 1.0s lasting 2.0s, with a 220ms ramp either side, must start
    // easing at 0.78 and finish returning at 3.22.
    const e = duckEnvelope([line(1000)], [2000], -12);
    assert.ok(e.includes("0.780"), `ramp-in start missing: ${e}`);
    assert.ok(e.includes("3.220"), `ramp-out end missing: ${e}`);
  });

  test("overlapping lines take the deepest duck rather than stacking", () => {
    const e = duckEnvelope([line(0), line(500)], [2000, 2000], -12);
    // One `max` joins the two spans; summing them would duck twice as far and
    // drive the bed to silence wherever two lines meet.
    assert.equal((e.match(/max\(/g) ?? []).length - (e.match(/max\(0/g) ?? []).length, 1);
  });

  test("parenthesises a ramp that starts before zero", () => {
    // A line at t=0 puts the ramp origin at -0.22, and `t--0.220` is only
    // correct by way of how the parser treats a subtracted negative.
    const e = duckEnvelope([line(0)], [2000], -12);
    assert.ok(e.includes("(t-(-0.220))"), `wanted an explicit negative: ${e}`);
    assert.ok(!e.includes("--"), `a double negative is too clever to rely on: ${e}`);
  });

  test("scales to a demo with many lines", () => {
    const many = Array.from({ length: 30 }, (_, i) => line(i * 3000));
    const e = duckEnvelope(many, many.map(() => 2500), -12);
    assert.ok(e.startsWith("1-"));
    // Balanced parentheses, or the filtergraph fails to parse at render time —
    // which is minutes into a recording, long after the mistake was made.
    let depth = 0;
    for (const c of e) {
      if (c === "(") depth++;
      else if (c === ")") depth--;
      assert.ok(depth >= 0, "unbalanced parentheses");
    }
    assert.equal(depth, 0, "unbalanced parentheses");
  });
});
