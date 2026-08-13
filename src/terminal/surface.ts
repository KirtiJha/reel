import type { Page } from "playwright-core";
import type { Span, Style } from "./emulator.js";

/**
 * The terminal as a DOM layer.
 *
 * Rendering into the same document as the app is what lets one spec show a
 * command *and* the browser it affects — `show: terminal` / `show: app` toggles
 * between them, and everything downstream (zoom, captions, cards, device frame,
 * encoding, the interactive build) is unchanged, because it all operates on
 * frames.
 */

export interface TerminalTheme {
  background: string;
  foreground: string;
  fontSize: number;
  fontFamily: string;
  /** Window title shown in the terminal chrome. */
  title: string;
}

export interface TerminalLayout {
  cols: number;
  rows: number;
  theme: TerminalTheme;
}

export const DEFAULT_TERMINAL_FONT =
  `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`;

/** Install (or re-install after a navigation) the terminal layer. */
export async function installTerminal(page: Page, layout: TerminalLayout): Promise<void> {
  await page.evaluate((l: TerminalLayout) => {
    if (document.getElementById("__reel_term__")) return;
    const root = document.createElement("div");
    root.id = "__reel_term__";
    Object.assign(root.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483646", // just below Reel's cursor/caption overlay
      background: l.theme.background,
      color: l.theme.foreground,
      display: "none",
      flexDirection: "column",
      overflow: "hidden",
    } as CSSStyleDeclaration);

    // The title bar tints toward the theme's *foreground*, not toward white.
    // Hardcoded white alphas were invisible the moment a light scheme arrived —
    // white text at 45% opacity on a white background is nothing at all.
    const tint = (pct: number) =>
      `color-mix(in srgb, ${l.theme.foreground} ${pct}%, transparent)`;

    const bar = document.createElement("div");
    Object.assign(bar.style, {
      flex: "0 0 auto",
      padding: "10px 14px",
      font: `500 12px/1 ${l.theme.fontFamily}`,
      color: tint(55),
      background: tint(5),
      borderBottom: `1px solid ${tint(10)}`,
      textAlign: "center",
      letterSpacing: ".02em",
    } as CSSStyleDeclaration);
    bar.id = "__reel_term_title__";
    bar.textContent = l.theme.title;

    const screen = document.createElement("pre");
    screen.id = "__reel_term_screen__";
    Object.assign(screen.style, {
      margin: "0",
      padding: "14px 16px",
      flex: "1 1 auto",
      font: `${l.theme.fontSize}px/1.45 ${l.theme.fontFamily}`,
      whiteSpace: "pre",
      // The grid is fixed-width; letting it wrap would desync what the emulator
      // thinks is on screen from what is rendered.
      overflow: "hidden",
      fontVariantLigatures: "none",
      tabSize: "8",
    } as CSSStyleDeclaration);

    root.appendChild(bar);
    root.appendChild(screen);
    document.documentElement.appendChild(root);
  }, layout);
}

/** Show either the terminal or the app underneath it. */
export async function showTerminal(page: Page, visible: boolean): Promise<void> {
  await page
    .evaluate((v: boolean) => {
      const el = document.getElementById("__reel_term__");
      if (el) el.style.display = v ? "flex" : "none";
    }, visible)
    .catch(() => {});
}

/** Push the emulator's current screen into the page. */
export async function renderTerminal(
  page: Page,
  rows: Span[][],
  cursor: { x: number; y: number } | null,
): Promise<void> {
  await page
    .evaluate(
      ({ rows: r, cursor: c }: { rows: Span[][]; cursor: { x: number; y: number } | null }) => {
        const screen = document.getElementById("__reel_term_screen__");
        if (!screen) return;
        const esc = (s: string) =>
          s.replace(/[<>&]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[ch]!);

        const html = r
          .map((spans, y) => {
            let line = "";
            let col = 0;
            for (const sp of spans) {
              const st = sp.style as Record<string, unknown>;
              const css: string[] = [];
              const fg = st.inverse ? (st.bg as string) : (st.fg as string);
              const bg = st.inverse ? (st.fg as string) : (st.bg as string);
              if (fg) css.push(`color:${fg}`);
              if (bg) css.push(`background:${bg}`);
              if (st.inverse && !st.fg && !st.bg) css.push("filter:invert(1)");
              if (st.bold) css.push("font-weight:700");
              if (st.dim) css.push("opacity:.6");
              if (st.italic) css.push("font-style:italic");
              if (st.underline) css.push("text-decoration:underline");

              // The block cursor is drawn into the text so it can't drift out
              // of alignment with a monospace grid.
              if (c && c.y === y && c.x >= col && c.x < col + sp.text.length) {
                const at = c.x - col;
                const pre = esc(sp.text.slice(0, at));
                const on = esc(sp.text[at] ?? " ");
                const post = esc(sp.text.slice(at + 1));
                const base = css.length ? ` style="${css.join(";")}"` : "";
                line +=
                  `<span${base}>${pre}</span>` +
                  `<span style="background:currentColor;color:${bg || "transparent"}">${on}</span>` +
                  `<span${base}>${post}</span>`;
                col += sp.text.length;
                continue;
              }
              line += css.length
                ? `<span style="${css.join(";")}">${esc(sp.text)}</span>`
                : esc(sp.text);
              col += sp.text.length;
            }
            // A cursor past the end of the row's content still needs drawing.
            if (c && c.y === y && c.x >= col) {
              line += " ".repeat(Math.max(0, c.x - col));
              line += `<span style="background:currentColor">&nbsp;</span>`;
            }
            return line;
          })
          .join("\n");
        screen.innerHTML = html;
      },
      { rows, cursor },
    )
    .catch(() => {});
}

/** Style helper shared with tests. */
export function styleCss(style: Style): string {
  const css: string[] = [];
  if (style.fg) css.push(`color:${style.fg}`);
  if (style.bg) css.push(`background:${style.bg}`);
  if (style.bold) css.push("font-weight:700");
  if (style.dim) css.push("opacity:.6");
  if (style.italic) css.push("font-style:italic");
  if (style.underline) css.push("text-decoration:underline");
  return css.join(";");
}
