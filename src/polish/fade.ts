/**
 * Fades — the difference between ten films and one.
 *
 * Reel's own tour is ten chapters, each rendered separately and joined with a
 * stream copy. That copy is the point: the picture that was rendered and
 * verified is bit-for-bit the picture that ships. An `xfade` between the files
 * would re-encode both sides of every join and throw that away.
 *
 * So the fade lives *inside* each chapter instead. A chapter that ramps up from
 * black and back down to it concatenates, with no re-encode, into a film that
 * dissolves between its parts. The join is free because it was never a join.
 *
 * Composited over the finished canvas rather than the app view, deliberately:
 * a fade is the *film* going dark, so the device frame and the background go
 * with it. Fading only the content would read as the app dimming inside a
 * window that stayed lit.
 */

export type FadeKind = "in" | "out" | "dip";

export interface FadeCue {
  /** ms since recording start. */
  from: number;
  to: number;
  /** What the picture fades to. Usually the spec's own background. */
  color: string;
  kind: FadeKind;
}

/**
 * How opaque the fade colour is at `t`, 0–1.
 *
 * Linear rather than eased. A fade is judged by its *timing*, and an eased
 * ramp spends so long near full black that a 400ms dip reads as 250ms — which
 * is the sort of thing you fix by fighting the number instead of the curve.
 */
export function fadeAt(cues: FadeCue[], t: number): { color: string; alpha: number } | null {
  let best: { color: string; alpha: number } | null = null;
  for (const cue of cues) {
    const span = cue.to - cue.from;
    if (span <= 0) continue;

    // Outside the window a fade *holds*, it does not reset. A fade-out that
    // stopped applying past its end let the picture pop back on the very last
    // frame, because the encoder holds a closing tail past the demo's own
    // duration — invisible in every measurement except the final frame.
    let alpha: number;
    if (cue.kind === "dip") {
      if (t < cue.from || t > cue.to) continue;
      // A dip goes all the way down and back up inside its own window.
      alpha = 1 - Math.abs((t - cue.from) / span - 0.5) * 2;
    } else if (cue.kind === "out") {
      if (t <= cue.from) continue;
      alpha = t >= cue.to ? 1 : (t - cue.from) / span;
    } else {
      if (t >= cue.to) continue;
      alpha = t <= cue.from ? 1 : 1 - (t - cue.from) / span;
    }

    // Overlapping fades: the darkest wins, so a dip that runs into a closing
    // fade-out never brightens in the middle of going dark.
    if (!best || alpha > best.alpha) best = { color: cue.color, alpha };
  }
  return best && best.alpha > 0.001 ? best : null;
}

/**
 * The fades a spec's own `polish` asks for at the ends of the film.
 *
 * Separate from the `transition:` steps an author places, because these are a
 * property of the whole recording rather than a moment in it — and because
 * they are what a chapter needs to sit next to another chapter.
 */
export function endFades(
  opts: { fadeIn?: number; fadeOut?: number; color: string },
  endMs: number,
): FadeCue[] {
  const out: FadeCue[] = [];
  if (opts.fadeIn && opts.fadeIn > 0) {
    out.push({ from: 0, to: Math.min(opts.fadeIn, endMs), color: opts.color, kind: "in" });
  }
  if (opts.fadeOut && opts.fadeOut > 0) {
    // Clamped so a fade-out longer than the demo does not start before it.
    const start = Math.max(0, endMs - opts.fadeOut);
    out.push({ from: start, to: endMs, color: opts.color, kind: "out" });
  }
  return out;
}

/**
 * A solid colour to dip to, given whatever `polish.background` holds.
 *
 * `background` may be a CSS gradient, and a gradient is not a valid SVG `fill`
 * — librsvg quietly falls back to black, so the fade worked by accident and
 * would have kept working right up until somebody set a solid background and
 * wondered why it dipped to the wrong colour. The first colour of a gradient is
 * the honest answer: the film dissolves into its own backdrop rather than to an
 * unrelated black.
 */
export function dipColor(background: string): string {
  if (!background.includes("gradient")) return background;
  const first = background.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)/);
  return first ? first[0] : "#000000";
}

/** A full-frame wash of colour, as an SVG the renderer composites. */
export function fadeSvg(fade: { color: string; alpha: number }, w: number, h: number): string {
  return (
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${w}" height="${h}" fill="${escapeXml(fade.color)}" ` +
    `fill-opacity="${fade.alpha.toFixed(4)}"/></svg>`
  );
}

function escapeXml(s: string): string {
  return s.replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!,
  );
}
