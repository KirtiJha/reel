import type { BrowserContext } from "playwright-core";
import type { Redact } from "../spec/schema.js";

/**
 * Redact sensitive regions so demos don't leak real data. An injected
 * MutationObserver continuously tags elements matching the given CSS selectors,
 * blurring (or boxing) them — so content added mid-demo (new rows, avatars) is
 * covered too. The effect is applied in the page, so it lands in every captured
 * frame of the video/GIF.
 */
export async function applyRedaction(context: BrowserContext, redact: Redact): Promise<void> {
  if (!redact.selectors.length) return;
  await context.addInitScript(redactionScript, redact);
}

function redactionScript(cfg: { selectors: string[]; mode: "blur" | "box"; blur: number }): void {
  const STYLE_ID = "__reel_redact_style__";
  const cls = cfg.mode === "box" ? "__reel_redact_box__" : "__reel_redact_blur__";

  const install = () => {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent =
        `.__reel_redact_blur__{filter:blur(${cfg.blur}px)!important}` +
        `.__reel_redact_box__{background:#0b0b0f!important;color:transparent!important;` +
        `text-shadow:none!important;border-radius:4px!important}` +
        `.__reel_redact_box__ *{visibility:hidden!important}`;
      (document.head || document.documentElement).appendChild(style);
    }
    for (const sel of cfg.selectors) {
      try {
        document.querySelectorAll(sel).forEach((el) => el.classList.add(cls));
      } catch {
        /* invalid selector — ignore */
      }
    }
  };

  const start = () => {
    install();
    // Re-tag as the app mutates the DOM (new rows, late-loaded content).
    new MutationObserver(() => install()).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
