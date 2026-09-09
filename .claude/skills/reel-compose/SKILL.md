---
name: reel-compose
description: Cut a product or CLI demo film in HyperFrames around footage Reel shot of the real app. Use when asked to make a demo video, product launch video, feature announcement or CLI walkthrough that combines real app footage with motion graphics; when working with a shots.json manifest; or when editing a HyperFrames composition that contains Reel footage. Covers the shoot → compose → check → render loop and the composition contract.
allowed-tools: Bash(npm run dev -- *) Bash(npx reel *) Bash(reel *) Bash(npx hyperframes *) Read Write Edit Glob Grep
---

# Cutting a demo film

Two tools, one job each, and the split is the whole idea:

- **Reel** films the real app. It drives a browser (or a real terminal) through
  a scripted flow and records what actually happened.
- **HyperFrames** renders the film. Compositions are HTML with `data-*` timing
  and one paused GSAP timeline, seeked once per frame and encoded with FFmpeg.

Reel does not draw pictures of products, and HyperFrames does not drive apps.

> **Never fake the product.** If you cannot drive it, say so. A demo that was
> not filmed from the running app can lie, and the reason to shoot footage at
> all is that footage cannot.

## The loop

You are the orchestrator. Run the steps in order and pass each gate before
continuing.

```bash
npm run dev -- check   demo.reel.yaml            # 1. does every step still work?
npm run dev -- shoot   demo.reel.yaml --out shot # 2. footage.mp4 + shots.json
npm run dev -- compose shot/shots.json --out film --look aurora --accent "#22d3ee"
# several shoots become several chapters, in the order given:
npm run dev -- compose app/shots.json cli/shots.json --out film   # 3. the scaffold

npm run dev -- packets  film                     # 4. one brief per scene
#    … author each scene from its packet …       # 5. THE PASS — the actual work
npm run dev -- assemble film                     # 6. rebuild the host
npm run dev -- status   film                     # is the pass finished?

cd film
npx hyperframes check                            # 7. lint, layout, motion, contrast
npx hyperframes snapshot --at 3,8,15             # seconds — LOOK at these
npx hyperframes render --fps 30                  # 8. only when it is finished
```

**`snapshot` is the iteration loop, not `render`.** A snapshot is seconds; a
render is minutes. Use `render` when you believe it is finished.

### Step 5 is the job. The rest is plumbing.

`compose` writes a **scaffold**, and says so: every scene lands as
`status: built`, which in their ladder means *the HTML exists and the layout is
real, but nothing has been authored*. The scaffold is the same five scenes for
every film Reel has ever composed — a waterfall headline, a chapter card,
footage under a bottom band. Shipping it is how you get a film that looks
generated, because it was.

The pass is: **read one packet, author that one scene, mark it `animated`.**

- `reel packets` writes `.hyperframes/frame-packets/<frame_id>.md` per scene
  plus `_role.md` — the contract every author works under.
- Dispatch **one sub-agent per scene**, in parallel. Each gets `_role.md` and
  exactly one packet, pasted in full or handed as two paths. Nothing else.
  Workers never open `STORYBOARD.md` — N of them writing that file at once is a
  lost edit — and never run the CLI.
- A worker's terminal action is writing `compositions/frames/<frame_id>.html`.
  **You** mark the frame `animated` in `STORYBOARD.md` as each one returns.
- Then `reel assemble`, then `hyperframes check`. If a scene fails, re-dispatch
  that worker with the finding; the packet's own retry rule covers it.

`reel status` is the gate: it prints which scenes are still `built`. A film
delivered with scenes still marked `built` is a film nobody authored — say so
rather than shipping it quietly.

### Never re-run `compose` over an authored project

It rewrites every scene file, so it would destroy the pass. It refuses when the
storyboard holds an `animated` frame, and `--force` means *start this film
over*. To change timing, edit the `duration:` in `STORYBOARD.md` and run
`reel assemble` — the running order, the seams and the music ducking all follow.
Retiming a scene is a change to the plan, so re-author that scene to fill its
new length rather than leaving it to hold its last frame.

One thing snapshots do *not* show: decoded video frames. A snapshot over the
footage clip renders the graphics on an empty box. That is expected — judge
overlays and cards from snapshots, and check the footage itself in a render.

## What `shoot` gives you

