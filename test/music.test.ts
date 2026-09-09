import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderMusic } from "../src/compose/music.js";
import { SFX_SAMPLE_RATE } from "../src/encode/sfx.js";

/** Mean absolute level, as a rough loudness. */
function rms(x: Float32Array): number {
  let n = 0;
  for (const v of x) n += v * v;
  return Math.sqrt(n / Math.max(1, x.length));
}

/**
 * How much of the signal survives a crude one-pole high-pass.
 *
 * Not a real filter, but enough to answer the question that matters: is there
 * anything above the bass at all? The first version of this bed put every
 * partial under 200Hz, which a spectrogram showed as a single band along the
 * bottom — inaudible on a laptop speaker and gone entirely on a phone.
 */
function highBandRatio(x: Float32Array): number {
  const out = new Float32Array(x.length);
  let prev = 0;
  const a = 0.97;
  for (let i = 1; i < x.length; i++) {
    out[i] = a * (out[i - 1]! + x[i]! - prev);
    prev = x[i]!;
  }
  return rms(out) / Math.max(1e-9, rms(x));
}

describe("renderMusic", () => {
  test("renders exactly the length asked for", () => {
    const bed = renderMusic(3000);
    assert.equal(bed.length, 3 * SFX_SAMPLE_RATE);
  });

  test("a zero-length film gets an empty bed rather than a crash", () => {
    assert.equal(renderMusic(0).length, 0);
  });

  test("stays well inside full scale, because it plays under a voice", () => {
    const bed = renderMusic(20_000);
    let peak = 0;
    for (const v of bed) peak = Math.max(peak, Math.abs(v));
    assert.ok(peak < 0.85, `peaked at ${peak.toFixed(3)}`);
    assert.ok(rms(bed) > 0.01, "a bed nobody can hear is not a bed");
    assert.ok(rms(bed) < 0.2, "loud enough to compete with narration");
  });

  test("carries real midrange, not just bass", () => {
    // The bug this pins: a pad voiced around a 110Hz root has no energy a small
    // speaker can reproduce, and sounds like a rumble or like nothing.
    const bed = renderMusic(20_000);
    assert.ok(highBandRatio(bed) > 0.1, "almost all the energy is in the bass");
  });

  test("fades in and out rather than starting and stopping", () => {
    const bed = renderMusic(20_000);
    const head = bed.slice(0, 200);
    const tail = bed.slice(bed.length - 200);
    const middle = bed.slice(bed.length / 2, bed.length / 2 + 4000);
    assert.ok(rms(head) < rms(middle) * 0.5, "the bed starts abruptly");
    assert.ok(rms(tail) < rms(middle) * 0.5, "the bed stops abruptly");
  });

  test("is a pure function of time, so two renders are the same bed", () => {
    // The whole render is reproducible; the music cannot be the exception.
    const a = renderMusic(5000);
    const b = renderMusic(5000);
    assert.deepEqual(Array.from(a.slice(0, 5000)), Array.from(b.slice(0, 5000)));
  });

  test("keeps moving — a held chord for the whole film is a test tone", () => {
    // Sampled either side of a chord change; they should not be identical.
    const bed = renderMusic(20_000);
    const early = bed.slice(2 * SFX_SAMPLE_RATE, 2 * SFX_SAMPLE_RATE + 1000);
    const later = bed.slice(12 * SFX_SAMPLE_RATE, 12 * SFX_SAMPLE_RATE + 1000);
    assert.notDeepEqual(Array.from(early), Array.from(later));
  });
});
