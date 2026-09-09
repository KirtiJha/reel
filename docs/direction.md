# Direction: making a demo watchable

A plan for the second half of Reel — the part that decides whether a demo holds
attention, and the interface that lets someone build one without hand-writing
YAML.

**Status: everything in this plan is built except the last step — re-cutting
the tour — which needs a machine that can reach a text-to-speech endpoint.
See "Part 6 — Finishing this on your own machine" at the end.**

Parts 7 and 8 were added after the fact and are built: scenes (HTML
compositions for the non-footage parts of a demo) and `output.player:` (the
demo as a self-contained HTML document that re-performs the recording). Neither
changes anything Part 6 asks you to do.

Built: `fit: flow`, idle motion, `highlight`, `image`, `diagram`, transitions
and fades, the preview tiers (`--draft`, `--only`), `reel narrate`, `reel say`,
`reel direct`, `reel capture` writing `highlight` and `say`, and all four
Studio views — script panel, direction inspector, beat strip and media library.
That is Parts 1, 2 and 3, and order steps 1 through 7.

Not built, deliberately, with the reason recorded where each is described:
`highlight`'s `arrow` and `pointer`, and `transition`'s `wipe` and `push`. In
both cases the schema *refuses* the value rather than accepting it and
rendering something else.

Two corrections the work forced, kept here because they contradict what this
document originally said:

- `--only` cannot run "against cached frames" as §3.6 proposed. Frames live in
  a temp directory removed when a run ends. It stops the drive once the
  requested section is filmed and renders only that range — real savings, but
  bounded by how far into the demo the section sits, and only as fine-grained
  as the beats a spec actually names.
- Transitions cannot be a cross-fade *between* chapters. They are joined with a
  stream copy, which is why the picture that ships is bit-for-bit the picture
  that was verified; an `xfade` would re-encode both sides of every join. The
  fade lives inside each chapter instead, and the joins dissolve for free.

Measured on a fixture built to the exact shape of the tour's chapter 3 — a
terminal session, `zoom: false`, five narration lines including three
consecutive ones at the end — with identical speech durations across all three
renders:

| | Duration | Frozen | Longest freeze |
|---|---|---|---|
| `stretch` (the tour as shipped) | 51.4s | 19.2s (37%) | 14.5s |
| `flow` | 42.5s | 10.3s (24%) | 8.4s |
| `flow` + `idleMotion: drift` | 42.5s | **0.0s** | **0.0s** |

Flow alone cuts frozen time by 46% and the chapter by 17%, but cannot fix the
residue: three `say` steps in a row have nothing to play the voice over, and no
retiming invents something to show. Drift closes it.

One correction the measurement forced. Nine of the tour's ten chapters set
`zoom: false`, which is a deliberate choice — they are terminal sessions where
pushing in would blur the text. Idle motion defaulting to on would have
overridden that in nine places, so `idleMotion: auto` now follows the camera and
an explicit `drift` is what opts a terminal chapter in.

## What is wrong today, measured

The ten-minute tour is the best demo the tool has produced, and it is still
hard to watch:

| Measure | Value |
|---|---|
| Visual changes across 10:18 | 100 — one every 6.2s |
| Longest completely static frame | **57.9s** (at 3:47) |
| Next two | 54.8s, 48.9s |
| `callout:` directions in ten chapters | **0** |
| `zoom:` directions | 10, across 618 seconds |

Three times, a single still image holds for nearly a minute under a voiceover.

Two causes, both mine:

**Narration blocks the picture.** `fit: stretch` grows the hold a line sits on
until the sentence finishes. A long line freezes the frame. The mode was built
so narration would never be cut off, and it succeeds at that by stopping
everything else.

**The camera only reacts to interaction.** `zoom: auto` eases toward whatever is
clicked or typed into. During narration nothing is clicked, so the camera has no
reason to move — exactly when the picture most needs to.

Neither is a bug in the sense of something broken. They are the right answers to
questions asked one at a time, and the wrong answer to "is this watchable".

## The correction

**The voice should run continuously and the picture should move underneath it.**
Narration is a track, not a step that blocks. Everything below follows from
inverting that one relationship.

---

# Part 1 — Primitives

## 1.1 `fit: flow`

A third fitting mode, and the one that should become the default:

- The demo runs at its authored pace.
- A line is placed at its cue and plays over whatever happens next.
- The timeline stretches **only** when a line would collide with the next line,
  or run past the end of the demo.

`stretch` stays for demos that genuinely want the picture to wait — a title card
being read aloud, a single hero moment. `none` stays for fixed-length cuts.
`flow` is what a product tour wants.

This alone converts three minute-long freezes into three minutes of a product
doing things, with no re-authoring of any existing spec.

## 1.2 Idle motion

Where the picture is genuinely static — a screen being narrated, a card, a
terminal waiting — drift the camera. A slow push-in, or a pan across the region
being discussed.

```yaml
polish:
  idleMotion: drift        # auto | drift | none  (auto follows the camera)
  idleMotionAfter: 1800    # only kick in once nothing has changed this long
  idleMotionScale: 0.94    # how far in one push goes
```

Consecutive idle stretches alternate in and out around the shot the author
directed, rather than each pushing further in — otherwise a dozen silences
compound into a heavily cropped, upscaled frame, and a spec with no keyframes
of its own drifts once and then holds a still for the rest of the run.

It is a render-time transform over frames already on disk: no re-capture, no
extra drive, and it cannot change what the demo did. Cheap, and it removes dead
air even from demos nobody re-authors.

## 1.3 `highlight` — annotation that does not interrupt

**Alongside `callout`, not instead of it.** They are different rhetorical
devices and a good demo uses both:

| | `callout` | `highlight` |
|---|---|---|
| Rest of screen | dimmed | untouched |
| Camera | eases toward the target | unchanged unless asked |
| Feels like | *stop and look at this* | *and notice this, as we go* |
| Use when | the beat exists for that one element | things keep happening around it |

The tour has zero callouts precisely because every one of them would have
stopped the film dead. `highlight` is what it needed.

```yaml
- highlight:
    selector: "text=Green Valley"
    shape: box            # box | circle | underline | arrow | pointer
    style: drawn          # drawn (hand-sketched) | clean
    label: "your society"  # optional
    ms: 2600
    until: dish            # or persist until a named beat
```

Several may be on screen at once — three fields marked as a form fills, a region
boxed while narration talks over it. `until:` is what makes an annotation able
to outlive the step that drew it, which a stop-and-look callout never needed.

## 1.4 `image` — bringing in what the app cannot show

Logos, architecture diagrams, before-and-after, a chart.

```yaml
- image:
    file: assets/architecture.png
    as: full        # full | inset | split
    corner: br      # for inset
    ms: 3000
    transition: fade
```

**Never fetched at render time.** A network fetch during a render breaks
byte-identical output and quietly pulls someone else's artwork into a video you
publish. Studio may *download* an asset while you are editing — into the spec's
own directory, committed like any other input — but the renderer only ever reads
local files.

Diagrams are worth a special case: a fenced `mermaid` block rendered to PNG at
build time and cached by content hash. Text in the spec, diffable, deterministic,
and no binary to maintain.

## 1.5 Transitions — done

`transition: { kind: fade, ms }` dips the picture to a colour and back, and
`polish.fadeIn` / `fadeOut` ramp the film up and down at its ends.

A correction the implementation forced. The chapters are joined with a stream
copy — that copy is why the picture that ships is bit-for-bit the picture that
was verified — so an `xfade` *between* the files would re-encode both sides of
every join and throw that away. The fade therefore lives inside each chapter:
one that ramps up from its background and back down concatenates, at no cost,
into a film that dissolves between its parts. The join is free because it was
never a join.

`wipe` and `push` are not implemented and the schema refuses them. Both have to
move between two pictures, and a recording is one continuous stream; doing it
between two *finished* films is the re-encode above.

---

# Part 2 — `reel direct`

The primitives above still have to be placed by hand, and that is the work most
people will not do. But Reel already knows more about its own footage than any
stock-footage tool knows about a clip: every step, every element's bounding box,
every narration line and its measured duration, every beat.

