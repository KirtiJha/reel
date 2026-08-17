/**
 * Proves that what `reel capture` writes down actually replays.
 *
 * The unit tests cover the judgements — which selector, which events collapse —
 * against synthetic input. What they can't reach is whether the observer sees a
 * real page the way it thinks it does: whether the accessible name it computes
 * is the one Playwright will resolve, whether a click into a field really
 * arrives before the keystrokes, whether the selectors it picks find anything
 * at all on a second visit.
 *
 * So this drives the example app for real, captures a spec from it, and then
 * runs that spec with `reel check` — the same drift check CI uses. A capture
 * that produces a spec the driver can't replay is worse than useless, and this
 * is the only test that can catch it.
 *
 * Usage: npm run test:capture
 */
import { chromium } from "playwright-core";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BINDING, OBSERVER_SCRIPT, type ObservedEvent } from "../src/authoring/observe.js";
import { toSteps, type CaptureEvent } from "../src/authoring/steps.js";
import { chooseSelector, roleSelector, type Candidate } from "../src/authoring/selector.js";
import { toPlaywrightSelector } from "../src/overlay/overlay.js";
import { emitSpec } from "../src/authoring/emit.js";
import { startApp } from "../src/driver/app.js";
import { loadSpec } from "../src/spec/load.js";
import { check } from "../src/driver/run.js";
import { setVerbose } from "../src/util/log.js";

const URL_ = "http://localhost:4399";
const fails: string[] = [];
const ok = (name: string, condition: boolean, extra = ""): void => {
  console.log(`${condition ? "  ok  " : "FAIL  "}${name}${extra ? ` — ${extra}` : ""}`);
  if (!condition) fails.push(name);
};

const app = await startApp({
  cmd: "node server.mjs",
  cwd: resolve(process.cwd(), "examples/taskflow"),
  readyOn: URL_,
  env: { PORT: "4399" },
  timeout: 30_000,
});

const browser = await chromium.launch({ headless: true });
const events: CaptureEvent[] = [];

try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 720 } });
  await context.exposeBinding(BINDING, (_s, e: ObservedEvent) => {
    if (e?.type && e.type !== "finish") events.push(e as CaptureEvent);
  });
  await context.addInitScript({ content: OBSERVER_SCRIPT });

  const page = await context.newPage();
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) events.push({ type: "nav", url: f.url() });
  });
  await page.goto(URL_, { waitUntil: "domcontentloaded" });

  // Do what a person demoing this app would do.
  await page.click("#task-input");
  await page.type("#task-input", "Ship the Reel demo", { delay: 10 });
  await page.getByRole("button", { name: "Add" }).click();
  await page.waitForSelector("text=Ship the Reel demo");
  await page.click("#task-input");
  await page.type("#task-input", "Write the README", { delay: 10 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);

  ok("the page reported events", events.length > 0, `${events.length} events`);

  const { steps, skipped } = toSteps(events, URL_);
  console.log(steps.map((s) => "    " + JSON.stringify(s)).join("\n"));

  ok("typing collapsed into whole-field steps", steps.filter((s) => "type" in s).length === 2,
    JSON.stringify(steps.filter((s) => "type" in s)));
  ok(
    "the text is the text that was typed",
    steps.some((s) => "type" in s && (s as any).type.text === "Ship the Reel demo"),
  );
  ok("the focus click is not a step of its own",
    !steps.some((s) => "click" in s && (s as any).click.includes("task-input")));
  ok("the Add button was named, not path-selected",
    steps.some((s) => "click" in s && /role=|data-test|^#/.test((s as any).click)),
    JSON.stringify(steps.filter((s) => "click" in s)));
  ok("Enter was recorded as a key press", steps.some((s) => "press" in s));
  ok("nothing was silently dropped", skipped.length === 0, skipped.join("; "));

  // The real test: hand the captured spec back to the driver.
  const dir = await mkdtemp(join(tmpdir(), "reel-capture-selftest-"));
  const file = join(dir, "captured.reel.yaml");
  await writeFile(
    file,
    emitSpec({ name: "Captured", url: URL_, steps, gif: "out/demo.gif" }),
    "utf8",
  );

  setVerbose(false);
  let replayed = true;
  let why = "";
  try {
    await check(await loadSpec(file));
  } catch (err) {
    replayed = false;
    why = (err as Error).message.split("\n")[0] ?? "";
  }
  ok("the captured spec replays against the app", replayed, why);

  // Two shapes the example app doesn't have and real apps all do, taken from a
  // Docusaurus site: an icon button whose click lands on the <path> inside its
  // <svg>, and the same link name in two regions. Served over http rather than
  // set with setContent so the init script installs the way it does in a real
  // capture.
  const probe = await context.newPage();
  const label = "Switch between dark and light mode (currently system mode)";
  await probe.route("**/__probe", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <nav><a href="#docs">Tutorial</a></nav>
        <main>
          <a href="#docs">Tutorial</a>
          <button aria-label="${label}">
            <svg width="16" height="16" viewBox="0 0 16 16"><path d="M1 1 L15 15"/></svg>
          </button>
        </main>`,
    }),
  );
  await probe.goto(`${URL_}/__probe`, { waitUntil: "domcontentloaded" });

  const clicked = async (target: string): Promise<Candidate[]> => {
    const seen = events.length;
    await probe.click(target);
    await probe.waitForTimeout(250);
    const event = events.slice(seen).find((e): e is ObservedEvent => e.type === "click");
    return (event?.candidates ?? []) as Candidate[];
  };

  const icon = await clicked("svg path");
  ok(
    "a click on an icon is named after its button, not path-selected",
    chooseSelector(icon) === roleSelector("button", label),
    JSON.stringify(chooseSelector(icon)),
  );

  const link = await clicked("nav a");
  const scoped = chooseSelector(link);
  ok("an ambiguous name is qualified by its region", scoped === "nav >> role=link[name=Tutorial]", String(scoped));
  // The point of the whole exercise: Playwright has to agree that this names
  // one element. A scope that reads well and resolves to two is worse than the
  // CSS path it replaced.
  ok(
    "and Playwright resolves it to exactly one element",
    scoped !== null && (await probe.locator(toPlaywrightSelector(scoped)).count()) === 1,
    scoped ? `${await probe.locator(toPlaywrightSelector(scoped)).count()} matches` : "no selector",
  );
} finally {
  await browser.close().catch(() => {});
  await app.stop().catch(() => {});
}

if (fails.length) {
  console.error(`\n${fails.length} failed:\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
console.log("\nAll capture self-tests passed.");
