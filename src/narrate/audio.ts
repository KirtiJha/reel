import { join } from "node:path";
import { probeDurationMs } from "../encode/audio.js";
import {
  synthesizeAll,
  voicePath,
  voiceKey,
  findVoiceProvider,
  VOICE_CACHE_DIR,
  type SpokenCue,
  type SpokenLine,
} from "./voice.js";
import type { AudioConfig, Voice } from "../spec/schema.js";
import { log } from "../util/log.js";
import { translateCues } from "./translate.js";
import { loadLlmConfig, type LlmConfig } from "../ai/llm.js";
import { access } from "node:fs/promises";

/**
 * From narration cues to audio files with known lengths.
 *
 * The step between "the author wrote a sentence" and "the timeline can make
 * room for it": every line is synthesized (or found in the cache), then
 * measured, because how long a sentence takes to say is not something the spec
 * can know and not something the author should have to guess.
 */

export interface AudioPlan {
  lines: SpokenLine[];
  synthesized: number;
  cached: number;
}

/** Where a spec keeps its spoken lines. Committed, so renders reproduce. */
export function voiceCacheDir(specDir: string): string {
  return join(specDir, VOICE_CACHE_DIR);
}

/**
 * The cues as they should be spoken in `lang`.
 *
 * Human-written first: `sayIn` is the copy the author reviewed. Machine
 * translation only fills the gaps, and only when a model is configured —
 * otherwise the original line stands, which is at least honest, where a
 * silently dropped line would not be.
 *
 * What happened is always said out loud. Shipping a demo whose German track is
 * quietly two-thirds English is worse than shipping no German track.
 */
export async function localizeCues(
  cues: SpokenCue[],
  lang: string,
): Promise<{ cues: SpokenCue[]; authored: number; machine: number; untranslated: number }> {
  const authoredCount = cues.filter((c) => c.alt?.[lang]).length;
  const missing = cues.filter((c) => !c.alt?.[lang]);
  if (missing.length === 0) {
    return { cues: cues.map((c) => ({ ...c, text: c.alt![lang]! })), authored: authoredCount, machine: 0, untranslated: 0 };
  }

  let translated = new Map<string, string>();
  let cfg: LlmConfig | null = null;
  try {
    cfg = loadLlmConfig();
  } catch {
    cfg = null;
  }
  if (cfg) {
    const out = await translateCues(
      cfg,
      missing.map((c) => ({ start: c.t, end: c.t, text: c.text })),
      lang,
    );
    missing.forEach((c, i) => {
      const t = out[i]?.text;
      if (t && t !== c.text) translated.set(c.text, t);
    });
  }

  const resolved = cues.map((c) => {
    const authored = c.alt?.[lang];
    if (authored) return { ...c, text: authored };
    const machine = translated.get(c.text);
    return machine ? { ...c, text: machine } : c;
  });
  return {
    cues: resolved,
    authored: authoredCount,
    machine: translated.size,
    untranslated: missing.length - translated.size,
  };
}

export async function planAudio(
  cues: SpokenCue[],
  voice: Voice,
  specDir: string,
): Promise<AudioPlan> {
  const cacheDir = voiceCacheDir(specDir);
  const { files, synthesized, cached } = await synthesizeAll(
    cues.map((c) => c.text),
    voice,
    cacheDir,
  );

  // Measured once per distinct line rather than per cue: the same sentence said
  // twice in a demo is the same file and the same length.
  const durations = new Map<string, number>();
  for (const [text, file] of files) durations.set(text, await probeDurationMs(file));

  const lines: SpokenLine[] = cues.map((c) => ({
    t: c.t,
    text: c.text,
    file: files.get(c.text)!,
    durationMs: durations.get(c.text) ?? 0,
  }));

  const totalMs = lines.reduce((n, l) => n + l.durationMs, 0);
  log.ok(
    `${lines.length} spoken lines · ${(totalMs / 1000).toFixed(1)}s of narration ` +
      `(${synthesized} synthesized, ${cached} cached)`,
  );
  return { lines, synthesized, cached };
}

/**
 * Which lines have no audio behind them yet.
 *
 * Used by `reel check`, which must not need an API key and must not be silent
 * about it: a demo that quietly ships with a third of its narration missing is
 * worse than one that refuses to render.
 */
export async function missingVoiceLines(
  cues: SpokenCue[],
  voice: Voice,
  specDir: string,
): Promise<string[]> {
  const p = findVoiceProvider(voice.provider);
  const cacheDir = voiceCacheDir(specDir);
  const missing: string[] = [];
  for (const text of new Set(cues.map((c) => c.text))) {
    const key = voiceKey(text, {
      providerId: p.id,
      baseUrl: p.baseUrl,
      apiKey: "",
      id: voice.id ?? p.defaultVoice,
      model: voice.model ?? p.defaultModel,
      style: p.steerable ? voice.style : undefined,
      speed: voice.speed,
      sslVerify: true,
    });
    try {
      await access(voicePath(cacheDir, key));
    } catch {
      missing.push(text);
    }
  }
  return missing;
}

/**
 * Whether this spec asks for a soundtrack at all.
 *
 * A music bed counts on its own. Plenty of demos want atmosphere and no
 * narrator, and requiring a spoken line before the bed is mixed would make
 * `music:` silently do nothing — the exact failure this returns false to avoid.
 */
export function audioEnabled(
  audio: AudioConfig | undefined,
  outputAudio: boolean | undefined,
  cues: SpokenCue[],
): audio is AudioConfig {
  if (!audio || outputAudio === false) return false;
  return cues.length > 0 || Boolean(audio.music);
}
