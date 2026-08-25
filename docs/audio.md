# Audio: narration, music, and sound design

A design note for adding a soundtrack to a Reel demo — spoken narration, a
music bed, and UI sound effects — without giving up the thing the tool is built
on: the same spec against the same app renders byte-identical media.

Status: phases 1 and 2 are implemented. Phase 3 (sound design) and
phase 4 (per-language voice tracks) are not.

## Why

The videos are silent. The workaround is to render a caption-free cut and take
it into a video editor, which throws away the reason to use Reel at all — the
soundtrack then lives outside the spec, drifts from it, and has to be redone by
hand every time the demo changes.

Two failure modes to design against, because both were hit in practice:

- **Off-the-shelf TTS sounds robotic.** Half of that is the engine. The other
  half is the script: captions are written to be *read* — terse, telegraphic,
  em-dashed. Fed to a synthesizer they come out clipped, because there is no
  connective tissue to carry rhythm. Good narration is different prose from a
  good caption, so it needs its own field, not a reuse of `text:`.
- **A soundtrack that can't be reproduced breaks the core promise.** TTS
  endpoints return slightly different audio for identical input. If synthesis
  happens on every render, no two renders match. The cache is not an
  optimisation here; it is what keeps the guarantee true.

## Shape of the change

Audio is a **post-process**, in the same place subtitles already live
(`src/narrate/`). The driver records exactly as it does today and makes no
network calls; synthesis, retiming and mixing all happen after the drive,
against the captured timeline.

This falls out of the existing architecture rather than being imposed on it:
every caption is already timestamped in demo time (`{ t, text }`, the same
array `buildCues` turns into an `.srt`), so placing a spoken line is the same
arithmetic that places a subtitle cue.

Three consequences worth having:

- Audio can be added to an existing recording without re-driving the app.
- CI never needs an API key, as long as the cache is complete.
- A failed or unconfigured provider degrades to a silent video plus a warning,
  never a failed render.

```
drive ──▶ frames + captions ──▶ [ synthesize ] ──▶ [ retime ] ──▶ render ──▶ [ mix ] ──▶ mp4
                                      │                                        │
                                  voice cache                            music, sfx
```

## Grammar

### Narration

`say:` on any caption step. Written for the ear; falls back to `text:` when
absent, so every existing spec keeps working and gains a rough soundtrack for
free.

```yaml
- caption:
    text: "No screen recorder, no editing, no second take"
    say: "There's no screen recorder here, and no editing.
          What you just watched is a file in the repository."
    ms: 3400
```

`say: false` marks a caption deliberately silent — a label, a chapter number, a
line that reads better than it speaks.

A standalone `- say:` step is also allowed, for narration with no caption on
screen. It holds like a caption does but draws nothing.

### Voice

A new top-level `audio:` block. Top-level rather than under `polish:` because
it is not a look — it survives cuts, and every cut of a recording shares it.

```yaml
audio:
  voice:
    provider: elevenlabs        # elevenlabs | openai | google | azure
    id: "rachel"
    # Steering, where the provider supports it. Ignored elsewhere.
    style: "calm, confident technical explainer, unhurried"
    speed: 1.0
  # How the timeline reconciles with speech that doesn't fit its authored hold.
  fit: stretch                  # stretch | speed | none
  music:
    file: assets/bed.mp3        # yours; Reel ships no tracks
    gain: -22                   # dBFS, before ducking
    duck: -12                   # additional dB under narration
    fadeIn: 1200
    fadeOut: 2500
  sfx: subtle                   # none | subtle | full
```

Credentials come from the environment, exactly as `src/ai/llm.ts` does it
today, and for the same reason: specs are committed to public repositories and
there is deliberately no `${ENV}` interpolation in them.

### Output

```yaml
output:
  mp4: media/demo.mp4
  audio: true          # mux the mixed track into the video
  audioTrack: media/demo.m4a   # optional: also write the bare mix
```

