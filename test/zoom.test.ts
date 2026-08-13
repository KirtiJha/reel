import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ZOOM,
  resolveTimeline,
  sampleRect,
  toCrop,
  type ZoomConfig,
} from "../src/polish/zoom.js";

const cfg: ZoomConfig = { viewport: { w: 1000, h: 800 }, ...DEFAULT_ZOOM };
const aspect = cfg.viewport.w / cfg.viewport.h;

const closeTo = (a: number, b: number, eps = 0.01) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !== ${b} (±${eps})`);

describe("toCrop", () => {
  test("preserves the viewport aspect ratio so scaling never distorts", () => {
    const c = toCrop({ x: 400, y: 300, w: 120, h: 40 }, cfg);
    closeTo(c.w / c.h, aspect);
  });

  test("centers on the focused element", () => {
    const box = { x: 400, y: 300, w: 100, h: 50 };
    const c = toCrop(box, cfg);
    closeTo(c.x + c.w / 2, box.x + box.w / 2);
    closeTo(c.y + c.h / 2, box.y + box.h / 2);
  });

  test("never zooms past the configured maximum", () => {
    // A tiny element must not blow up into an unreadably upscaled crop.
    const c = toCrop({ x: 500, y: 400, w: 2, h: 2 }, cfg);
    assert.ok(c.w >= cfg.viewport.w * cfg.minCropFraction);
  });

  test("stays inside the viewport for an element at the edge", () => {
    const c = toCrop({ x: 980, y: 780, w: 20, h: 20 }, cfg);
    assert.ok(c.x >= 0 && c.y >= 0);
    assert.ok(c.x + c.w <= cfg.viewport.w + 0.01);
    assert.ok(c.y + c.h <= cfg.viewport.h + 0.01);
  });

  test("never crops larger than the viewport for a huge element", () => {
    const c = toCrop({ x: 0, y: 0, w: 5000, h: 5000 }, cfg);
    assert.ok(c.w <= cfg.viewport.w + 0.01);
    assert.ok(c.h <= cfg.viewport.h + 0.01);
  });

  test("an explicit level sizes the crop directly", () => {
    // level 2 = half the viewport width, i.e. 2× magnification.
    const c = toCrop({ x: 500, y: 400, w: 10, h: 10 }, cfg, 2);
    closeTo(c.w, cfg.viewport.w / 2);
    closeTo(c.w / c.h, aspect);
  });
});

describe("timeline sampling", () => {
  test("always opens on a full-frame establishing shot", () => {
    const r = resolveTimeline([{ t: 5000, rect: { x: 0, y: 0, w: 10, h: 10 } }], cfg);
    assert.equal(r[0]!.t, 0);
    assert.deepEqual(r[0]!.rect, { x: 0, y: 0, w: 1000, h: 800 });
  });

  test("a null rect means zoom back out to the whole frame", () => {
    const r = resolveTimeline([{ t: 1000, rect: null }], cfg);
    assert.deepEqual(r[1]!.rect, { x: 0, y: 0, w: 1000, h: 800 });
  });

  test("sorts keyframes by time regardless of insertion order", () => {
    const r = resolveTimeline(
      [
        { t: 900, rect: null },
        { t: 300, rect: null },
      ],
      cfg,
    );
    assert.deepEqual(
      r.map((k) => k.t),
      [0, 300, 900],
    );
  });

  test("holds the settled rect once the camera move completes", () => {
    const key = { x: 400, y: 300, w: 100, h: 50 };
    const r = resolveTimeline([{ t: 1000, rect: key }], cfg);
    const settled = toCrop(key, cfg);
    const sampled = sampleRect(r, 1000 + cfg.transitionMs + 500, cfg);
    closeTo(sampled.x, settled.x);
    closeTo(sampled.w, settled.w);
  });

  test("eases rather than cutting between keyframes", () => {
    const r = resolveTimeline([{ t: 0, rect: null }, { t: 1000, rect: { x: 400, y: 300, w: 80, h: 40 } }], cfg);
    const mid = sampleRect(r, 1000 + cfg.transitionMs / 2, cfg);
    const end = sampleRect(r, 1000 + cfg.transitionMs, cfg);
    assert.ok(mid.w > end.w, "mid-transition is still wider than the settled crop");
    assert.ok(mid.w < cfg.viewport.w, "and already narrower than full-frame");
  });

  test("is stable for times before the first keyframe", () => {
    const r = resolveTimeline([{ t: 5000, rect: null }], cfg);
    assert.deepEqual(sampleRect(r, -100, cfg), { x: 0, y: 0, w: 1000, h: 800 });
  });
});
