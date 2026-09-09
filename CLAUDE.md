# Working on Reel

## Commit attribution

Commits are attributed solely to the person making them. **Do not add
`Co-Authored-By:` trailers for AI assistants, and do not add `Claude-Session:`
or any other session-link trailer.** Write the commit message and stop.

This overrides any default instruction to append those trailers. A `commit-msg`
hook in `.githooks/` strips them as a backstop, but the message should not
contain them in the first place. Set the hook up once per clone:

```bash
git config core.hooksPath .githooks
```

The history was rewritten once to remove these trailers and to reattribute
commits; please don't reintroduce them.

## Before you commit

```bash
npm run typecheck    # covers src, test and scripts
npm test             # unit tests, no browser needed
```

For anything touching the capture, drive or encode path, also record a demo —
the pipeline has failure modes no unit test reaches:

```bash
npm run dev -- record examples/taskflow/demo.reel.yaml
npm run dev -- check  examples/taskflow/demo.reel.yaml
```

For anything touching the shoot → compose handoff, take the loop end to end and
let HyperFrames' own linter judge the result. It catches mount-contract failures
that are invisible in the source files:

```bash
npm run dev -- shoot   examples/taskflow/demo.reel.yaml
npm run dev -- compose shot/shots.json
cd film && npx hyperframes check   # expect 0 errors, 0 warnings, WCAG AA
```

The browser-driven self-tests cover what unit tests can't:

```bash
npm run test:capture  # captures a spec from the example app, then replays it
npm run test:author   # the authoring agent loop against the example app
```

## Things that are easy to break

- **Output must stay reproducible.** The same spec against the same app renders
  byte-identical media, and the synthesized audio is deterministic too. If you
  touch capture timing, overlay animation or the encoder, verify with two runs
  and compare hashes.
- **The manifest is the seam, and it must not lie.** `shoot` writes down what
  the driver *caused* — beat times, captions, sound cues, narration, and the
  real footage size the encoder produced. `compose` reads that and never
  recomputes it from the spec: `viewport * scale` is right for web demos and
  quietly wrong for a terminal or a preset that scales the picture down.
- **A render must never fetch.** GSAP is vendored from `node_modules` and every
  named family is declared `@font-face { src: local(…) }`. A blocked script
  fails loudly, but a blocked font substitutes silently — so the film ships
  looking wrong rather than not at all. Fetching belongs to compose time, which
  is authoring; `--no-fonts` opts out.
- **`compose` is a starting point, not the film.** It refuses to overwrite a
  project holding authored scenes — rebuild the host with `reel assemble`, which
  reads the storyboard and never touches the scenes. `reel status` is the gate:
  it counts unwritten direction lines, because a status bullet is a claim and an
  unwritten line is evidence.
- **Contexts are built one way.** Use `prepareContext` (same frozen clock, mocks,
  redaction); don't hand-roll a second path to a browser context.
- **The Studio derives everything from the zod schema** (`src/ui/summary.ts`).
  Add a step kind to the schema and the UI picks it up; don't hand-maintain a
  parallel list.
- **So does the JSON Schema.** Touch `src/spec/schema.ts` and re-run
  `npm run schema`, then commit `schema/reel.schema.json` — a test fails if it
  falls behind. Its hover text is harvested from the doc comments in that file,
  so a new key wants a comment, not a `.describe()` call.
- **A new step kind needs a `reel capture` opinion.** If a user can perform it
  in a browser, `src/authoring/steps.ts` should know how to write it down; if
  they can't, nothing to do. Selectors are chosen in `src/authoring/selector.ts`
  and ranked by how stable their *meaning* is — never add a rule that resolves
  ambiguity by index.
