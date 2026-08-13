import type { Page } from "playwright-core";
import type { TerminalConfig } from "../spec/schema.js";
import type { Recorder } from "../driver/recorder.js";
import { TerminalEmulator } from "./emulator.js";
import { runCommand } from "./session.js";
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

  constructor(
    private readonly page: Page,
    private readonly cfg: TerminalConfig,
    private readonly rec: Recorder,
    private readonly cwd: string,
  ) {
    this.emu = new TerminalEmulator(cfg.cols, cfg.rows);
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
    await showTerminal(this.page, which === "terminal");
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
  }): Promise<void> {
    const { cmd } = opts;

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

    // 3) Replay the output.
    await this.replay(result.output, opts.replayMs ?? this.cfg.replayMs);
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
