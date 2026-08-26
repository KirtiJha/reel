# Direction: making a demo watchable

A plan for the second half of Reel — the part that decides whether a demo holds
attention, and the interface that lets someone build one without hand-writing
YAML.

Status: proposed. Nothing here is implemented.

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
  idleMotion: drift        # drift | none
  idleMotionAfter: 1200    # only kick in once nothing has changed this long
```

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

# Part 3 — Studio as the place you build a demo

Today Studio edits a spec's *options*. It should become where the demo is
authored — the equivalent of an invideo timeline, with the spec underneath
rather than a proprietary project file.

The rule that keeps this honest: **every action writes YAML.** The spec stays
the source of truth, so a demo built entirely in the UI still diffs in a pull
request, still runs in CI, still renders the same bytes. Nothing becomes
editable only through the UI.

## 3.1 The beat strip

The main surface. Not a frame-accurate timeline — Reel's unit is the beat, and
pretending otherwise would invent precision the model does not have.

Each beat shows its storyboard thumbnail, its narration, its duration, and small
marks for the direction on it — camera, annotations, media. Drag to reorder,
click to inspect.

## 3.2 The script panel

Narration as a document, read top to bottom — the thing you actually edit
when a demo does not flow.

- Every `say:` line, in order, beside the beat it belongs to.
- **Generate a draft**: an LLM reads the steps and beats and proposes a line per
  beat. Reviewed in place, never auto-applied. This is `reel author`'s sibling —
  it writes prose, not selectors, which is the safer half of the problem.
- **Speak this line** — synthesize one line and play it, without a render. The
  cache makes this nearly free and it is the fastest way to hear whether a
  sentence lands.
- Per-line duration once synthesized, so an over-long line is visible as a
  number rather than discovered in the finished film.
- A word-count and estimated-runtime header. Ten minutes of narration is about
  1,400 words; knowing that while writing prevents the film the tour became.

## 3.3 The direction inspector

Selected beat, right-hand panel: camera (auto / hold / drift / zoom to
selector), annotations (add a highlight, pick shape and style, choose the
element by clicking the preview), media (drop an image, choose full/inset),
transition.

Picking an element by clicking a thumbnail — rather than typing a selector —
is the single biggest usability win available, and Reel already records every
element's box.

## 3.4 The media library

Drag a file in; it lands in the spec's directory and is referenced by path. Paste
a URL and Studio downloads it *now*, into that same directory, so the render
stays local. A mermaid editor for diagrams.

## 3.5 Preview that is fast enough to iterate

The blocker for all of the above. A ten-minute render is minutes; nobody edits
against that.

Three tiers, cheapest first:

1. **The interactive build.** Reel already produces a self-contained
   click-through of scenes. It needs no video encode and is nearly instant — the
   right live preview for structure, order and script.
2. **Per-beat render.** Re-render one beat against cached frames. Seconds, and
   the natural loop when tuning a single annotation.
3. **Draft render.** `preset: draft` — small, low frame rate, video only, cached
   audio only. For seeing the whole film before committing to a full one.

Without tier 1 and 2, the UI is a form over a batch job. With them, it is an
editor.

---

# Part 4 — What must not change

- **The spec is the source of truth.** Everything the UI does is a YAML edit.
- **Renders stay byte-identical.** Nothing added here may fetch at render time
  or introduce unseeded randomness. Idle motion, annotations and transitions are
  all pure functions of the spec and the frames.
- **Nothing is applied silently.** `direct` and generated narration propose; a
  person accepts. The tool's whole claim is that a demo is reviewable.

---

# Part 5 — Order

1. **`fit: flow` and idle motion.** The root cause. Improves every existing demo
   with no re-authoring.
2. **`highlight`**, alongside `callout`.
3. **`image`**, plus mermaid diagrams.
4. **Studio: beat strip, script panel, direction inspector** — on the fast
   preview tiers, which have to come first or the UI is unusable.
5. **`reel direct`.** Wants the primitives to exist before it can place them.
6. **Re-cut the tour** using all of it, and compare against the numbers at the
   top of this document. One visual change every 6.2 seconds is the bar to beat.

Step 6 is the honest test. The measurements are the acceptance criteria: if the
re-cut still has a fifty-second static frame, none of this worked.
