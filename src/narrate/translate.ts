import { chat, messageText, type LlmConfig } from "../ai/llm.js";
import type { Cue } from "./subtitles.js";

const LANG_NAMES: Record<string, string> = {
  es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese",
  ja: "Japanese", ko: "Korean", zh: "Chinese", hi: "Hindi", ar: "Arabic",
  nl: "Dutch", ru: "Russian", tr: "Turkish", pl: "Polish", sv: "Swedish",
};

/** Human name for a language code (falls back to the code as-is). */
export function langName(code: string): string {
  return LANG_NAMES[code.toLowerCase()] ?? code;
}

/**
 * Translate the caption text of each cue into `lang` via the LLM, preserving
 * timings. On any failure, returns the original cues unchanged.
 */
export async function translateCues(cfg: LlmConfig, cues: Cue[], lang: string): Promise<Cue[]> {
  const texts = cues.map((c) => c.text);
  const system =
    `You translate short product-demo captions into ${langName(lang)}. ` +
    "Keep each translation concise and natural for on-screen display. " +
    "Return ONLY a JSON array of the translated strings, in the same order, with no extra text.";
  const res = await chat(cfg, [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify(texts) },
  ]);
  const raw = messageText(res.message);
  const match = /\[[\s\S]*\]/.exec(raw);
  if (!match) return cues;
  try {
    const arr = JSON.parse(match[0]) as unknown[];
    if (!Array.isArray(arr) || arr.length !== cues.length) return cues;
    return cues.map((c, i) => ({ ...c, text: String(arr[i] ?? c.text) }));
  } catch {
    return cues;
  }
}
