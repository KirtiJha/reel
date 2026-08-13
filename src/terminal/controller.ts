import type { Page } from "playwright-core";
import type { TerminalConfig } from "../spec/schema.js";
import type { Recorder } from "../driver/recorder.js";
import { TerminalEmulator } from "./emulator.js";
import { findTextRegion, fitToContent, type GridRegion } from "./grid.js";
import { checkRequirements, runCommand } from "./session.js";
import {
  DEFAULT_TERMINAL_FONT,
  installTerminal,
  renderTerminal,
  showTerminal,
} from "./surface.js";
import { ReelError, log } from "../util/log.js";

/**
 * Drives a terminal demo: types the command, runs it for real, then replays the
 * captured output on camera at a bounded pace.
 *
 * Splitting "run" from "show" is the whole trick. The command runs at whatever
 * speed it runs; the recording shows it at whatever speed reads well, with
 * frames synthesized at exact timeline positions. A 60-second install becomes
 * two seconds of film, and the result is byte-identical run to run.
 */
export class TerminalController {
  private readonly emu: TerminalEmulator;
  /** Text of every command run, for a useful error when an assertion fails. */
  private lastOutput = "";
  /** Rows the last `run` occupied — the camera target for `zoom: { to: output }`. */
  private lastRegion: GridRegion | null = null;
  /** Whether that command actually printed anything. */
  private lastPrinted = false;
  /** Whether the terminal layer is the visible surface. */
  private shown = false;

  constructor(
    private readonly page: Page,
    private readonly cfg: TerminalConfig,
    private readonly rec: Recorder,
    private readonly cwd: string,
  ) {
    this.emu = new TerminalEmulator(cfg.cols, cfg.rows, cfg.palette);
  }

  /**
   * Verify the demo's declared dependencies before anything is filmed.
   *
   * Runs in `check` as well as `record`: a drift check that silently recorded
   * "command not found" would be worse than one that failed.
   */
  checkRequirements(): void {
    checkRequirements(this.cfg.require);
  }

  /** Install the terminal layer (also called again after a navigation). */
  async install(): Promise<void> {
    await installTerminal(this.page, {
      cols: this.cfg.cols,
      rows: this.cfg.rows,
      theme: {
        background: this.cfg.background,
        foreground: this.cfg.foreground,
        fontSize: this.cfg.fontSize,
        fontFamily: this.cfg.fontFamily ?? DEFAULT_TERMINAL_FONT,
        title: this.cfg.title,
      },
    });
    await this.paint();
  }

  async show(which: "terminal" | "app"): Promise<void> {
    this.shown = which === "terminal";
    await showTerminal(this.page, this.shown);
  }

  /**
   * Whether the terminal is the surface on screen.
   *
   * A hybrid spec shows a command and then the app it affected, so `text=` has
   * to mean the grid in one moment and the DOM in the next. This is how the
   * camera tells them apart.
   */
  get visible(): boolean {
    return this.shown;
  }

  /** The text currently on screen — what assertions read. */
  screen(): string {
    return this.emu.text();
  }

  private async paint(): Promise<void> {
    if (this.rec.cinematic) {
      await renderTerminal(this.page, this.emu.spans(), this.emu.cursor());
    }
  }

  async clear(): Promise<void> {
    this.emu.reset();
    // The rows the last command occupied no longer hold it.
    this.lastRegion = null;
    this.lastPrinted = false;
    await this.paint();
    await this.rec.frameFor(180);
  }

  async expectOutput(text: string): Promise<void> {
    if (this.emu.text().includes(text)) return;
    throw new ReelError(
      `expectOutput failed: the terminal does not contain "${text}".`,
      `Last command printed:\n${this.lastOutput.slice(-400) || "(nothing)"}`,
    );
  }

