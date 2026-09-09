import type { Look } from "../scene/looks.js";
import type { ShotManifest } from "../shoot/manifest.js";

/**
 * Time-coded shot sequences — the unit an author actually builds against.
 *
 * ## The failure this exists to prevent
 *
 * A scene brief that says *"Real footage of TaskFlow; 3 lower thirds, 3 beats"*
 * tells an author what the scene **is** and nothing about how it develops over
 * fifteen seconds. What comes back is a picture: everything on screen inside the
 * first quarter, then nothing. HyperFrames names that failure precisely — it is
 * what reads as PowerPoint — and their fix is not advice but a change of unit.
 * A frame's visual layer is *"a sequence of time windows paced to the voiceover,
 * not a bag of effect tags"*, and writing it that way makes front-loading
 * impossible, because every window is a phase somebody has to fill.
 *
 * ## Why Reel can derive the windows and they cannot
 *
 * In their loop a person writes the sequence, because nothing knows where the
 * beats are. Reel does: the driver caused every moment in the film and wrote
 * down when. So the window boundaries are not a creative decision here, they
 * are arithmetic over recorded fact — each spoken cue opens a window, and the
 * beats and sounds that land inside it are known exactly.
 *
 * What goes *in* each window — what is on screen, what moves, where it sits —
 * is the creative decision, and stays the author's. So this file writes the
 * skeleton and marks the direction `TODO` in each window, which is both honest
 * and checkable: `reel status` can see a scene claiming to be authored while
 * its direction is still unwritten.
 */

/** One phase of a shot: a window of time, and what the driver recorded in it. */
export interface ShotWindow {
  from: number;
  to: number;
  /** What is being said or claimed as the window opens. */
  cue?: string;
  beats: { t: number; label: string }[];
  sfx: { t: number; kind: string; ms?: number }[];
}

/**
 * Shorter than this and a window is a twitch, not a phase.
 *
 * Reel's captions can land a second apart, and one window each would produce a
 * sequence nobody can direct — the point of a phase is that it is long enough
 * to hold an idea.
 */
const MIN_WINDOW = 1.5;

/**
 * Cut a shot into phases at its spoken cues.
 *
 * Narration first, captions second: their rule is that reveals are paced *to
 * the voiceover*, so where a line is actually spoken beats where a caption was
 * scheduled. When a demo is silent the captions are the closest thing to a
 * spoken cue it has, and are the honest substitute.
 */
export function shotWindows(shot: ShotManifest): ShotWindow[] {
  const cues = (shot.narration.length > 0 ? shot.narration : shot.captions)
    .map((c) => ({ t: Math.max(0, c.t), text: c.text }))
    .sort((a, b) => a.t - b.t);

  // Every cue opens a window; one that would open too soon after the last is
  // folded into it rather than becoming a phase of its own.
  const starts: { t: number; text?: string }[] = [{ t: 0 }];
  for (const c of cues) {
    const last = starts[starts.length - 1]!;
    if (c.t - last.t < MIN_WINDOW) {
      // The first cue at or near zero names the opening window rather than
      // being dropped — otherwise the shot opens with no cue at all.
      if (last.text === undefined) last.text = c.text;
      continue;
    }
    if (shot.duration - c.t < MIN_WINDOW) continue; // no room left for a phase
    starts.push({ t: Number(c.t.toFixed(2)), text: c.text });
  }

  return starts.map((s, i) => {
    const to = Number((starts[i + 1]?.t ?? shot.duration).toFixed(2));
    return {
      from: s.t,
      to,
      ...(s.text === undefined ? {} : { cue: s.text }),
      beats: shot.beats.filter((b) => b.t >= s.t && b.t < to),
      sfx: shot.sfx.filter((c) => c.t >= s.t && c.t < to),
    };
  });
}

/**
 * A card has no recorded cues, so its phases come from its shape.
 *
 * Not an arbitrary split: their rule is that a shot arrives, develops, and then
 * **ends on a held read** — *"prefer stillness to bad motion"*. Three windows
 * say that structurally. A card too short to hold three gets two, because the
 * final reveal and the hold are then the same window, which is their rule too.
 */
export function cardWindows(duration: number): ShotWindow[] {
  const at = (f: number): number => Number((duration * f).toFixed(2));
  const cuts = duration >= 3 ? [0, at(0.28), at(0.62)] : [0, at(0.4)];
  return cuts.map((from, i) => ({
    from,
    to: Number((cuts[i + 1] ?? duration).toFixed(2)),
    beats: [],
    sfx: [],
  }));
}

