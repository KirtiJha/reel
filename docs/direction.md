# Direction: making a demo watchable

A plan for the second half of Reel — the part that decides whether a demo holds
attention, and the interface that lets someone build one without hand-writing
YAML.

Status: implemented — `fit: flow`, idle motion, `highlight`, `image`,
`diagram`, the preview tiers, `reel narrate`, `reel say`, and `reel capture`
writing `highlight` and `say` (Part 1.1–1.4, 3.6 and order step 5). Still
proposed: `reel direct`, transitions, and the Studio views.

One correction the measurement forced: `--only` cannot run "against cached
frames", because frames live in a temp directory that is removed when a run
ends. It stops the drive once the requested section is filmed and renders only
that range — real savings, but bounded by how far into the demo the section
sits, and only as fine-grained as the beats a spec actually names.

`highlight` shipped with `box`, `circle` and `underline`; `arrow` and
`pointer` are not implemented and the schema refuses them rather than
accepting a value the renderer cannot draw. `reel capture` does not write
`highlight` steps yet — that is step 5 of the order below, along with the
other step kinds it cannot yet author.

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

## 1.5 Transitions

Chapters currently hard-cut. `transition: { kind: fade | wipe | push, ms }` on a
card or between cuts, so a ten-part film reads as one piece.

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
6. **`reel direct`.** Wants the primitives to exist before it can place them.
7. **Studio: beat strip, script panel, direction inspector** — views onto the
   commands from 4-6, which is why they come after rather than before.
8. **Re-cut the tour** using all of it, and compare against the numbers at the
   top of this document. One visual change every 6.2 seconds is the bar to beat.

Step 8 is the honest test. The measurements are the acceptance criteria: if the
re-cut still has a fifty-second static frame, none of this worked.
