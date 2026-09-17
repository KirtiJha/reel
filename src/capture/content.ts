import type { Page } from "playwright-core";
import type { Rect } from "../polish/zoom.js";

/**
 * Where the app's content actually is, as opposed to where its viewport is.
 *
 * ## Why this exists
 *
 * Reel films a viewport, but most web apps do not fill one. A centred card, a
 * narrow prose column, a login box — the app is the small bright thing and the
 * rest is page background. Measured on Reel's own example app the content box
 * is **16% of the viewport**; the other 84% is a dark gradient. A demo of that
 * is mostly nothing, and no amount of zooming *into a click* fixes the shots
 * between the clicks.
 *
 * So the camera needs to know where the content is, and `fullRect` uses this to
 * make the wide shot frame the app rather than the page.
 *
 * ## What counts as content
 *
 * Only elements that actually paint something a viewer would call part of the
 * app: text, a background, a border, an image. A full-bleed wrapper with a
 * gradient on it is exactly the thing being excluded, so a `<body>`-sized
 * element is never counted — otherwise every page would measure as "full" and
 * this would do nothing at all.
 *
 * ## Determinism
 *
 * The result is rounded to whole pixels and measured against a page whose
 * clock is frozen and whose animations are disabled, so two runs of one spec
 * measure the same box. That matters: this feeds the camera, and the camera
 * decides every output pixel.
 */
export async function measureContent(page: Page): Promise<Rect | null> {
  try {
    const box = await page.evaluate(() => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (!vw || !vh) return null;

      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let counted = 0;

      for (const el of Array.from(document.body.querySelectorAll("*"))) {
        const s = window.getComputedStyle(el);
        if (s.visibility === "hidden" || s.display === "none") continue;
        if (Number(s.opacity) === 0) continue;

        const b = el.getBoundingClientRect();
        // Hairlines and spacers are not content.
        if (b.width < 4 || b.height < 4) continue;
        // Off-screen entirely.
        if (b.right <= 0 || b.bottom <= 0 || b.left >= vw || b.top >= vh) continue;

        // A wrapper that spans the viewport is the page, not the app. Counting
        // it would make every measurement "full" and defeat the whole point.
        if (b.width >= vw * 0.985 && b.height >= vh * 0.985) continue;

        const paints =
          s.backgroundImage !== "none" ||
          (s.backgroundColor !== "rgba(0, 0, 0, 0)" && s.backgroundColor !== "transparent") ||
          parseFloat(s.borderTopWidth) > 0 ||
          parseFloat(s.borderBottomWidth) > 0 ||
          el.tagName === "IMG" ||
          el.tagName === "SVG" ||
          el.tagName === "CANVAS" ||
          el.tagName === "VIDEO" ||
          // Text, but only where this element owns it rather than inheriting a
          // descendant's — otherwise every ancestor up to <body> counts.
          Array.from(el.childNodes).some(
            (n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0,
          );
        if (!paints) continue;

        x0 = Math.min(x0, Math.max(0, b.left));
        y0 = Math.min(y0, Math.max(0, b.top));
        x1 = Math.max(x1, Math.min(vw, b.right));
        y1 = Math.max(y1, Math.min(vh, b.bottom));
        counted++;
      }

      if (counted === 0 || !Number.isFinite(x0) || !Number.isFinite(y0)) return null;
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    });

    if (!box || box.w <= 0 || box.h <= 0) return null;
    // Whole pixels: sub-pixel layout noise must not move the camera.
    return {
      x: Math.floor(box.x),
      y: Math.floor(box.y),
      w: Math.ceil(box.w),
      h: Math.ceil(box.h),
    };
  } catch {
    // Measuring is an enhancement, never a reason a recording fails. A page
    // that navigated mid-evaluate, or a closed context, just means no hint.
    return null;
  }
}

/**
 * The smallest box containing both, so a wide shot fits everything the demo
 * ever showed.
 *
 * Content grows: a list gains rows, a form reveals a field. Framing the app as
 * it looked at second zero would clip what it looked like at second thirty, and
 * a camera that crops away the thing being demonstrated is worse than one that
 * sits too wide.
 */
export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}
