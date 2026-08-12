import pc from "picocolors";

let verbose = false;
export function setVerbose(v: boolean): void {
  verbose = v;
}

export type LogLevel = "info" | "step" | "ok" | "warn" | "error" | "debug" | "phase";
export interface LogEvent {
  level: LogLevel;
  msg: string;
}

/** Sinks receive every log event — used by the Studio UI to stream logs live. */
const sinks = new Set<(e: LogEvent) => void>();
export function addLogSink(fn: (e: LogEvent) => void): () => void {
  sinks.add(fn);
  return () => sinks.delete(fn);
}
function emit(level: LogLevel, msg: string): void {
  for (const s of sinks) {
    try {
      s({ level, msg });
    } catch {
      /* a broken sink must not break logging */
    }
  }
}

export const log = {
  info: (msg: string) => {
    console.error(pc.dim("›"), msg);
    emit("info", msg);
  },
  step: (msg: string) => {
    console.error(pc.cyan("→"), msg);
    emit("step", msg);
  },
  ok: (msg: string) => {
    console.error(pc.green("✓"), msg);
    emit("ok", msg);
  },
  warn: (msg: string) => {
    console.error(pc.yellow("!"), msg);
    emit("warn", msg);
  },
  error: (msg: string) => {
    console.error(pc.red("✗"), msg);
    emit("error", msg);
  },
  debug: (msg: string) => {
    if (verbose) console.error(pc.dim(`  ${msg}`));
    emit("debug", msg);
  },
  /** A headline line for phase boundaries. */
  phase: (msg: string) => {
    console.error(pc.bold(pc.magenta(`\n${msg}`)));
    emit("phase", msg);
  },
};

export class ReelError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "ReelError";
  }
}