Schema work, per `CLAUDE.md`: these keys go in `src/spec/schema.ts` with doc
comments (the JSON Schema harvests hover text from them, not from `.describe()`),
then `npm run schema` and commit `schema/reel.schema.json`. Studio picks the
new block up from zod automatically — nothing to hand-maintain in `src/ui/`.

## Synthesis and the cache

One provider interface, mirroring the shape `src/ai/llm.ts` already uses:

```ts
interface VoiceProvider {
  id: string;
  synthesize(text: string, opts: VoiceOpts): Promise<Buffer>;  // mp3 or wav
}
```

Every line is cached at:

```
.reel-cache/voice/<sha256(provider|voiceId|style|speed|text)>.mp3
```

**The cache is meant to be committed.** That is what makes a render
reproducible on another machine, what keeps CI key-free, and what makes the
cost of a re-render zero. Changing one line of narration invalidates exactly
that line.

A stray key change or a provider silently swapping a voice would otherwise
produce a video that differs from the last one for no visible reason, so the
hash covers every input that can affect the waveform.

`reel check` gains a cache audit: a `say:` line with no cached audio is
reported as drift, in the same list as a selector that no longer matches. It
must not be a silent skip — a demo that quietly loses a third of its narration
is worse than one that fails.

## Fitting speech to the timeline

The interesting part, and the thing a stock-footage tool cannot do: Reel owns
the timeline, so the picture can move to fit the voice rather than the other
way round.

After synthesis every line has a real duration `D`. Its authored hold `ms` was
written for reading and will usually be shorter.

`src/polish/retime.ts` already remaps a whole timeline piecewise-linearly, with
frames, captions, zoom keys, beats and interactive scenes all carried along.
It caps idle gaps today; fitting audio is the same operation with different
breakpoints — stretch the interval starting at each caption to at least `D`,
plus a small inter-line breath.

```ts
export function buildAudioRetime(
  frameTimes: number[],
  lines: { t: number; durationMs: number }[],
  endMs: number,
  opts: { breathMs?: number },
): Retimed;
```

Modes:

| `fit` | Behaviour | When |
|---|---|---|
| `stretch` | Extend holds so each line fits. Video gets longer. | Default. Preserves delivery. |
| `speed` | Ask the provider for a faster read to fit the authored `ms`. | Fixed-length cuts (a 30s social spot). Rushed past ~1.15×. |
| `none` | Leave the timeline alone; warn on any overrun. | Narration authored against known holds. |

Only stretching is safe to do blind. `speed` should refuse to exceed a ceiling
and warn rather than quietly produce something unlistenable.

Note that stretching changes the duration of every cut derived from the
recording. Cuts resolve by beat label rather than timestamp already, so they
follow correctly — but a `targetDuration` and an audio stretch can disagree,
and that conflict should be an error, not a silent winner.

## Mixing

One ffmpeg graph, built alongside the existing encode in `src/encode/`:

- **Narration** — each cached file delayed to its retimed offset (`adelay`),
  summed (`amix`).
- **Music** — looped or trimmed to length, `volume=gain`, then
  `sidechaincompress` keyed on the narration bus so it ducks automatically
  instead of needing hand-drawn envelopes. Fades at the ends.
- **SFX** — a soft tick on `click`, key texture under `type`, a low sweep on
  card transitions. Placed from the step timeline, which already records when
  each of those happened.
- **Out** — `-c:a aac -b:a 192k`, loudness-normalised to about **-14 LUFS**,
  which is what YouTube and LinkedIn normalise to anyway. Getting this right is
  the difference between "sounds produced" and "sounds like a screen capture".

Ducking is not done with `sidechaincompress`, though that is the usual answer.
A compressor cannot honour a number in dB — how far it pulls down depends on how
loud the narrator happened to be, so `duck: -12` would mean "about twelve,
sometimes". Reel already knows when every line starts and how long it runs, so
the envelope is written out directly and the number means what it says. Measured
on a rendered mix, `-15` comes back as 14.9dB and 15.5dB.

