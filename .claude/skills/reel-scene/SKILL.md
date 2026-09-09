---
name: reel-scene
description: Design the parts of a Reel demo that are not the app — title cards, chapter openers, claims, stat hits, outros. Use when a demo's scenes look plain, generic or like slides; when asked to make a demo brighter, more animated, more cinematic or "like a launch film"; when choosing or customising a look; or when writing a bespoke `scene: { file: … }` composition. Covers the look catalogue, the seek contract every scene obeys, and the preview loop for judging motion.
allowed-tools: Bash(npm run dev -- *) Bash(npx reel *) Bash(reel *) Read Write Edit Glob Grep
---

# Designing a scene

A **scene** is the part of a demo that was never footage: the title, the chapter
opener, the claim between two sections, the number at the end. Everything else
Reel films from a real running app — see the `reel` skill, and do not confuse
the two. A scene may never depict the product. If you find yourself drawing a
fake dashboard in HTML, stop: that belongs in the app, and Reel exists so demos
cannot lie about it.

## Two ways to make one, and how to choose

**A template in a look** — one line of spec, nothing to maintain:

```yaml
polish:
  look: neon           # the whole film's visual identity
  accent: "#22d3ee"    # every look is built from this
steps:
  - scene:
      template: chapter
      eyebrow: Chapter three
      title: Branching paths
      slate: "03 · Chapter"
      slateNote: taskflow.app
      ms: 3200
```

**A composition of your own** — an HTML file, written for this one demo:

```yaml
  - scene: { file: scenes/opening.html, ms: 4000 }
```

Reach for a template first. Reach for a file when the demo needs something the
catalogue has no word for — a chart that draws itself, a logo lockup, a stat
that counts, a layout nobody anticipated. **Do not write a file to get a
different colour or font.** That is what looks are for, and a bespoke file is a
thing someone has to maintain forever.

## Step 1: pick a look, by looking

Never pick from the list of names. Render the catalogue and read the image:

```bash
npm run dev -- looks --accent "#22d3ee" --title "The demo's actual title"
```

That writes `.reel/looks.png` — ten identities, same words, same accent, side by
side. Open it with Read and choose. `--list` prints them as text if you only
need the names.

| Look        | Reach for it when                                    |
| ----------- | ---------------------------------------------------- |
| `aurora`    | The default. Calm, premium, safe with any accent.    |
| `neon`      | Launch films, hero titles. Loud on purpose.          |
| `swiss`     | Dev tools, data, APIs. Clinical and gridded.         |
| `editorial` | Claims and quotes. Serif, cream, unhurried.          |
| `brutal`    | One big announcement or a single number.             |
| `terminal`  | CLI demos and anything about code.                   |
| `blueprint` | Architecture, specs, systems diagrams.               |
| `poster`    | Chapter openers and section breaks.                  |
| `mono`      | When the app itself is the colour.                   |
| `dawn`      | Consumer apps, onboarding, anything friendly.        |

Set it once in `polish.look`. Override it on a single scene with `scene.look`
when a departure earns its keep — a `statement` in `editorial` between two
`neon` chapters lands harder than either alone. Two looks in a film is a
decision; four is a mess.

**A look never owns the accent.** Every backdrop in the catalogue is built out
of `polish.accent`, so the same look on two products is two pictures. Set the
accent to the brand's colour and leave it alone.

## Step 2: look at the motion

A scene is motion, and motion cannot be judged from source. Shoot it:

```bash
npm run dev -- scene --template chapter --look poster \
  --title "Branching paths" --eyebrow "Chapter three" --out .reel/sheet.png

npm run dev -- scene scenes/opening.html --out .reel/sheet.png   # your own file
```

That writes a contact sheet — the same document seeked at six positions and
tiled, weighted toward the entrance because that is where everything happens.
**Read the image.** You are looking for: does the title finish arriving before
the scene is half over? Is anything still blurred when it should be settled?
Does the backdrop move at all after the entrance? Is the type legible against
it at every position?

Iterate here. It takes seconds, and it is the only way to catch a scene that
reads as a slide.

## Writing a composition of your own

Everything above still applies; what follows is the contract.

### The three variables

Reel rewrites these on the document element once per output frame. They are the
only clock a scene gets.

| Variable | Range | What it is                                          |
| -------- | ----- | --------------------------------------------------- |
| `--p`    | 0 → 1 | Raw progress through the scene. Always moving.      |
| `--in`   | 0 → 1 | Arrival. Eased, spent by ~28% of the scene.         |
| `--out`  | 1 → 0 | Departure. 1 until ~84%, then ramps to 0.           |

