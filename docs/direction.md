# Direction: making a demo watchable

A plan for the second half of Reel — the part that decides whether a demo holds
attention, and the interface that lets someone build one without hand-writing
YAML.

**Status: everything in this plan is built except the last step — re-cutting
the tour — which needs a machine that can reach a text-to-speech endpoint.
See "Part 6 — Finishing this on your own machine" at the end.**

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
