/**
 * The demo clock.
 *
 * Frame timestamps used to come from `Date.now()`, which quietly made the
 * output a function of how fast the machine was: the same spec against the same
 * app produced a 14.8s video on one run and a 19.9s video on the next, with
 * different bytes every time. That defeats the point of committing demo media
 * from CI — every push rewrites a multi-megabyte GIF whether or not the demo
 * changed, and the diff tells a reviewer nothing.
 *
 * So the timeline is virtual. A step advances it by the duration it *declares*
 * (a beat is 1300ms because the spec says so, not because 1300ms elapsed), and
 * real waiting — letting the app settle, waiting for a selector — costs no demo
 * time at all. A slow CI runner then produces exactly the video a fast laptop
 * does.
 */
export class Timeline {
  private t = 0;

  /**
   * @param speed Playback rate for authored durations. 2 renders the demo in
   *   half the time; 0.5 slows it down. Real waits are unaffected — this paces
   *   the demo, it doesn't rush the app.
   */
  constructor(private readonly speed: number = 1) {}

  /** Current position on the demo clock (ms). */
  now(): number {
    return this.t;
  }

  /** An authored duration in demo time, after the speed multiplier. */
  scale(ms: number): number {
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    return Math.max(1, Math.round(ms / this.speed));
  }

  /** Advance by an authored duration; returns the scaled amount consumed. */
  advance(ms: number): number {
    const d = this.scale(ms);
    this.t += d;
    return d;
  }

  /** Advance by an already-scaled amount (for synthesized motion segments). */
  advanceScaled(ms: number): void {
    this.t += Math.max(0, Math.round(ms));
  }
}
