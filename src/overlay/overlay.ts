import type { Page } from "playwright-core";
import { SCOPE } from "../authoring/selector.js";

/**
 * The overlay layer draws Reel's presentation furniture INTO the page, in a
 * fixed top-layer container that sits above app content but is ignored by
 * hit-testing. Because it lives in the DOM, the capture loop records it for
 * free — no fragile post-process compositing needed.
 *
 * It provides the things a raw screen recording can't: a synthetic cursor (a
 * real OS cursor doesn't exist headless), title cards that give a demo scene
 * structure, and a spotlight that directs the eye. The easing on all of it is
 * a big part of what reads as "Screen Studio polish".
 *
 * Captions are the exception: when auto-zoom is on they're composited in post
 * (see polish/render.ts) so a zoomed crop can never clip them.
 */

export interface OverlayOptions {
  cursor: boolean;
  captions: boolean;
  /** Brand accent for the ripple, spotlight ring, and card rule. */
  accent: string;
  /**
   * Let the overlay animate itself with CSS transitions / WAAPI.
   *
   * False on a deterministic recording: a transition's progress at capture time
   * depends on wall-clock, so a frame grabbed mid-fade differs run to run. With
   * this off every overlay state change is instantaneous and the driver
   * synthesizes the motion it wants, frame by frame, at exact positions.
   */
  animate?: boolean;
}

/** Word advance widths for a caption, measured at a 100px reference size. */
export interface TextMetrics {
  space: number;
  words: { word: string; adv: number }[];
}

const FONT_STACK = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

