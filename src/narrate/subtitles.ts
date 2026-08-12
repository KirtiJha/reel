import { writeFile } from "node:fs/promises";

/** A subtitle cue: display `text` from `start` to `end` (ms). */
export interface Cue {
  start: number;
  end: number;
  text: string;
}

/**
 * Turn the recorded caption timeline into non-overlapping cues. Each caption
 * runs from its timestamp until the next one (or the end of the recording).
 */
export function buildCues(captions: { t: number; text: string }[], endMs: number): Cue[] {
  const sorted = captions.filter((c) => c.text.trim()).sort((a, b) => a.t - b.t);
  const cues: Cue[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = Math.max(0, sorted[i]!.t);
    const next = sorted[i + 1]?.t ?? endMs;
    const end = Math.max(start + 800, Math.min(next, endMs));
    cues.push({ start, end, text: sorted[i]!.text.trim() });
  }
  return cues;
}

function stamp(ms: number, sep: "," | "."): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const millis = t % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(millis, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\n${c.text}\n`)
    .join("\n");
}

export function toVtt(cues: Cue[]): string {
  return (
    "WEBVTT\n\n" +
    cues.map((c) => `${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${c.text}\n`).join("\n")
  );
}

/** Write both .srt and .vtt for a cue list at the given path base (no extension). */
export async function writeSubtitles(base: string, cues: Cue[]): Promise<string[]> {
  const srt = `${base}.srt`;
  const vtt = `${base}.vtt`;
  await writeFile(srt, toSrt(cues), "utf8");
  await writeFile(vtt, toVtt(cues), "utf8");
  return [srt, vtt];
}