`reel direct` reads a spec and **proposes** direction:

- Zoom to the element a line is *about* — matching narration text against the
  selectors in nearby steps — not merely what was clicked.
- Highlight that element for the length of the line.
- Drift where a stretch is static and nothing is named.
- Pull wide at chapter boundaries, so each chapter opens on an establishing shot.

It writes into the spec and prints a diff. It never applies silently: direction
is taste, and a tool that quietly restages your film is worse than one that
suggests. Same shape as `reel heal` — propose, show, let the author accept.

This is the piece with no equivalent elsewhere, and it is worth being clear why.
A prompt-to-video tool assembles footage it has no model of. Reel directs
footage it understands completely. That is not a slogan; it is the reason the
auto-direction can be specific enough to be useful.

---

# Part 3 — Two surfaces, one spec

Everything above is a change to the *file*. That is deliberate, and it is the
part of Reel that must not move: a demo is a text file in a repository, it
diffs in a pull request, and CI can run it. The CLI is how that file is worked
on, and it stays the complete interface — nothing below is reachable only by
clicking.

So the shape is not "Studio becomes the editor". It is:

**Every capability is a command. Studio is a view onto the same commands.**

Which means each new affordance is designed as a CLI verb first, and the UI is
built on top of that verb rather than beside it. Two consequences worth stating,
because they are what keeps this honest: a demo can be authored start to finish
without ever opening Studio, and anything Studio can do can be scripted, put in
a Makefile, or run in CI.

| Capability | Command | Studio view |
|---|---|---|
| Propose camera + annotation | `reel direct <spec>` | Diff, accept per item |
| Draft narration | `reel narrate --draft <spec>` | Script panel, editable in place |
| Hear one line | `reel say "<text>"` | ▶ beside the line |
| Render one beat | `reel record --only <beat>` | Live preview while editing |
| Cheap whole-film render | `reel record --draft` | Preview button |
| Structure preview | `reel record --html` (exists) | Embedded click-through |
| Pick an element by clicking | `reel capture` (exists) | Click the thumbnail |
| Add an asset | copy the file / `reel assets add <url>` | Drag-and-drop |

The last two are the interesting ones. Choosing a selector by pointing at it is
not a UI-only idea — `reel capture` already does exactly that, by driving a real
browser and letting you click. What it lacks is the vocabulary added in Part 1:
it can write a `click`, but not a `highlight`, an `image` or a `say`. Teaching
`capture` the new step kinds is what keeps the two surfaces equal, and it is the
gap I flagged when the audio work landed.

## 3.1 Where each surface is actually better

Not everything should be done in both, and pretending otherwise produces a
worse version of each. Where they genuinely differ:

**The CLI is better for** CI and batch, scripting a re-render across many specs,
working beside the spec in your own editor, and anything that has to be
reproducible without a person present. It is also the only one that works over
SSH, which is where a lot of this runs.

**Studio is better for** the parts that are irreducibly visual or aural: seeing
the beats laid out in order, hearing whether a sentence lands, pointing at an
element instead of writing a selector, and judging whether a film flows — which
is a question no log output can answer.

**Both, equally**: editing narration, setting camera direction, adding
annotations. These are the ones to hold to the rule strictly, because they are
where a UI-only affordance would be most tempting and most damaging.

## 3.2 The beat strip

The main Studio surface. Not a frame-accurate timeline — Reel's unit is the
beat, and pretending otherwise would invent precision the model does not have.

Each beat shows its storyboard thumbnail, its narration, its duration, and small
marks for the direction on it. Drag to reorder, click to inspect. Reordering
writes the steps in the spec; the file is what changed.

## 3.3 The script panel

Narration as a document, read top to bottom — the thing you actually edit when a
demo does not flow.

- Every `say:` line, in order, beside the beat it belongs to.
- **Draft** calls `reel narrate --draft`, which proposes a line per beat from
  the steps and beats. Reviewed in place, never auto-applied. It writes prose,
  not selectors, which is the safer half of what `reel author` does.
- **Speak this line** calls `reel say`, synthesizing one line and playing it
  without a render. The cache makes it nearly free.
- Per-line duration once synthesized, so an over-long line is a number rather
  than something discovered in the finished film.
- Word count and estimated runtime. Ten minutes of narration is about 1,400
  words; knowing that while writing prevents the film the tour became.

## 3.4 The direction inspector

Selected beat, right-hand panel: camera (auto / hold / drift / zoom to
selector), annotations (shape, style, target), media, transition. Every control
writes the same YAML you would have typed.

Choosing the element by clicking the preview is the biggest usability win
available, and Reel already records every element's box — but the same choice is
available from `reel capture`, and both write the same selector.

## 3.5 The media library

Drag a file in; it lands in the spec's directory and is referenced by path.
Paste a URL and Studio downloads it *now*, into that same directory, committed
like any other input — so the render still only ever reads local files. A
mermaid editor for diagrams, writing a fenced block into the spec.

## 3.6 Preview that is fast enough to iterate

The blocker for the UI, and useful on its own at the command line. A ten-minute
render is minutes; nobody edits against that.

Three tiers, cheapest first — each a CLI flag before it is a button:

1. **The interactive build** (`--html`, already exists). A self-contained
   click-through of scenes, no video encode, nearly instant. The right preview
   for structure, order and script.
2. **Per-beat render** (`--only <beat>`). Seconds, against cached frames. The
   natural loop when tuning one annotation.
3. **Draft render** (`--draft`). Small, low frame rate, video only, cached audio
   only. For seeing the whole film before committing to a full one.

Tiers 2 and 3 are worth having even for someone who never opens Studio: they are
the difference between iterating on a demo and batch-rendering one.

---

# Part 4 — What must not change

- **The spec is the source of truth.** Every action in either surface is a YAML
  edit. A demo built entirely in the UI still diffs in a pull request.
- **The CLI stays complete.** Nothing is reachable only by clicking. If a
  feature cannot be expressed as a command, it is the wrong feature.
- **Renders stay byte-identical.** Nothing added here may fetch at render time
  or introduce unseeded randomness. Idle motion, annotations and transitions are
  pure functions of the spec and the frames.
- **Nothing is applied silently.** `direct` and drafted narration propose; a
  person accepts. The tool's whole claim is that a demo is reviewable.

---

# Part 5 — Order

1. **`fit: flow` and idle motion.** The root cause. Improves every existing demo
   with no re-authoring.
2. ~~**`highlight`**, alongside `callout`.~~ Done — composited in post like
   captions, so it is a pure function of the cue list and cannot make two
   renders differ.
3. ~~**`image`**, plus mermaid diagrams.~~ Done — drawn into the page rather
   than composited, so the picture reaches the storyboard and the
   click-through, which read frames rather than the finished video.
4. ~~**Preview tiers** — `--only` and `--draft`.~~ Done. Measured on the
   taskflow example: a full render is 150s, `--draft` 41s, `--draft --only`
   37s. Neither writes the master or its fingerprint stamp.
5. ~~**`reel narrate --draft` and `reel say`**, then **`reel capture` learning
   the new step kinds**.~~ Done. `capture` grew a Narrate field and a Mark
   button — marking swallows the click, because pointing at an element is not
   pressing it. `narrate` without a model reads the script and needs nothing
   installed, which turned out to be the more useful half.
6. ~~**`reel direct`.**~~ Done, and deterministic: the match that matters —
   "this line talks about the thing that step points at" — is a comparison
   between a narration line and the *name inside a selector*, so it needs no
   key, no network and no browser. Conservative by design: on Reel's own tour
   it proposes once, because nine chapters are terminal demos where there is no
   element to mark, and the tenth already directs itself. That is the honest
   result, not a tuning failure — the rule fires on a confident match or stays
   quiet.
7. **Studio.** The script panel and the direction inspector are done, as views
   onto `reel narrate`, `reel say` and `reel direct` — every button is a
   command that works without opening Studio. The preview button is
   `record --draft` with the same flags, rather than a second render path. The
   beat strip and the media library are still proposed.
