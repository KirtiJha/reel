import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { storyboardFrame } from "../src/polish/render.js";

/** 30fps, a 480ms camera move — the defaults. */
const FPS = 30;
const SETTLE = 480;
const many = 10_000;

describe("which frame stands for a beat", () => {
  test("waits out the camera move rather than filming it mid-glide", () => {
    // The bug this exists for: a `hero` beat right after a navigation was
    // rendered as the tight crop the camera was leaving, because the still was
    // sampled at the instant the move began.
    const beats = [{ t: 1000 }];
    assert.equal(storyboardFrame(beats, 0, FPS, SETTLE, many), Math.round((1480 / 1000) * FPS));
  });

  test("never shows the shot belonging to the next beat", () => {
    // Beats 200ms apart: settling fully would land past the next one.
    const beats = [{ t: 1000 }, { t: 1200 }];
    const idx = storyboardFrame(beats, 0, FPS, SETTLE, many);
    assert.ok(idx < Math.round((1200 / 1000) * FPS), `landed at frame ${idx}, on the next beat`);
  });

  test("never lands before the beat it represents", () => {
    // Two beats one frame apart — the clamp must not push it backwards.
    const beats = [{ t: 1000 }, { t: 1000 + 1000 / FPS }];
    assert.ok(storyboardFrame(beats, 0, FPS, SETTLE, many) >= Math.round(FPS));
  });

  test("the last beat has the rest of the demo to settle in", () => {
    const beats = [{ t: 0 }, { t: 2000 }];
    assert.equal(storyboardFrame(beats, 1, FPS, SETTLE, many), Math.round((2480 / 1000) * FPS));
  });

  test("clamps to the frames that exist", () => {
    // A beat near the end must not index past the rendered sequence.
    assert.equal(storyboardFrame([{ t: 100_000 }], 0, FPS, SETTLE, 50), 49);
  });

  test("a beat at zero still settles", () => {
    assert.equal(storyboardFrame([{ t: 0 }], 0, FPS, SETTLE, many), Math.round((480 / 1000) * FPS));
  });
});
