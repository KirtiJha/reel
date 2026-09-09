# Reel — where the work stands

**Last updated:** 2026-09-09 · **Version:** 0.4.0

This is a handoff document. It says what Reel is now, what is finished, what is
not, and what to do next. Read it before picking the work back up.

> **All of this is on `main`.** The rescope branch
> `claude/bundle-unpack-push-kweov9` was merged in `6ea1d21`, so `main` carries
> every commit described below. The branch is now fully contained in `main` and
> has nothing left to merge.
>
> ```bash
> git checkout main && npm install
> ```

---

## 1. What Reel is now

Reel was rescoped. It used to render finished demo videos by itself. It now does
one job and hands off:

- **Reel films the real app.** It drives a browser — or a real terminal —
  through a scripted, asserted flow, records what happened, and writes down
  every beat, caption, click and keystroke it caused.
- **[HyperFrames](https://www.npmjs.com/package/hyperframes) cuts the film.**
  Compositions are HTML with `data-*` timing and one paused GSAP timeline,
  seeked once per frame and encoded with FFmpeg.

The seam between them is **`shots.json`**, the shot manifest.

This split exists because HyperFrames' own `capture` reads a website's *design*
so an agent can rebuild it — it has no way to drive a flow and film it. That gap
is exactly Reel's shape. Reel does not draw pictures of products; HyperFrames
does not drive apps.

HyperFrames is a **dependency** (`hyperframes`, `@hyperframes/core`), not
vendored and not reimplemented.

### The loop

```bash
reel check    demo.reel.yaml            # 1. does every step still work?
reel shoot    demo.reel.yaml --out shot # 2. footage.mp4 + shots.json
reel compose  shot/shots.json --out film --look coral   # 3. the scaffold

reel packets  film                      # 4. one bounded brief per scene
#    … author each scene from its packet …   ← 5. THE PASS. This is the film.
reel mark     film 1 2 3 4 5            # 6. as each author returns
reel assemble film                      # 7. rebuild the host

cd film
npx hyperframes check                   # 8. lint, layout, motion, contrast
npx hyperframes snapshot --at 3,8,15    #    seconds — LOOK at these
npx hyperframes render --fps 30         # 9. only when it is finished
```

**Step 5 is the job; the rest is plumbing.** `compose` writes a *scaffold* — real
and renderable and the same five scenes for every film Reel has ever composed.
The pass over the per-scene briefs is what makes it *this* product's film.

---

## 2. What is done

### 2.1 The rescope (`166d168`, `12d3099`, `e23cece`, `5e0a4cc`)

- `reel shoot` films the app and **nothing else** — no chrome, no burned-in
  captions, no title cards, no fades. Every one of those is now the
  composition's decision, and a decision baked into a frame cannot be unmade.
- `reel compose` emits a **canonical HyperFrames project**, in the layout their
  production loop assumes:

  ```
  frame.md                          design spec; tokens in frontmatter
  STORYBOARD.md                     the plan layer, and the contract
  hyperframes.json                  what makes the directory a project
  index.html                        assembly only: scenes on tracks
  compositions/frames/NN-*.html     one scene per file
  compositions/frames/media/        footage and its synthesized sound
  compositions/frames/fonts/        vendored woff2
  gsap.min.js                       vendored, never linked
  .hyperframes/reel-assembly.json   ground, bed, fps — what their format lacks
  .hyperframes/shots/<id>.json      the shot manifest, parked
  .hyperframes/frame-packets/       written by `reel packets`
  ```

- **One file per scene**, as sub-compositions. A monolithic composition renders
  fine and is still wrong: a scene you cannot open, snapshot and rewrite on its
  own is a scene nobody edits. It also turned out ~17× faster to render
  (3m13s vs 54min for a comparable film).

### 2.2 Looks and frame presets (`77b3f4b`, `5cc47d9`)

- `src/scene/looks.ts` — ten named visual identities as data: `aurora`, `neon`,
  `swiss`, `editorial`, `brutal`, `terminal`, `blueprint`, `poster`, `mono`,
  `dawn`.
- `src/scene/presets.ts` — reads HyperFrames' 13 installed `FRAME.md` frame
  presets and treats them as first-class identities. Their display type runs
  4.6–10.4cqw (88–422px at 1920), which is roughly twice what feels right when
  guessing and is most of what separates their frames from a first attempt.
- Fonts are **vendored at compose time** (real woff2, latin subset). Composing
  is authoring, so it may fetch; a *render* never does.

### 2.3 The deletion pass (`ed93df8`)

9,204 deletions across 62 files. The CI-drift half of Reel — byte-identical
output checks, visual diffing, the interactive player build, branch splicing —
was removed. It was a different product wearing the same name.

### 2.4 Audio (`3eae4a3`)

Three layers, all deterministic and offline:

- **Interaction sound** — `src/encode/sfx.ts` synthesizes clicks and keystroke
  texture from the cues the driver recorded, so a click lands on the exact
  frame the button went down.
- **Narration** — carried through the manifest. A line with no audio still
  travels as a `voiceover:` guide, so a demo that ships two-thirds narrated
  says so instead of being quietly mute.
- **A music bed** — `src/compose/music.ts` synthesizes an ambient pad. No
  licence to clear, nothing fetched. Ducked ~12dB under every spoken line,
  timed from the narration cues rather than measured off the waveform.

### 2.5 Real transitions (`498a786`)

Scenes used to fade themselves out, which HyperFrames' docs explicitly ban:
*"exit animations are BANNED except on the final scene — the transition IS the
exit."* A fade-out followed by a fade-in is a jump cut with a dip; it looks
correct in every still and stutters in motion.

The seams now live in `index.html`, the only layer that can see two scenes at
once. One primary (blur crossfade) plus one accent (overexposure flash into
chapter cards only), per their guidance. The flash contrasts with the *ground* —
white on a dark film, the look's ink on a light one, because white on cream has
no contrast to spend and blows the frame out.

`@hyperframes/shader-transitions` was evaluated and **ruled out**: it resolves
scenes by id in the host document, requires them to be `.scene` elements, owns
the whole running order, and rasterises through `drawElementImage` or
`html2canvas` — neither of which draws a `<video>` frame. It cannot transition
footage.

### 2.6 The authoring pass (`54c1db7`)

The gap that had been named at the end of every previous stage. `compose`
generated a whole film and marked its own output `status: animated`, which is a
claim that somebody authored it. Nobody had.

Underneath, one thing was wrong three ways: **compose was write-only.** It never
read `STORYBOARD.md` back, it built `index.html` from in-memory state, and
re-running it overwrote every scene file. So the only safe thing to do with a
composed project was to not touch it — the pass was not skipped, it *could not
be taken*.

Now:

| Command | Does |
| --- | --- |
| `reel packets [project]` | One bounded brief per scene + `_role.md`, the contract |
| `reel mark <project> <n…>` | Promote a frame as its author returns |
| `reel assemble [project]` | Rebuild `index.html` from the storyboard, never the scenes |
| `reel status [project]` | How far the pass has got |

- `src/compose/storyboard.ts` parses `STORYBOARD.md`, lenient the way theirs is
  (never throws; records surprises as warnings). This makes the file a contract
  rather than a report.
- Generated scenes are `status: built` — their exact middle rung.
- `compose` **refuses to clobber** a project holding an authored scene, by name,
  and points at `assemble`. `--force` means *start this film over*.

### 2.7 Time-coded shot sequences (`a860c2e`)

The pass had a mechanism but handed authors the wrong unit — a one-line label
instead of a build spec. Every scene now carries the windows it develops across:

```
Scene 1 (0.00–5.93s): cue: "Capture work in a snap" · beat `hero` at 0.95s ·
  click at 3.15s, type 3.15–4.23s. TODO — what is on screen, what moves, and
  where it sits.
```

**Reel gets the hard half for free.** In HyperFrames' loop a person writes the
whole sequence, because nothing knows where the beats are. Reel's driver caused
every moment and wrote down when — so the window boundaries are arithmetic over
recorded fact. What goes *inside* each window is the author's, and is marked
`TODO` rather than guessed: a plausible-sounding line nobody wrote is worse than
a blank, because it reads as a decision and gets built.

`STORYBOARD.md` also gained a `## Video direction` block, written once, so
parallel authors share one grammar.

**The unwritten window is a check, not a comment.** `reel status` counts them and
flags a scene marked `animated` that still has some — the first verifiable
signal in the pass. A status bullet is a claim; an unwritten window is evidence.

### 2.8 The showcase spec

`demo/whats-new.reel.yaml` exercises everything the direction added — narration
with `fit: flow`, `idleMotion`, diagrams, the lot. Its voice and diagram caches
are **committed** (`demo/.reel-cache/`), so it replays with no key and no
network.

### 2.9 Verification state

- **856 unit tests pass**, 173 suites. `npm test` needs no browser.
- `npm run typecheck` clean (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`).
- The example film passes `hyperframes check` with **0 errors, 0 warnings, 0
  layout issues, 8/8 WCAG AA**.
- Rendered end to end several times: 1920×1080, 30fps, 41.5s, ~8MB, AAC stereo,
  ~5m30s per render.

---

## 3. What is pending

Ordered by what would improve the product most.

### 3.1 Run the pass on a whole film — the obvious next step

Only **one scene of one film** has ever been through the authoring pass (the
title card, as a proof). Everything else in every film Reel has produced is
still the scaffold.

Concretely: take the example, write all 14 direction lines in `STORYBOARD.md`,
dispatch one author per scene, `mark`, `assemble`, `check`, render. That yields
the first film that has actually been through the loop — and it will surface
whatever is wrong with the loop, which nothing else will.

### 3.2 Blueprints — the shot shapes

HyperFrames ships `hyperframes-animation/blueprints/` — product-agnostic,
time-coded shot templates with `[slots]` and a named **signature move**. Their
Step 4 picks one per frame from a role→blueprint menu. Reel writes window
skeletons but names no shape, so every author invents one from scratch. This is
the largest remaining piece of their loop Reel does not have.

### 3.3 Colour grading — LUTs and the `media-use` chain

Their grade layer: LUTs, film emulation, the "real footage looks flat" fix.
Touches every footage frame at once, so it changes the whole film's feel for one
piece of work. Nothing in Reel does colour at all today.

### 3.4 Catalog blocks mounted in a real film

The registry has 155 blocks and 220 components. `reel blocks` de-CDNs installed
ones so they render offline, but **nothing has ever mounted one in an actual
cut**. Widens what a scene author can reach for without writing from zero.

### 3.5 Real narration end to end

The plumbing exists and has so far been exercised **only in its degraded path** —
every film produced to date is silent apart from the synthesized bed and the
interaction sound, because no session had a key.

**This is now cheap to test.** `demo/whats-new.reel.yaml` is a showcase spec
with a **warm voice cache committed** at `demo/.reel-cache/voice/` (six mp3s),
so `shoot` on that spec should resolve real narration with no key and no network
at all. Run it, `compose` it, and listen — that closes the last untested seam in
the audio chain. Nobody has done it yet.

### 3.6 Smaller, known

- **`hyperframes-audio`'s voiceover *carve*** — ducking only the bands the voice
  occupies rather than the whole bed, which is a better ducker than a volume
  tween. `<hf-audio-group>` would let the bed and effects share one fader.
- **Music that fits the look.** The bed is the same pad for every film; a
  `brutal` cut and an `editorial` one want different beds, and the look already
  knows which it is.
- **Shader transitions between cards.** Ruled out *between footage*, not
  everywhere. A film that is all cards could run their displacement wipes if the
  host learned to flatten a scene into a `.scene` element.
- **Their creation workflows** (`/product-launch-video` and friends) have not
  been adapted to Reel's shape.

---

## 4. Open decisions

These need a human, not more code:

1. **What happens to `reel record`?** The standalone path (drive the app, render
   a finished GIF/MP4 without a composition) still exists and still works. It
   overlaps the new path. Keep both, or deprecate one?
2. **Is `0.4.0` the version this ships as?** The rescope is breaking — the
   CI-drift half of the product was deleted, which is a scope change a released
   version should probably announce.
3. **Does the example film in the repo get re-shot and re-composed?**
   `examples/*/shot/shots.json` are committed and were produced before the
   authoring pass existed.

---

## 5. Working on it

```bash
git config core.hooksPath .githooks   # once per clone

npm run typecheck    # covers src, test and scripts
npm test             # unit tests, no browser
```

Commits are attributed solely to the person making them — **no `Co-Authored-By:`
trailers for AI assistants, no session-link trailers.** A `commit-msg` hook
strips them as a backstop; the message should not contain them in the first
place. See `CLAUDE.md`.

### Things that are easy to break

- **The sub-composition transport rule.** The runtime clones *only the contents
  of `<template>`* and discards the `<head>`. Every `<style>` and `<script>`
  must live inside the template, or the scene renders unstyled and unanimated
  with no error anywhere.
- **Style the scene root by `#root`, never a class on it.** At render the CSS is
  scoped to the composition id and a class selector on the root stops matching.
  Studio's preview still looks right — trust the rule, not the preview.
- **One string, three places.** The file stem, the `data-composition-id` and the
  `window.__timelines` key are one string. A mismatch passes lint and then waits
  45 seconds per scene at render before capturing static frames.
- **Never author an exit.** The transition is the exit; seams belong to
  `index.html`.
- **A render never fetches.** Composing may (that is how fonts are vendored); a
  render may not.
- **One tween per property per element.** Two tweens on one property depend on
  GSAP's overwrite order, which is not guaranteed.
- **The Studio derives everything from the zod schema** (`src/ui/summary.ts`).
  Add a step kind to the schema and the UI picks it up.
- **Touch `src/spec/schema.ts` → re-run `npm run schema`** and commit
  `schema/reel.schema.json`, or a test fails.

### Where the reasoning lives

`docs/direction.md` is the long-form record — 16 parts, each explaining why a
decision was made and what was tried first. Parts 14–16 cover transitions, the
authoring pass and shot sequences. Read it before reversing anything; most of
the non-obvious choices have a failed alternative behind them.

The skills in `.claude/skills/` are the operational versions of the same
knowledge: `reel` (the spec loop), `reel-compose` (the film loop and the
composition contract), `reel-scene` (designing the parts that are not footage),
`reel-polish` (fixing a demo that drags).

---

## 6. A concrete first session

If you want to pick this up without re-deciding anything, do §3.1. It is about
half a day and it will teach you more about what is broken than any amount of
reading.

```bash
git checkout main && npm install
git config core.hooksPath .githooks

# 1. Build the scaffold from footage that is already committed.
npx tsx src/cli.ts compose \
  examples/taskflow/shot/shots.json examples/cli/shot/shots.json \
  --out film --look coral --title "Reel" \
  --subtitle "Demos as code. Filmed from the real app."

# 2. See what is unwritten. Expect: 0 of 5 authored, 14 TODO.
npx tsx src/cli.ts status film
```

Then, in `film/STORYBOARD.md`, **write the direction into each Scene line** —
replace every `TODO` with what is on screen, what moves, and where it sits. The
windows are already correct; only the direction is missing. Read
`## Video direction` at the top first; it is the grammar all five scenes share.

```bash
# 3. Cut the briefs and dispatch one author per scene.
npx tsx src/cli.ts packets film      # read .hyperframes/frame-packets/_role.md
#    … each author writes exactly one compositions/frames/<id>.html …

# 4. Promote, reassemble, verify, render.
npx tsx src/cli.ts mark film 1 2 3 4 5
npx tsx src/cli.ts assemble film
npx tsx src/cli.ts status film       # expect: 5 of 5, 0 unwritten
cd film && npx hyperframes check && npx hyperframes snapshot --at 3,8,18,30,40
npx hyperframes render --fps 30      # ~5m30s
```

Watch for the two failures the whole design is aimed at: a scene that dumps its
canvas in the first quarter and then freezes, and a seam where the outgoing
scene is not fully visible when the transition starts.

## 7. The short version

Reel films real apps and HyperFrames cuts the film. The pipeline works end to
end and produces a clean, checked, rendered 41.5s film today. What it does not
yet produce is a film anybody *authored* — `compose` writes a scaffold, and the
mechanism for turning that into a real film now exists and has been used exactly
once, on one scene.

**Next: use it on a whole film.** That is both the most valuable thing left and
the thing most likely to reveal what is still wrong.
