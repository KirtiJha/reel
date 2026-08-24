# Changelog

Notable changes to Reel. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions are
[semantic](https://semver.org/spec/v2.0.0.html) — with the honest caveat that
while this is 0.x, a minor bump may change spec behaviour.

Two things earn a line here that a normal changelog might leave out, because for
this tool they are the whole point:

- **Anything that changes rendered output.** The same spec is supposed to render
  the same bytes forever, so a release that alters them is a release that will
  produce a media diff in your repository, and you should be able to find out
  why from this file rather than from a surprise in a pull request.
- **Bugs found by pointing Reel at software nobody here wrote.** Most of the
  fixes below came from capturing real applications — Uptime Kuma, a Docusaurus
  site, n8n — and each one is named with the app that exposed it, because that
  is the fastest way to tell whether it is a bug you have hit too.

## [Unreleased]

### Added

- **`drag` steps.** Kanban boards, flow builders, sliders, reorderable lists and
  drag-to-upload could not be demoed at all — not by capture and not by hand,
  because there was no step to write. `drag: { from, to }` takes another element
  or a point, and the driver walks the path rather than using a single jump,
  which many apps read as a click.

### Fixed

- **`diff` and `review` called a changed price identical.** A demo whose plan
  went from "£9 per month" to "USD 29" came back as *"Identical — the two
  renders are the same demo, frame for frame"*, which is the worst answer this
  tool can give: it is the one people will trust without looking. The threshold
  sat at 0.2% of pixels while the change moved 0.168%. It is now 0.1%.

  The old number was justified as sitting "well under a moving cursor (~0.3%)",
  and that was describing a world Reel does not have: two renders of one spec
  differ by exactly 0.0000%, because renders are deterministic — that is the
  whole point of the project. The real noise ceiling is GIF palette
  quantisation at 0.073%, and only when comparing *across* formats. The new
  threshold sits between that and the smallest real change measured, with room
  either side, and the numbers are pinned in the tests so the next person to
  move it has to move the measurements too.

- **Capture recorded a drag as nothing at all.** Press and release on different
  elements fire no click, and the observer only listened for clicks — so the
  gesture produced no step *and* nothing in the skipped list. Found in n8n.
- **A URL containing a freshly minted id was recorded literally.** n8n's "Build
  a workflow" lands on `/workflow/xOKY1J9Z2cJ40cBe`, and the next run creates a
  different workflow, so the captured step waited for something that would never
  exist. Generated path segments are now `*`.
- **`waitForUrl` with a wildcard silently matched nothing.** A path like
  `/workflow/*` was treated as a complete pattern, so it was compared against
  the whole address and never got past the scheme and host.
- **Accessible names were taken from element content for roles that forbid it.**
  ARIA does not allow name-from-content for `group`, `region`, `dialog` and
  friends, so `role=group[name="Add first step…"]` looked perfect, passed
  capture's own uniqueness check, and resolved to zero elements in Playwright.
  Found in n8n.
- **A captured drag onto a point wrote a spec that could not be parsed.** A
  nested `{ x, y }` was serialized block-style inside an inline map, producing
  `- drag: { from: "#card", to: x: 900` and a second line. Capture said it had
  succeeded and the file was unloadable. Found in n8n's canvas.
- **A drag to a point outside the viewport reported success.** There is nothing
  out there to drop onto, and the mouse goes wherever it is told without
  complaining, so the step did nothing and `check` called the demo fine. Found
  by replaying a captured n8n drag at a smaller viewport than it was recorded
  at — which is exactly what the point form warns is fragile.

### Changed

- **`.reel-stamp.json` is now committed rather than ignored.** It is what
  `record --if-changed` compares against, so a fresh checkout — every CI run —
  answered "no previous render recorded" and re-rendered regardless. The flag
  was inert in the one place it was meant to save time. To make the file safe to
  commit it dropped its `at` timestamp (read by nothing, and it would have made
  every render look like a change) and now stores output paths relative to
  itself instead of absolute ones.

  Using `--if-changed` still needs `--app-revision` when your app can change
  independently of the spec: Reel cannot know what a URL will serve, so the app
  is deliberately not fingerprinted.

## [0.2.0] — 2026-08-23

### Added

- **`reel review`** — says *what* changed between two renders and whether the
  demo is still true, including a caption the screen no longer matches. `check`
  proves the steps ran and `diff` proves pixels moved; neither catches a
  renamed button leaving the narration wrong. Needs a model; without one you get
  the pixel report and a note that nothing judged it, never a false pass.
- **`reel ci`** — every demo in a repository in one run, with one exit code and
  one pull-request comment.
- **A GitHub Action.** `uses: KirtiJha/reel@v1`. Deliberately thin: every
  decision it makes is `reel ci`, which you can run locally and get the same
  answer.
- **Demos behind a login.** `reel capture --save-auth` saves the signed-in
  session and `storageState:` replays it, so the sign-in is never filmed. A
  `signIn` step crosses over mid-demo, for a story that has to start signed out
  on a marketing page and continue inside the product.
- **Scoped selectors.** An ambiguous name is qualified by the region it lives in
  — `nav >> role=link[name=Tutorial]` — rather than discarded or, worse,
  resolved by index.
- **A release workflow** publishing from a tag with npm provenance.

### Fixed

- **GIFs are rendered from the encoded video rather than the PNG sequence**,
  which was truncating long demos. *Changes rendered output.*
- **Captions were composited twice** when auto-zoom was on. *Changes rendered
  output.*
- **A single-page app's own routing was recorded as demo steps** — three
  `waitForUrl`s for pages the demo had not navigated to yet. Found in Uptime
  Kuma.
- **Auto-zoom cropped the wrong region after a navigation**, filming a new page
  through a crop shaped around a button on the old one. Found in Uptime Kuma.
  *Changes rendered output.*
- **A click on an icon was recorded as a path through its `<svg>`.** The walk
  now goes up to the control the person actually clicked. Found in a Docusaurus
  site.
- **Long `aria-label`s were discarded** by the cap meant for visible prose,
  throwing away a perfectly stable selector. Found in a Docusaurus site.
- **`~` in a spec path** resolved to a directory that could not exist.

## [0.1.0] — 2026-08-17

Predates tagged releases, so there is no GitHub release to link to; the link
below goes to the published package.

First published release: the deterministic runner, retina capture, auto-zoom,
device frames, the scene grammar (title cards, callouts, rendered scrolling,
assertions), GIF/MP4/WebM/storyboard encoders, the interactive HTML build,
branching, terminal demos, `reel capture`, AI authoring, self-healing drift
repair, subtitles and localization, PII redaction and mock data, `reel doctor`,
`reel diff`, failure artifacts, `--json`, `--if-changed`, and a JSON Schema for
editor autocomplete.

[Unreleased]: https://github.com/KirtiJha/reel/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/KirtiJha/reel/releases/tag/v0.2.0
[0.1.0]: https://www.npmjs.com/package/@kirti_jha/reel/v/0.1.0
