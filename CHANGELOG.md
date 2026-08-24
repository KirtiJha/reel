# Changelog — the 0.2.x line

This is the maintenance branch for 0.2. It exists to carry fixes to people who
are pinned to `~0.2` and are not ready to move to 0.3, and it takes **only**
fixes — nothing that changes the spec grammar, and nothing that changes
rendered output.

Development happens on `main`. For everything in 0.3.0 and later, read the
changelog there.

Install from this line by name, since `latest` points at the newest release
rather than this one:

```bash
npm install @kirti_jha/reel@0.2.x
```

## [0.2.1] — 2026-08-24

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

  Backported from 0.3.0. It changes which comparisons `diff` and `ci` call
  changed — that is the point of it — so a demo that was passing on a real
  difference will start failing. It does not change rendered media.

## [0.2.0] — 2026-08-23

See the [release notes](https://github.com/KirtiJha/reel/releases/tag/v0.2.0).

[0.2.1]: https://github.com/KirtiJha/reel/releases/tag/v0.2.1
[0.2.0]: https://github.com/KirtiJha/reel/releases/tag/v0.2.0
