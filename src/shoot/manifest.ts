/**
 * The shot manifest — what Reel hands to a composition.
 *
 * ## Why this file is the whole point
 *
 * HyperFrames renders HTML to video, and it is very good at it. What it has no
 * way to produce is *footage of a real product doing a real thing*: its own
 * `capture` reads a website's design — screenshots, tokens, fonts — so an agent
 * can rebuild it, which is a different job from driving an app through a flow
 * and filming what happened.
 *
 * Reel does exactly that job, and always has. So the two fit together the
 * obvious way: Reel shoots the footage, HyperFrames cuts the film. This
 * manifest is the seam.
 *
 * A bare `.mp4` would be a poor seam. A composition needs to *time* things
 * against the footage — a lower third when the user clicks Add, a punch-in on
 * the moment the list updates, a chapter card between two sections — and
 * without a manifest an author is left scrubbing an mp4 and guessing at
 * timestamps. The driver already knows every one of those moments, because it
 * caused them. Writing them down costs nothing and is the difference between
 * footage you can edit and footage you can only play.
 */

/** A moment the demo named — a `beat:` step, or a scene's title. */
export interface ShotBeat {
  label: string;
  /** Seconds from the start of the footage. */
  t: number;
}

/** What the demo claimed at a given moment. */
export interface ShotCaption {
  t: number;
  text: string;
}

export interface ShotManifest {
  /** Schema version, so a composition can refuse a manifest it cannot read. */
  version: 1;
  /** The spec this came from, for the trail back. */
  spec: string;
  /** Human name from the spec — a reasonable default for the title card. */
  name: string;
  /** The footage, relative to the manifest file. */
  footage: string;
  width: number;
  height: number;
  fps: number;
  /** Seconds. Floating point, because a composition times in seconds. */
  duration: number;
  /**
   * Named moments, in order.
   *
   * These are what a composition should cut against. A punch-in that lands on a
   * beat reads as direction; the same punch-in two hundred milliseconds late
   * reads as a mistake, and there is no way to tell the difference by eye
   * afterwards.
   */
  beats: ShotBeat[];
  /**
   * What the demo said, and when.
   *
   * Not burned into the footage — deliberately. A caption baked into a frame
   * cannot be restyled, retimed, translated or removed, and the composition is
   * the layer that should own all four. Reel shoots them as data instead.
   */
  captions: ShotCaption[];
}

/** Round to milliseconds — a manifest is read by people as well as by code. */
export function seconds(ms: number): number {
  return Math.round(ms) / 1000;
}

/**
 * Build a manifest from what the driver already recorded.
 *
 * Everything here is a fact the drive produced rather than a re-derivation of
 * the spec: re-deriving would mean the manifest could disagree with the
 * footage, which is the one thing it must never do.
 */
export function buildManifest(input: {
  spec: string;
  name: string;
  footage: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  beats: { label: string; t: number }[];
  captions: { t: number; text: string }[];
}): ShotManifest {
  return {
    version: 1,
    spec: input.spec,
    name: input.name,
    footage: input.footage,
    width: input.width,
    height: input.height,
    fps: input.fps,
    duration: seconds(input.durationMs),
    beats: input.beats.map((b) => ({ label: b.label, t: seconds(b.t) })),
    // A blank caption is how the driver takes one off screen; it is a real
    // event to the video pipeline but noise in a manifest, where a caption
    // simply runs until the next one.
    captions: input.captions
      .filter((c) => c.text.trim().length > 0)
      .map((c) => ({ t: seconds(c.t), text: c.text })),
  };
}
