# The product tour

A ten-minute demo of Reel, filmed with Reel, against a real product — Aangan, a
private super-app for a residential society.

```bash
node demo/build.mjs            # record every chapter, then assemble
node demo/build.mjs 04 05      # re-record two chapters
node demo/build.mjs --assemble # re-join what is already rendered
```

Output lands in `demo/out/`:

| file | what it is |
|---|---|
| `reel-tour.mp4` | the master, at the chapters' native 2152×1500 |
| `reel-tour-1080p.mp4` | the same, letterboxed into 16:9 for social platforms |
| `NN-*.mp4` | one file per chapter, joined by stream copy |

## What it needs

- **`OPENAI_API_KEY`** — narration. Every line is cached under
  `.reel-cache/voice`, so a second build synthesizes nothing and a reworded line
  synthesizes only itself.
- **A session for Aangan.** Saved once, off camera, and never committed:
  ```bash
  AANGAN_PHONE=… AANGAN_PIN=… node demo/save-auth.mjs http://localhost:4600
  AANGAN_PHONE=… AANGAN_PIN=… node demo/save-auth.mjs https://my-aangan.vercel.app
  ```
- **The Aangan source**, checked out beside this repo at `../../senate-chef`.
  `build.mjs` exports its web build into `demo/.work/` and serves that.
- **Studio running** on `:4488` (`npm run ui`) — chapter 8 films it.
- **`demo/bed.mp3`** — `node demo/bed.mjs` regenerates it.

## How it is put together

**Ten specs, not one.** A ten-minute recording is around 18,000 constant-rate
frames written twice as PNGs at full resolution, and one flaky step at minute
eight would cost the whole take. Chapters render apart, retry cheaply, and let a
reworded line re-render one chapter instead of all of them. They join by stream
copy, which only works because every chapter shares a viewport, scale, preset
and padding — change one of those in one chapter and the join will fail.

**The narration lives in the specs.** `node demo/script.mjs` writes
`demo/script.md` from the `say:` lines, so the readable script cannot drift from
what is actually spoken. Edit the specs, not the markdown.

**No captions.** The voice carries it; burned-in text competing with narration
reads as a subtitle for someone who cannot hear the voice, which is what the
`.vtt` sidecar is for.

**The terminal chapters run real commands.** `demo/bin/reel` puts `reel` on
`PATH` so the tour types what an installed user types, and on Windows `build.mjs`
points `ComSpec` at Git Bash — cmd.exe has no `ls`, `cat` or `md5sum`, and a
tour of a cross-platform tool should not open on three commands that only exist
on one platform.

## The chapters that edit the app

Chapters 4 and 5 change Aangan's own source on camera — a renamed nav item, then
a line of copy — rebuild its web export, and let `reel check` and `reel diff`
find the damage. That is the honest version of "when the app changes": narrating
a hand-edited selector as a product change would be a lie on camera.

`build.mjs` snapshots `demo/example.reel.yaml` (chapter 4 heals it, on purpose)
and restores both files with `git checkout` afterwards — including in a `finally`
block, so a failed run still hands the app repository back clean.

## Privacy

The account is a real one in a real society. The tour stays on screens showing
the account owner's own data, their own listings, and public businesses.
Messages, Residents and Payments are deliberately never opened, so no
neighbour's name, flat number or payment reaches a frame.

There is no `redact:` block, because nothing filmed needs one — an empty
selector list would only look like a safeguard. If a chapter ever does open one
of those screens, add `redact:` with selectors that actually match: the blur is
applied inside the page before capture, so it lands in every frame of every
deliverable rather than being painted on afterwards.