`shoot` films the app and nothing else — no browser chrome, no burned-in
captions, no title cards, no fades. Every one of those is now the composition's
decision, and a decision baked into a frame cannot be unmade.

Alongside `footage.mp4` it writes `shots.json`:

```json
{
  "version": 1, "name": "TaskFlow", "footage": "footage.mp4",
  "width": 2560, "height": 1440, "fps": 30, "duration": 15.34,
  "beats":    [{ "label": "hero", "t": 0.95 }, { "label": "added", "t": 10.44 }],
  "captions": [{ "t": 0, "text": "Capture work in a snap" }]
}
```

**Cut against the beats.** They are the moments the driver *caused*, so they are
exact. A punch-in that lands on a beat reads as direction; the same move 200ms
late reads as a mistake, and you cannot tell the difference by eye afterwards.
Guessing timestamps by scrubbing the mp4 is the thing this file exists to
prevent.

Footage times are relative to the footage. In the composition, add the clip's
`data-start` to get composition time — the scaffold does this for you.

## What `compose` gives you, and what it does not

A **canonical HyperFrames project**, in the layout their production loop
assumes — not an ad-hoc directory that happens to render:

```
frame.md                       design spec; tokens in frontmatter, prose below
STORYBOARD.md                  the plan layer, and the contract `assemble` reads
hyperframes.json               what makes the directory a project
index.html                     assembly only: scenes as sub-compositions on tracks
compositions/frames/NN-*.html  one scene per file
compositions/frames/media/     footage and its synthesized sound
gsap.min.js                    vendored, never linked
.hyperframes/reel-assembly.json  ground, bed, fps — what their format has no field for
.hyperframes/shots/<id>.json     the shot manifest, parked for the packet builder
.hyperframes/frame-packets/      written by `reel packets`, one brief per scene
```

**`STORYBOARD.md` is read, not just written.** It is the running order:
`assemble` rebuilds `index.html` from it, `packets` cuts each brief from it, and
`compose` reads it to refuse to clobber work it did not write. Edit a
`duration:` there and the whole cut moves. That is the file to change, never
`index.html` — the assembler owns that one.

Each scene is its own sub-composition: a title card, a footage scene per shoot,
a chapter card before each shoot after the first, and a close. Lower thirds are
timed to the captions, the camera drifts across each shot and pushes in on its
beats, and the footage carries a synthesized sound bed built from the clicks and
keystrokes the driver recorded.

**Why one file per scene rather than one big index.** A monolithic composition
renders perfectly well and is still wrong: a scene you cannot open, snapshot and
rewrite on its own is a scene nobody edits. This is also the structure every one
of HyperFrames' own skills expects to find.

**Footage that is not the frame's aspect is inset, not cropped.** A terminal
sizes from its grid and a phone viewport is portrait; either one scaled to fill
1920×1080 would lose the thing the demo is about. They sit at 86% on the look's
ground instead, which reads as a framed window rather than as letterboxing
somebody forgot about.

**What it does not give you is a film.** Every scene is `status: built`: real,
renderable, and identical in shape to every other film Reel has composed. The
authoring pass above is where it becomes this product's film — a punch-in on the
beat that matters, a stat that counts, an idea rather than a headline centred on
a background. Do not ask `compose` for more options; that is how the generator
grew a template layer once already. Reach into the scene, which is where
HyperFrames intends the work to happen.

## Picking an identity

```bash
npm run dev -- looks --title "The demo's actual title"   # .reel/looks.png
```

Twenty-three identities, side by side, each in its own typeface and its own
accent: Reel's ten looks (`aurora` `neon` `swiss` `editorial` `brutal`
`terminal` `blueprint` `poster` `mono` `dawn`) and every installed HyperFrames
**frame preset** (`biennale-yellow` `blockframe` `blue-professional`
`bold-poster` `broadside` `capsule` `cartesian` `cobalt-grid` `code-editorial`
`coral` `creative-mode` `daisy-days` `editorial-forest`). Open the image and
choose; never pick from the names.

Presets are read from the installed `hyperframes-creative` skill rather than
copied into Reel — `npx hyperframes skills` installs them. Each is a complete
design system: palette, a full type ramp, spacing, component recipes and prose
about when it is right. Two things follow from using one:

- **Its typography is fetched at compose time and written into the project.**
  A render still never fetches; composing is authoring. Without this the preset
  renders in a system fallback, which is to say as not itself. `--no-fonts`
  skips it and falls back to `local()` faces.
