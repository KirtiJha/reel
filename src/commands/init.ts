import { writeFile, mkdir, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { schemaDirective } from "./schema.js";
import { log, ReelError } from "../util/log.js";

/** Scaffold a starter spec so a new user is one edit away from a demo. */
export async function initSpec(
  dir: string,
  opts: { url: string; name: string },
): Promise<void> {
  const target = resolve(process.cwd(), dir);
  await mkdir(target, { recursive: true });
  const file = join(target, "demo.reel.yaml");

  try {
    await access(file);
    throw new ReelError(`${file} already exists.`, "Delete it or pick another directory.");
  } catch (err) {
    if (err instanceof ReelError) throw err;
    // ENOENT — good, the file does not exist yet.
  }

  await writeFile(file, template(opts), "utf8");
  log.ok(`Created ${file}`);
  log.info("Edit the steps, then run:");
  console.error(`    ${"reel record " + file}`);
}

function template(opts: { url: string; name: string }): string {
  // The schema line comes first so an editor picks it up before anything else
  // is typed: completion and validation from the first keystroke is most of
  // what makes a spec pleasant to write.
  return `${schemaDirective()}
# Reel demo spec — https://github.com/KirtiJha/reel
name: ${opts.name}
url: ${opts.url}
viewport: { width: 1280, height: 800, scale: 2 }
theme: light

# Make the app reproducible so \`reel check\` is stable in CI.
deterministic:
  disableAnimations: true
  freezeClock: "2026-01-01T12:00:00Z"
  locale: en-US                  # pin formatting so CI renders what you recorded
  timezone: UTC

polish:
  zoom: auto
  cursor: smooth
  captions: true
  frame: none                    # none · browser · window (device chrome)
  accent: "#6d8bff"              # ripple, callout ring, title-card rule
  # background: "linear-gradient(135deg, #2b3a67, #1a1f36)"

# Boot the app under test (optional — omit if it's already running).
# run:
#   cmd: npm run dev
#   readyOn: ${opts.url}

steps:
  - goto: /
  - card: { title: "${opts.name}", subtitle: "What it does, in one line" }
  - caption: "Here's the thing you built"
  - beat: hero
  # - click: text=Get started
  # - type: { selector: "#email", text: "you@acme.com" }
  # - click: role=button[name=Continue]
  # - waitFor: text=Welcome        # state-based, not sleep()
  # - expect: { selector: "h1", text: "Welcome" }   # assert, don't assume
  # - callout: { selector: "#inbox", text: "Everything lands here" }
  # - scroll: { to: "#pricing" }   # cinematic pan down a long page
  # - caption: "You're in — no config"
  # - beat: done

output:
  # preset: share (default) · readme · social · hq · docs
  preset: share
  mp4: docs/demo.mp4
  gif: docs/demo.gif
  # html: docs/demo.html        # self-contained interactive click-through
`;
}
