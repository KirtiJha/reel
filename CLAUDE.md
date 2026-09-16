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

For anything touching the capture, render or encode path, also record a demo —
the pipeline has failure modes no unit test reaches:

```bash
npm run dev -- record examples/taskflow/demo.reel.yaml
npm run dev -- check  examples/taskflow/demo.reel.yaml
```

The browser-driven self-tests cover what unit tests can't:

```bash
npm run test:player   # the interactive build's router, autoplay, embed, a11y
npm run test:branch   # branch splicing, choice UI, deep links
npm run test:capture  # captures a spec from the example app, then replays it
```

## Things that are easy to break

- **Output must stay reproducible.** The same spec against the same app renders
  byte-identical media. If you touch capture timing, overlay animation or the
  encoder, verify with two runs and compare hashes — CI commits this media, so
  churn there is a real regression.
- **Alternate branch paths must be prepared exactly like the main pass** (same
  frozen clock, mocks, redaction). Use `prepareContext`; there is one way to
  build a context for a reason.
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
