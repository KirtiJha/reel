/**
 * A small terminal emulator — enough of xterm to film a CLI, none of the weight.
 *
 * Reel already owns a rendering pipeline that operates on DOM and frames, so a
 * terminal demo only needs something that turns a byte stream into a grid of
 * styled cells. Vendoring xterm.js would add ~250KB to a self-contained page
 * for capabilities a recorded demo never uses (selection, links, reflow, an
 * addon system).
 *
 * Supported: SGR colours and attributes (including 256-colour and truecolour),
 * cursor motion and addressing, erase-in-line/display, scrolling on overflow,
 * and the usual control characters. Not supported: alternate screen buffers,
 * scroll regions, and mouse reporting — a full-screen TUI is out of scope.
 *
 * Pure and synchronous: bytes in, grid out. Which is what makes it testable.
 */

export interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface Cell {
  ch: string;
  style: Style;
}

/** One row, run-length grouped into styled spans for compact rendering. */
export interface Span {
  text: string;
  style: Style;
}

const EMPTY: Style = {};

/** The xterm 16-colour palette, as rendered by most modern terminals. */
const BASE_COLORS = [
  "#1e2029", "#f0616e", "#7ee787", "#f0c674",
  "#79b8ff", "#d2a8ff", "#56d4dd", "#c9d1d9",
  "#5a6172", "#ff8a94", "#a2f2a9", "#ffe08a",
  "#a5d6ff", "#e2c5ff", "#8ff0f5", "#ffffff",
];

/** xterm 256-colour cube → hex. */
function color256(n: number): string {
  if (n < 16) return BASE_COLORS[n]!;
  if (n < 232) {
    const i = n - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    const r = steps[Math.floor(i / 36) % 6]!;
    const g = steps[Math.floor(i / 6) % 6]!;
    const b = steps[i % 6]!;
    return rgb(r, g, b);
  }
  const v = 8 + (n - 232) * 10;
  return rgb(v, v, v);
}

