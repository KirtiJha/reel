# When a Reel command fails

Reel's errors carry a hint. Read it first — it usually names the fix. This is
what the hints do not cover.

| Symptom | Cause | Fix |
|---|---|---|
| A step times out on a selector | The UI drifted | `heal <spec> --write` re-resolves it offline for most drift; a model handles the rest |
| `No API key for OpenAI` | A spoken line is not in the voice cache | Set `OPENAI_API_KEY`, render once, then **commit `.reel-cache/voice/`** so nobody else needs a key |
| `This spec draws a Mermaid diagram, and there is no rendered copy` | A new `diagram:` step, mermaid not installed | `npm install --save-dev mermaid`, render once, commit `.reel-cache/diagram/` |
| `is a URL, and a render never fetches` | An `image:` step points at http(s) | Download it into the spec's directory and reference it by path |
| `output.targetDuration and audio.fit: stretch disagree` | Two settings both claim to decide the length | Use `fit: none` to keep the target, or drop `targetDuration` |
| Two renders produce different bytes | A determinism regression | `REEL_KEEP_FRAMES=1` on both runs, then diff the frame directories to find the first frame that differs |
| The demo is much longer than expected | `flow` still inserted time for colliding lines | `narrate <spec>` shows which lines are long enough to collide |
| A GIF is one frame | ffmpeg's palettegen/image2 interaction | Known; the encoder already routes GIFs through a video intermediate |
| Nothing renders, only HTML is written | The spec declares no video output | Add `mp4:`/`gif:`/`webm:` under `output:` |
| `A job is already running` (Studio) | One in-process job at a time | Wait, or use the CLI |

## Diagnosing before you render

```bash
npm run dev -- doctor              # browser, ffmpeg, image pipeline, temp space
npm run dev -- check <spec>        # every step, headlessly, in seconds
npm run dev -- check <spec> --json # the same, machine-readable
```

`check` also audits the voice cache and the diagram cache, so it tells you what
a render on another machine would need before you find out the slow way.

## Reading a failure

A failed step writes diagnostics to `.reel-failures/`: a screenshot at the
moment it broke, the page HTML, and the console log. `--json` names that
directory in the error payload, so you can go straight to it.

## Determinism, specifically

The promise is that the same spec against the same app renders byte-identical
media. Things that have broken it before, and are now guarded:

- **Chromium partial raster** — fixed with `--disable-partial-raster`. If you
  change launch arguments, re-verify with two runs.
- **Unseeded randomness in overlay drawing** — the hand-drawn highlight wobble
  is seeded from the element's geometry for exactly this reason. Never use
  `Math.random()` anywhere in the render path.
- **A gradient used as an SVG fill** — librsvg silently falls back to black.
  Resolve a gradient to a solid colour before handing it to a rasterizer.
- **ffmpeg metadata** — outputs use `-fflags +bitexact -flags:v +bitexact
  -map_metadata -1`, which are output-side flags.

Verify like this:

```bash
npm run dev -- record <spec> && md5sum out/demo.mp4
npm run dev -- record <spec> && md5sum out/demo.mp4
```

(`md5` on macOS, `Get-FileHash` on Windows.) They must match.

## Before committing a change to the pipeline

```bash
npm run typecheck
npm test
npm run schema        # if you touched src/spec/schema.ts — then commit the JSON Schema
npm run dev -- record examples/taskflow/demo.reel.yaml    # the pipeline has failure modes no unit test reaches
npm run dev -- check  examples/taskflow/demo.reel.yaml
```