8. **Re-cut the tour** using all of it, and compare against the numbers at the
   top of this document. One visual change every 6.2 seconds is the bar to beat.
   **This is the only step left. See Part 6.**

Step 8 is the honest test. The measurements are the acceptance criteria: if the
re-cut still has a fifty-second static frame, none of this worked.

---

# Part 6 — Finishing this on your own machine

Everything above is built and pushed. What remains is step 8: re-render the
tour with the new direction and check the result against the numbers this
document opens with.

## Why it could not be finished where the rest was built

The work was done in a sandboxed container with no route to a speech endpoint.
Three facts follow from that, and they are the whole reason this section exists:

- **`api.openai.com` and `api.elevenlabs.io` are unreachable there** — the
  egress proxy answers `CONNECT tunnel failed, response 403`. Narration cannot
  be synthesized, so the tour cannot be rendered with audio.
- **`demo/.reel-cache/voice/` is not committed.** It never was: `.gitignore`
  ignored the whole of `.reel-cache/`, which contradicted the code — the
  renderer calls that cache "committed, so renders reproduce" and `reel doctor`
  tells you a render needs no key because narration comes from it. The ignore
  rule is fixed now (`voice/` and `diagram/` are re-included), but the audio
  itself only exists on whichever machine last rendered the tour with a key.
  **That is your machine.**
- **`mermaid` is a dev dependency**, needed only to *draw* a diagram the first
  time. Rendered diagrams are cached in `.reel-cache/diagram/` and committed,
  so this only matters if you add a new `diagram:` step.

## What is already done, so you do not redo it

All ten chapters in `demo/chapters/` have been edited and pushed:

| Setting | Value | Why |
|---|---|---|
| `audio.fit` | `flow` (was `stretch`) | The root cause. `stretch` grows the hold a line sits on, which is what produced the fifty-second stills. |
| `polish.idleMotion` | `drift` on chapters 01–09 | They are terminal demos with `zoom: false`, so nothing moved the camera. Chapter 00 already drifts via `auto`. |
| `polish.fadeIn` / `fadeOut` | 400ms, except 700 in / 1200 out at the ends | Each chapter fades itself, so the stream-copy concat dissolves at every join. |

You should not need to touch a chapter to get the re-cut. Everything below is
running commands and reading numbers.

## Setup

```bash
git clone https://github.com/KirtiJha/reel   # or: git pull
cd reel
npm install
git config core.hooksPath .githooks          # once per clone; strips AI trailers
npx playwright install chromium              # if you have not already
```

Set a voice key **only if the cache turns out to be incomplete** (see step 2):

```bash
export OPENAI_API_KEY=sk-...     # the chapters specify provider: openai, id: onyx
# or: export REEL_VOICE_API_KEY=...
```

> The ElevenLabs key pasted into the chat during this work is in that
> transcript and should be **rotated**. It was used inline for single commands
> and never written to disk, and the tour does not use ElevenLabs anyway — the
> chapters all specify `provider: openai`.

**Windows:** everything works, with two differences. Use PowerShell's
`$env:OPENAI_API_KEY = "sk-..."` instead of `export`. And `demo/build.mjs`
shells out to `ffmpeg` — it uses `ffmpeg-static`, so no separate install is
needed, but run it from a shell where `npm` scripts work (PowerShell or Git
Bash, not `cmd` with a stale PATH).

## Step 1 — confirm the build is sound

```bash
npm run typecheck
npm test              # expect 877 passing
npm run schema        # must produce no diff; a diff means the schema drifted
```

## Step 2 — commit the voice cache

This is the one thing only you can do, and it is what makes the tour
reproducible for everyone else.

```bash
# What the specs intend to say, and what is missing from the cache:
npm run dev -- check demo/chapters/03-byte-identical.reel.yaml
```

`check` audits the voice cache and names any line that has no audio yet. If it
reports nothing missing across the chapters, the cache is complete and no key
is needed. Then:

```bash
git add demo/chapters/.reel-cache/voice demo/.reel-cache/voice
git commit -m "chore(demo): commit the tour's voice cache"
```

The cache is content-hashed over provider, model, voice, style, speed and the
text, so a reworded line leaves its old mp3 behind. There is no prune command
yet; at ten minutes of narration it does not matter.

## Step 3 — hear the script before you render it

```bash
npm run dev -- narrate demo/chapters/03-byte-identical.reel.yaml
```

It prints every line with its length and flags any that run long enough for the
picture to wait. Across all ten chapters the tour is **55 lines, 1,229 words,
about 8.2 minutes of talking** — against a 10:18 film.

Two lines in chapter 3 are marked at ~10s each. With `fit: flow` they no longer
freeze the picture, but they are still long sentences; splitting them is a
judgement call and yours to make. `reel say "<the rewritten line>"` speaks one
line and reports its real duration, using and filling the same cache.

## Step 4 — let `direct` propose what it can

```bash
for f in demo/chapters/*.reel.yaml; do npm run dev -- direct "$f"; done
```

Expect **very little** — one proposal, on chapter 8. That is the honest result,
not a bug: nine chapters are terminal demos where there is no element to mark,
and `direct` fires on a confident match or stays quiet. Add `--write` to any
chapter whose proposal you like; it inserts one line and leaves your comments
and formatting alone.

## Step 5 — render one chapter and look at it

Do not start with the whole tour.

```bash
npm run dev -- record demo/chapters/03-byte-identical.reel.yaml --draft
```

A draft is small, low frame rate, video only, and speaks only what the cache
already holds — about 3–4× faster than a full render. It writes
`demo/out/03-byte-identical.preview.mp4` and **never touches the master or its
fingerprint stamp.**

Watch it. You are looking for: the camera drifting during narration instead of
sitting still, the film fading up at the start and down at the end, and the
voice running over a moving picture rather than the picture waiting.

If it looks right, render it properly and measure:

```bash
npm run dev -- record demo/chapters/03-byte-identical.reel.yaml
```

## Step 6 — measure, before rendering all ten

The acceptance criteria are the numbers at the top of this document. Reproduce
them with the same tools they were produced with:

```bash
# Frozen picture, and the longest single still:
./node_modules/ffmpeg-static/ffmpeg -hide_banner -i demo/out/03-byte-identical.mp4 \
  -vf "freezedetect=n=-60dB:d=0.5" -map 0:v -f null - 2>&1 \
  | grep -oE "freeze_duration: [0-9.]+" | awk '{n++; s+=$2; if($2>m) m=$2}
      END {printf "%d freezes, %.1fs frozen, longest %.1fs\n", n, s, m}'
```

On a fixture of chapter 3's exact shape, the three configurations measured:

| | Duration | Frozen | Longest freeze |
|---|---|---|---|
| `stretch` (as the tour shipped) | 51.4s | 19.2s (37%) | 14.5s |
| `flow` | 42.5s | 10.3s (24%) | 8.4s |
| `flow` + `idleMotion: drift` | 42.5s | **0.0s** | **0.0s** |

**The bar, and a caution about which number you are looking at.** Run that same
command against the tour as it shipped and it reports:

```
77 freezes, 589.3s frozen, longest 38.4s
```

That is the apples-to-apples baseline — use it, not the 57.9s in the table at
the top of this document. The two disagree because they measure different
things: 57.9s is the longest stretch with no *visual change at all*, found by
frame comparison, while `freezedetect` at `-60dB:d=0.5` merges and splits runs
by its own threshold. Both are true; only one is comparable to what you are
about to run.

So: **589.3s frozen out of 618s (95%), longest freeze 38.4s** is what to beat.
A re-cut that still contains a thirty-second still means none of this worked.

## Step 7 — render the whole tour

```bash
node demo/build.mjs        # renders every chapter and concatenates them
```

Then measure the master the same way:

```bash
./node_modules/ffmpeg-static/ffmpeg -hide_banner -i demo/out/reel-tour.mp4 \
  -vf "freezedetect=n=-60dB:d=0.5" -map 0:v -f null - 2>&1 \
  | grep -oE "freeze_duration: [0-9.]+" | awk '{n++; s+=$2; if($2>m) m=$2}
      END {printf "%d freezes, %.1fs frozen, longest %.1fs\n", n, s, m}'
```

