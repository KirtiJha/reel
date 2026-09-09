/**
 * Reading `STORYBOARD.md` back.
 *
 * ## Why a parser at all
 *
 * `reel compose` used to be write-only: it generated the storyboard and never
 * looked at it again, and it built `index.html` from the array of scenes it
 * happened to have in memory. Two things follow from that, and both are why the
 * authoring pass did not exist.
 *
 * The first is that re-running `compose` overwrote every scene file, so any
 * scene somebody had actually authored was destroyed by the next command that
 * touched the project. The second is that there was no way to rebuild the host
 * *without* re-running compose — so after editing a scene there was no step that
 * could re-derive the running order and the seams.
 *
 * Parsing the storyboard fixes both, because it makes the file the contract
 * rather than a report. `assemble` reads it to rebuild `index.html`; `packets`
 * reads it to cut one bounded brief per scene; `compose` reads it to refuse to
 * clobber work it did not write.
 *
 * ## Lenient, deliberately
 *
 * Their parser "never throws and records anything surprising as a warning", and
 * this one behaves the same way. A storyboard is edited by hand between every
 * step of the loop; a parser that rejects the file over a stray bullet would
 * make the format hostile to the one thing it exists for.
 */

/** Their ladder: an outline, a built scaffold, an authored scene. */
export type FrameStatus = "outline" | "built" | "animated";

const STATUSES: FrameStatus[] = ["outline", "built", "animated"];

export interface StoryboardFrame {
  /** 1-based, as the headings number them. */
  index: number;
  title: string;
  status: FrameStatus;
  /** Project-relative path to the scene's HTML. */
  src?: string;
  /** Seconds. */
  duration?: number;
  transitionIn?: string;
  scene?: string;
  voiceover?: string;
  poster?: number;
  /** Markdown below the metadata bullets. */
  narrative: string;
  /** Keys the format does not name, kept verbatim. */
  extra: Record<string, string>;
}

export interface StoryboardGlobals {
  format?: string;
  duration?: string;
  message?: string;
  arc?: string;
  audience?: string;
  mode?: string;
  extra: Record<string, string>;
}

export interface Storyboard {
  globals: StoryboardGlobals;
  frames: StoryboardFrame[];
  warnings: { message: string; line?: number; frameIndex?: number }[];
}

/** Aliases their format accepts, mapped onto the canonical key. */
const ALIAS: Record<string, string> = {
  transition: "transition_in",
  description: "scene",
  summary: "scene",
  caption: "scene",
  vo: "voiceover",
  voice_over: "voiceover",
  narration: "voiceover",
};

const GLOBAL_KEYS = new Set(["format", "duration", "message", "arc", "audience", "mode"]);

/** `Frame`, `Beat` and `Scene` are all accepted, at H2 or H3. */
const HEADING = /^(#{2,3})\s+(?:Frame|Beat|Scene)\s+(\d+)\s*(?:[—–-]\s*(.*))?$/i;
const BULLET = /^\s*[-*]\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/;

export function parseStoryboard(src: string): Storyboard {
  const warnings: Storyboard["warnings"] = [];
  const lines = src.split(/\r?\n/);

  // --- frontmatter --------------------------------------------------------
  const globals: StoryboardGlobals = { extra: {} };
  let i = 0;
  if (lines[0]?.trim() === "---") {
    i = 1;
    for (; i < lines.length && lines[i]?.trim() !== "---"; i++) {
      const line = lines[i]!;
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      const at = line.indexOf(":");
      if (at < 0) {
        warnings.push({ message: `Frontmatter line is not a key: ${line.trim()}`, line: i + 1 });
        continue;
      }
      const key = line.slice(0, at).trim();
      const value = unquote(line.slice(at + 1).trim());
      if (GLOBAL_KEYS.has(key)) (globals as unknown as Record<string, string>)[key] = value;
      else globals.extra[key] = value;
    }
    if (i >= lines.length) {
      warnings.push({ message: "Frontmatter is never closed; read it as far as it went.", line: 1 });
    }
    i++;
  }

  // --- frames -------------------------------------------------------------
  const frames: StoryboardFrame[] = [];
  let current: StoryboardFrame | null = null;
  let narrative: string[] = [];
  // Bullets only count while they are still the metadata block. Once prose has
  // started, a `- key: value` line is prose — a list in the narrative should not
  // silently become a field.
  let inMeta = false;

  const close = (): void => {
    if (!current) return;
    current.narrative = narrative.join("\n").trim();
    frames.push(current);
    narrative = [];
  };

  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const heading = HEADING.exec(line.trim());
    if (heading) {
      close();
      current = {
        index: Number(heading[2]),
        title: (heading[3] ?? "").trim(),
        status: "outline",
        narrative: "",
        extra: {},
      };
      inMeta = true;
      continue;
    }
    if (!current) continue;

    const bullet = inMeta ? BULLET.exec(line) : null;
    if (bullet) {
      const raw = bullet[1]!.toLowerCase().replace(/-/g, "_");
      const key = ALIAS[raw] ?? raw;
      assign(current, key, unquote(bullet[2]!.trim()), warnings, i + 1);
      continue;
    }
    if (line.trim() !== "") inMeta = false;
    narrative.push(line);
  }
  close();

  for (const [n, f] of frames.entries()) {
    if (f.index !== n + 1) {
      warnings.push({
        message: `Frame headings are out of order: frame ${n + 1} is numbered ${f.index}.`,
        frameIndex: n + 1,
      });
    }
  }
  return { globals, frames, warnings };
}