For the same reason loudness is measured first and corrected with one constant
gain rather than normalised in a single pass: one-pass `loudnorm` rides the
level and, with a loudness-range target, lifts quiet passages back up —
undoing the very envelope the mix just built.

Reel should ship **no music and no sound effects**. Licensing makes bundling
tracks a liability, and a bundled bed would be instantly recognisable across
everyone's demos. `music.file` points at something the author supplies;
Uppbeat, Epidemic Sound and the YouTube Audio Library are the usual sources.
A short `sfx` set is different — clicks and ticks can be synthesized at build
time from primitives, with no licensing question at all.

## Localization, nearly free

`src/narrate/translate.ts` already produces translated cue lists, and captions
are composited in post rather than drawn into the page. Add a voice per
language and one recording yields a narrated demo in every language you ask
for, with no second drive:

```yaml
output:
  languages: [es, de, ja]
  audio: true         # one mp4 per language, each with its own voice track
```

This is the feature most likely to matter to a company rather than an
individual, and it is a small increment on top of everything above.

## Cost

Measured against the current 6:20 tour, whose caption text totals ~3,600
characters across the three chapters. Narration written for the ear runs
roughly double that, so call it **~8,000 characters for the whole video**.

| Provider | Rough rate | One full render | Notes |
|---|---|---|---|
| OpenAI TTS | ~$15 / 1M chars | **~$0.12** | Steerable via a style instruction. Best value. |
| Google / Azure neural | ~$16 / 1M chars | **~$0.13** | Cheapest at volume; slightly flatter. |
| ElevenLabs | credit tiers; free 10k/mo, ~$22/mo for 100k | **free, or ~$2** | Best quality. Free tier covers ~1 full render/month; $22 covers ~12. |

Verify current pricing before committing — these move.

Two things make the real number lower than the table suggests:

- **The cache.** You pay once per line, not once per render. Fixing a typo in
  one sentence re-synthesizes one sentence. Re-encoding for a different aspect
  ratio costs nothing.
- **CI pays nothing**, because the cache is committed and no key is present.

Music is the larger recurring line item and it is not ours: roughly $0–15/month
depending on source, or free with attribution.

So: a few cents to a couple of dollars per full re-narration, and effectively
zero for iteration. The cost is not the constraint here — the script is.

## Phasing

1. ~~**`say:` + one provider + cache + stretch-to-fit + mux.**~~ Done. A good
   voice reading prose written for the ear, landing with the picture.
2. ~~**Music bed with ducking**, and loudness normalisation.~~ Done, along with
   per-cut mixing: a cut takes the lines that begin inside it, since one that
   started earlier would arrive halfway through a word.
3. **SFX** from the step timeline.
4. **Per-language voice tracks**, reusing `translate.ts`.

Two modes are deliberately absent. `fit: speed` needs re-synthesis at a computed
rate, and a version that quietly rushed the delivery would be worse than its
absence. And nothing here has been heard through a real vendor yet: the pipeline
is verified end to end against a seeded cache, which exercises every stage except
the HTTP call itself.

Phase 1 is the only one with any design risk, and it is all in the retiming.

## Open questions

- Where does narration for a `card:` go? Cards have their own `ms` and no
  caption. Probably `say:` on the card, same fallback rule.
- Should `reel capture` prompt for narration while authoring? It already
  collects captions and beats — the two things only a person knows. Narration
  is a third.
- Does the interactive HTML build carry audio? Per-scene narration in the
  player is appealing and is a different problem from a linear mix.
- Does a stretched timeline invalidate a committed `.reel-stamp.json` in a way
  that makes `--skip-unchanged` do the wrong thing? The stamp needs to cover
  the audio inputs, or a narration edit will not trigger a re-render.