Projected from the shipped tour's own freeze intervals plus the 1.8s drift
threshold: **109s frozen instead of 589s, and no single still longer than
1.8s.** That projection predates `fit: flow`, which shortens the film as well,
so treat it as a floor rather than a forecast.

## Step 8 — verify determinism before you publish

The central promise. Render twice and compare:

```bash
npm run dev -- record demo/chapters/03-byte-identical.reel.yaml && md5 demo/out/03-byte-identical.mp4
npm run dev -- record demo/chapters/03-byte-identical.reel.yaml && md5 demo/out/03-byte-identical.mp4
```

(`md5sum` on Linux, `md5` on macOS, `Get-FileHash` on Windows.) The two must
match. Every feature added here was checked this way — highlights, images,
diagrams and fades each produced identical bytes across two runs — but the
combination of all of them on the real tour has not been, and that is exactly
the kind of thing worth confirming once.

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `No API key for OpenAI` | A line is not in the voice cache | Set `OPENAI_API_KEY`, render once, then commit the cache |
| `This spec draws a Mermaid diagram, and there is no rendered copy` | A new `diagram:` step, and mermaid is not installed | `npm install --save-dev mermaid`, render once, commit `.reel-cache/diagram` |
| The two md5s differ | A determinism regression | Render with `REEL_KEEP_FRAMES=1` and diff the frame directories to find the first frame that differs |
| `reel direct --write` refuses | The edit would have changed a step, not just added one | Nothing was written. Run without `--write` and paste the proposal by hand |
| A chapter is suddenly much longer | `fit: flow` still had to insert time for colliding lines | `reel narrate <spec>` shows which lines are long enough to collide |

## What is still proposed, if you want to keep going

- **`highlight` shapes `arrow` and `pointer`**, and **`transition` kinds `wipe`
  and `push`**. The schema refuses all four today. Arrow and pointer need an
  anchor and a direction; wipe and push need two shots to move between, which a
  single continuous recording does not have.
- **A highlight that follows a scroll.** The element's box is measured once,
  when the step runs, so an annotation spanning a `scroll:` will not travel with
  it. Recording a track of boxes would fix it.
- **A voice-cache prune.** Reworded lines leave their old mp3 behind.
- **`reel capture` writing `image:` and `diagram:` steps.** It writes `click`,
  `type`, `waitFor`, `caption`, `say` and `highlight` today. The rest are
  directorial, and a picture is not something you perform in a browser.

---

# Part 7 — Scenes: HTML for the parts that were never footage

