/**
 * Drives the generated interactive build in a real browser.
 *
 * The player ships as one self-contained file with its own router, autoplay and
 * host API — none of which a unit test can exercise. This is the only way to
 * know the thing people actually open works. Kept out of `npm test` because it
 * needs Chromium and a recorded demo.
 *
 * Usage: npm run test:player [path/to/demo.html]
 */
import { chromium } from "playwright-core";
import { pathToFileURL } from "node:url";
import { writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const target =
  process.argv[2] ?? resolve(process.cwd(), "examples/taskflow/out/showcase.html");
if (!existsSync(target)) {
  console.error(
    `No interactive build at ${target}\n` +
      "Record one first, e.g. `npx reel record examples/taskflow/showcase.reel.yaml`.",
  );
  process.exit(2);
}
const file = pathToFileURL(target).href;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const fails: string[] = [];
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) fails.push(name);
};

page.on("pageerror", (e) => fails.push(`pageerror: ${e.message}`));

await page.goto(file);
await page.waitForTimeout(300);

// --- initial render ---
const total = await page.evaluate(() => (window as any).reelDemo.scenes.length);
ok("renders a frame", (await page.getAttribute("#shot", "src"))?.startsWith("data:image/") === true);
ok("counter shows position", (await page.textContent("#counter"))?.trim() === `1 / ${total}`);
ok("chapters rendered", (await page.locator("#chapters .chip").count()) > 0);
ok("ticks match scene count", (await page.locator("#track .tick").count()) === total);

// --- navigation ---
await page.click("#next");
ok("next advances", (await page.textContent("#counter"))?.trim() === `2 / ${total}`);
ok("next pushes a deep link", page.url().includes("#/"), page.url().split("#")[1] ?? "");
await page.click("#prev");
ok("prev goes back", (await page.textContent("#counter"))?.trim() === `1 / ${total}`);

await page.keyboard.press("ArrowRight");
ok("arrow key advances", (await page.textContent("#counter"))?.trim() === `2 / ${total}`);
await page.keyboard.press("End");
ok("End jumps to the last scene", (await page.textContent("#counter"))?.trim() === `${total} / ${total}`);
ok("last scene offers a restart", (await page.textContent("#next"))?.includes("Restart") === true);
await page.keyboard.press("Home");
ok("Home returns to the first", (await page.textContent("#counter"))?.trim() === `1 / ${total}`);
ok("Back is disabled at the start", await page.isDisabled("#prev"));

// --- deep link by chapter slug ---
const slug = await page.evaluate(() => (window as any).reelDemo.scenes.find((s: any) => s.slug)?.slug);
const idx = await page.evaluate(
  (s) => (window as any).reelDemo.scenes.findIndex((x: any) => x.slug === s),
  slug,
);
await page.goto(`${file}#/${slug}`);
await page.waitForTimeout(200);
ok(`deep link #/${slug} lands on its scene`, (await page.textContent("#counter"))?.trim() === `${idx + 1} / ${total}`);

// --- deep link by step number ---
await page.goto(`${file}#/step-3`);
await page.waitForTimeout(200);
ok("deep link #/step-3 lands on step 3", (await page.textContent("#counter"))?.trim() === `3 / ${total}`);

// --- history ---
await page.click("#next");
await page.goBack();
await page.waitForTimeout(200);
ok("browser Back restores the previous scene", (await page.textContent("#counter"))?.trim() === `3 / ${total}`);

// --- autoplay uses recorded durations ---
await page.goto(`${file}#/step-1`);
await page.waitForTimeout(200);
const ms = await page.evaluate(() => (window as any).reelDemo.scenes[0].ms);
ok("scene carries a recorded duration", typeof ms === "number" && ms > 0, `${ms}ms`);
await page.click("#play");
ok("play toggles to pause", (await page.textContent("#play"))?.includes("Pause") === true);
await page.waitForTimeout(Math.min(ms + 500, 4000));
const after = (await page.textContent("#counter"))?.trim();
ok("autoplay advanced on its own", after !== `1 / ${total}`, `now ${after}`);
await page.click("#play");
ok("play toggles back", (await page.textContent("#play"))?.includes("Play") === true);

// --- embed mode ---
await page.goto(`${file}?embed=1`);
await page.waitForTimeout(200);
ok("embed hides the header", !(await page.locator("header").isVisible()));
ok("embed hides the control bar", !(await page.locator(".bar").isVisible()));
ok("embed still renders the stage", await page.locator("#stage").isVisible());

// --- postMessage API, as a real host page would use it ---
// The host must itself be a file:// page — Chromium blocks a file:// iframe
// inside an about:blank document, which has nothing to do with the player.
const hostPath = resolve(dirname(target), ".reel-host.html");
await writeFile(
  hostPath,
  `<!doctype html><meta charset="utf-8"><iframe id="f" src="./${basename(target)}?embed=1" width="900" height="600" style="border:0"></iframe>`,
  "utf8",
);
const host = await browser.newPage();
await host.goto(pathToFileURL(hostPath).href);
await host.waitForTimeout(800);
const events = await host.evaluate(async () => {
  const seen: any[] = [];
  window.addEventListener("message", (e) => seen.push(e.data));
  const f = document.getElementById("f") as HTMLIFrameElement;
  f.contentWindow!.postMessage({ type: "reel:go", index: 4 }, "*");
  await new Promise((r) => setTimeout(r, 400));
  return seen;
});
const scene = events.find((e: any) => e?.type === "reel:scene" && e.index === 4);
ok("host can drive the demo via postMessage", !!scene, JSON.stringify(scene ?? events.slice(-1)));
ok("player reports scene changes to the host", events.some((e: any) => e?.type === "reel:scene"));

// --- accessibility surface ---
await page.goto(file);
await page.waitForTimeout(200);
ok("stage is focusable", (await page.getAttribute("#stage", "tabindex")) === "0");
ok("live region announces", ((await page.textContent("#live")) ?? "").includes("Step 1"));
ok("image has real alt text", ((await page.getAttribute("#shot", "alt")) ?? "").length > 0);

await browser.close();
await rm(hostPath, { force: true });
console.log(fails.length ? `\n${fails.length} FAILED:\n - ${fails.join("\n - ")}` : "\nALL PLAYER CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