- **A preset gets no accent bloom and no plate.** Every one of them is derived
  from print — paper, hairlines, graph grids, flat registers — and a radial glow
  behind the headline is the single element that says "not this system".

Their display type is the surprise: 4.6–10.4cqw, which is 88–200px at 1920 and
roughly twice what feels right when guessing. "One very large element" is the
rule it comes from, and Reel honours a preset's own scale rather than imposing
its own.

## Catalog blocks

The registry has 155 blocks and 220 components — shader transitions, code
reveals, chart races, terminal skins, lower thirds. Install them normally, then
**always run `reel blocks`**:

```bash
cd film
npx hyperframes add cinematic-zoom
npm run dev -- blocks .          # rewrite the block's CDN references
```

Every catalog block links GSAP from jsdelivr and its fonts from Google Fonts.
That is fine on a machine with open egress and fatal anywhere else — a blocked
script fails the render outright (`sub_timeline_script_failure`), and a blocked
*font* is worse because it fails silently, substituting a different typeface so
the block ships looking wrong rather than not at all. `reel blocks` re-points
GSAP at the project's vendored copy and re-declares the fonts as `local()`
faces, and leaves everything else exactly as the catalog wrote it.

Mount a block the way its install message says — a host clip with
`data-composition-src` — and give the host the same `data-composition-id` as the
block's own root.

## Audio

Three layers, and each one arrives differently.

**Interaction sound** is synthesized from the manifest's `sfx` cues — a tick per
click, key texture per typed field. A click landing on the exact frame the
button went down is not something an editor can place by ear afterwards,
because only the driver knows when the press happened. Nothing to configure.

**Narration** rides in the manifest as `narration`: text always, audio only when
the committed voice cache holds the line or `audio.voice` is configured to
synthesize it. Lines with no audio are *not* dropped — they land in
`STORYBOARD.md` as `voiceover:` guides and `shoot` says how many are missing.
A demo that quietly ships two-thirds narrated is worse than one that admits it
is silent.

**A music bed** is synthesized by default, ducking ~12dB under every spoken
line:

```bash
npm run dev -- compose shot/shots.json --out film                 # synthesized bed
npm run dev -- compose shot/shots.json --out film --music bed.mp3 # your own track
npm run dev -- compose shot/shots.json --out film --music none    # silence
```

Synthesized because a recording needs a licence — and a licence that suits this
repository is not necessarily the one that suits the demo you cut with it — and
because a render must not fetch. It is a slow four-chord pad, deliberately
plain: a bed under a product demo exists to stop silence being the loudest thing
in the room, and anything with an opinion competes with the narration and wins.

The duck spans come from the narration cues, not from analysing the audio: the
driver knows when each line starts because it scheduled it.

## The sub-composition contract

This is where the mount-time failures live, and none of them are caught by
reading the file on its own.

- **`<template>` is the transport container, not a wrapper.** The runtime
  fetches the file, parses it, and clones **only the contents of `<template>`**.
  Everything outside — including the entire `<head>` — is discarded. So
  `<style>` and `<script>` go *inside* the template, which is precisely where
  habit says they should not. A stylesheet in `<head>` passes every static check
  and ships a scene of unstyled text in the top-left corner.
- **Style the root by `#root`, never by a class.** At render the CSS is scoped
  to the composition id, so a class selector on the root stops matching.
- **Three strings must be identical:** the host's `data-composition-id`, the
  inner root's, and the `window.__timelines` key. A mismatch passes lint and
  then waits 45 seconds per scene at render before capturing static frames.
- **Composition ids must be valid CSS identifiers.** `00-title` is a fine
  filename and an invalid selector — `#00-title-v` throws a SyntaxError inside
  the scene's own timeline script.
- **Media inside a scene still needs `data-start` and `data-duration`.**
  HyperFrames cannot own playback for untimed media.
- **No asset path may climb above the project root.** A render rewrites `../`
  against the sub-composition's own path, but Studio and other live consumers
  resolve from the root and 404. Keep media beside the scenes that play it.
- **The index needs its own registered timeline.** A composition with no
  `window.__timelines` entry is an error even when every child has one.

## The composition contract

Read `/hyperframes-core` for the full thing. The parts that bite:

- **One paused timeline** per composition, at `window.__timelines["<id>"]`,
  keyed by the root's `data-composition-id`. Register it *after* it is built.
- **`data-start` is what makes an element a clip.** `data-duration` is required
  on `div` and `img`. The window is half-open: `[start, start + duration)`, so
  land an animation's end state slightly before the end or its last frame never
  renders.
- **Root needs an explicit pixel size** and a resolvable height chain, or
  content collapses into the top-left corner.
- **Never fetch.** No CDN `<script>`, no webfont, no remote image. Vendor it.
  A render that fetches fails outright in a sandbox — and every named font
  family needs an `@font-face`, `src: local("…")` for system faces, or
  `check` rejects it.
- **Determinism bans:** no `Date.now()` / `performance.now()`, no unseeded
  `Math.random()`, no hover/scroll/focus state, no `repeat: -1`. The renderer
  seeks frames out of order and in parallel.
- **Never tween `display` or `visibility` on a clip** — the framework owns clip
  visibility. Use `autoAlpha`.
- **Never pair a CSS `transform` with a GSAP tween on the same property.** Set
  the initial state in `gsap.fromTo(...)` instead.
- `<video>`/`<audio>` need an `id`. An id-less `<audio>` renders silent.
- **Never fade a clip element itself.** An opacity tween that ends on the clip's
  own boundary leaves stale state when the renderer seeks out of order
  (`gsap_exit_missing_hard_kill`). Put the content in an inner non-clip `<div>`,
  fade that, and add a zero-duration `tl.set(inner, { opacity: 0 }, end)`.
- **One tween per property per element.** Two tweens on the same property at the
  same time depend on GSAP's overwrite order, which is not guaranteed
  (`overlapping_gsap_tweens`). The scaffold hits this with the camera: the
  chapter drift and the beat punch are both `scale`, so the drift goes on an
  untimed wrapper and the punch on the video. Nested transforms multiply, so it
  composes correctly.

## Making it good rather than merely correct

- **Cut on beats.** Every camera move, card and callout should land on one.
- **Punch in on the moment that matters.** A `scale: 1.18` on the footage clip
  timed to a beat, held, then released, is the single highest-value edit.
- **Per-word titles.** A headline that arrives a word at a time reads as
  deliberate; the same headline fading in as a block reads as a slideshow.
- **Never write an exit.** Exit animations are banned except on the final
  scene: the outgoing scene must be *fully visible* when the transition starts,
  because **the transition is the exit**. A scene that fades itself out followed
  by one that fades itself in is a jump cut with a dip — it looks correct in
  every snapshot and stutters in motion. A real handoff animates both sides at
  the same instant, so it belongs in `index.html`, the only layer that can see
  both scenes; sub-compositions cannot reach each other. `transitionTweens()` in
  `src/compose/project.ts` writes them, and the scenes write none.
- **One primary transition plus one accent, for the whole film.** Never a
  different transition per scene. The scaffold's primary is a blur crossfade
  over the 0.5s the scenes already overlap by; the accent is an overexposure
  flash, and only into a chapter card.
- **Flash away from the ground.** White at a cut reads as overexposure on a dark
  film. On a cream ground it has no contrast to spend and blows the frame out,
  so a light look dips to its own ink instead.
- **Lower thirds go in a band at the bottom edge**, not floated over the
  picture. The footage is full-bleed and its content moves, so anything placed
  on it collides with the app eventually — and you find out per demo, after
  rendering.
- **Never fade an arrival.** Reveal each word with a zero-duration `tl.set` and
  whip it into place in 0.13–0.20s on `power4.out`, overlapping so the cascade
  accelerates. This is the `waterfall-entry` rule, and it is the single change
  that stops a title card reading as a slide. A 0.7s fade — which is what feels
  right when guessing — is four times too slow.
- **Let the backdrop keep moving.** A card whose background stops after the
  entrance reads as a slide. Tween it across the card's whole duration.
- **Keep cards short.** 2.5–3.5s. A card held past its welcome is the most
  common way a demo drags.

## Related

- `reel` — the spec grammar and the app-driving loop that produces footage.
- `reel-scene` — the look catalogue and the seek contract, in Reel's own terms.
- `/hyperframes-core`, `/hyperframes-animation`, `/hyperframes-cli` — the
  engine's own skills, if installed. They are the authority on the contract.