```css
.title  { opacity: var(--in); transform: translateY(calc((1 - var(--in)) * .3em)); }
.bg     { transform: scale(calc(1 + var(--p) * .2)); }   /* moves all scene */
body    { opacity: var(--out); }                          /* leaves cleanly */
```

### The rules, and why each one exists

1. **No `animation`, no `transition`.** The determinism layer suppresses both in
   every document so an app's own motion cannot make two renders differ. A
   scene that used either would simply not move. This is not a style
   preference — it is the reason two renders match.
2. **Motion must be a pure function of the variables.** No `Date.now()`, no
   `requestAnimationFrame` accumulating state, no counters. Reel seeks to
   arbitrary positions and expects the same pixels every time.
3. **Never fetch.** No `<link>`, no `<script src>`, no webfont, no remote image.
   A scene that fetched would put someone else's uptime between a spec and its
   output. Inline the CSS, inline the SVG, base64 the image.
4. **Escape everything author-supplied.** A title ends up in a document that
   runs.
5. **Read `--p` somewhere.** A backdrop driven only by `--in` arrives and then
   sits still for the rest of the scene, which is exactly what makes a scene
   read as a slide.

### Motion the variables cannot express

Define `window.__reelScene.seek(p)`. Reel calls it after setting the variables,
once per frame. It must be **pure in `p`** — same `p`, same DOM, every time:

```html
<script>
  window.__reelScene = {
    seek(p) {
      const v = Math.round(p * 1284);           // a counting stat
      document.getElementById("n").textContent = v.toLocaleString();
    },
  };
</script>
```

Do not start timers in there. Do not append. Set state from `p` alone.

### A skeleton that obeys all of it

```html
<style>
  :root { --p: 0; --in: 0; --out: 1; }
  * { box-sizing: border-box; margin: 0; }
  html, body { height: 100%; overflow: hidden; }
  body {
    display: grid; place-items: center;
    background: #05060d; color: #fff; opacity: var(--out);
    font: 700 clamp(32px, 7vw, 96px)/1.05 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .glow {
    position: absolute; inset: -30%;
    background: radial-gradient(closest-side, #22d3ee, transparent 70%);
    filter: blur(70px);
    opacity: calc(var(--in) * .7);
    transform: scale(calc(1 + var(--p) * .25));   /* alive all scene */
  }
  h1 { position: relative; opacity: var(--in); transform: translateY(calc((1 - var(--in)) * .3em)); }
</style>
<div class="glow"></div>
<h1>Ship it</h1>
```

Then shoot it, read the sheet, and fix what you see.

## Making a demo feel like a film rather than a deck

These are cheap and they are most of the difference:

- **A slate.** `slate: "03 · Chapter"` plus `slateNote: taskflow.app` pins a
  numbered label in a corner for the whole scene. Nothing else on this list buys
  as much for as little.
- **Per-word arrival.** Templates already do it. In your own composition, wrap
  words in spans and give each its own slice of `--in`, overlapping heavily —
  a ripple, not a typewriter.
- **Scale contrast.** One very large element and everything else small. A frame
  where three things are medium-sized reads as a slide.
- **Let it leave.** Use `--out`. A scene that cuts at full opacity is a jump.
- **Fades between chapters.** `polish.fadeIn` / `fadeOut`, and a
  `transition: { kind: fade }` step between sections.
- **Keep it short.** 2.5–3.5s for a chapter opener. A scene held past its
  welcome is the most common way a demo drags.

## Common failures

| What you see                       | Why                                                    |
| ---------------------------------- | ------------------------------------------------------ |
| Nothing moves                      | Used `animation`/`transition`; the determinism layer removed it |
| Moves once, then freezes           | Everything reads `--in`; nothing reads `--p`           |
| Blank frames in the sheet          | A fetch failed silently — inline it                    |
| Title unreadable over the backdrop | Wrong look for a loud accent, or your own composition needs a plate behind the type |
| Two renders differ                 | Something in `seek()` is not pure in `p`               |

## Related

- `reel` — the demo loop itself: spec grammar, check, record, narration.
- `reel-polish` — camera, captions, highlights, fades, pacing.
- `src/scene/looks.ts` — the catalogue, if you are adding a look rather than
  using one. A new look is data; it should not need a change to `templates.ts`.