function assign(
  frame: StoryboardFrame,
  key: string,
  value: string,
  warnings: Storyboard["warnings"],
  line: number,
): void {
  switch (key) {
    case "status":
      if (isStatus(value)) frame.status = value;
      else {
        warnings.push({ message: `Unknown status "${value}"; read it as outline.`, line });
      }
      return;
    case "src":
      frame.src = value;
      return;
    case "duration": {
      const n = seconds(value);
      if (n === undefined) warnings.push({ message: `Unreadable duration "${value}".`, line });
      else frame.duration = n;
      return;
    }
    case "poster": {
      const n = seconds(value);
      if (n === undefined) warnings.push({ message: `Unreadable poster "${value}".`, line });
      else frame.poster = n;
      return;
    }
    case "transition_in":
      frame.transitionIn = value;
      return;
    case "scene":
      frame.scene = value;
      return;
    case "voiceover":
      frame.voiceover = value;
      return;
    default:
      // Their rule: unknown keys are kept, not dropped. A workflow carries its
      // own per-frame data here, and this one carries the shot facts.
      frame.extra[key] = value;
  }
}

export function isStatus(s: string): s is FrameStatus {
  return (STATUSES as string[]).includes(s);
}

/** `4s`, `4`, `4.25s` — all seconds. */
function seconds(v: string): number | undefined {
  const n = Number(/^\s*(-?[\d.]+)\s*s?\s*$/i.exec(v)?.[1]);
  return Number.isFinite(n) ? n : undefined;
}

function unquote(v: string): string {
  const m = /^(['"])(.*)\1$/.exec(v);
  return m ? m[2]! : v;
}

/**
 * Rewrite one frame's `status:` bullet in place.
 *
 * A whole-file regeneration would lose everything an author added — the shot
 * sequence, the narrative, the direction block — which is the entire value of
 * the storyboard after the first pass. So this edits the one line.
 */
export function setStatus(src: string, frameIndex: number, status: FrameStatus): string {
  const lines = src.split(/\r?\n/);
  let n = 0;
  let inFrame = false;
  let inMeta = false;
  let lastMeta = -1;
  let headingAt = -1;

  for (let i = 0; i < lines.length; i++) {
    const heading = HEADING.exec(lines[i]!.trim());
    if (heading) {
      if (inFrame) break;
      n++;
      inFrame = n === frameIndex;
      inMeta = inFrame;
      if (inFrame) headingAt = i;
      continue;
    }
    if (!inFrame) continue;
    const bullet = inMeta ? BULLET.exec(lines[i]!) : null;
    if (bullet) {
      lastMeta = i;
      if (bullet[1]!.toLowerCase() === "status") {
        lines[i] = lines[i]!.replace(/(:\s*).*$/, `$1${status}`);
        return lines.join("\n");
      }
      continue;
    }
    if (lines[i]!.trim() !== "") inMeta = false;
  }
  if (headingAt < 0) return src;
  // No status bullet to rewrite: add one at the end of the metadata block, or
  // straight after the heading when the frame has no metadata at all.
  lines.splice(lastMeta >= 0 ? lastMeta + 1 : headingAt + 1, 0, `- status: ${status}`);
  return lines.join("\n");
}
