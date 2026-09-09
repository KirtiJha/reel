---
name: reel
description: Build, render and verify a demo video of a web or terminal app with Reel — demos-as-code from a .reel.yaml spec. Use when asked to make, record, script or fix a product demo, screen recording, GIF or walkthrough video of an app; to write or edit a .reel.yaml; or when a `reel` command fails. Covers the spec grammar, the author→check→shoot loop, narration, and the determinism rules.
allowed-tools: Bash(npm run dev -- *) Bash(npx reel *) Bash(reel *) Read Write Edit Glob Grep
---

# Making a demo with Reel

Reel drives a **real app** in a real browser and films what actually happened.
That is the whole point, and the first rule follows from it:

> **Never hand-author a demo that pretends to be the product.** If you cannot
> drive it, say so. A demo that was not recorded from the running app can lie,
> and Reel's value is that its demos cannot.

## The loop

Work in this order. Each step is cheap and catches what the next one would make
expensive.

```bash
npm run dev -- init                      # scaffold a spec (or write one by hand)
npm run dev -- check   <spec>            # headless: does every step still work?
npm run dev -- narrate <spec>            # read the script; how long does it talk?
npm run dev -- direct  <spec>            # propose camera + annotations
npm run dev -- shoot   <spec> --out shot # footage.mp4 + shots.json for a film
npm run dev -- record  <spec> --draft    # standalone preview: small, fast, video only
npm run dev -- record  <spec>            # a standalone film, no composition
```

`npm run dev --` is the in-repo form. Installed, every command is `reel <verb>`.

**Two ways out.** `shoot` produces footage for a HyperFrames composition — that
is the path for a real demo film, and `reel-compose` covers it. `record`
produces a finished GIF/MP4 on its own, which is right when you want a quick
artefact and no film.

**Always `check` before either.** A check runs the same steps headlessly with
no rendering — it finds a broken selector in seconds instead of five minutes
into a recording.

**Always `--draft` before a full render.** On the bundled example a full render
is ~150s and a draft is ~41s. A draft is the same demo at 720p/15fps, video
only, speaking only narration already in the cache. It writes
`<name>.preview.mp4` and never touches the master or its fingerprint stamp.

Use `--only <beat>` to render just one named section at full quality when you
are tuning a single moment.

## Writing the spec

A spec is a YAML file: where the app is, how it is filmed, and the steps.

```yaml
name: TaskFlow — add a task
url: http://localhost:4321
viewport: { width: 1280, height: 800, scale: 2 }

run:                          # optional: Reel boots the app itself
  cmd: node server.mjs
  readyOn: http://localhost:4321

polish:
  frame: browser              # macOS window chrome + URL pill
  background: "linear-gradient(135deg, #2b3a67, #1a1f36)"
  fadeIn: 400
  fadeOut: 400

steps:
  - card: { title: "TaskFlow", say: "Capturing work should take one keystroke." }
  - type: { selector: "#task-input", text: "Ship the demo" }
  - click: role=button[name=Add]
  - expect: { selector: "#list li", count: 1 }     # assert, don't assume
  - highlight: { selector: "text=Ship the demo", shape: circle, until: done }
  - caption: "Click a task to complete it"
  - click: text=Ship the demo
  - beat: done

output:
  preset: share
  mp4: out/taskflow.mp4
```

For the complete step grammar — every step kind, every option — read
`reference/spec.md` in this skill directory. For camera, annotation, narration
and pacing, read `reference/direction.md`.

Two grammar facts worth knowing without opening either file:

- **Waits are on states, not time.** Use `waitFor`, `expect`, `waitForUrl`.
  Never add a `hold` to "let it finish" — the timeline is virtual, so a real
  wait costs no demo time and a fixed sleep is a race you will lose in CI.
- **A caption speaks its own text** when narration is on. `say:` overrides it
  for the ear; `say: false` keeps one caption silent.

For the title cards, chapter openers and claims — the parts that are *not*
footage — use `scene:` and pick a `look:`, and read the **`reel-scene`** skill
before designing one. It covers the ten looks, the seek contract a bespoke
composition obeys, and `reel scene` / `reel looks`, which shoot a contact sheet
so you can actually see the motion instead of guessing at it.

## Selectors

Ranked by how stable their *meaning* is, which is what survives a redesign:

| Prefer | Example |
|---|---|
| test id | `[data-testid=submit]` |
| role + name | `role=button[name=Add]` |
| label / placeholder | `[placeholder=Email]` |
| visible text | `text=Ship the demo` |
| id | `#task-input` |
| CSS path | `div > ul li:nth-child(2)` ← last resort |

Never resolve ambiguity by index. If two things match, name the one you mean.

`reel capture` writes selectors for you: it opens the app, you drive it, and it
emits a spec — including `say` lines and `highlight` marks from its toolbar.

## Things that break, and how not to break them

- **Output must stay byte-identical.** The same spec against the same app
  renders the same bytes. If you touch capture timing, overlay drawing or the
  encoder, verify with two runs and compare hashes. CI commits this media, so
  churn is a real regression.
- **A render never fetches.** Images and diagrams are read from disk. A network
  fetch at render time makes the output depend on someone's uptime. Download
  assets while *editing* (`assets/` beside the spec, committed like any input).
- **Narration is cached and committed.** `.reel-cache/voice/` holds the audio,
  keyed by voice + model + style + speed + text. A checkout renders the same
  words in the same voice with **no API key**. Commit it.
- **Diagrams are cached the same way.** `.reel-cache/diagram/` holds the
  rendered PNG; `mermaid` is only needed to draw one the first time.

## When something fails

Reel's errors carry a hint — read it, it usually names the fix. Beyond that:

- `npm run dev -- doctor` — can this machine record at all?
- `npm run dev -- heal <spec> --write` — the UI drifted; re-resolve broken
  selectors and repair the spec. Works offline for most drift.
- `REEL_KEEP_FRAMES=1` — keep the frame directory to inspect what was filmed.
- `--json` on any command — structured output, including the error and its hint.

`reference/troubleshooting.md` has the failure table.

## When to reach for Studio instead

`npm run dev -- ui` opens a local web UI. It is a *view onto these same
commands*, not a second implementation. Suggest it only for the parts that are
irreducibly visual or aural: hearing whether a line lands, seeing beats laid
out, picking an element by clicking it. Everything else is faster here.
