# The `.reel.yaml` grammar

The authority is `src/spec/schema.ts` and the generated `schema/reel.schema.json`
— both carry the doc comments this file summarises. When they disagree with
this file, they are right.

Run `npm run dev -- schema` to print the JSON Schema for editor autocomplete.

## Top level

| Key | What it is |
|---|---|
| `name` | The demo's title. Shows in the storyboard and the click-through. |
| `url` | Where the app is. |
| `viewport` | `{ width, height, scale }` — `scale: 2` is retina. |
| `theme` | `dark` or `light`. |
| `run` | Boot the app yourself: `{ cmd, cwd, readyOn, env }`. |
| `terminal` | Makes this a terminal demo: `{ cols, rows, cwd, prompt, fontSize, typing, theme }`. |
| `deterministic` | `{ freezeClock, disableAnimations, seedRandom, locale, timezone, timeline }`. |
| `polish` | How it is filmed. See below. |
| `audio` | Narration and music. See below. |
| `mock` | Deterministic network: `{ har }` or route stubs. |
| `storageState` | A saved sign-in. **Never commit one** — it is a bearer credential. |
| `steps` | The demo. |
| `cuts` | Extra deliverables sliced out of one recording. |
| `output` | What to write. |

## Steps

Every step is a single-key object. `- click: "#a"` and
`- click: { selector: "#a" }` are the same step where a shorthand exists.

### Doing things

| Step | Shape |
|---|---|
| `goto` | a URL or path |
| `click` / `dblclick` / `hover` | a selector |
| `type` | `{ selector, text }` — types character by character, on camera |
| `fill` | `{ selector, text }` — sets the value at once, for long strings |
| `press` | `{ key, selector? }` |
| `drag` | `{ from, to }` — `to` is a selector or `{ x, y }` |
| `scroll` | `{ to, ms }` — eased, cinematic |
| `scrollTo` | a selector, instantly |
| `signIn` | `{ state, goto? }` — restore a session off camera |
| `run` | a shell command, in a terminal demo |

### Asserting

| Step | Shape |
|---|---|
| `waitFor` | a selector, or `{ selector, timeout }` |
| `waitForUrl` | a path or URL |
| `expect` | `{ selector, text?, count?, visible? }` |
| `expectOutput` | text a terminal command must have printed |

`check` runs all of these. They are what make a demo a smoke test.

### Saying things

| Step | Shape |
|---|---|
| `caption` | text, or `{ text, ms, position, say, sayIn }` |
| `say` | text, or `{ text, ms, sayIn }` — narration with nothing on screen |
| `card` | title, or `{ title, subtitle, ms, say, sayIn }` — a full-screen title |

A caption speaks its own text unless `say:` gives the ear something better, or
`say: false` keeps it silent. A card is silent unless given a `say` — a title
read aloud sounds like a title.

### Showing things

| Step | Shape |
|---|---|
| `image` | a path, or `{ file, as, corner, alt, ms, say }` — `as` is `full`, `inset` or `split` |
| `diagram` | Mermaid source, or `{ mermaid, as, corner, theme, alt, ms, say }` |

Always a local file. A render never fetches.

### Directing

| Step | Shape |
|---|---|
| `zoom` | `{ to, level, ms }`, or `out` for a wide shot |
| `callout` | `{ selector, text, ms }` — dims everything else and **holds the film** |
| `highlight` | `{ selector, shape, style, label, ms, until }` — marks and keeps going |
| `transition` | ms, or `{ kind: fade, ms, color }` — dips to a colour and back |
| `beat` | a name — marks a moment; the storyboard and `--only` use it |

`callout` and `highlight` are different sentences. A callout is *stop and look
at this*; a highlight is *and notice this, as we go*. Use a callout when the
beat exists for that one element, a highlight when things keep happening around
it. Several highlights can be up at once, and `until: <beat>` keeps one up
across as many steps as you like.

`highlight` shapes: `box`, `circle`, `underline`. Styles: `drawn`, `clean`.
`arrow` and `pointer` are not implemented and the schema refuses them.

## `polish`

| Key | Default | What it does |
|---|---|---|
| `zoom` | `auto` | Camera eases toward whatever is clicked or typed into. `false` never zooms. |
| `zoomOutput` | `false` | Terminal demos: follow each command's output. |
| `zoomRows` | `12` | Most rows the camera frames at once. |
| `cursor` | `smooth` | Synthetic cursor that eases between targets. |
| `captions` | `true` | Draw caption text. |
| `frame` | `none` | `browser` (chrome + URL pill) or `window`. |
| `frameUrl` | — | What the URL pill reads. Cosmetic; the demo still runs against `url`. |
| `padding` / `background` / `radius` | | The presentation layer around the page. |
| `accent` | `#6d8bff` | Click ripple, callout ring, highlight stroke, card rule. |
| `speed` | `1` | Scales every authored duration. Real waiting is unaffected. |
| `trimIdle` | — | Caps dead air. Blunt — prefer `speed` or `targetDuration`. |
| `idleMotion` | `auto` | `drift` moves the camera where nothing changes. `auto` follows `zoom`. |
| `idleMotionAfter` | `1800` | How long nothing may change before drifting. |
| `idleMotionScale` | `0.94` | How far one push goes. |
| `fadeIn` / `fadeOut` | `0` | Ramp the film up and down at its ends. |

## `audio`

```yaml
audio:
  voice: { provider: openai, id: onyx, style: "Calm, unhurried technical explainer." }
  fit: flow            # flow | stretch | none
  breathMs: 380
  sfx: subtle
  music: { file: ../bed.mp3, gain: -21, duck: -13, fadeIn: 900, fadeOut: 900 }
```

**`fit` is the single most important audio setting.**

- `flow` (default) places each line at its cue and lets the demo run underneath,
  stretching the timeline only where a line would collide with the next.
- `stretch` grows the hold a line sits on until the sentence finishes. It
  guarantees narration is never cut off, and it does that by stopping
  everything else — this is what produces minute-long frozen frames.
- `none` keeps a fixed length.

Use `flow` unless you specifically want the picture to wait.

## `output`

```yaml
output:
  preset: share        # share | readme | social | hq | docs
  mp4: out/demo.mp4
  gif: out/demo.gif
  webm: out/demo.webm
  storyboard: out/storyboard   # one PNG per beat
  audio: true
  audioTrack: out/demo.m4a
  subtitles: out/demo.vtt
  languages: [de, ja]
  targetDuration: "45s"
```

A preset sets fps, resolution and GIF compression; any field can be overridden.
