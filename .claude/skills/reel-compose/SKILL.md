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

```bash
npm run dev -- check   demo.reel.yaml            # does every step still work?
npm run dev -- shoot   demo.reel.yaml --out shot # footage.mp4 + shots.json
npm run dev -- compose shot/shots.json --out film --look aurora --accent "#22d3ee"
cd film
npx hyperframes check                            # lint, layout, motion, contrast
npx hyperframes snapshot --at 3,8,15             # seconds — LOOK at these
npx hyperframes render --fps 30
```

**`snapshot` is the iteration loop, not `render`.** A snapshot is seconds; a
render is minutes. Use `render` when you believe it is finished.

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

It scaffolds the boring 80%: the footage on the timeline at the right size, a
title card in a look, lower thirds already timed to the captions, a closing
card, GSAP vendored locally, `hyperframes.json`.

**Then you edit the HTML.** That is the point. Add a punch-in on a beat, a stat
that counts, a chapter card between sections, a callout on the element the
narration is about. Do not ask `compose` for more options — reach into the
composition, which is where HyperFrames intends the work to happen.

Pick the look by looking: `npm run dev -- looks --accent "#22d3ee"` renders the
catalogue side by side (`aurora` `neon` `swiss` `editorial` `brutal` `terminal`
`blueprint` `poster` `mono` `dawn`).

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

## Making it good rather than merely correct

- **Cut on beats.** Every camera move, card and callout should land on one.
- **Punch in on the moment that matters.** A `scale: 1.18` on the footage clip
  timed to a beat, held, then released, is the single highest-value edit.
- **Per-word titles.** A headline that arrives a word at a time reads as
  deliberate; the same headline fading in as a block reads as a slideshow.
- **Overlap the cuts.** Dissolve the title into the footage rather than
  splicing — the scaffold overlaps them by 0.5s.
- **Lower thirds go in a band at the bottom edge**, not floated over the
  picture. The footage is full-bleed and its content moves, so anything placed
  on it collides with the app eventually — and you find out per demo, after
  rendering.
- **Let the backdrop keep moving.** A card whose background stops after the
  entrance reads as a slide. Tween it across the card's whole duration.
- **Keep cards short.** 2.5–3.5s. A card held past its welcome is the most
  common way a demo drags.

## Related

- `reel` — the spec grammar and the app-driving loop that produces footage.
- `reel-scene` — the look catalogue and the seek contract, in Reel's own terms.
- `/hyperframes-core`, `/hyperframes-animation`, `/hyperframes-cli` — the
  engine's own skills, if installed. They are the authority on the contract.