/** Install the overlay container and its controller once per page. */
export async function installOverlay(page: Page, opts: OverlayOptions): Promise<void> {
  await page.evaluate(
    ({ o, fontStack }) => {
      if ((window as any).__reel__) return;

      const root = document.createElement("div");
      root.id = "__reel_overlay__";
      if (o.animate === false) {
        // A stylesheet `!important` rule beats the inline transitions set
        // below, so every overlay state change lands instantly.
        const kill = document.createElement("style");
        kill.id = "__reel_no_overlay_anim__";
        kill.textContent =
          `#__reel_overlay__, #__reel_overlay__ * ` +
          `{ transition: none !important; animation: none !important; }`;
        (document.head || document.documentElement).appendChild(kill);
      }
      Object.assign(root.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483647",
        pointerEvents: "none",
        contain: "layout style size",
      } as CSSStyleDeclaration);

      // --- Synthetic cursor ---
      const cursor = document.createElement("div");
      Object.assign(cursor.style, {
        position: "fixed",
        left: "0",
        top: "0",
        width: "22px",
        height: "22px",
        marginLeft: "-3px",
        marginTop: "-2px",
        transform: "translate(-100px, -100px)",
        transformOrigin: "4px 3px",
        willChange: "transform",
        pointerEvents: "none",
        filter: "drop-shadow(0 2px 3px rgba(0,0,0,.35))",
        opacity: o.cursor ? "1" : "0",
        transition: "none",
        zIndex: "4",
      } as CSSStyleDeclaration);
      cursor.innerHTML = `
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M4 2 L4 17 L8.2 13.2 L11 19.5 L13.6 18.4 L10.8 12.1 L16 12 Z"
            fill="white" stroke="black" stroke-width="1.2" stroke-linejoin="round"/>
        </svg>`;
      root.appendChild(cursor);

      // --- Click ripple ---
      const ripple = document.createElement("div");
      Object.assign(ripple.style, {
        position: "fixed",
        width: "10px",
        height: "10px",
        borderRadius: "50%",
        border: `2px solid ${o.accent}`,
        transform: "translate(-100px,-100px) scale(1)",
        opacity: "0",
        pointerEvents: "none",
        zIndex: "3",
      } as CSSStyleDeclaration);
      root.appendChild(ripple);

      // --- Spotlight (callout) ---
      // A transparent rect with an enormous spread shadow = everything outside
      // it dims, in one composited layer, with no per-frame math.
      const spot = document.createElement("div");
      Object.assign(spot.style, {
        position: "fixed",
        left: "0",
        top: "0",
        width: "0",
        height: "0",
        borderRadius: "14px",
        boxShadow: "0 0 0 9999px rgba(6,8,14,0)",
        outline: `2px solid ${o.accent}`,
        outlineOffset: "3px",
        opacity: "0",
        pointerEvents: "none",
        transition: "opacity .28s ease",
        zIndex: "1",
      } as CSSStyleDeclaration);
      root.appendChild(spot);

      const spotLabel = document.createElement("div");
      Object.assign(spotLabel.style, {
        position: "fixed",
        maxWidth: "62%",
        padding: "10px 16px",
        borderRadius: "11px",
        background: "rgba(15,15,20,.94)",
        color: "#fff",
        font: `500 17px/1.4 ${fontStack}`,
        boxShadow: "0 10px 34px rgba(0,0,0,.45)",
        borderLeft: `3px solid ${o.accent}`,
        opacity: "0",
        pointerEvents: "none",
        transition: "opacity .28s ease, transform .28s ease",
        zIndex: "2",
      } as CSSStyleDeclaration);
      root.appendChild(spotLabel);

      // --- Title card ---
      const card = document.createElement("div");
      Object.assign(card.style, {
        position: "fixed",
        inset: "0",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "18px",
        textAlign: "center",
        padding: "8%",
        background: "linear-gradient(160deg, rgba(9,11,18,.97), rgba(17,21,36,.99))",
        opacity: "0",
        pointerEvents: "none",
        transition: "opacity .34s ease",
        zIndex: "5",
      } as CSSStyleDeclaration);
      const cardTitle = document.createElement("div");
      Object.assign(cardTitle.style, {
        color: "#fff",
        font: `700 clamp(28px, 5.4vw, 60px)/1.15 ${fontStack}`,
        letterSpacing: "-0.02em",
        transform: "translateY(10px)",
        transition: "transform .44s cubic-bezier(.2,.7,.2,1)",
      } as CSSStyleDeclaration);
      const cardRule = document.createElement("div");
      Object.assign(cardRule.style, {
        width: "0px",
        height: "3px",
        borderRadius: "2px",
        background: o.accent,
        transition: "width .5s cubic-bezier(.2,.7,.2,1) .08s",
      } as CSSStyleDeclaration);
      const cardSub = document.createElement("div");
      Object.assign(cardSub.style, {
        color: "rgba(255,255,255,.66)",
        font: `400 clamp(15px, 2.1vw, 22px)/1.45 ${fontStack}`,
        transform: "translateY(10px)",
        transition: "transform .44s cubic-bezier(.2,.7,.2,1) .06s",
      } as CSSStyleDeclaration);
      card.append(cardTitle, cardRule, cardSub);
      root.appendChild(card);

      // --- Caption bar (used when captions aren't composited in post) ---
      const caption = document.createElement("div");
      Object.assign(caption.style, {
        position: "fixed",
        left: "50%",
        bottom: "34px",
        transform: "translateX(-50%) translateY(8px)",
        maxWidth: "78%",
        padding: "12px 20px",
        borderRadius: "12px",
        background: "rgba(15,15,20,.86)",
        color: "#fff",
        font: `500 19px/1.35 ${fontStack}`,
        letterSpacing: ".01em",
        textAlign: "center",
        boxShadow: "0 8px 30px rgba(0,0,0,.35)",
        backdropFilter: "blur(6px)",
        opacity: "0",
        pointerEvents: "none",
        whiteSpace: "pre-wrap",
        zIndex: "3",
      } as CSSStyleDeclaration);
      root.appendChild(caption);

      document.documentElement.appendChild(root);

      const state = {
        x: -100,
        y: -100,
        showCursor: o.cursor,
        showCaptions: o.captions,
      };

      /** Slight overshoot then settle — how a real hand lands on a target. */
      const easeOutBack = (p: number): number => {
        const c1 = 1.1;
        const c3 = c1 + 1;
        return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
      };

      (window as any).__reel__ = {
        state,
        setCursor(x: number, y: number, scale = 1) {
          state.x = x;
          state.y = y;
          cursor.style.transform =
            scale === 1
              ? `translate(${x}px, ${y}px)`
              : `translate(${x}px, ${y}px) scale(${scale})`;
        },
        /**
         * The click ripple as an explicit function of progress (0→1) rather
         * than a CSS transition, so a deterministic recording can step it.
         */
        rippleAt(x: number, y: number, p: number) {
          ripple.style.transition = "none";
          ripple.style.transform = `translate(${x}px, ${y}px) scale(${1 + 3 * p})`;
          ripple.style.opacity = p >= 1 ? "0" : String(0.9 * (1 - p));
        },
        /**
         * Ease the cursor along a gentle arc with a slight overshoot, animated
         * page-side so Node just waits out the duration (no per-frame IPC that
         * would contend with the screenshot loop).
         */
        glide(x: number, y: number, d: number) {
          const fromX = state.x;
          const fromY = state.y;
          const dx = x - fromX;
          const dy = y - fromY;
          const dist = Math.hypot(dx, dy) || 1;
          // Bow the path perpendicular to the direction of travel; longer
          // moves arc more, but never absurdly.
          const bow = Math.min(54, dist * 0.16);
          const nx = -dy / dist;
          const ny = dx / dist;

          const steps = 26;
          const frames: Keyframe[] = [];
          for (let i = 0; i <= steps; i++) {
            const p = i / steps;
            const e = easeOutBack(p);
            const arc = Math.sin(Math.PI * p) * bow;
            const px = fromX + dx * e + nx * arc;
            const py = fromY + dy * e + ny * arc;
            frames.push({ transform: `translate(${px}px, ${py}px)` });
          }
          state.x = x;
          state.y = y;
          // Set the resting position first: with fill "none" the element falls
          // back to it the instant the animation ends, so there's no snap.
          cursor.style.transform = `translate(${x}px, ${y}px)`;
          cursor.animate(frames, { duration: d, easing: "linear", fill: "none" });
        },
        /** Click feedback: the cursor presses in, a ring expands out. */
        pulse(x: number, y: number) {
          cursor.animate(
            [
              { transform: `translate(${x}px, ${y}px) scale(1)` },
              { transform: `translate(${x}px, ${y}px) scale(0.86)`, offset: 0.35 },
              { transform: `translate(${x}px, ${y}px) scale(1)` },
            ],
            { duration: 260, easing: "ease-out", fill: "none" },
          );
          ripple.style.transition = "none";
          ripple.style.transform = `translate(${x}px, ${y}px) scale(1)`;
          ripple.style.opacity = "0.9";
          void ripple.offsetWidth;
          ripple.style.transition = "transform .38s ease-out, opacity .38s ease-out";
          ripple.style.transform = `translate(${x}px, ${y}px) scale(4)`;
          ripple.style.opacity = "0";
        },
        setCaption(text: string) {
          if (!state.showCaptions) return;
          if (!text) {
            caption.style.opacity = "0";
            caption.style.transform = "translateX(-50%) translateY(8px)";
            return;
          }
          caption.textContent = text;
          caption.style.transition = "opacity .25s ease, transform .25s ease";
          caption.style.opacity = "1";
          caption.style.transform = "translateX(-50%) translateY(0)";
        },
        card(title: string, subtitle: string) {
          cardTitle.textContent = title;
          cardSub.textContent = subtitle || "";
          cardSub.style.display = subtitle ? "block" : "none";
          card.style.opacity = "1";
          // Force a reflow so the entrance transitions actually run.
          void card.offsetWidth;
          cardTitle.style.transform = "translateY(0)";
          cardSub.style.transform = "translateY(0)";
          cardRule.style.width = "72px";
        },
        cardOut() {
          card.style.opacity = "0";
          cardTitle.style.transform = "translateY(10px)";
          cardSub.style.transform = "translateY(10px)";
          cardRule.style.width = "0px";
        },
        spot(r: { x: number; y: number; w: number; h: number }, text: string, dim: number) {
          const pad = 6;
          spot.style.transform = `translate(${r.x - pad}px, ${r.y - pad}px)`;
          spot.style.width = `${r.w + pad * 2}px`;
          spot.style.height = `${r.h + pad * 2}px`;
          spot.style.boxShadow = `0 0 0 9999px rgba(6,8,14,${dim})`;
          spot.style.opacity = "1";

          if (text) {
            spotLabel.textContent = text;
            // Prefer below the target; flip above when there isn't room.
            const below = r.y + r.h + 18;
            const fitsBelow = below + 60 < window.innerHeight;
            spotLabel.style.left = `${Math.max(16, Math.min(r.x, window.innerWidth - 340))}px`;
            spotLabel.style.top = fitsBelow ? `${below}px` : `${Math.max(16, r.y - 74)}px`;
            spotLabel.style.transform = "translateY(0)";
            spotLabel.style.opacity = "1";
          }
        },
        spotOut() {
          spot.style.opacity = "0";
          spot.style.boxShadow = "0 0 0 9999px rgba(6,8,14,0)";
          spotLabel.style.opacity = "0";
          spotLabel.style.transform = "translateY(6px)";
        },
        /** Eased programmatic scroll — frame-counted, so a frozen clock can't stall it. */
        scrollTo(targetY: number, ms: number) {
          return new Promise<void>((resolve) => {
            const startY = window.scrollY;
            const dist = targetY - startY;
            if (Math.abs(dist) < 2) return resolve();
            const total = Math.max(2, Math.round(ms / 16));
            let i = 0;
            const tick = () => {
              i++;
              const p = Math.min(1, i / total);
              const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
              window.scrollTo(0, startY + dist * e);
              if (p < 1) requestAnimationFrame(tick);
              else resolve();
            };
            requestAnimationFrame(tick);
          });
        },
        /**
         * Measure a caption with the browser's own text engine at a 100px
         * reference size. The renderer scales these advances to lay out real
         * line breaks instead of guessing an average character width.
         */
        measure(text: string, font: string) {
          const ctx = document.createElement("canvas").getContext("2d");
          if (!ctx) return null;
          ctx.font = font;
          const words = text.split(/\s+/).filter(Boolean);
          return {
            space: ctx.measureText(" ").width,
            words: words.map((word) => ({ word, adv: ctx.measureText(word).width })),
          };
        },
      };
    },
    { o: opts, fontStack: FONT_STACK },
  );
}