/** What each card window is for, so the skeleton is not three blank slots. */
const CARD_INTENT = [
  "the arrival — only the one element the scene opens on",
  "the development — the next piece lands, and the ground keeps moving",
  "the held read — content resolved, still; a held read beats bad motion",
];

/**
 * Render the windows as the Scene lines an author fills in.
 *
 * Their shape: `Scene N (from–to): what is on screen, what moves, where it
 * sits`. What Reel can state is the recorded half — the cue, the beats, the
 * sounds. The direction is left as an explicit `TODO` rather than guessed at,
 * because a plausible-sounding line nobody wrote is worse than a blank: it
 * reads as a decision and gets built.
 */
export function renderSequence(windows: ShotWindow[], kind: "shot" | "card"): string {
  return windows
    .map((w, i) => {
      const facts: string[] = [];
      if (w.cue) facts.push(`cue: “${w.cue}”`);
      for (const b of w.beats) facts.push(`beat \`${b.label}\` at ${b.t.toFixed(2)}s`);
      const sounds = w.sfx.map((s) =>
        s.ms === undefined ? `${s.kind} at ${s.t.toFixed(2)}s` : `${s.kind} ${s.t.toFixed(2)}–${(s.t + s.ms).toFixed(2)}s`,
      );
      if (sounds.length > 0) facts.push(sounds.join(", "));
      if (kind === "card") facts.push(CARD_INTENT[Math.min(i, CARD_INTENT.length - 1)]!);
      const last = i === windows.length - 1;
      const todo = last
        ? "TODO — what has resolved, and what holds still."
        : "TODO — what is on screen, what moves, and where it sits.";
      return `Scene ${i + 1} (${w.from.toFixed(2)}–${w.to.toFixed(2)}s): ${facts.join(" · ")}${facts.length ? ". " : ""}${todo}`;
    })
    .join("\n");
}

/** True when a block still carries an unwritten direction line. */
export function hasTodo(s: string): boolean {
  return /^\s*Scene \d+ \([\d.]+–[\d.]+s\):.*\bTODO\b/m.test(s);
}

/** How many direction lines in a block are still unwritten. */
export function countTodo(s: string): number {
  return (s.match(/^\s*Scene \d+ \([\d.]+–[\d.]+s\):.*\bTODO\b/gm) ?? []).length;
}

/**
 * `## Video direction` — the invariants, written once.
 *
 * Their block, and their reason for it being one block rather than a paragraph
 * per frame: *"it is what binds many independent shots into one film"*. Scenes
 * are authored in parallel by people who cannot see each other's work, so
 * anything true of the whole film has to be stated somewhere all of them read —
 * and restating it per frame is the bloat this layer exists to prevent.
 *
 * Reel can write a real one rather than a placeholder, because the look already
 * decided the palette and the motion grammar is the composition contract.
 */
export function videoDirection(look: Look, accent: string): string {
  return `## Video direction

Written once. Every scene inherits this; a scene's own Scene lines carry only
what is different about that scene.

- **Palette** — ground \`${look.ground}\`, ink \`${look.ink}\`, muted
  \`${look.muted}\`, accent \`${accent}\`. The accent is the brand's and every
  backdrop is built out of it. Ground and ink belong to the look; do not edit
  them per scene, and pull every token from \`frame.md\` by role rather than
  naming a colour.
- **Motion grammar** — long-tail eases, \`power4.out\` by default; smooth over
  bouncy. Arrivals are **binary**: a word is revealed with a zero-duration
  \`set\` and whipped into place in 0.13–0.20s, never faded. A backdrop moves
  for its scene's whole life.
- **Reveal model** — pace every reveal to its cue. At the top of a scene show
  only what the cue is saying then; reveal each further piece as the shot
  reaches it, across the back half as much as the front. This is the one rule
  that stops a scene reading as a slide.
- **Held reads are deliberate.** A scene that has resolved and now holds still
  is right, often at a chapter or a close. Prefer stillness to bad motion. What
  is banned is *front-loaded then frozen* — everything dumped by the first
  quarter and nothing after.
- **Seams belong to \`index.html\`.** No scene animates its own exit; the
  transition is the exit. Only the final scene resolves on screen.
- **Never appears** — text floated over moving footage (it collides; use the
  bottom band), footage cropped to fill the frame, browser chrome or a real
  cursor, decorative shapes standing in for a real asset, and both motion
  failure modes: the slideshow (front-load then freeze) and the screensaver
  (everything drifting independently of any cue).
`;
}
