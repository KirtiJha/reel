/**
 * Drives a branching interactive build in a real browser.
 *
 * Branching is the one feature where the recorder and the player have to agree
 * about a structure neither can see on its own: alternates are captured in a
 * separate pass, as stills, and the player splices them into a running order at
 * playback time. Only an end-to-end check proves the two halves line up.
 *
 * Usage: npm run test:branch [path/to/demo.html]
 */
import { chromium } from "playwright-core";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const target =
  process.argv[2] ?? resolve(process.cwd(), "examples/taskflow/out/branching.html");
if (!existsSync(target)) {
  console.error(
    `No branching build at ${target}\n` +
      "Record one first: `npx reel record examples/taskflow/branching.reel.yaml`.",
  );
  process.exit(2);
}
const file = pathToFileURL(target).href;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const fails: string[] = [];
const ok = (n: string, c: boolean, extra = "") => {
  console.log(`${c ? "  ok  " : "FAIL  "}${n}${extra ? ` — ${extra}` : ""}`);
  if (!c) fails.push(n);
};
page.on("pageerror", (e) => fails.push(`pageerror: ${e.message}`));

await page.goto(file);
await page.waitForTimeout(300);

const info = await page.evaluate(() => {
  const d = (window as any).reelDemo;
  return { total: d.total, scenes: d.scenes.length, branches: d.branches, choices: d.choices };
});
ok("a branch was recorded", info.branches.length === 1, JSON.stringify(info.branches[0]?.prompt));
ok("both paths captured scenes", info.branches[0].paths.every((p: any) => p.scenes.length > 0),
  info.branches[0].paths.map((p: any) => `${p.label}:${p.scenes.length}`).join(", "));
ok("default path is pre-selected", Object.values(info.choices)[0] === info.branches[0].paths.find((p: any) => p.isDefault).id);
ok("order is shorter than the flat scene list", info.total < info.scenes,
  `${info.total} of ${info.scenes} scenes in the running order`);

// Walk to the choice scene.
const atScene = info.branches[0].atScene;
await page.evaluate((n) => (window as any).reelDemo.go(n), 0);
let guard = 0;
while (guard++ < 40) {
  const s = await page.evaluate(() => (window as any).reelDemo.scene);
  if (s === atScene) break;
  await page.click("#next");
}
ok("reaches the choice scene", await page.locator("#choices").isVisible());
ok("shows the prompt", ((await page.textContent(".choice-prompt")) ?? "").length > 0,
  (await page.textContent(".choice-prompt")) ?? "");
ok("offers one button per path", (await page.locator("button.choice").count()) === 2);

// Default route: stepping forward enters the default path.
await page.click("#next");
const afterDefault = await page.evaluate(() => {
  const d = (window as any).reelDemo;
  return d.scenes[d.scene].path;
});
ok("default path is entered by stepping on", !!afterDefault, String(afterDefault));

// Switch to the other path from the choice UI.
await page.evaluate((n) => (window as any).reelDemo.go(n), 0);
guard = 0;
while (guard++ < 40) {
  const s = await page.evaluate(() => (window as any).reelDemo.scene);
  if (s === atScene) break;
  await page.click("#next");
}
const totalBefore = await page.evaluate(() => (window as any).reelDemo.total);
const other = await page.evaluate(() => {
  const d = (window as any).reelDemo;
  return d.branches[0].paths.find((p: any) => !p.isDefault);
});
await page.locator("button.choice", { hasText: other.label }).click();
await page.waitForTimeout(200);
const afterSwitch = await page.evaluate(() => {
  const d = (window as any).reelDemo;
  return { path: d.scenes[d.scene].path, total: d.total, choice: d.choices[d.branches[0].id] };
});
ok("choosing the other path selects it", afterSwitch.choice === other.id);
ok("and steps into it", afterSwitch.path === other.id, String(afterSwitch.path));
ok("the running order re-splices", typeof afterSwitch.total === "number" && afterSwitch.total > 0,
  `${totalBefore} → ${afterSwitch.total}`);

// Walking to the end from the alternate must reach the shared continuation.
guard = 0;
while (guard++ < 40) {
  const done = await page.evaluate(() => {
    const d = (window as any).reelDemo;
    return d.index >= d.total - 1;
  });
  if (done) break;
  await page.click("#next");
}
const tail = await page.evaluate(() => {
  const d = (window as any).reelDemo;
  return d.scenes[d.scene];
});
ok("the alternate rejoins the shared ending", !tail.path, `ends on "${tail.label}"`);

// A deep link into a path selects that path automatically.
const altScene = other.scenes[0];
await page.goto(`${file}#/step-${altScene + 1}`);
await page.waitForTimeout(250);
const deep = await page.evaluate(() => {
  const d = (window as any).reelDemo;
  return { scene: d.scene, choice: d.choices[d.branches[0].id] };
});
ok("deep link into a path lands on it", deep.scene === altScene, `${deep.scene} vs ${altScene}`);
ok("and auto-selects that path", deep.choice === other.id);

// The host API can choose a path too.
await page.evaluate(
  ([b, p]) => (window as any).reelDemo.choose(b, p),
  [info.branches[0].id, info.branches[0].paths.find((x: any) => x.isDefault).id] as [string, string],
);
await page.waitForTimeout(150);
ok(
  "host API can switch paths",
  (await page.evaluate(() => (window as any).reelDemo.choices))[info.branches[0].id] ===
    info.branches[0].paths.find((x: any) => x.isDefault).id,
);

// Autoplay must not answer the question for the viewer.
await page.evaluate((n) => (window as any).reelDemo.go(n), 0);
guard = 0;
while (guard++ < 40) {
  const s = await page.evaluate(() => (window as any).reelDemo.scene);
  if (s === atScene) break;
  await page.click("#next");
}
await page.click("#play");
await page.waitForTimeout(2500);
const stillThere = await page.evaluate(() => (window as any).reelDemo.scene);
ok("autoplay pauses at a choice instead of picking", stillThere === atScene, `scene ${stillThere}`);

await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED:\n - ${fails.join("\n - ")}` : "\nALL BRANCH CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