/** Read the center point of an element in viewport coordinates. */
export async function elementCenter(
  page: Page,
  selector: string,
): Promise<{ x: number; y: number } | null> {
  const loc = page.locator(toPlaywrightSelector(selector)).first();
  const box = await loc.boundingBox();
  if (!box) return null;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Ease the synthetic cursor to a target, then wait out its duration in Node.
 * Because the animation runs in the page (not a per-frame Node loop), it
 * doesn't contend with the retina screenshot capture, so the recording plays
 * back at the intended pace.
 */
export async function moveCursorTo(
  page: Page,
  x: number,
  y: number,
  opts: { durationMs?: number; fps?: number } = {},
): Promise<void> {
  const duration = opts.durationMs ?? 520;
  await page.evaluate(
    ([px, py, d]) => (window as any).__reel__?.glide(px, py, d),
    [x, y, duration] as [number, number, number],
  );
  await page.waitForTimeout(duration);
}

export async function pulseCursor(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(([px, py]) => (window as any).__reel__?.pulse(px, py), [x, y]);
}

/** Place the cursor at an exact position (deterministic recording). */
export async function setCursorAt(
  page: Page,
  x: number,
  y: number,
  scale = 1,
): Promise<void> {
  await page
    .evaluate(
      ([px, py, s]) => (window as any).__reel__?.setCursor(px, py, s),
      [x, y, scale] as [number, number, number],
    )
    .catch(() => {});
}

/** Draw the click ripple at an exact progress (deterministic recording). */
export async function rippleAt(
  page: Page,
  x: number,
  y: number,
  p: number,
): Promise<void> {
  await page
    .evaluate(
      ([px, py, pr]) => (window as any).__reel__?.rippleAt(px, py, pr),
      [x, y, p] as [number, number, number],
    )
    .catch(() => {});
}

/**
 * The cursor's eased arc from `from` to `to` at progress `p`, mirroring the
 * page-side `glide()` so a synthesized move looks identical to an animated one.
 */
export function cursorPathAt(
  from: { x: number; y: number },
  to: { x: number; y: number },
  p: number,
): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const bow = Math.min(54, dist * 0.16);
  const nx = -dy / dist;
  const ny = dx / dist;
  const c1 = 1.1;
  const c3 = c1 + 1;
  const e = 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
  const arc = Math.sin(Math.PI * p) * bow;
  return { x: from.x + dx * e + nx * arc, y: from.y + dy * e + ny * arc };
}

