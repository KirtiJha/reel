// Save an Aangan session for the demo to replay.
//
// Reel deliberately gives a spec nowhere to put a password, so a logged-in
// demo replays a session saved once, off camera. `reel capture --save-auth`
// does this interactively; Aangan is React-Native-Web with no <form> and no
// button roles, so it gets this small scripted equivalent instead.
//
// A session belongs to an origin, so the deployed app and a local dev server
// each need their own — hence the argument, and the origin in the filename.
//
//   AANGAN_PHONE=… AANGAN_PIN=… node demo/save-auth.mjs [baseUrl]
//
// Credentials come from the environment and are never written to the repo.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const phone = process.env.AANGAN_PHONE;
const pin = process.env.AANGAN_PIN;
if (!phone || !pin) {
  console.error("Set AANGAN_PHONE and AANGAN_PIN in the environment.");
  process.exit(1);
}

const base = (process.argv[2] ?? "https://my-aangan.vercel.app").replace(/\/+$/, "");
const host = new URL(base).host.replace(/[^a-z0-9]+/gi, "-");
const out = join(dirname(fileURLToPath(import.meta.url)), ".auth", `aangan-${host}.json`);
mkdirSync(dirname(out), { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
await page.goto(`${base}/sign-in`, { waitUntil: "domcontentloaded", timeout: 180_000 });
// The dev server bundles on first hit; the deployed build does not. Waiting for
// the fields rather than a fixed delay covers both.
await page.locator('input[type="tel"]').waitFor({ timeout: 180_000 });
await page.locator('input[type="tel"]').fill(phone);
await page.locator('input[type="password"]').fill(pin);
// Every control here is a <div>: no role, no form, nothing to submit.
await page.locator('div:text-is("Sign in")').last().click();
await page.waitForURL((u) => !u.pathname.includes("sign-in"), { timeout: 60_000 });
await page.waitForTimeout(4000);
await ctx.storageState({ path: out });
await browser.close();
console.log(`saved ${out}`);