Prompted by [HyperFrames](https://github.com/heygen-com/hyperframes), which
renders HTML compositions to MP4 by seeking a paused timeline in headless
Chrome. The idea is right; the scope needs care.

## What was taken, and what was not

**Not taken: authoring the demo in HTML.** HyperFrames composes *authored*
content. Reel drives a real app and films what happened, and that difference is
the product — `check` fails CI when the app drifts, `heal` repairs selectors,
and "when the media in a pull request changes, something in the product really
changed" is the claim chapter 3 of the tour makes. An HTML-authored demo renders
whether or not the app still works. It can lie. Rebuilding Reel on that concept
would mean competing with Remotion and HyperFrames having thrown away the one
thing neither has.

**Taken: HTML for everything that was never footage.** A title, a chapter
opener, a claim between two sections — none of that is a recording. Until now
Reel drew a title card as a flex `div` with two lines of text, because the rest
of the render path composites with sharp and sharp cannot lay out a paragraph.

The evidence that this was the right seam: Reel had **1,887 lines** hand-rolling
what a browser does for free — word wrapping from advances measured in the
browser and shipped back out (`captions.ts`), a `text.length * fs * 0.54`
character-width *estimate* for label placement (`highlight.ts`), device chrome
as generated SVG strings (`frame.ts`). Meanwhile a Chromium was already open.

## The `scene:` step

```yaml
- scene:
    template: chapter        # title | chapter | statement | bullets
    eyebrow: "Chapter one"
    title: "Capture work in a snap"
    subtitle: "One keystroke, from anywhere in the app."
    ms: 2400
    say: "Let's start where everyone starts."
```

Or a composition of your own:

```yaml
- scene: { file: scenes/opening.html, ms: 3000 }
```

Templates take the spec's `accent`, `background` and `theme`, so a scene looks
like the rest of the demo rather than like a slide someone pasted in.

## How it renders, and why it stays deterministic

The composition is mounted as a **same-origin `srcdoc` iframe** in the overlay
layer — an iframe so the app's CSS cannot reach the composition and the
composition cannot reach the app, `srcdoc` so Reel can seek it directly instead
of talking to it by message.

Seeking uses a primitive Reel already had. `Recorder.motion(ms, render)` calls
`render(p)` once per output frame and captures at an exact timeline position, so
the frame count is a function of duration and fps rather than of how fast
screenshots come back. That is precisely HyperFrames' seek-per-frame model,
already implemented, previously used for scrolls.

**The animation model differs from HyperFrames' on purpose.** HyperFrames seeks
paused GSAP timelines. Reel cannot: the determinism layer suppresses CSS
animation and transition inside *every* document, including nested ones, so a
clock-driven entrance would not move at all. Instead a scene's motion is a pure
function of the seek position — Reel writes `--in` and `--out` as CSS custom
properties and the composition reads them:

```css
.title { opacity: var(--in); transform: translateY(calc((1 - var(--in)) * 2.2vh)); }
```

There is no clock to freeze, which is a stronger guarantee than freezing one. A
custom composition can also export `window.__reelScene = { seek(p) {…} }` for
motion the variables cannot express.

Verified: a spec with three scenes rendered twice produced identical md5s.

## What this fixed on the way

Captions are composited in post from a cue list where a cue runs until the next
one. Nothing ended a caption when a full-frame composition replaced the picture,
so an old caption sat on top of the first scene. It did the same over a `card`
and a `full` image — invisible until now only because the tour sets
`captions: false`. All three now clear the caption; `inset` images do not,
because the app is still visible behind them.

## Not built

- **An HTML compositor for the overlay layer** (captions, highlights, device
  chrome, fades). This is the bigger prize and the same idea, but it moves the
  *app footage* through Chromium's rasterizer instead of sharp's, which widens
  the determinism surface considerably — Reel has already been bitten once, by
  Chromium partial raster. It also loses `mapPool` parallelism across cores and
  lanczos3 downscaling. Worth doing behind a flag, validated by rendering the
  same spec both ways and diffing frames. Not worth doing casually.
- **A track abstraction.** There are now five parallel cue lists — captions,
  highlights, fades, zoom, sfx — each with its own retime remap and its own cut
  slice. `remapHighlights` and `remapFades` are the same function twice.
  HyperFrames' `data-start`/`data-duration` convention is the better model; one
  `{from, to}` track type would collapse them. A contained refactor with no
  rendering risk.
- **More templates.** Four is enough to prove the seam. Comparison, before/after
  and a metric counter are the obvious next ones.

---

# Part 8 — The demo as a document

`output.player:` writes a self-contained HTML page that **re-performs** the
recording instead of baking it into pixels.

```yaml
output:
  mp4: out/demo.mp4          # for LinkedIn, YouTube, anywhere that takes video
  player: out/demo.html      # for a README, a docs site, a PR preview
```

## The idea

Every other deliverable flattens the demo. The camera becomes a cropped raster,
a caption becomes burned-in text, an annotation becomes composited SVG. That is
correct for a video, and it throws away everything that made the demo legible:
the words stop being words, and the result is opaque to search, to translation
and to a screen reader.

Reel already collects everything needed to avoid that. The frames stay raster —
they genuinely are a recording of an app. Everything layered on top stays what
it was:

| Collected | In the video | In the document |
|---|---|---|
| frames + times | 18,540 encoded frames | ~163 `<img>` swaps (the tour changes 100 times in 618s) |
| zoom timeline | a crop baked by sharp | a CSS transform, interpolated per animation frame |
| caption cues | pixels | real DOM text |
| highlight spans | composited SVG | live SVG inside the camera transform |
| fade cues | composited alpha | an overlay's opacity |
| narration | muxed into the MP4 | one `<audio>` — **and the clock** |
| beats, branches | a storyboard | scrub targets, deep links, choices |

## One clock

The hard part of any player is sync, and it always fails the same way: two
timers that are each individually correct and drift apart. So there is exactly
one. With narration it is `audio.currentTime`, because audio is what a viewer
notices drifting; without, a plain elapsed counter. Nothing chases anything.

The camera reuses the same resolved keyframes and the same `easeInOutCubic` the
video compositor uses, interpolated per animation frame rather than per encoded
frame — so the movement is **smoother than the video it came from**, not
steppier.

## What it costs, honestly

- **It is not a video.** A social platform takes an MP4. This is a third
  deliverable, not a replacement, and `mp4:` remains the one to publish.
- **Determinism means something different.** Byte-identical is a promise about
  rendered media. A document is deterministic in its *data*; what a reader sees
  depends on their browser. `check` and `diff` compare media, so the document
  would want data-level diffing — arguably better, since "the caption at 4.2s
  changed" beats "pixels differ".
- **Audio autoplay is blocked** until a gesture, so playback starts on a click.
- **A busy demo gets heavy.** Frames are emitted on visual change; a flow with
  video playing inside the app produces many. The taskflow example is 163
  frames and 2.0 MB.

## Two bugs the browser found that no unit test would have

Both were caught by driving the generated page in Playwright and looking at it.

1. **The annotation was drawn beside the camera instead of inside it.** `#marks`
   was a sibling of the transformed shot, so a highlight sat in untransformed
   viewport space — it appeared under the wrong list item the moment the camera
   zoomed. A mark has to be carried by the same transform as the thing it marks.
   It also needs `vector-effect="non-scaling-stroke"`, or the stroke fattens as
   the camera pushes in.
2. **The camera scaled against the viewport rather than the stage.** That gives
   scale 1 at full frame, which leaves the shot at its authored pixel size
   inside a stage that is almost always smaller.

## Not built

- **Branch choices in the document.** The click-through build has them; this one
  has beats and deep links but plays one path.
- **Data-level `diff`.** Comparing two documents by their timelines rather than
  their pixels is the natural follow-on, and would describe a change in the
  demo's own vocabulary.
- **Lazy frame loading.** Every frame is a data URI in one file, which is what
  makes it emailable and what makes it large. A directory build with real files
  would suit a docs site better.
- **Copyable terminal text.** In a terminal demo the text was real text before
  it was pixels; the document could carry it, and a reader could copy the
  command. This is the most obviously valuable thing left.

---

# Part 9 — Looks: making every demo not look like every other demo

## The mistake this corrects

Part 7 shipped four scene templates. Part 8's first pass at making them
*good* hard-coded one backdrop into `templates.ts` — concentric saturated
rings, borrowed from a HyperFrames showcase poster. It looked expensive, and it
was exactly wrong: every demo Reel ever rendered would have opened on the same
picture. A tool that produces one look does not produce a look. It produces a
watermark.

The redirect came from a fair question — *"the goal is not the ring; it can't be
the same for every demo. How does the other tool generate these?"* — so the
right move was to go and read, rather than tune CSS harder.

## What HyperFrames actually does

It ships **no templates at all.** There is no design in its framework code. Its
engine's entire contract is four data attributes and one global:

```html
<div id="stage" data-composition-id="launch" data-width="1920" data-height="1080">
  <h1 class="clip" data-start="1" data-duration="4">Launch day</h1>
</div>
<script>
  const tl = gsap.timeline({ paused: true });
  window.__timelines.launch = tl;   // paused, seekable
</script>
```

The renderer seeks that paused timeline once per frame in headless Chrome and
encodes with FFmpeg. Every pixel of design is **LLM-written HTML, bespoke per
project**. The framer rings were not a feature; an agent wrote them for one
video.

What makes the output good lives one layer up, in ~20 Claude Code skills:
`hyperframes-creative` alone carries 15 reference documents (`visual-styles.md`,
`typography.md`, `motion-principles.md`, `beat-direction.md`), nine palettes, and
13 `frame-presets` — each a complete `FRAME.md` design language. `visual-styles.md`
names identities grounded in real traditions ("Swiss Pulse — Josef
Müller-Brockmann, clinical, precise, for SaaS and dev tools") as copy-paste token
blocks.

**The design intelligence is in the prompt layer. The framework only guarantees
determinism.** That is the inversion worth copying.

## What Reel already had

More than expected. `window.__reelScene = { seek(p) }` plus `--p`/`--in`/`--out`
*is* the `window.__timelines` contract, and arguably stronger: suppressing CSS
`animation` and `transition` in every document means there is no clock to
freeze, rather than a clock that must be paused correctly. `scene: { file: … }`
already took a bespoke composition. Reel already shipped a Claude Code plugin.

Missing were the design layer and the authoring loop.

## The look layer

`src/scene/looks.ts` — ten named visual identities, as **data**:

| Look | For |
| ---- | --- |
| `aurora` | The default. Calm, premium, safe with any accent. |
| `neon` | Launch films and hero titles. Loud on purpose. |
| `swiss` | Dev tools, data, APIs. Clinical and gridded. |
| `editorial` | Claims and quotes. Serif, cream, unhurried. |
| `brutal` | One big announcement, or a single number. |
| `terminal` | CLI demos and anything about code. |
| `blueprint` | Architecture, specs, systems diagrams. |
| `poster` | Chapter openers and section breaks. |
| `mono` | When the app itself is the colour. |
| `dawn` | Consumer apps and onboarding. |

A look owns the ground, the ink, the backdrop, the type and how words arrive.
Templates became **layout only**. So `look: swiss` and `look: neon` are the same
four templates wearing different films, and adding an eleventh look needs no
change to `templates.ts`.

```yaml
polish:
  look: neon
  accent: "#22d3ee"
steps:
  - scene: { template: chapter, title: Branching paths, look: poster }
```

**A look never owns the accent.** Every backdrop is built out of
`polish.accent` — hue-rotated, tinted, repeated — which is why `neon` on a cyan
product is not the picture in these docs. `scene.look` overrides `polish.look`
for one scene; an `editorial` statement between two `neon` chapters lands harder
than either alone.

The one thing a look must not skip is reading `--p`. `--in` is spent by 28% of
the scene, so a backdrop driven only by `--in` arrives and then sits still —
which is precisely what makes a scene read as a slide. A test asserts every look
in the catalogue reads `--p`; `brutal` failed it on the first run and got a
register mark that steps across the top.

## The authoring loop

Motion cannot be judged from source, and an agent cannot scrub an MP4. Two
commands close that:

```bash
reel looks --accent "#22d3ee" --title "The demo's title"   # .reel/looks.png
reel scene --template chapter --look poster --title "…"    # .reel/scene.png
reel scene scenes/opening.html                             # your own composition
```

`looks` renders the whole catalogue side by side — the same argument as `reel
themes` printing swatches instead of names. `scene` seeks one composition at six
positions and tiles them into a contact sheet, weighted toward the entrance
because that is where everything happens. Both are shot with the same seek
runtime and the same deterministic launch flags as a real render, so a sheet
that looks right is not a different picture from the film.

The `reel-scene` skill teaches the rest: the three variables, the five rules,
the `__reelScene.seek(p)` escape hatch for motion CSS cannot express, and a
skeleton that obeys all of it.

## Determinism

Verified two-run byte-identical on six looks including the ones that worried me
— `neon` uses `mix-blend-mode: screen` across three layers, `aurora` blurs at
90px. All identical. Then an end-to-end draft render with two scenes at
different looks inside one film, which is what actually exercises the driver.

## Not built

- **Custom looks in a spec.** The catalogue is code. A `looks:` block letting a
  repo define its own — HyperFrames' `frame.md` — is the obvious next step, and
  the shape is already right for it: a look is data.
- **Looks beyond scenes.** Captions, the browser frame and the callout spotlight
  still read `polish.accent` directly rather than the look's palette. A look
  ought to dress the whole film.
- **Per-look motion timing.** `IN_FRACTION` and `OUT_FRACTION` are global. A
  `brutal` scene probably wants to arrive faster than an `editorial` one.
- **Type scale as data.** Sizes are still `clamp()` literals in `templates.ts`.
  They belong in the look.

---

# Part 10 — The rescope: Reel shoots, HyperFrames cuts

## The decision

Reel was a whole pipeline: drive the app, film it, composite captions and
chrome, encode, diff, and fail CI when the app drifted. Part 9 added scene
looks to that pipeline. Then the scope changed on purpose — the goal is
HyperFrames-quality product and CLI demo films, and the byte-identical/CI half
is not what makes those.

So Reel keeps the half nobody else has, and stops doing the half that is
already solved better elsewhere.

| | Does it |
| --- | --- |
| **Reel** | Drives the real app or a real terminal through a scripted, asserted flow and films what happened |
| **HyperFrames** | Renders HTML to video — seek-per-frame, GSAP, FFmpeg, audio mix, transitions |

HyperFrames' own `capture` reads a *website's design* — screenshots, tokens,
fonts — so an agent can rebuild it. It has no way to drive an app through a
flow. That gap is exactly Reel's shape, and it is why this is a combination
rather than a clone.

## The core is a dependency, not a reimplementation

`hyperframes` and `@hyperframes/core` are Apache-2.0 on npm, so "the same core"
is literally the same core, and it stays the same as they ship. Reimplementing
the parser, seven runtime adapters, the audio mixer, shader transitions,
chunked parallel encode and the lint suite would take months and trail forever.
Nothing in `src/compose` reimplements any of it; it writes HTML that honours
the contract and hands off.

## The seam: a shot manifest

A bare mp4 is a poor handoff, because a composition needs to *time* things
against the footage and an author is otherwise left scrubbing and guessing.
The driver already knows every one of those moments — it caused them.

`reel shoot` therefore writes `footage.mp4` **and** `shots.json`:

```json
{ "version": 1, "name": "TaskFlow", "duration": 15.34,
  "beats":    [{ "label": "hero", "t": 0.95 }, { "label": "added", "t": 10.44 }],
  "captions": [{ "t": 0, "text": "Capture work in a snap" }] }
```

`shoot` also strips the picture back to footage: no browser chrome, no
burned-in captions, no cards, no fades. Each of those is now the composition's
to decide, and a decision baked into a frame cannot be unmade. Zoom is the one
thing kept, because a push-in was chosen while the app was being driven with
the element's real box in hand, and it cannot be recovered from a flat
recording afterwards. `--flat` turns it off.

`reel compose` scaffolds the project around that manifest — footage on the
timeline, a title card in a look, lower thirds already timed to the captions, a
closing card, GSAP vendored, `hyperframes.json`. Then an agent edits the HTML,
which is the whole HyperFrames bet. Scaffolding further would be building
templates again.

## Three things the first attempt got wrong

1. **The CDN.** The scaffold linked GSAP from jsdelivr and the render failed
   outright behind an egress proxy — `sub_timeline_script_failure`. It is now
   copied from `node_modules`. A render that fetches depends on someone else's
   uptime, which Reel already believed and the composition had quietly stopped
   honouring.
2. **Fonts.** `hyperframes check` rejects a family it cannot resolve, and it is
   right to: a silently substituted font is not the typography anyone approved.
   The composer now emits `@font-face { src: local("…") }` for every named
   family in a look.
3. **Lower thirds floated over the picture.** They collided with the app card.
   The fix is not more padding — the footage is full-bleed and its content
   moves, so *anything* placed on it collides eventually, and you only find out
   per demo after a three-minute render. They are a band at the bottom edge now,
   which is correct at every frame of every demo.

## Proven end to end

`check` clean across lint, runtime, layout, motion and contrast (10/10 WCAG AA),
then a 20.8s 1920×1080 render: title card → real TaskFlow footage with lower
thirds on the manifest's timings → closing card.

`hyperframes snapshot --at <seconds>` is the iteration loop — seconds, against
three and a half minutes for a render. It does not inject decoded video frames,
so it judges graphics and cards but not the footage itself.

## Still to do

- **Delete the old half.** `check`, `diff`, `ci`, the fingerprint/stamp
  machinery, `src/encode`, the interactive player and the burn-in compositors
  come out in one reviewable commit now that the new path renders. Nothing has
  been removed yet, deliberately: the old surface stays until the new one is
  finished.
- **Terminal footage.** `src/terminal` is the other thing HyperFrames cannot do
  and it already works; it needs a `shoot` path and a manifest of its own
  (commands, their output regions, exit codes).
- **Narration onto the composition timeline.** Reel's voice cache should land
  as `<audio>` clips with the caption timings, rather than being mixed by Reel.
- **Looks as composition CSS.** `src/scene/looks.ts` currently only dresses
  Reel's own scenes; the composer reimplements a subset. One source.
- **Beat-driven camera.** The manifest has the beats; `compose` should be able
  to emit a punch-in on each one rather than leaving every camera move manual.

---

# Part 11 — Doing it the way HyperFrames actually does it

## The honest starting point

Part 10 wired HyperFrames in as a renderer and stopped there. Asked whether
everything had been incorporated, the answer was no, and the inventory was
embarrassing: 155 registry blocks unused, 220 components unused, shader
transitions unused, 20 skills unused (a bespoke one written instead), 13 frame
presets unused, the audio mixer unused, the film silent. Worse, `compose` was
emitting **one fixed template from code** — the exact mistake Part 9 diagnosed
and swore off.

The film looked much like Reel's old output because the design was still
hand-rolled and identical every run. HyperFrames' output looks good because an
*agent authors each composition* against those skills and that catalog. The
mechanism had been bypassed entirely.

## What their project actually looks like

Read from `references/production-loop.md`, `sub-compositions.md`,
`storyboard-format.md` and `design-spec.md` rather than guessed:

```
frame.md                       design spec — YAML frontmatter is normative, prose is context
STORYBOARD.md                  the plan layer; Studio renders it as a contact sheet
hyperframes.json               what makes the directory a project
index.html                     assembly only — scenes as sub-compositions on tracks
compositions/frames/NN-*.html  one scene per file
```

`reel compose` now emits exactly that. The monolithic `index.html` is gone.

**Why one file per scene.** A monolithic composition renders perfectly well and
is still wrong: a scene you cannot open, snapshot and rewrite on its own is a
scene nobody edits. It is also the structure every one of their skills expects.

## Five mount-contract failures their linter caught

None would have been found by reading the files, and all seven errors came from
one `hyperframes check`:

1. **`missing_timeline_registry`.** The index had no timeline — deliberately, on
   the theory that scenes own their motion. A composition with no
   `window.__timelines` entry is an error regardless. It now drives a global
   grade layer, a vignette that breathes across the whole film, which is a real
   finishing element rather than a stub tween.
2. **`id_requires_css_escape`.** Scene ids began `00-`, so `#00-title-v` throws
   a SyntaxError in `querySelector` — inside the scene's own timeline script.
   Ids are prefixed with a letter now.
3. **`media_missing_data_start`.** Video and audio inside a sub-composition still
   need their own timing; HyperFrames cannot own playback for untimed media.
4. **`invalid_parent_traversal_in_asset_path`.** Media referenced as
   `../../media/…` works at render — which rewrites `../` against the
   sub-composition's own path — and 404s in Studio, which resolves from the
   project root. Media moved beside the scenes that play it.
5. **`studio_missing_editable_id`.** Host clips need ids or Studio has no stable
   edit target.

Then: 0 errors, 0 warnings, 11/11 WCAG AA, and a contact sheet confirming all
five scenes mount.

## The catalog, made usable

`npx hyperframes add` works, and every block it installs links GSAP from
jsdelivr and its fonts from Google Fonts. Fine with open egress, fatal without —
and the font case is the dangerous one, because a blocked script *fails* the
render while a blocked font silently substitutes a typeface, so the block ships
looking wrong rather than not at all.

`reel blocks <project>` rewrites them: GSAP re-pointed at the vendored copy,
remote font imports and links dropped, and every family they were fetching
re-declared as a `local()` face so `check` can still resolve it. Everything else
is left exactly as the catalog wrote it — a block edited beyond recognition is
no longer the block you installed. Verified on `cinematic-zoom`: one script, four
families, zero remaining remote references.

## What the skills corrected

`waterfall-entry`, from `hyperframes-animation`, says two things that are
counter-intuitive and both wrong in the earlier version:

- **Opacity is binary.** A word is revealed with a zero-duration `set`, never
  faded. "Never fade an arrival."
- **It is fast.** 0.13–0.20s per word, against the 0.7s that felt right when
  guessing — four times too slow — and the cascade *overlaps*, each word
  starting before the previous settles.

A title now composes by ~0.8s instead of ~2s. That single rule is most of the
difference between a title card and a slide.

## Sound

Reel has always collected sfx cues to build its own audio track. Handed to a
composition they are worth more: a click landing on the exact frame the button
went down is not something an editor can place by ear afterwards, because only
the driver knows when the press happened. `RunResult` and the shot manifest
carry them; `compose` synthesizes a WAV per shot and places it as a timed
`<audio>`. Synthesized, not sampled — no licence to honour, no binary vendored,
and Reel already owned the synthesis.

## Still not incorporated

- **BGM.** HyperFrames bundles SFX but no music, and the local generators
  (Kokoro, MusicGen) are not installed here.
- **Frame presets and visual styles.** Thirteen complete design languages plus
  eight named visual styles; Reel still uses its own `looks.ts`. These should
  merge — a look and a frame preset are the same idea in two vocabularies.
- **Shader transitions.** Installed and de-CDN'd blocks can now be mounted, but
  no scene handoff uses one yet; the handoffs are crossfades and a flash.
- **The creation workflows.** `/product-launch-video`, `/motion-graphics` and
  the rest plan a film from a brief. Reel's spec is a different front door and
  the two have not been reconciled.
- **Captions track, LUTs, `media-use` sourcing.**
- **The deeper one:** `compose` is still a generator. It emits a better
  structure now, and an agent can edit any single scene — but nothing forces the
  per-project authoring pass that makes their showcase output what it is.

---

# Part 12 — The deletion pass

## What went, and why it had to

The rescope added a second pipeline without removing the first, and a repository
that tells two stories about what it is teaches neither. This removes the half
the rescope replaced.

| Removed | Why |
| --- | --- |
| `reel ci` + the GitHub Action (`action.yml`) | The whole thing was a drift gate: run every spec, regenerate committed media, fail the build when it moved. That is not what Reel is for now. |
| `reel diff`, `src/diff/` | Pixel comparison of two renders. Only ever a review aid for committed media. |
| `reel review`, `src/review/` | Model-judged verdicts on a changed render. Same. |
| Fingerprints, stamps, `--if-changed` | Skipping a render when nothing changed paid for itself only in CI. |
| `src/encode/html.ts`, `player.ts`, `document.ts` | The interactive click-through and the document build. A HyperFrames composition supersedes both. |
| The `branch` step, `src/driver/branches.ts` | Went with the click-through — see below. |
| `scripts/{player,branch}-selftest.ts`, `npm run test:{player,branch}` | Nothing left to test. |

Roughly 1,500 lines of source, plus their tests and two examples.

## The one that was not merely dead

`branch:` still *ran*. With no click-through to carry the alternate paths it
would have recorded its default and silently dropped the rest — a spec that
declares three paths, gets one, and is told nothing. That is worse than not
offering the feature, which is why it went with the build that gave it meaning
rather than being left as a stub.

## What was kept, and the judgement in each

- **`reel record`.** It shares 95% of its machinery with `shoot` and produces a
  finished GIF/MP4 with no composition involved, which is genuinely the right
  tool for a quick artefact. Deleting it would also have meant deleting the
  burn-in compositors — captions, device frame, fades, highlights — and with
  them a large part of the spec grammar that existing specs use. Removing a
  working feature to make a narrative tidier is not a good trade. It is demoted
  in the README, not removed.
- **`reel check`.** It *was* the drift gate, but it is also a cheap smoke test:
  run every step headlessly, exit 1 if one cannot complete. Before a shoot that
  takes minutes, that is worth thirty seconds. Reframed rather than deleted.
- **`imageFiles` / `signInStates`**, rescued into `src/spec/inputs.ts`. They
  were part of the fingerprint and answer a question that outlives it — *what
  does this spec read from disk?* — and one is security-adjacent: a storage
  state is a bearer credential, and knowing which files a spec will open is how
  you notice one is committed.
- **The Studio's beat strip**, repointed from the render stamp to the shot
  manifest. The manifest is the better source anyway: it is written by the drive
  that caused the beats rather than derived from the media afterwards.

## What it cost to do

The linter and the type checker did the work. The removals cascaded through
`isBranch` in eight files, `output.html` through the matrix expander and the
Studio summary, and `Scene`/`snap()` through every step handler — none of which
would have been findable by grep alone, and all of which the compiler named.

One real mistake on the way: the first cut at the schema deleted the region
between "every step except `branch`" and the privacy section, which contained
the step union itself, not only the branch grammar. Caught immediately by
`tsc`, restored from git, redone precisely.

763 tests pass. `reel shoot`, `reel compose` and `hyperframes check` were all
re-run end to end afterwards — 0 errors, 0 warnings, 11/11 WCAG AA — because a
deletion pass that leaves the pipeline broken is not a deletion pass.

## What CI does now

Typecheck and unit tests on Linux and Windows — Windows because that is where
Reel's process handling is thinnest, since app and terminal teardown both signal
a process group and Windows has none — plus the capture self-test on Linux,
which needs a browser. No media is regenerated, committed or policed.

---

# Part 13 — Audio

The films were near-silent: clicks and keystrokes, nothing else. Three layers
now, and each arrives differently on purpose.

## Interaction sound

Already there from Part 10, and worth restating because it is the one thing in
the mix nobody else can produce. Reel's driver caused every click and keystroke,
so it knows when each happened to the millisecond. A click landing on the exact
frame the button went down cannot be placed by ear afterwards.

## Narration, and admitting when there is none

`RunResult` and the shot manifest carry the spoken lines as **text always,
audio only when it exists** — synthesized now, or already in the committed voice
cache. The split is the point. A line with no audio is not dropped: it reaches
the composition as text, lands in `STORYBOARD.md` as a `voiceover:` guide —
their storyboard format has a field for exactly this — and `shoot` reports how
many lines are missing a track.

This sandbox has no voice cache and no API key, so the path was built and
exercised in its degraded mode: *"3 spoken lines, and no `audio.voice` to say
them — the film will carry the text only."* That is the honest outcome. A demo
that quietly ships two-thirds narrated is worse than one that says it is silent.

## A music bed, synthesized

`src/compose/music.ts` renders a slow four-chord pad sized to the film, ducked
about 12dB under every spoken line. `--music <file>` takes a real track instead;
`--music none` is silence.

Synthesized rather than shipped, and the argument is stronger than it was for
the sound effects: a recording needs a licence, and a licence that is right for
Reel's repository is not necessarily right for the demo someone cuts with it.
"Royalty-free" covers a dozen incompatible things and the person who discovers
theirs was not covered discovers it from a takedown. None of this is a
recording, so there is nothing to clear — and it is deterministic and offline,
which the render already has to be.

**The first version was a rumble.** Voiced -7 to +12 semitones around a 110Hz
root, every partial that mattered fell under 200Hz; a spectrogram of it is one
band along the bottom of the image. Inaudible on a laptop speaker, gone entirely
on a phone. Re-voiced upward from a 220Hz root with stronger second and third
partials, the energy above 300Hz now sits 2.4dB below the full-band level rather
than being absent. A test pins it, because "is there anything above the bass"
is not a question a listener of the code can answer.

Ducking is timed from the narration cues rather than measured off the waveform:
the driver knows when each line starts because it scheduled it, and a level
automation derived from the audio would only ever be an estimate of that.

# 14. Transitions, and the pattern we had been shipping

The task was "do the shader transitions" — HyperFrames publishes
`@hyperframes/shader-transitions`, a WebGL library of displacement wipes,
dissolves and glitches. Two things came out of reading it, and the second
matters much more than the first.

**Shader transitions cannot transition footage.** `init({ scenes, transitions })`
resolves every scene with `document.getElementById(id)` and requires
`el.classList.contains("scene")` — the elements must live in the host document,
and `scenes.length` must equal `transitions.length + 1`, so the library owns the
whole running order. Then `captureScene()` rasterises each one through
`drawElementImage` or `html2canvas`, and **neither draws a `<video>` frame**.
They would work between card scenes on a film with no footage in it. Reel's
films are mostly footage, and every scene is a sub-composition the host cannot
reach into, so the API is incompatible twice over. Not adopted, and the reason
is worth writing down so nobody spends the afternoon again.

**The important finding: we had been shipping the pattern their docs ban.**
Every scene faded its own `#root` out at the end, and the next scene faded its
own in. `transitions/overview.md` is unambiguous about this — *"exit animations
are BANNED except on the final scene; the outgoing scene's content must be fully
visible when the transition starts. The transition IS the exit."* A fade-out
followed by a fade-in is, in their words, "a jump cut with a dip". It looks
like a transition in a still and reads as a stutter in motion, which is exactly
why it survived so long: every snapshot of it looked fine.

A real transition animates both sides at the same instant, so it has to be
written by the only layer that can see both — the index. A sub-composition
cannot reach its neighbour, and a sub-composition timeline cannot touch the
host. So `transitionTweens()` in `src/compose/project.ts` writes the seams, and
`cardScene`/`shotScene` write no exits at all.

The vocabulary is one primary and one accent, which is their guidance —
*"pick ONE primary (60–70% of scene changes) plus one or two accents; never use
a different transition for every scene"*:

- **Blur crossfade** everywhere, the recipe from `css-dissolve.md`: the outgoing
  blurs and swells slightly as it leaves, the incoming arrives from under a blur
  a beat later. Both halves start within 100ms of each other and share the
  handoff window the scenes already overlap by.
- **Overexposure flash** into a chapter card only, because that seam is a
  section break rather than a continuation.

Every departure ends with a zero-duration `set` on the clip boundary. An opacity
tween that merely *reaches* zero there leaves stale state when the renderer seeks
out of order, which their linter calls `gsap_exit_missing_hard_kill`.

**The flash has to flash away from the ground.** White at a cut reads as
overexposure on a dark film. On the cream ground of an `editorial` or a frame
preset it has no contrast to spend and simply blows the frame out — the first
render of this was a white rectangle where the seam should have been. A light
look dips to its own ink instead, which is the same edit read the other way up,
and the snapshot at the seam shows the outgoing frame still legible under it.

`test/transitions.test.ts` pins all of it: no scene animates `#root`, anything
that does fade lands before the handoff window opens, both halves of every seam
exist and start together, every departure has its hard kill, the last scene is
never faded, and the flash contrasts with the ground it sits on.

# 15. The authoring pass

The gap this closes was named at the end of every previous part and never
fixed: **`compose` generated a whole film, so nothing forced a per-project
pass.** Every film it wrote was structurally the same film — a waterfall
headline, a chapter card, footage under a bottom band — and it marked its own
output `status: animated`, which is a claim that somebody authored it. Nobody
had.

Three things were wrong underneath that, and they were all the same thing:
**`compose` was write-only.**

- It generated `STORYBOARD.md` and never read it again, so the plan layer was a
  report rather than a contract.
- It built `index.html` from the array of scenes it happened to have in memory,
  so there was no way to rebuild the host without re-running compose.
- Re-running compose overwrote every scene file, so anything authored was
  destroyed by the next command that touched the project.

Which meant the only safe thing to do with a composed project was to not touch
it. That is why the pass never happened: it was not that people skipped a step,
it was that the step could not be taken.

## Reading the storyboard back

`src/compose/storyboard.ts` parses it, lenient in the way theirs is — it never
throws, and records anything surprising as a warning. A file edited by hand
between every step of the loop cannot have a parser that rejects it over a stray
bullet. One judgement in there is worth stating: a `- key: value` line **after
the prose has started is prose**, so an author can write a list in the narrative
without inventing a field.

With a parser, the storyboard becomes the running order. `assemble` rebuilds
`index.html` from it, `packets` cuts each brief from it, and `compose` reads it
to refuse to clobber work it did not write.

Making that round trip lossless found a real bug on the first try: the
storyboard wrote durations at two decimals, so re-assembling a composed project
moved the back half of the film by 4ms and put every seam a frame off the scene
it belonged to. Durations are milliseconds now, and the round trip is
byte-identical.

## The three steps

- **`reel packets`** writes one bounded brief per scene plus `_role.md`. A scene
  author reads exactly those two files and `frame.md`, and nothing else — not
  the storyboard, not its siblings, not the skill catalogue. That bound is the
  mechanism: it is what lets N scenes be authored at once without the workers
  colliding, and what stops each one drifting into a different film.
- **`reel assemble`** rebuilds the host from the storyboard and never touches a
  scene. Change a `duration:` and the running order, the seams and the music
  ducking all follow.
- **`reel mark`** promotes a frame as its author returns. It rewrites the one
  `status:` bullet rather than regenerating the file, because by then the
  narrative and the shot sequence are the most valuable things in it.

And **`reel status`** is the gate: it prints which scenes are still `built`. A
film delivered with scenes still marked `built` is a film nobody authored.

## What a Reel packet carries that a HyperFrames one cannot

The shot facts. A HyperFrames frame worker invents its content; a Reel one is
cutting against footage of a real app, and the driver wrote down every moment it
caused — the exact second the button went down, what the demo claimed and when,
where each narration line starts. Those are the difference between an edit that
lands on the beat and one that is 200ms late, and there is no way to recover
them by eye afterwards. So every footage packet carries its scene's beats,
captions, sound cues and narration in the scene's own time.

It also inlines the `<video>` and `<audio>` tags verbatim, lifted out of the
scaffold. That is the one mistake in the whole pass that fails silently: a
re-typed `src` renders a black rectangle and passes lint, and the paths are not
derivable from the manifest because compose decides them.

## Proving it

The loop was run end to end on the example film: compose the scaffold, cut the
packets, author the title card from its packet as a dispatched worker would,
`reel mark 1`, `reel assemble`, `hyperframes check`.

The authored card is a film strip travelling left with the wordmark cut out of
it in a masked band — the thesis of the film as an image, rather than a headline
centred on a background. `check` passes clean, and the card develops across its
full duration instead of holding from 25%.

Two guard rails earned their place while proving it. `compose` over an authored
project now refuses by name — *"holds 1 authored scene, and compose would
overwrite it: Title"* — and points at `assemble`. And `reel mark` exists at all
because the orchestrator's own step had no command, so marking a frame meant
hand-editing markdown in the middle of a dispatch loop.

## Still open

- **Shader transitions between cards.** They are ruled out *between footage*,
  not everywhere. A film that is all cards — a changelog, a feature announcement
  — could run their displacement wipes, if the host learned to flatten a scene
  into a `.scene` element the library recognises.
- **A storyboard worth authoring against.** `compose` writes a one-line `scene:`
  per frame. Their workflows write a *time-coded shot sequence* — Scene 1
  (0.0–2.0s) … Scene 2 … — paced to the voiceover, and that is what makes a
  frame worker build a shot rather than a picture. Reel's packets carry the
  beats to pace against but not yet the sequence itself.
- **Real narration end to end.** The plumbing is exercised only in its degraded
  path here. With a key or a warm cache, `shoot` copies the per-line audio into
  the shot directory and `compose` places it — but nothing in this session has
  heard it.
- **The `hyperframes-audio` chain.** Their EQ, compressor and voiceover *carve*
  — ducking only the bands the voice occupies, rather than the whole bed — is a
  better ducker than a volume tween, and `<hf-audio-group>` would let the bed
  and the effects share one fader.
- **Music that fits the look.** The bed is the same pad for every film. A
  `brutal` cut and an `editorial` one want different beds, and the look already
  knows which it is.