export async function setCaption(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => (window as any).__reel__?.setCaption(t), text);
}

/** Show a full-screen title card. */
export async function showCard(page: Page, title: string, subtitle?: string): Promise<void> {
  await page.evaluate(
    ([t, s]) => (window as any).__reel__?.card(t, s),
    [title, subtitle ?? ""] as [string, string],
  );
}

export async function hideCard(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__reel__?.cardOut());
}

/** Dim the page except for `rect`, with an optional explanatory label. */
export async function spotlight(
  page: Page,
  rect: { x: number; y: number; w: number; h: number },
  text?: string,
  dim = 0.66,
): Promise<void> {
  await page.evaluate(
    ({ r, t, d }) => (window as any).__reel__?.spot(r, t, d),
    { r: rect, t: text ?? "", d: dim },
  );
}

export async function clearSpotlight(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__reel__?.spotOut());
}

/** Eased scroll to an absolute Y offset, animated in-page. */
export async function smoothScroll(page: Page, y: number, ms: number): Promise<void> {
  await page.evaluate(
    ([ty, d]) => (window as any).__reel__?.scrollTo(ty, d),
    [y, ms] as [number, number],
  );
}

/**
 * Measure a caption's words with the browser's text engine, so the post-render
 * caption bar can wrap at real word boundaries. Returns null if measurement
 * isn't available (the renderer then falls back to an estimate).
 */
