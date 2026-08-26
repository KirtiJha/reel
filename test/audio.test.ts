import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildAudioRetime, buildFlowRetime } from "../src/polish/retime.js";
import {
  voiceKey,
  resolveVoice,
  findVoiceProvider,
  type ResolvedVoice,
  type SpokenCue,
} from "../src/narrate/voice.js";
import { audioEnabled, localizeCues } from "../src/narrate/audio.js";
import { duckEnvelope } from "../src/encode/audio.js";
import { withIdleMotion } from "../src/polish/zoom.js";
import { placeHits, renderSfx, synthesize, toWav, SFX_SAMPLE_RATE } from "../src/encode/sfx.js";
import { audioSchema, specSchema } from "../src/spec/schema.js";
import { applyPatch } from "../src/ui/server.js";
import { summarize } from "../src/ui/summary.js";
import { parse as parseYaml } from "yaml";

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

  test("defaults: flow, with a breath", () => {
    const a = audioSchema.parse({});
    // Flow rather than stretch: stretching freezes the picture for as long as
    // a line takes to say, which is what made the tour unwatchable.
    assert.equal(a.fit, "flow");
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

/* ----------------------------- Sound design ----------------------------- */

describe("synthesize", () => {
  test("produces a normalized, non-silent burst for every kind", () => {
    for (const kind of ["click", "type", "card"] as const) {
      const s = synthesize(kind);
      assert.ok(s.length > 0, `${kind} is empty`);
      const peak = Math.max(...Array.from(s, Math.abs));
      assert.ok(Math.abs(peak - 1) < 1e-6, `${kind} peak is ${peak}, wanted 1`);
    }
  });

  test("is identical every call — noise is seeded, not random", () => {
    // Math.random() here would make every render's soundtrack different, which
    // is the one thing the whole pipeline is built to prevent.
    for (const kind of ["click", "type", "card"] as const) {
      assert.deepEqual(Array.from(synthesize(kind)), Array.from(synthesize(kind)));
    }
  });

  test("a card sweep is long and a keystroke is short", () => {
    assert.ok(synthesize("card").length > synthesize("click").length);
    assert.ok(synthesize("click").length > synthesize("type").length);
  });
});

describe("placeHits", () => {
  test("passes discrete cues through untouched", () => {
    const hits = placeHits([{ t: 100, kind: "click" }, { t: 900, kind: "card" }], "full");
    assert.deepEqual(hits, [{ t: 100, kind: "click" }, { t: 900, kind: "card" }]);
  });

  test("spreads a typing span into repeated ticks", () => {
    const hits = placeHits([{ t: 0, kind: "type", durationMs: 425 }], "full");
    assert.equal(hits.length, 5); // 85ms apart across 425ms
    assert.deepEqual(hits.map((h) => h.t), [0, 85, 170, 255, 340]);
  });

  test("subtle types at half the rate", () => {
    const full = placeHits([{ t: 0, kind: "type", durationMs: 425 }], "full");
    const subtle = placeHits([{ t: 0, kind: "type", durationMs: 425 }], "subtle");
    assert.ok(subtle.length < full.length);
    assert.deepEqual(subtle.map((h) => h.t), [0, 170, 340]);
  });

  test("a typing cue with no duration makes no sound", () => {
    assert.deepEqual(placeHits([{ t: 0, kind: "type" }], "full"), []);
  });

  test("returns hits in time order", () => {
    const hits = placeHits(
      [{ t: 500, kind: "click" }, { t: 0, kind: "type", durationMs: 300 }],
      "full",
    );
    for (let i = 1; i < hits.length; i++) assert.ok(hits[i]!.t >= hits[i - 1]!.t);
  });
});

describe("renderSfx", () => {
  const energyNear = (track: Float32Array, ms: number, windowMs = 30) => {
    const from = Math.round((ms / 1000) * SFX_SAMPLE_RATE);
    const to = Math.min(track.length, from + Math.round((windowMs / 1000) * SFX_SAMPLE_RATE));
    let sum = 0;
    for (let i = Math.max(0, from); i < to; i++) sum += track[i]! ** 2;
    return sum;
  };

  test("is silent when switched off", () => {
    const t = renderSfx([{ t: 100, kind: "click" }], 1000, "none");
    assert.ok(t.every((v) => v === 0));
  });

  test("puts a hit where the cue was, and silence where it wasn't", () => {
    const t = renderSfx([{ t: 500, kind: "click" }], 2000, "full");
    assert.ok(energyNear(t, 500) > 0, "nothing at the cue");
    assert.equal(energyNear(t, 1200), 0, "sound away from the cue");
  });

  test("runs exactly as long as the video", () => {
    const t = renderSfx([{ t: 0, kind: "click" }], 1500, "full");
    assert.equal(t.length, Math.round(1.5 * SFX_SAMPLE_RATE));
  });

  test("truncates a hit at the end rather than dropping or overflowing it", () => {
    // The cue lands 5ms before the end; the click is 22ms long.
    const t = renderSfx([{ t: 995, kind: "click" }], 1000, "full");
    assert.equal(t.length, Math.round(1.0 * SFX_SAMPLE_RATE));
    assert.ok(energyNear(t, 995, 5) > 0, "the attack should still land");
  });

  test("subtle is quieter than full", () => {
    const cues = [{ t: 100, kind: "click" as const }];
    assert.ok(energyNear(renderSfx(cues, 1000, "subtle"), 100) <
              energyNear(renderSfx(cues, 1000, "full"), 100));
  });

  test("never clips, even when every effect lands at once", () => {
    const together = Array.from({ length: 40 }, () => ({ t: 200, kind: "click" as const }));
    const t = renderSfx(together, 1000, "full");
    assert.ok(t.every((v) => v >= -1 && v <= 1), "soft clip should hold the track in range");
  });

  test("renders the same bytes twice", () => {
    const cues = [{ t: 0, kind: "click" as const }, { t: 40, kind: "type" as const, durationMs: 300 }];
    assert.deepEqual(
      Array.from(renderSfx(cues, 1000, "full")),
      Array.from(renderSfx(cues, 1000, "full")),
    );
  });
});

describe("toWav", () => {
  test("writes a mono 16-bit header ffmpeg can read without guessing", () => {
    const wav = toWav(new Float32Array(10));
    assert.equal(wav.subarray(0, 4).toString(), "RIFF");
    assert.equal(wav.subarray(8, 12).toString(), "WAVE");
    assert.equal(wav.readUInt16LE(20), 1, "PCM");
    assert.equal(wav.readUInt16LE(22), 1, "mono");
    assert.equal(wav.readUInt32LE(24), SFX_SAMPLE_RATE);
    assert.equal(wav.readUInt16LE(34), 16, "bit depth");
    assert.equal(wav.readUInt32LE(40), 20, "data length");
    assert.equal(wav.length, 44 + 20);
  });

  test("full scale does not wrap to the opposite sign", () => {
    // 16-bit reaches -32768 but only +32767. Scaling +1.0 by 32768 overflows to
    // full-scale negative — an audible tick exactly where the signal is loudest.
    const wav = toWav(Float32Array.from([1, -1]));
    assert.equal(wav.readInt16LE(44), 32767);
    assert.equal(wav.readInt16LE(46), -32768);
  });

  test("clamps anything the mix pushed out of range", () => {
    const wav = toWav(Float32Array.from([2, -2]));
    assert.equal(wav.readInt16LE(44), 32767);
    assert.equal(wav.readInt16LE(46), -32768);
  });
});

/* ------------------------------ Languages ------------------------------- */

describe("localizeCues", () => {
  const cues: SpokenCue[] = [
    { t: 0, text: "One", alt: { es: "Uno", de: "Eins" } },
    { t: 1000, text: "Two", alt: { es: "Dos" } },
    { t: 2000, text: "Three" },
  ];

  test("prefers the line a person wrote", async () => {
    const r = await localizeCues(cues, "es");
    assert.deepEqual(r.cues.map((c) => c.text), ["Uno", "Dos", "Three"]);
    assert.equal(r.authored, 2);
  });

  test("counts what it could not translate rather than hiding it", async () => {
    // No model is configured in the test environment, so the untranslated
    // lines stay in the original — and must be reported, because a German
    // track that is quietly two-thirds English is worse than none.
    const r = await localizeCues(cues, "de");
    assert.equal(r.authored, 1);
    assert.equal(r.untranslated, 2);
    assert.equal(r.cues[0]!.text, "Eins");
    assert.equal(r.cues[1]!.text, "Two", "falls back to the original, not to silence");
  });

  test("keeps timings untouched — only the words change", async () => {
    const r = await localizeCues(cues, "es");
    assert.deepEqual(r.cues.map((c) => c.t), [0, 1000, 2000]);
  });

  test("a language nobody wrote for leaves every line in the original", async () => {
    const r = await localizeCues(cues, "ja");
    assert.equal(r.authored, 0);
    assert.equal(r.untranslated, 3);
    assert.deepEqual(r.cues.map((c) => c.text), ["One", "Two", "Three"]);
  });

  test("a fully authored language needs no model at all", async () => {
    const full: SpokenCue[] = [{ t: 0, text: "One", alt: { fr: "Un" } }];
    const r = await localizeCues(full, "fr");
    assert.deepEqual(r.cues.map((c) => c.text), ["Un"]);
    assert.equal(r.untranslated, 0);
    assert.equal(r.machine, 0);
  });
});

describe("the sayIn grammar", () => {
  const minimal = {
    name: "t",
    url: "http://localhost:3000",
    output: { mp4: "out.mp4" },
  };

  test("a caption can carry translations beside its spoken line", () => {
    const spec = specSchema.parse({
      ...minimal,
      audio: {},
      steps: [{ caption: { text: "Hi", say: "Hello there", sayIn: { es: "Hola" } } }],
    });
    const step = spec.steps[0]! as { caption: { sayIn?: Record<string, string> } };
    assert.deepEqual(step.caption.sayIn, { es: "Hola" });
  });

  test("an empty translation is rejected rather than spoken as silence", () => {
    assert.throws(() =>
      specSchema.parse({ ...minimal, steps: [{ caption: { text: "Hi", sayIn: { es: "" } } }] }),
    );
  });
});

/* ---------------------- The Studio's audio controls ---------------------- */

describe("the audio options round-trip", () => {
  const base = [
    "name: t",
    "url: http://localhost:3000",
    "steps:",
    "  - caption: { text: Hi, say: Hello there }",
    "output:",
    "  mp4: out/demo.mp4",
    "",
  ].join("\n");

  test("switching narration on writes a block that parses", () => {
    const raw = applyPatch(base, {
      audio: {
        voice: { provider: "elevenlabs", id: "abc123" },
        fit: "stretch",
        sfx: "subtle",
        music: { file: "bed.mp3", duck: -14 },
      },
    });
    const spec = specSchema.parse(parseYaml(raw));
    assert.equal(spec.audio?.voice.provider, "elevenlabs");
    assert.equal(spec.audio?.voice.id, "abc123");
    assert.equal(spec.audio?.sfx, "subtle");
    assert.equal(spec.audio?.music?.file, "bed.mp3");
    assert.equal(spec.audio?.music?.duck, -14);
  });

  test("an unset voice id is removed, not written as empty", () => {
    // An empty string would fail the schema, and a key that is present but
    // blank reads as a choice nobody made.
    const withId = applyPatch(base, { audio: { voice: { provider: "openai", id: "x" } } });
    const cleared = applyPatch(withId, { audio: { voice: { provider: "openai", id: null } } });
    assert.ok(!/id:/.test(cleared), `id should be gone:\n${cleared}`);
    assert.doesNotThrow(() => specSchema.parse(parseYaml(cleared)));
  });

  test("switching narration off removes the whole block", () => {
    const on = applyPatch(base, { audio: { voice: { provider: "openai" }, sfx: "full" } });
    const off = applyPatch(on, { audio: null });
    assert.ok(!/audio:/.test(off), `audio should be gone:\n${off}`);
    assert.equal(specSchema.parse(parseYaml(off)).audio, undefined);
  });

  test("dropping the bed leaves the rest of the soundtrack alone", () => {
    const on = applyPatch(base, {
      audio: { voice: { provider: "openai" }, sfx: "full", music: { file: "bed.mp3", duck: -10 } },
    });
    const off = applyPatch(on, { audio: { voice: { provider: "openai" }, sfx: "full", music: null } });
    const spec = specSchema.parse(parseYaml(off));
    assert.equal(spec.audio?.music, undefined);
    assert.equal(spec.audio?.sfx, "full", "the rest of the block must survive");
  });
});

describe("what the Studio is told about audio", () => {
  const spec = (steps: string) =>
    summarize(["name: t", "url: http://x", "steps:", steps, "output: { mp4: o.mp4 }"].join("\n"));

  test("counts the steps that actually carry a line", () => {
    const s = spec(
      [
        "  - caption: { text: A, say: One }",
        "  - caption: { text: B, say: false }", // deliberately silent
        "  - caption: C", // a bare string is spoken
        "  - card: { title: D }", // a card is silent unless given a line
        "  - card: { title: E, say: Five }",
        "  - say: Six",
        "  - click: '#x'",
      ].join("\n"),
    );
    assert.equal(s.options.audio.spokenLines, 4);
  });

  test("reports the defaults when a spec has no audio block", () => {
    const s = spec("  - caption: A");
    assert.equal(s.options.audio.enabled, false);
    assert.equal(s.options.audio.sfx, "none");
    assert.equal(s.options.audio.fit, "stretch");
  });
});

/* --------------------------- Flow, and drifting -------------------------- */

describe("buildFlowRetime", () => {
  test("does nothing when every line fits the gap it was given", () => {
    const r = buildFlowRetime([{ t: 0, durationMs: 800 }, { t: 2000, durationMs: 900 }], 4000, {
      breathMs: 200,
    });
    assert.equal(r.changed, false);
    assert.equal(r.endMs, 4000);
  });

  test("inserts only the overflow, not the whole line", () => {
    // 3000ms of speech in a 2000ms gap needs 1000 more — and stretch would have
    // held the frame for the full 3000. That difference is the whole point.
    const r = buildFlowRetime([{ t: 0, durationMs: 3000 }, { t: 2000, durationMs: 500 }], 5000, {
      breathMs: 0,
    });
    assert.equal(r.changed, true);
    assert.equal(r.endMs, 6000);
    assert.equal(r.map(2000), 3000, "the next line starts once the first has finished");
  });

  test("leaves everything before the overflow exactly where it was", () => {
    const r = buildFlowRetime([{ t: 1000, durationMs: 3000 }], 5000, { breathMs: 0 });
    // The picture up to the deficit is untouched: it keeps its own pace.
    for (const t of [0, 250, 500, 999]) assert.equal(r.map(t), t);
  });

  test("counts the breath between lines but not after the last", () => {
    const withNext = buildFlowRetime([{ t: 0, durationMs: 1000 }, { t: 1000, durationMs: 100 }], 5000, {
      breathMs: 300,
    });
    assert.equal(withNext.map(1000), 1300, "300ms of silence before the next line");
    const alone = buildFlowRetime([{ t: 0, durationMs: 1000 }], 1000, { breathMs: 300 });
    assert.equal(alone.endMs, 1000, "no breath owed after the final line");
  });

  test("extends the end for a line that would run past it", () => {
    const r = buildFlowRetime([{ t: 4000, durationMs: 2000 }], 5000, { breathMs: 0 });
    assert.equal(r.endMs, 6000);
  });

  test("is monotonic", () => {
    const r = buildFlowRetime(
      [{ t: 0, durationMs: 2500 }, { t: 1000, durationMs: 2500 }, { t: 3000, durationMs: 900 }],
      5000,
      { breathMs: 200 },
    );
    let prev = -1;
    for (let t = 0; t <= 5000; t += 25) {
      const v = r.map(t);
      assert.ok(v >= prev, `map(${t}) = ${v} went backwards from ${prev}`);
      prev = v;
    }
  });

  test("flow never stretches more than stretch would", () => {
    const lines = [{ t: 0, durationMs: 4000 }, { t: 1000, durationMs: 4000 }];
    const flow = buildFlowRetime(lines, 6000, { breathMs: 200 });
    const stretch = buildAudioRetime([0, 1000, 2000, 3000, 6000], lines, 6000, { breathMs: 200 });
    assert.ok(
      flow.endMs <= stretch.endMs,
      `flow ${flow.endMs} should not exceed stretch ${stretch.endMs}`,
    );
  });
});

describe("withIdleMotion", () => {
  const cfg = { viewport: { w: 1000, h: 500 }, padding: 3.2, minCropFraction: 0.62, transitionMs: 480 };
  const full = { t: 0, rect: { x: 0, y: 0, w: 1000, h: 500 } };

  test("drifts through a long static stretch", () => {
    const out = withIdleMotion([full], [0, 12000], 12000, { afterMs: 1800, scale: 0.94 });
    assert.equal(out.length, 2);
    const drift = out[1]!;
    assert.equal(drift.t, 1800, "starts once the stretch has proved itself idle");
    assert.ok(drift.rect.w < 1000, "the crop shrinks, which reads as pushing in");
    assert.equal(drift.ms, 10200, "eased across the whole remaining silence");
  });

  test("leaves a stretch alone if it is shorter than the threshold", () => {
    const out = withIdleMotion([full], [0, 1000, 2000], 2000, { afterMs: 1800, scale: 0.94 });
    assert.deepEqual(out, [full]);
  });

  test("keeps the drift centred on what the camera was showing", () => {
    const out = withIdleMotion([full], [0, 9000], 9000, { afterMs: 1000, scale: 0.9 });
    const r = out[1]!.rect;
    assert.equal(r.x + r.w / 2, 500);
    assert.equal(r.y + r.h / 2, 250);
  });

  test("does not drift through a stretch the author already directed", () => {
    // A keyframe inside the window means the camera is already moving; adding a
    // drift would fight the direction that was asked for.
    const directed = [full, { t: 4000, rect: { x: 100, y: 100, w: 400, h: 200 } }];
    const out = withIdleMotion(directed, [0, 9000], 9000, { afterMs: 1000, scale: 0.9 });
    assert.deepEqual(out, directed);
  });

  test("is off for a scale that would do nothing or invert the frame", () => {
    for (const scale of [1, 1.2, 0, -0.5]) {
      assert.deepEqual(withIdleMotion([full], [0, 9000], 9000, { afterMs: 1000, scale }), [full]);
    }
  });

  test("stays sorted, so sampling still walks forward", () => {
    const keys = [full, { t: 20000, rect: { x: 0, y: 0, w: 200, h: 100 } }];
    const out = withIdleMotion(keys, [0, 9000, 20000, 34000], 34000, { afterMs: 1200, scale: 0.94 });
    for (let i = 1; i < out.length; i++) assert.ok(out[i]!.t >= out[i - 1]!.t);
  });

  void cfg;
});
