import { join, dirname, basename, extname } from "node:path";
import { buildCues, writeSubtitles } from "./subtitles.js";
import { translateCues } from "./translate.js";
import { loadLlmConfig, type LlmConfig } from "../ai/llm.js";
import { log } from "../util/log.js";

export interface NarrateInput {
  captions: { t: number; text: string }[];
  endMs: number;
  /** Resolved video output paths — used to derive the subtitle path base. */
  mp4?: string;
  webm?: string;
  /** Resolved subtitle base path (no extension), or undefined to skip sidecars. */
  subtitleBase?: string;
  languages?: string[];
  workDir: string;
}

/** Path base (dir + filename without extension) for deriving sibling outputs. */
function stripExt(p: string): string {
  return join(dirname(p), basename(p, extname(p)));
}

/**
 * Post-process narration: sidecar subtitles from the captions, plus localized
 * subtitle variants. All opt-in via the spec's output block.
 */
export async function narrate(input: NarrateInput): Promise<string[]> {
  const cues = buildCues(input.captions, input.endMs);
  const outputs: string[] = [];
  if (cues.length === 0) {
    if (input.subtitleBase) log.warn("No captions to narrate — skipping subtitles.");
    return outputs;
  }

  const videos = [input.mp4, input.webm].filter((v): v is string => Boolean(v));

  // Base-language subtitles.
  if (input.subtitleBase) {
    outputs.push(...(await writeSubtitles(input.subtitleBase, cues)));
    log.ok(`subtitles → ${input.subtitleBase}.srt / .vtt`);
  }

  // Localized variants.
  if (input.languages?.length) {
    let cfg: LlmConfig | null = null;
    try {
      cfg = loadLlmConfig();
    } catch {
      log.warn(
        "Translated subtitles need a model configured — skipping those. " +
          "Spoken language tracks are unaffected; they come from `sayIn`.",
      );
    }
    if (cfg) {
      const subBase = input.subtitleBase ?? (videos[0] ? stripExt(videos[0]) : undefined);
      for (const lang of input.languages) {
        const tcues = await translateCues(cfg, cues, lang);
        if (subBase) {
          outputs.push(...(await writeSubtitles(`${subBase}.${lang}`, tcues)));
          log.ok(`subtitles [${lang}] → ${subBase}.${lang}.srt / .vtt`);
        }
      }
    }
  }

  return outputs;
}
