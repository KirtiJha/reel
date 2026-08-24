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

## [0.4.0] — 2026-08-24

A minor rather than a patch because the spec is now strict about keys it does
not recognize — see Changed. Everything here came out of filming a real
product demo end to end, which is the only way some of these surface.

### Added

- **`cuts` — several deliverables out of one recording.** One demo has to be
  several: a long walkthrough for YouTube, a minute for LinkedIn, forty seconds
  for Twitter, something much shorter for a README. Written as four specs they
  drift apart within a month.

  ```yaml
  cuts:
    - name: readme
      from: hero          # a beat label, or a ms offset
      to: pricing
      output: { preset: readme, gif: docs/demo.gif }
  ```

  A cut is not a second recording: it names a range of the demo already filmed
  and re-encodes frames already on disk, so it costs no browser time and cannot
  disagree with the master about what the app did. Beat labels rather than
  timestamps are the point — `from: pricing` still means the right moment after
  the caption above it gets slower.

  The frame in effect at the in point is carried in and rebased to zero, since
  frames land only when the picture changes; slicing to frames inside the range
  opens the cut on whatever changes next, with the opening stretch missing.
  Captions and zooms carry in for the same reason. Beats deliberately do not — a
  chapter that ended before the cut began would mislabel it.

- **`polish.frameUrl`** — the address shown in the browser frame's URL pill.
  Demos are filmed against a dev server, so every published video carried
  `localhost:4500` in the chrome. Cosmetic by construction: it changes the pill
  and nothing else, so it cannot make a recording claim it visited somewhere it
  did not.

### Changed

- **An unrecognized top-level key is now an error rather than a shrug.** Every
  step kind was already strict; the root object was not — which is exactly
  where a version mismatch shows up. A spec using `cuts:` run against 0.3.0
  rendered, reported success, and quietly produced one deliverable instead of
  four, with nothing said. The same hole swallowed ordinary typos: `polsih:`
  renders a demo without the polish you asked for and looks like it worked.

  Both are now rejected by name. Every spec in this repository validates
  unchanged, but a spec carrying a stray key will now fail where it previously
  rendered — which is the point.

### Fixed

- **The polish render path reused its working directories.** Frames are
  expanded into `cfr/` and `proc/` under the frames dir, created but never
  cleared, while ffmpeg restarts its numbering at `000001` every time. A second
  render into the same place read back its own frames *and* the previous
  render's — the first cut of a 22.2s demo came out 27.8s, longer than the
  recording it was taken from, and nothing failed. Latent until `cuts` made a
  second render routine.

### Known limitation

- **`reel check` skips caption and hold time**, which is what makes it fast. A
  timing-sensitive assertion can therefore pass `check` and still fail
  `record` — a lazily-rendered element gets time to appear that the check never
  gave it. Prefer assertions on meaning over exact `count:` on text that the
  app renders in more than one place.

## [0.3.0] — 2026-08-24

A minor rather than a patch because `drag` is a new step kind: a spec that
uses it will not load on 0.2.x. The reason to take it anyway is the first
entry under Fixed — `diff` could call a real change identical, and everything
downstream of it inherited that answer.

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

[Unreleased]: https://github.com/KirtiJha/reel/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/KirtiJha/reel/releases/tag/v0.4.0
[0.3.0]: https://github.com/KirtiJha/reel/releases/tag/v0.3.0
[0.2.0]: https://github.com/KirtiJha/reel/releases/tag/v0.2.0
[0.1.0]: https://www.npmjs.com/package/@kirti_jha/reel/v/0.1.0
