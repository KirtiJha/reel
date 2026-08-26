import type { BaseStep, Step } from "../spec/schema.js";

/**
 * What a step says out loud.
 *
 * One rule, in one place, because getting it wrong is invisible. `reel narrate`
 * under-counted a demo whose script lives in its captions, and `reel direct`
 * had nothing to match against — both because they looked only for an explicit
 * `say:` and a caption does not need one.
 *
 * The authority is the driver (`runStep`, the `caption` branch): a caption's own
 * text is spoken unless the author wrote something better for the ear, or
 * `false` to keep it silent. A card is the opposite — silent unless given a
 * line, because a title read aloud sounds like a title. Anything here that
 * disagrees with that produces a script the render does not perform.
 */
export function spokenTextOf(step: Step | BaseStep): string | undefined {
  const v = step as Record<string, unknown>;

  // A standalone line: narration with nothing on screen.
  if ("say" in v) {
    return typeof v.say === "string" ? v.say : (v.say as { text?: string } | undefined)?.text;
  }

  if ("caption" in v) {
    if (typeof v.caption === "string") return v.caption;
    const c = v.caption as { text?: string; say?: string | false };
    // `say: false` is how an author keeps one caption silent.
    if (c.say === false) return undefined;
    return c.say === undefined ? c.text : c.say;
  }

  // Silent unless spoken to: a title, a picture and a diagram all show rather
  // than tell, and narrating them by default would read their own text back.
  for (const kind of ["card", "image", "diagram"]) {
    const o = v[kind];
    if (o && typeof o === "object" && "say" in o) {
      const said = (o as { say?: string }).say;
      if (said) return said;
    }
  }
  return undefined;
}