export async function measureText(page: Page, text: string): Promise<TextMetrics | null> {
  return page
    .evaluate(
      ([t, f]) => (window as any).__reel__?.measure(t, f) ?? null,
      [text, `600 100px ${FONT_STACK}`] as [string, string],
    )
    .catch(() => null);
}

/**
 * Translate the friendly selector syntax used in specs into Playwright
 * selectors:
 *   text=Foo            → text locator
 *   role=button[name=X] → getByRole-style engine selector
 *   nav >> role=link[…] → each half translated, chained by Playwright
 *   anything else       → passed through (CSS / Playwright selector)
 */
export function toPlaywrightSelector(sel: string): string {
  // Scoping is Playwright's own chaining operator, so the only work here is to
  // make sure a role or text half is normalised the same as an unscoped one.
  if (sel.includes(SCOPE)) return sel.split(SCOPE).map(toPlaywrightSelector).join(SCOPE);
  if (sel.startsWith("text=")) return `text=${sel.slice(5)}`;
  if (sel.startsWith("role=")) {
    const m = /^role=([a-z]+)(?:\[name=(.+?)\])?$/i.exec(sel);
    if (m) {
      const role = m[1];
      const name = m[2];
      return name ? `role=${role}[name="${name.replace(/^["']|["']$/g, "")}"]` : `role=${role}`;
    }
  }
  return sel;
}
