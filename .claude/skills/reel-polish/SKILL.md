---
name: reel-polish
description: Diagnose and improve an existing Reel demo that is boring, slow, frozen, badly paced or hard to watch. Use when a .reel.yaml renders correctly but the video drags, the picture sits still under narration, the camera never moves, or someone asks to make a demo more engaging. Measures frozen time with ffmpeg, then fixes it with audio.fit, idleMotion, highlight and fades.
argument-hint: [path/to/spec.reel.yaml]
allowed-tools: Bash(npm run dev -- *) Bash(npx reel *) Bash(reel *) Bash(./node_modules/ffmpeg-static/ffmpeg *) Read Write Edit Glob Grep
---

# Making an existing demo watchable

The demo records correctly. It is just hard to watch. **Measure first — an
impression of pacing is not evidence, and the fixes are cheap enough that
guessing wastes more time than measuring.**

## 1. Measure

If a render exists, measure it:

```bash
./node_modules/ffmpeg-static/ffmpeg -hide_banner -i <the rendered mp4> \
  -vf "freezedetect=n=-60dB:d=0.5" -map 0:v -f null - 2>&1 \
  | grep -oE "freeze_duration: [0-9.]+" | awk '{n++; s+=$2; if($2>m) m=$2}
      END {printf "%d freezes, %.1fs frozen, longest %.1fs\n", n, s, m}'
```

Two numbers decide everything: **frozen time as a fraction of the film**, and
**the longest single still**. For scale, Reel's own tour before this work:
`77 freezes, 589.3s frozen, longest 38.4s` — out of 618s. 95% frozen.

Then read the script:

```bash
npm run dev -- narrate <spec>
```

It flags every line long enough that the picture will wait for it, and gives
the total. Ten minutes of narration is roughly 1,400 words.

## 2. Diagnose

Check the spec for these, in this order. The first two explain almost all of it.

| Look for | Why it hurts |
|---|---|
| `audio.fit: stretch` | Grows the hold a line sits on until the sentence ends. **This is usually the whole problem.** |
| `polish.zoom: false` with no `idleMotion` | The camera never moves, so a narrated screen is one still image |
| No `highlight` steps | Nothing draws the eye during narration |
| Long `say`/`caption` lines | Each one is a stretch of held picture |
| `callout` used mid-flow | A callout dims the page and *stops the film* |
| No `fadeIn`/`fadeOut` | Chapters hard-cut into each other |

## 3. Fix, in order of leverage

**`audio.fit: flow`** — one line per spec, the single biggest win. Measured on
a fixture of the tour's chapter 3:

| | Duration | Frozen | Longest freeze |
|---|---|---|---|
| `stretch` | 51.4s | 19.2s (37%) | 14.5s |
| `flow` | 42.5s | 10.3s (24%) | 8.4s |
| `flow` + `idleMotion: drift` | 42.5s | **0.0s** | **0.0s** |

**`polish.idleMotion: drift`** — one line per spec. Required for terminal demos
(`zoom: false`), where `auto` deliberately holds still so text stays sharp.

**`polish.fadeIn: 400` / `fadeOut: 400`** — one line each. Makes separate
chapters read as one film.

**Highlights, not callouts** — `highlight` marks an element and lets the demo
keep running; `callout` dims everything and holds the timeline. Ask Reel to
propose them:

```bash
npm run dev -- direct <spec>            # propose, write nothing
npm run dev -- direct <spec> --write    # insert
```

Expect it to be quiet on terminal demos — there is no element to mark, and it
fires on a confident match or not at all.

**Split long lines** — `npm run dev -- say "<the rewrite>"` reports the real
duration of a replacement before you commit to it.

## 4. Verify

```bash
npm run dev -- record <spec> --draft    # fast: 720p, 15fps, video only
```

Watch it. Then render properly and measure again with the same command from
step 1. **State the before and after numbers.** If the longest still is still
tens of seconds, something above was not applied.

## What not to do

- **Do not reach for `trimIdle`.** It cannot tell dead air from a deliberate
  pause, so it crushes title cards to unreadable. Use `speed` or
  `output.targetDuration` to shorten a paced demo.
- **Do not add holds to slow things down.** The timeline is virtual; author
  duration is the only lever, and `speed` scales all of it coherently.
- **Do not re-cut a demo into a hand-authored animation.** The value is that it
  filmed the real app. Polish the recording; never replace it.
