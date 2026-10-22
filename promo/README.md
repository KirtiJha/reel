# The promo

A three-and-a-half minute film about Reel, filmed with Reel, against this repository.

```bash
npm run ui                       # Studio on :4488 — chapters 3, 4 and 8 film it
node promo/build.mjs             # render every chapter, then assemble
node promo/build.mjs 03 08       # re-record two chapters
node promo/build.mjs --assemble  # re-join what is already rendered
```

Output lands in `promo/out/`:

| file | what it is |
|---|---|
| `reel-promo-final.mp4` | the upload — 1920×1080, 30fps, levelled to −14 LUFS |
| `reel-promo.mp4` | the same cut before the loudness pass |
| `NN-*.mp4` | one file per chapter |

## How it differs from `demo/`

`demo/` is the ten-minute product tour: narrated, filmed against a real
third-party app, and joined by stream copy so the picture that ships is the
picture that was verified. It needs an API key and a checkout of that app.

This is a promo. It has **no narration** — captions and title cards carry it, a
synthesized score carries the rest — and it films nothing but this repository,
so it builds from a clean checkout with no keys and no network.

It also **cross-dissolves rather than stream-copying**, which means the assembly
re-encodes. That is a deliberate trade: a promo is a thing people watch to the
end or do not, and a dissolve between chapters is most of the difference.

## The chapters

| | what it films | where |
|---|---|---|
| 01 | a demo running, before saying what it is | TaskFlow, `:4321` |
| 02 | the spec it came from, and `reel check` passing | terminal |
| 03 | one recording as GIF, MP4, terminal and storyboard | Reel's site, `:4488` |
| 04 | narration, a ducked music bed, and the same cut in Spanish | Reel's site, `:4488` |
| 05 | the interactive build, branch choice and all | a real `html:` output, `:4597` |
| 06 | `reel check` **failing** on a spec that is wrong on purpose | terminal |
| 07 | the same spec rendered twice, checksums compared | terminal |
| 08 | Studio — gallery, spec, record, check, heal | Studio, `:4488` |
| 09 | `reel publish`, then the close | a real published site, `:4596` |

Chapter 07 renders the demo twice while the camera is running, so it is the
slow one — and its `terminal.timeout` is raised accordingly. It was verified
before it was filmed: two renders of `mini.reel.yaml` on this machine produce
the same md5. Had they differed, the honest move would have been to cut the
chapter, not to stage it.

Every chapter shares `viewport: 1440x696`, `scale: 2` and `padding: 50`. That
is not taste, and the arithmetic is worth writing down because it is easy to
get wrong: `output.maxWidth` caps the **captured page**, not the finished
frame, and the device frame and padding are then added on top of the capped
width. So the page lands at 1920x928, the title bar adds 68 and the padding
adds 96 a side, and the canvas is 2112x1188 — true 16:9, scaling to 1920x1080
with nothing letterboxed.

The first cut used `1440x713` on the theory that the viewport was what got
capped. It came out 2112x1210, which is 1.745:1, and would have been pillar-
boxed on every platform it was uploaded to. Change one of the three numbers in
one chapter and that chapter alone comes out the wrong shape.

## The things it films are real

Chapter 5 drives an interactive build that `examples/taskflow/branching.reel.yaml`
wrote. Chapter 9 drives a site that `reel publish` wrote. Chapter 6's failure is
a real non-zero exit from `broken.reel.yaml`, which names a button the app does
not have. `build.mjs` renders all of that first — which is why the promo cannot
be built without a few minutes of rendering before any of its own chapters start.

The terminal chapters type `reel`, not `npm run dev --`: `build.mjs` puts
`promo/bin` first on `PATH`, the same trick `demo/build.mjs` uses.

`mini.reel.yaml` is a prop as well as a spec. Chapter 2 holds it on screen and
asks the viewer to read it, so it is kept to the smallest thing that is still a
real demo — boot, drive, assert, render — and to one line of comment. The usual
explanatory header would be the first seven lines a viewer reads, and they
would be about this repository rather than about the tool.

## The score

`node promo/score.mjs out.wav` synthesizes it — a four-and-a-half
minute cue at 112 BPM, trimmed and faded to the film's length when it is mixed.
Nothing is sampled and nothing is licensed, for the same reason
`src/encode/sfx.ts` synthesizes the UI sound: a bundled track would be a
liability and would make every demo built with Reel sound like every other one.

The UI sound on top of it is Reel's own `audio.sfx: full` — the clicks and key
texture are the ones the recorder emitted, at the moments it emitted them.
