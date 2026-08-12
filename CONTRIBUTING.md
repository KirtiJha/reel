# Contributing to Reel

Thanks for helping build the open-source standard for demos-as-code.

## Dev setup

```bash
npm install
npx playwright install chromium
npm run dev -- record examples/taskflow/demo.reel.yaml   # run the CLI from source
npm run typecheck
npm run build                                            # emit dist/
```

## Layout

```
src/
  cli.ts            CLI entry (commander)
  spec/             schema (zod) + loader/validator
  driver/           browser launch, determinism, app lifecycle, step execution
  overlay/          synthetic cursor + captions (drawn into the page)
  capture/          CDP screencast → timestamped PNG frames
  encode/           ffmpeg → GIF / MP4 / WebM / storyboard
  ai/               `reel author` (agent authoring — v0.3)
examples/taskflow/  self-contained demo app used to dogfood
```

## Principles

- **State-based, never time-based.** New step types wait on app state.
- **Determinism first.** Anything that makes a real app reproducible belongs in
  `src/driver/determinism.ts` and runs before app code.
- **Frames are the substrate.** Capture stays lossless/timestamped so polish
  steps compose. Don't reach for Playwright's built-in video.
- **The spec is a semver'd contract.** Additive changes only within a major;
  update `SPEC_VERSION` for breaking ones.

## Before opening a PR

- `npm run typecheck` is clean.
- `npm run dev -- record examples/taskflow/demo.reel.yaml` produces a GIF.
- `npm run dev -- check examples/taskflow/demo.reel.yaml` exits 0.

Good first issues are labeled on the tracker. Be kind, keep scope small.
