"use client";
import { useCallback, useEffect, useState } from "react";

export interface Shot {
  src: string;
  title: string;
  blurb: string;
}

/**
 * An auto-advancing screenshot carousel.
 *
 * The track is moved with a transform rather than by scrolling. A scroll-based
 * track has to reconcile two sources of truth — the element's scrollLeft and
 * React state — and a smooth programmatic scroll emits events the whole way
 * across, so reading the position mid-flight reports the slide being left and
 * cancels the advance that started it. One transform driven by one piece of
 * state has no such race.
 *
 * Movement a reader cannot stop is hostile, so it pauses on pointer-over,
 * keyboard focus and background tabs, and never auto-advances for readers who
 * asked for reduced motion. Arrows and dots work regardless, so the animation
 * is a convenience rather than the only way through.
 */
export function Carousel({ shots, intervalMs = 5000 }: { shots: Shot[]; intervalMs?: number }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  const go = useCallback(
    (next: number) => {
      const n = shots.length;
      setIndex(((next % n) + n) % n);
    },
    [shots.length],
  );

  useEffect(() => {
    if (paused || shots.length < 2) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => go(index + 1), intervalMs);
    return () => window.clearInterval(id);
  }, [paused, index, intervalMs, go, shots.length]);

  // A background tab should not keep animating.
  useEffect(() => {
    const onVis = () => setPaused(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const current = shots[index]!;

  return (
    <div
      className="relative"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") go(index - 1);
        if (e.key === "ArrowRight") go(index + 1);
      }}
      role="group"
      aria-roledescription="carousel"
      aria-label="Reel Studio screenshots"
    >
      <div className="overflow-hidden rounded-[20px] border border-line bg-panel shadow-panel">
        <div
          className="flex transition-transform duration-500 ease-out motion-reduce:transition-none"
          style={{ transform: `translateX(-${index * 100}%)` }}
        >
          {shots.map((s, i) => (
            <div key={s.src} className="w-full flex-none" aria-hidden={i !== index}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className="block w-full"
                alt={s.title}
                src={s.src}
                loading={i === 0 ? "eager" : "lazy"}
                draggable={false}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Arrows sit outside the frame on wide screens so they never cover the
          UI being shown, and tuck back inside when there is no room. */}
      <button
        onClick={() => go(index - 1)}
        aria-label="Previous screenshot"
        className="absolute left-3 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full border border-line2 bg-bg/80 text-[18px] text-ink backdrop-blur transition hover:border-brand hover:bg-panel min-[1340px]:-left-14"
      >
        ‹
      </button>
      <button
        onClick={() => go(index + 1)}
        aria-label="Next screenshot"
        className="absolute right-3 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full border border-line2 bg-bg/80 text-[18px] text-ink backdrop-blur transition hover:border-brand hover:bg-panel min-[1340px]:-right-14"
      >
        ›
      </button>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 className="text-[16px] font-semibold">{current.title}</h3>
          <p className="mt-1 text-[14px] text-muted">{current.blurb}</p>
        </div>
        <div className="flex items-center gap-2">
          {shots.map((s, i) => (
            <button
              key={s.src}
              onClick={() => go(i)}
              aria-label={`Show ${s.title}`}
              aria-current={i === index}
              className={`h-1.5 rounded-full transition-all ${
                i === index ? "w-7 bg-brand2" : "w-1.5 bg-line2 hover:bg-muted"
              }`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
