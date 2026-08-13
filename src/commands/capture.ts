import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { BINDING, OBSERVER_SCRIPT, type ObservedEvent } from "../authoring/observe.js";
import { toSteps, type CaptureEvent } from "../authoring/steps.js";
import { emitSpec } from "../authoring/emit.js";
import { log, ReelError } from "../util/log.js";

/**
 * `reel capture` — author a demo by performing it.
 *
 * The gap this closes is the first five minutes. Writing a spec means knowing
 * the selector vocabulary before you have anything to show for it, and the
 * honest answer to "what do I put here" has been "open devtools". Driving the
 * app and getting a draft back inverts that: you start from something that
 * already replays, and edit it into the demo you wanted.
 *
 * What comes out is a draft and is described as one. Capture can see what was
 * clicked; it can't see which moment was the point, and a tool that pretended
 * otherwise would produce demos with no shape. The toolbar therefore asks for
 * the two things only a person knows — captions, and where the beats fall.
 */

export interface CaptureOptions {
  url: string;
  out: string;
  name?: string;
  /** Overwrite an existing spec instead of refusing. */
  force?: boolean;
}

export async function capture(opts: CaptureOptions): Promise<{ file: string; steps: number }> {
  const file = resolve(process.cwd(), opts.out);
  if (!opts.force && (await exists(file))) {
    throw new ReelError(`${file} already exists.`, "Pass --force to overwrite it, or -o another path.");
  }

  let browser: Browser | null = null;
  const events: CaptureEvent[] = [];

  try {
    // Headed, unlike everything else Reel does: the whole point is that a
    // person is driving.
    browser = await chromium.launch({ headless: false }).catch((err: Error) => {
      throw new ReelError(
        `Could not open a browser: ${err.message.split("\n")[0]}`,
        "Run `reel doctor` — capture needs a Chromium that can open a window.",
      );
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

    let finish: () => void = () => {};
    const finished = new Promise<void>((r) => {
      finish = r;
    });

    await context.exposeBinding(BINDING, (_source, event: ObservedEvent) => {
      if (event?.type === "finish") {
        finish();
        return;
      }
      if (event?.type) events.push(event as CaptureEvent);
    });
    await context.addInitScript({ content: OBSERVER_SCRIPT });

    const page = await context.newPage();
    // Every navigation, including the ones the app makes for itself, so a
    // captured demo waits for the page it is about to act on.
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) events.push({ type: "nav", url: frame.url() });
    });
    // Closing the window is the other way to say you're done, and the one
    // people reach for first.
    page.on("close", () => finish());
    context.on("close", () => finish());

    log.phase("Capturing");
    log.info(`Opening ${opts.url}`);
    log.info("Use the app as you would in the demo.");
    log.info("Add captions and beats from the toolbar, then press Finish (or close the window).");

    await page.goto(opts.url, { waitUntil: "domcontentloaded" }).catch((err: Error) => {
      throw new ReelError(
        `Could not open ${opts.url}: ${err.message.split("\n")[0]}`,
        "Start the app first, or pass the URL it's actually serving on.",
      );
    });

    await finished;

    const { steps, skipped } = toSteps(events, opts.url);
    log.phase("Draft");
    for (const s of skipped) log.warn(`Skipped: ${s}`);
    if (steps.length === 0) {
      log.warn("Nothing was captured — the spec is a starting point rather than a recording.");
    }

    await writeFile(
      file,
      emitSpec({
        name: opts.name ?? "Captured demo",
        url: opts.url,
        steps,
        gif: "out/demo.gif",
        mp4: "out/demo.mp4",
      }),
      "utf8",
    );

    log.ok(`${steps.length} ${steps.length === 1 ? "step" : "steps"} → ${file}`);
    log.info("Read it before you record it — capture drafts, you direct:");
    console.error(`    reel record ${opts.out}`);
    return { file, steps: steps.length };
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