  /**
   * Type a command, run it, and replay its output.
   *
   * The command is typed character by character (one frame each) so it reads as
   * typing; the output is replayed in chunks sized to fit the replay budget.
   */
  async run(opts: {
    cmd: string;
    input?: string;
    expectCode?: number;
    replayMs?: number;
    hidden?: boolean;
  }): Promise<void> {
    const { cmd } = opts;

    // Off-camera setup: run it, assert on it, show none of it. `lastRegion` and
    // `lastPrinted` are deliberately left alone — they describe the last thing
    // the viewer actually saw, which a hidden command hasn't changed.
    if (opts.hidden) {
      log.debug(`terminal (hidden): ${cmd}`);
      await this.execute(cmd, opts);
      return;
    }

    // Note where this command starts so the camera can frame it afterwards.
    // Rows are viewport-relative and the screen scrolls, so the start row is
    // re-based by however many times it scrolled while the command ran.
    const scrollsBefore = this.emu.scrollCount();
    const startRow = this.emu.cursor().y;

    // 1) Prompt and typed command.
    this.emu.write(this.cfg.prompt);
    await this.paint();
    for (const ch of cmd) {
      this.emu.write(ch);
      await this.paint();
      await this.rec.frameFor(this.cfg.typing);
    }
    this.emu.write("\n");
    await this.paint();
    await this.rec.frameFor(140);

    // 2) Run it for real.
    const result = await this.execute(cmd, opts);

    // 3) Replay the output.
    await this.replay(result.output, opts.replayMs ?? this.cfg.replayMs);

    const shifted = this.emu.scrollCount() - scrollsBefore;
    const row0 = Math.max(0, startRow - shifted);
    const row1 = Math.max(row0, this.emu.cursor().y);
    this.lastRegion = { row0, row1 };
    this.lastPrinted = result.output.length > 0;
  }

  /**
   * Run a command and apply its assertions. Shared by filmed and hidden runs so
   * that `expectCode`, the timeout and the error messages behave identically
   * whether or not the command appears on camera.
   */
  private async execute(
    cmd: string,
    opts: { input?: string; expectCode?: number },
  ): Promise<{ output: string; code: number }> {
    const result = await runCommand(cmd, {
      cwd: this.cwd,
      env: this.cfg.env,
      cols: this.cfg.cols,
      input: opts.input,
      timeoutMs: this.cfg.timeout,
    });
    this.lastOutput = result.output;

    if (result.timedOut) {
      throw new ReelError(
        `Command timed out after ${this.cfg.timeout}ms: ${cmd}`,
        "Raise `terminal.timeout`, or use a command that finishes faster.",
      );
    }
    if (opts.expectCode !== undefined && result.code !== opts.expectCode) {
      throw new ReelError(
        `Command exited ${result.code}, expected ${opts.expectCode}: ${cmd}`,
        result.output.slice(-400),
      );
    }
    return result;
  }

  /**
   * Rows the last command occupied — its prompt line through its final output.
   *
   * `printed` is false when the command was silent. Auto-zoom sits still in
   * that case: there is nothing new to look at, and moving the camera onto a
   * bare prompt reads as a twitch.
   */
  outputRegion(): { region: GridRegion; printed: boolean } | null {
    return this.lastRegion ? { region: this.lastRegion, printed: this.lastPrinted } : null;
  }

  /** The row the cursor is on — the live prompt line. */
  cursorRegion(): GridRegion {
    const y = this.emu.cursor().y;
    return { row0: y, row1: y };
  }

  /** Rows containing `needle`, matched against the same text `expectOutput` reads. */
  findRegion(needle: string): GridRegion | null {
    return findTextRegion(this.emu.text(), needle);
  }

  /** Narrow a region's columns to the text on those rows. */
  fit(region: GridRegion): GridRegion {
    return fitToContent(region, this.emu.text());
  }

  /** Grid width, for converting a region to pixels. */
  get cols(): number {
    return this.cfg.cols;
  }

  /** Feed the whole input to stdin of a command already described by `run`. */
  async send(text: string): Promise<void> {
    this.emu.write(text);
    await this.paint();
    await this.rec.frameFor(120);
  }

  /**
   * Write captured output to the screen over a bounded stretch of demo time.
   *
   * Chunks break after every newline *and* every carriage return, so a progress
   * bar that redraws its own line animates instead of snapping to its final
   * state.
   */
  private async replay(output: string, budgetMs: number): Promise<void> {
    if (!output) return;
    const pieces = output.split(/(?<=[\n\r])/).filter((p) => p.length > 0);

    if (!this.rec.cinematic || budgetMs <= 0) {
      this.emu.write(output);
      await this.paint();
      return;
    }

    // One frame per tick; never more ticks than there is content to show.
    const ticks = Math.max(1, Math.min(pieces.length, Math.round((budgetMs / 1000) * 30)));
    const per = pieces.length / ticks;
    const msPerTick = budgetMs / ticks;

    let written = 0;
    for (let i = 0; i < ticks; i++) {
      const upto = i === ticks - 1 ? pieces.length : Math.round((i + 1) * per);
      const chunk = pieces.slice(written, upto).join("");
      written = upto;
      if (chunk) this.emu.write(chunk);
      await this.paint();
      await this.rec.frameFor(msPerTick);
    }
    log.debug(`terminal replay: ${pieces.length} pieces over ${ticks} frames`);
  }
}