function rgb(r: number, g: number, b: number): string {
  const h = (v: number) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

export class TerminalEmulator {
  private grid: Cell[][] = [];
  private style: Style = {};
  private cx = 0;
  private cy = 0;
  /** Bytes that arrived mid-escape-sequence, awaiting the rest. */
  private pending = "";
  /** How many times the screen has scrolled — lets a caller re-base a row it noted earlier. */
  private scrolls = 0;

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.reset();
  }

  reset(): void {
    this.grid = Array.from({ length: this.rows }, () => this.blankRow());
    this.cx = 0;
    this.cy = 0;
    this.style = {};
  }

  private blankRow(): Cell[] {
    return Array.from({ length: this.cols }, () => ({ ch: " ", style: EMPTY }));
  }

  /** The plain text on screen — what `expectOutput` matches against. */
  text(): string {
    return this.grid
      .map((row) => row.map((c) => c.ch).join("").replace(/\s+$/, ""))
      .join("\n")
      .replace(/\n+$/, "");
  }

  /** Rows as run-length styled spans, ready to render. */
  spans(): Span[][] {
    return this.grid.map((row) => {
      const out: Span[] = [];
      for (const cell of row) {
        const last = out[out.length - 1];
        if (last && sameStyle(last.style, cell.style)) last.text += cell.ch;
        else out.push({ text: cell.ch, style: cell.style });
      }
      // Trailing blanks carry no information and bloat the payload.
      while (out.length > 1 && out[out.length - 1]!.text.trim() === "" && !out[out.length - 1]!.style.bg) {
        out.pop();
      }
      return out;
    });
  }

  cursor(): { x: number; y: number } {
    return { x: this.cx, y: this.cy };
  }

  /**
   * Total scrolls since construction.
   *
   * A row noted before some output arrived has moved up by the difference in
   * this count — that is how a region recorded across a `run` stays pointed at
   * the same text once the screen has scrolled under it.
   */
  scrollCount(): number {
    return this.scrolls;
  }

  /** Feed a chunk of output. Safe to call with a sequence split across chunks. */
  write(chunk: string): void {
    const data = this.pending + chunk;
    this.pending = "";
    let i = 0;

    while (i < data.length) {
      const ch = data[i]!;

      if (ch === "\x1b") {
        const consumed = this.escape(data, i);
        if (consumed < 0) {
          // Incomplete sequence — keep it for the next chunk rather than
          // printing escape bytes as literal text.
          this.pending = data.slice(i);
          return;
        }
        i += consumed;
        continue;
      }

      i++;
      switch (ch) {
        case "\n":
          // A terminal in cooked mode maps LF to CRLF (ONLCR), and programs
          // emit bare LF expecting exactly that. Without the column reset,
          // output stair-steps to the right.
          this.newline();
          this.cx = 0;
          break;
        case "\r":
          this.cx = 0;
          break;
        case "\b":
          this.cx = Math.max(0, this.cx - 1);
          break;
        case "\t":
          this.cx = Math.min(this.cols - 1, (Math.floor(this.cx / 8) + 1) * 8);
          break;
        case "\x07": // bell
          break;
        default:
          if (ch >= " " || ch === " ") this.put(ch);
      }
    }
  }

  private put(ch: string): void {
    if (this.cx >= this.cols) {
      this.cx = 0;
      this.newline();
    }
    this.grid[this.cy]![this.cx] = { ch, style: this.style };
    this.cx++;
  }

  private newline(): void {
    this.cy++;
    if (this.cy >= this.rows) {
      this.grid.shift();
      this.grid.push(this.blankRow());
      this.cy = this.rows - 1;
      this.scrolls++;
    }
  }

  /**
   * Handle an escape sequence starting at `start`. Returns how many characters
   * were consumed, or -1 if the sequence is incomplete.
   */
  private escape(data: string, start: number): number {
    const next = data[start + 1];
    if (next === undefined) return -1;

    // OSC: ESC ] ... BEL | ESC \  — window titles and hyperlinks; ignored, but
    // must be consumed or the payload prints as garbage.
    if (next === "]") {
      const bel = data.indexOf("\x07", start);
      const st = data.indexOf("\x1b\\", start);
      if (bel === -1 && st === -1) return -1;
      const end = bel === -1 ? st + 2 : st === -1 ? bel + 1 : Math.min(bel + 1, st + 2);
      return end - start;
    }

    if (next !== "[") {
      // Two-character escapes (charset selection, RIS, …) — skip both.
      return 2;
    }

    // CSI: ESC [ params intermediates final
    let i = start + 2;
    while (i < data.length && /[\d;?<>!]/.test(data[i]!)) i++;
    if (i >= data.length) return -1;
    const final = data[i]!;
    const params = data.slice(start + 2, i);
    this.csi(final, params);
    return i - start + 1;
  }

  private csi(final: string, raw: string): void {
    const priv = raw.startsWith("?");
    const nums = (raw.replace(/^[?<>!]/, "").split(";").map((p) => (p === "" ? NaN : Number(p))));
    const n = (idx: number, dflt = 1): number => {
      const v = nums[idx];
      return v === undefined || Number.isNaN(v) ? dflt : v;
    };

    switch (final) {
      case "A": this.cy = Math.max(0, this.cy - n(0)); break;
      case "B": this.cy = Math.min(this.rows - 1, this.cy + n(0)); break;
      case "C": this.cx = Math.min(this.cols - 1, this.cx + n(0)); break;
      case "D": this.cx = Math.max(0, this.cx - n(0)); break;
      case "E": this.cy = Math.min(this.rows - 1, this.cy + n(0)); this.cx = 0; break;
      case "F": this.cy = Math.max(0, this.cy - n(0)); this.cx = 0; break;
      case "G": this.cx = clamp(n(0) - 1, 0, this.cols - 1); break;
      case "H":
      case "f":
        this.cy = clamp(n(0) - 1, 0, this.rows - 1);
        this.cx = clamp(n(1) - 1, 0, this.cols - 1);
        break;
      case "J": this.eraseDisplay(n(0, 0)); break;
      case "K": this.eraseLine(n(0, 0)); break;
      case "m": if (!priv) this.sgr(nums); break;
      default: break; // cursor visibility, modes, device reports — no-ops here
    }
  }

  private eraseLine(mode: number): void {
    const row = this.grid[this.cy]!;
    const blank = { ch: " ", style: EMPTY };
    if (mode === 0) for (let x = this.cx; x < this.cols; x++) row[x] = { ...blank };
    else if (mode === 1) for (let x = 0; x <= this.cx; x++) row[x] = { ...blank };
    else for (let x = 0; x < this.cols; x++) row[x] = { ...blank };
  }

  private eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      this.grid = Array.from({ length: this.rows }, () => this.blankRow());
      this.cx = 0;
      this.cy = 0;
      return;
    }
    if (mode === 0) {
      this.eraseLine(0);
      for (let y = this.cy + 1; y < this.rows; y++) this.grid[y] = this.blankRow();
    } else {
      this.eraseLine(1);
      for (let y = 0; y < this.cy; y++) this.grid[y] = this.blankRow();
    }
  }

  private sgr(nums: number[]): void {
    if (nums.length === 0 || nums.every((v) => Number.isNaN(v))) {
      this.style = {};
      return;
    }
    for (let i = 0; i < nums.length; i++) {
      const v = Number.isNaN(nums[i]!) ? 0 : nums[i]!;
      switch (true) {
        case v === 0: this.style = {}; break;
        case v === 1: this.style = { ...this.style, bold: true }; break;
        case v === 2: this.style = { ...this.style, dim: true }; break;
        case v === 3: this.style = { ...this.style, italic: true }; break;
        case v === 4: this.style = { ...this.style, underline: true }; break;
        case v === 7: this.style = { ...this.style, inverse: true }; break;
        case v === 22: this.style = { ...this.style, bold: false, dim: false }; break;
        case v === 23: this.style = { ...this.style, italic: false }; break;
        case v === 24: this.style = { ...this.style, underline: false }; break;
        case v === 27: this.style = { ...this.style, inverse: false }; break;
        case v >= 30 && v <= 37: this.style = { ...this.style, fg: BASE_COLORS[v - 30] }; break;
        case v === 39: this.style = { ...this.style, fg: undefined }; break;
        case v >= 40 && v <= 47: this.style = { ...this.style, bg: BASE_COLORS[v - 40] }; break;
        case v === 49: this.style = { ...this.style, bg: undefined }; break;
        case v >= 90 && v <= 97: this.style = { ...this.style, fg: BASE_COLORS[v - 90 + 8] }; break;
        case v >= 100 && v <= 107: this.style = { ...this.style, bg: BASE_COLORS[v - 100 + 8] }; break;
        case v === 38 || v === 48: {
          // Extended colour: 5;n (256) or 2;r;g;b (truecolour).
          const key = v === 38 ? "fg" : "bg";
          if (nums[i + 1] === 5) {
            this.style = { ...this.style, [key]: color256(nums[i + 2] ?? 0) };
            i += 2;
          } else if (nums[i + 1] === 2) {
            this.style = {
              ...this.style,
              [key]: rgb(nums[i + 2] ?? 0, nums[i + 3] ?? 0, nums[i + 4] ?? 0),
            };
            i += 4;
          }
          break;
        }
        default: break;
      }
    }
  }
}

function sameStyle(a: Style, b: Style): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.inverse === !!b.inverse
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
