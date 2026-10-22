# The promo

A four-minute film about Reel, filmed with Reel, against this repository.

```bash
npm run ui                           # Studio on :4488 — chapters 3 and 6 film it
node promo/build.mjs        # render every chapter, then assemble
node promo/build.mjs 03 06  # re-record two chapters
node promo/build.mjs --assemble
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
| 04 | the interactive build, branch choice and all | a real `html:` output, `:4597` |
| 05 | `reel check` **failing** on a spec that is wrong on purpose | terminal |
| 06 | Studio — gallery, spec, record, check, heal | Studio, `:4488` |
| 07 | `reel publish`, then the close | a real published site, `:4596` |

Every chapter shares `viewport: 1440×713`, `scale: 2` and `padding: 50`, which
is not arbitrary: with a device frame that composites to exactly 3168×1782, so
the film is true 16:9 before anything is scaled and nothing is ever letterboxed.
Change one of those three in one chapter and that chapter alone will be the
wrong shape.

## The things it films are real

Chapter 4 drives an interactive build that `examples/taskflow/branching.reel.yaml`
wrote. Chapter 7 drives a site that `reel publish` wrote. Chapter 5's failure is
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
