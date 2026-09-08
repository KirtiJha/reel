# Making a demo watchable

A demo that records correctly can still be unwatchable. This is what goes
wrong, measured on Reel's own ten-minute tour, and what fixes it.

## The failure mode, with numbers

The tour was the best demo the tool had produced, and:

| Measure | Value |
|---|---|
| Visual changes across 10:18 | 100 — one every 6.2s |
| Frozen picture | 589.3s of 618s (95%) |
| Longest single still | 38.4s (by `freezedetect`) |
| `callout` directions in ten chapters | 0 |

Three times, one still image held for most of a minute under a voiceover.

Two causes, and neither is a bug — they are right answers to questions asked
one at a time:

1. **Narration blocked the picture.** `audio.fit: stretch` grows the hold a
   line sits on until the sentence finishes.
2. **The camera only reacted to interaction.** `zoom: auto` eases toward
   whatever is clicked. During narration nothing is clicked, so the camera had
   no reason to move — exactly when the picture most needed it.

## The fixes, in order of leverage

### 1. `audio.fit: flow`

The default now, but check an older spec for an explicit `stretch`. Measured on
a fixture of the tour's chapter 3:

| | Duration | Frozen | Longest freeze |
|---|---|---|---|
| `stretch` | 51.4s | 19.2s (37%) | 14.5s |
| `flow` | 42.5s | 10.3s (24%) | 8.4s |
| `flow` + `idleMotion: drift` | 42.5s | **0.0s** | **0.0s** |

### 2. `polish.idleMotion: drift`

Where the picture is genuinely static, drift the camera. It costs nothing — the
frames are already on disk and the camera is already interpolated per output
frame — and it is the difference between a demo and a slideshow.

`auto` follows the camera: it drifts where `zoom: auto` and holds still where
`zoom: false`. That default exists because `zoom: false` is usually a terminal
demo, where pushing in would blur the text the demo exists to show. An explicit
`drift` is how a terminal chapter opts in.

### 3. `highlight`, not `callout`

The tour had zero callouts because every one of them would have stopped the
film. A highlight marks an element and gets out of the way — nothing dims, the
camera does not move, the timeline does not pause.

```yaml
- highlight: { selector: "text=Green Valley", shape: circle, label: "your society", until: dish }
```

`until:` is what lets an annotation outlive the step that drew it.

### 4. Fades at the ends

```yaml
polish:
  fadeIn: 400
  fadeOut: 400
```

What makes several chapters read as one piece. Chapters are joined with a
stream copy — that copy is why the picture that ships is the picture that was
verified — so a cross-fade *between* files would re-encode both sides of every
join. A chapter that fades itself concatenates into a film that dissolves, at
no cost.

### 5. Shorter lines

```bash
npm run dev -- narrate <spec>
```

Prints every spoken line with its length and flags any long enough that the
picture will wait. Ten minutes of narration is about 1,400 words; knowing that
while writing is what prevents a film nobody watches.

`npm run dev -- say "<a rewritten line>"` speaks one line and reports its real
duration. `--dry-run` estimates from the word count with no key and no network.

## Letting Reel propose direction

```bash
npm run dev -- direct <spec>          # propose
npm run dev -- direct <spec> --write  # insert it
```

It reads the spec and matches narration text against the *name inside a
selector* — `text=Ship the demo` carries the words on screen,
`role=button[name=Add]` the button's label, `#task-input` what somebody called
it. Where a line talks about an element a nearby step points at, it proposes a
highlight; where a chapter opens straight into a close-up, it proposes a wide
establishing shot.

It is conservative on purpose: a short name must match as a whole word, or
"Add" matches "additional" and every proposal is noise. **Expect it to stay
quiet often.** On the tour it proposes once across ten chapters, because nine
are terminal demos with no element to mark. That is the rule working, not
failing.

`--write` edits the file as text so your comments and formatting survive, and
re-parses the result before saving — it refuses anything that changed a step
rather than adding one.

## Measuring, instead of guessing

Do not trust an impression of pacing. Measure:

```bash
./node_modules/ffmpeg-static/ffmpeg -hide_banner -i out/demo.mp4 \
  -vf "freezedetect=n=-60dB:d=0.5" -map 0:v -f null - 2>&1 \
  | grep -oE "freeze_duration: [0-9.]+" | awk '{n++; s+=$2; if($2>m) m=$2}
      END {printf "%d freezes, %.1fs frozen, longest %.1fs\n", n, s, m}'
```

Two numbers matter: total frozen time as a fraction of the film, and the
longest single still. A demo with a thirty-second still has a problem no amount
of polish elsewhere will fix.

## What a good demo looks like

- Something changes on screen at least every few seconds.
- The camera moves during narration, not only during clicks.
- One idea per beat, named with `beat:` so it can be previewed with `--only`.
- Annotations that let the demo keep running.
- Sentences short enough that the picture never waits.
- Opens and closes on a fade, not a hard cut.
