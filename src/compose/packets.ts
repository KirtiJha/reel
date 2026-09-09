import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ReelError } from "../util/log.js";
import type { ShotManifest } from "../shoot/manifest.js";
import { parseStoryboard, type StoryboardFrame, type StoryboardGlobals } from "./storyboard.js";
import { readAssembly } from "./assembly.js";

/**
 * Frame packets — one bounded brief per scene, plus the role that reads them.
 *
 * ## The problem this solves
 *
 * `reel compose` writes five scenes that are structurally the same five scenes
 * every time: a waterfall headline, a chapter card, footage under a bottom
 * band. That is a scaffold, and a scaffold is the right output for a generator
 * — but nothing turned it into *this product's* film, because there was no step
 * where anybody looked at one scene and decided what it should be.
 *
 * HyperFrames' own workflows do have that step, and its mechanism is the packet:
 * the orchestrator cuts one bounded document per frame and dispatches a worker
 * per packet. The worker reads its packet and the design spec, and nothing else
 * — not the storyboard, not the other scenes, not the skill catalogue. That
 * bound is the point. It is what lets N scenes be authored at once without the
 * workers colliding, and it is what stops each one drifting into a different
 * film.
 *
 * ## What Reel puts in a packet that they cannot
 *
 * The shot facts. A HyperFrames frame worker invents its content; a Reel one is
 * cutting against footage of a real app, and the driver wrote down every moment
 * it caused — the exact second the button went down, what the demo claimed and
 * when, where each narration line starts. Those timings are the difference
 * between an edit that lands on the beat and one that is 200ms late, and there
 * is no way to recover them by eye afterwards. So every footage packet carries
 * its scene's beats, captions, sound cues and narration, in the scene's own
 * time.
 */

/** Where packets are written, relative to the project root. */
export const PACKET_DIR = ".hyperframes/frame-packets";
/** Where compose parks each footage scene's manifest for the packet builder. */
export const SHOT_DIR = ".hyperframes/shots";

export interface PacketResult {
  dir: string;
  /** Packet paths, project-relative. */
  packets: string[];
  role: string;
  /** Scenes that already carry `status: animated`. */
  skipped: number;
}

/**
 * Write `_role.md` and one packet per scene still awaiting a pass.
 *
 * Scenes already marked `animated` are skipped unless `all` is set: re-cutting
 * a packet for a finished scene invites a worker to rewrite work somebody
 * approved, which is the opposite of what the pass is for.
 */
export async function writePackets(
  dirIn: string,
  opts: { all?: boolean } = {},
): Promise<PacketResult> {
  const dir = resolve(dirIn);
  const a = await readAssembly(dir);

  let src: string;
  try {
    src = await readFile(join(dir, "STORYBOARD.md"), "utf8");
  } catch {
    throw new ReelError(
      `No STORYBOARD.md in ${dir}.`,
      "`reel compose <manifest>` writes the project the pass works on.",
    );
  }
  const board = parseStoryboard(src);
  if (board.frames.length === 0) {
    throw new ReelError(
      "That storyboard has no frames, so there is nothing to author.",
      "Every scene is a `## Frame N — Title` heading with a `src:` and a `duration:`.",
    );
  }

  const blocks = frameBlocks(src, board.frames.length);
  await rm(join(dir, PACKET_DIR), { recursive: true, force: true });
  await mkdir(join(dir, PACKET_DIR), { recursive: true });

  const packets: string[] = [];
  let skipped = 0;
  for (const [i, f] of board.frames.entries()) {
    if (f.status === "animated" && !opts.all) {
      skipped++;
      continue;
    }
    const id = idFor(f);
    const shot = await readShot(dir, id);
    const media = f.src ? await mediaTags(join(dir, f.src)) : [];
    const rel = `${PACKET_DIR}/${id}.md`;
    await writeFile(
      join(dir, rel),
      packetMd({
        id,
        frame: f,
        block: blocks[i] ?? "",
        width: a.width,
        height: a.height,
        accent: a.accent,
        lookName: a.lookName,
        media,
        globals: board.globals,
        ...(shot ? { shot } : {}),
      }),
    );
    packets.push(rel);
  }

  const role = `${PACKET_DIR}/_role.md`;
  await writeFile(join(dir, role), roleMd());
  return { dir, packets, role, skipped };
}

/** The composition id — the filename stem, which is also the timeline key. */
function idFor(f: StoryboardFrame): string {
  const stem = (f.src ?? "").split("/").pop()?.replace(/\.html?$/i, "") ?? "";
  return stem || `frame-${f.index}`;
}

async function readShot(dir: string, id: string): Promise<ShotManifest | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, SHOT_DIR, `${id}.json`), "utf8")) as ShotManifest;
  } catch {
    return undefined; // A card has no footage, which is not a problem.
  }
}

/**
 * Slice the storyboard into one verbatim block per frame.
 *
 * Verbatim rather than re-rendered from the parse, because the block is the
 * author's own writing by the time the pass runs — a shot sequence, direction,
 * a note about what this scene has to prove. Round-tripping it through the
 * parser would keep the fields and quietly drop the prose that matters most.
 */
export function frameBlocks(src: string, count: number): string[] {
  const lines = src.split(/\r?\n/);
  const heading = /^(#{2,3})\s+(?:Frame|Beat|Scene)\s+\d+/i;
  const starts: number[] = [];
  for (const [i, line] of lines.entries()) if (heading.test(line.trim())) starts.push(i);

  return Array.from({ length: count }, (_, n) => {
    const from = starts[n];
    if (from === undefined) return "";
    const to = starts[n + 1] ?? lines.length;
    return lines.slice(from, to).join("\n").trim();
  });
}

/**
 * Lift the media elements out of the scene that is already there.
 *
 * Inlined into the packet so the author never has to copy a path by hand. This
 * is the one mistake in the whole pass that fails silently: a re-typed `src`
 * that is subtly wrong renders a black rectangle, passes lint, and is only
 * caught by watching the film. The paths are also not derivable from the shot
 * manifest — compose decides them — so reading them back is the only honest way
 * to state them.
 */
export async function mediaTags(file: string): Promise<string[]> {
  let html: string;
  try {
    html = await readFile(file, "utf8");
  } catch {
    return [];
  }
  return [...html.matchAll(/<(?:video|audio)\b[^>]*>/g)].map((m) => m[0].trim());
}

interface PacketInput {
  id: string;
  frame: StoryboardFrame;
  block: string;
  width: number;
  height: number;
  accent: string;
  lookName: string;
  /** The `<video>`/`<audio>` tags the scaffold already wired, verbatim. */
  media: string[];
  /** The film's own direction, so a scene knows what it is part of. */
  globals: StoryboardGlobals;
  shot?: ShotManifest;
}

function packetMd(p: PacketInput): string {
  const kind = p.shot ? "footage" : "card";
  return `# Packet — ${p.id}

You are authoring **one scene**. Read \`_role.md\` in this directory first; it is
the contract, and this file is the brief.

| | |
| --- | --- |
| \`frame_id\` | \`${p.id}\` |
| Write to | \`compositions/frames/${p.id}.html\` |
| Canvas | ${p.width}×${p.height} |
| Duration | ${p.frame.duration?.toFixed(2) ?? "?"}s — **fixed**, do not tween past it |
| Kind | ${kind} scene |
| Look | \`${p.lookName}\`, accent \`${p.accent}\` — tokens are in \`frame.md\` |

${filmBrief(p.globals)}
## Your storyboard block, verbatim

${p.block ? "```markdown\n" + p.block + "\n```" : "_(the storyboard has no block for this frame)_"}

\`scene:\` is design intent and never visible text. \`voiceover:\` is a timing
reference — sync your reveals to it — and is never rendered as text.

${p.shot ? shotFacts(p.shot) : cardBrief()}${mediaBrief(p.media)}
## The file that is already there

\`compositions/frames/${p.id}.html\` exists: it is \`reel compose\`'s scaffold,
not an approved layout. Nothing in it is binding except the contract in
\`_role.md\`${p.media.length ? " and the media wiring above" : ""}. Replace it.

The scaffold is the same shape for every film Reel composes, which is exactly
what this pass exists to fix. If you finish and the scene is recognisably the
generated one with different words in it, the pass did not happen.
`;
}

/**
 * What film this scene belongs to.
 *
 * A scene authored with no idea of the whole is how five scenes end up being
 * five unrelated pieces of design. This is the smallest useful amount of that
 * context: the thesis, the arc and who it is for — not the other scenes, which
 * belong to their own authors.
 */
function filmBrief(g: StoryboardGlobals): string {
  const rows = [
    g.message ? `- **Message** — ${g.message}` : "",
    g.arc ? `- **Arc** — ${g.arc}` : "",
    g.audience ? `- **Audience** — ${g.audience}` : "",
    g.duration ? `- **Whole film** — ${g.duration}` : "",
  ].filter(Boolean);
  if (rows.length === 0) return "";
  return `## The film your scene is part of

${rows.join("\n")}

Yours is one scene of it. The others belong to other authors; do not design
theirs, and do not restate what they will say.

`;
}

/**
 * The half of a packet no HyperFrames workflow can write.
 *
 * Every number here was recorded by the driver at the instant it caused the
 * thing to happen, so it is exact rather than estimated. A cut on `t` lands on
 * the frame the button went down; the same cut placed by eye afterwards does
 * not, and nobody can tell which they are watching except by feel.
 */
function shotFacts(shot: ShotManifest): string {
  const rows = (xs: string[]): string => (xs.length ? xs.join("\n") : "_(none)_");
  return `## The shot — what the driver recorded

Real footage of **${shot.name}**, ${shot.duration.toFixed(2)}s at
${shot.width}×${shot.height}. Every time below is in **this scene's own time**,
measured by the driver as it drove the app.

### Beats — the moments worth cutting on

${rows(shot.beats.map((b) => `- \`${b.t.toFixed(2)}s\` — ${b.label}`))}

### Captions — what the demo claimed, and when

${rows(shot.captions.map((c) => `- \`${c.t.toFixed(2)}s\` — ${c.text}`))}

### Sound the demo made

${rows(shot.sfx.map((s) => `- \`${s.t.toFixed(2)}s\` — ${s.kind}${s.ms === undefined ? "" : ` over ${s.ms.toFixed(2)}s`}`))}

### Narration

${rows(shot.narration.map((l) => `- \`${l.t.toFixed(2)}s\` — ${l.file ? "" : "**(no audio; text only)** "}${l.text}`))}

`;
}

/**
 * The exact tags to carry across, so nobody re-types a path.
 *
 * Also the honest place to say what an author may not change about them: the
 * `id` is what the timeline addresses, and the timing attributes are what makes
 * the framework play the clip at all.
 */
function mediaBrief(media: string[]): string {
  if (media.length === 0) return "";
  return `## Media already wired — carry these across verbatim

\`\`\`html
${media.join("\n")}
\`\`\`

Paths are relative to your scene file. Keep each element's \`id\`, \`src\`,
\`data-start\` and \`data-duration\` exactly as they are: the id is what your
timeline addresses, and an element without the timing attributes is never played
at all. Do not re-point, re-encode, crop or replace the footage, and do not add
audio of your own — the bed and its ducking belong to the host.

`;
}

function cardBrief(): string {
  return `## A card, not footage

There is no footage here, so everything on screen is yours to design: this is
where a film stops looking generated. Build the idea the block describes out of
type, the accent, and motion — not a headline centred on a background.

`;
}

/**
 * `_role.md` — the contract every scene author works under.
 *
 * Modelled on their `frame-worker-core.md`, and restating the rules rather than
 * linking them, for the reason they give: a worker that has to go and read four
 * documents to learn the law will skip one.
 */
export function roleMd(): string {
  return `# Scene author — the contract

You author **one scene** of a Reel film and nothing else. Sibling authors have
the other scenes; the orchestrator owns everything between them.

**Input:** this role, your packet (\`.hyperframes/frame-packets/<frame_id>.md\`),
and \`frame.md\` at the project root — the design truth, and the only file you
read outside your packet. You never open \`STORYBOARD.md\`: your packet carries
your block, and N siblings must not write that file at once.

**Output:** \`compositions/frames/<frame_id>.html\`, rewritten. Writing it is your
terminal action — you do not run the CLI, assemble the index, mint audio, or
edit the storyboard. The orchestrator runs \`reel assemble\`, then
\`hyperframes check\`, and re-dispatches you with the finding if your scene fails.

## The transport rule — most lethal, so first

The runtime clones **only the contents of \`<template>\`** and discards the
\`<head>\`. Every \`<style>\` and \`<script>\` must live inside the template, or
the scene renders unstyled and unanimated with no error anywhere.

\`\`\`html
<template>
  <style>/* … */</style>
  <div id="root" data-composition-id="<frame_id>" data-width="W" data-height="H">…</div>
  <script>
    (function () {
      var tl = gsap.timeline({ paused: true });
      /* … */
      window.__timelines["<frame_id>"] = tl;
    })();
  </script>
</template>
\`\`\`

- **Style the root by \`#root\`, never a class on it.** At render the CSS is
  scoped to the composition id and a class selector on the root stops matching,
  so the whole scene renders unstyled. Studio's preview still looks right —
  trust the rule, not the preview.
- **One string, three places.** \`<frame_id>\` is the file stem, the
  \`data-composition-id\`, and the \`window.__timelines\` key. A mismatch passes
  lint and then waits 45 seconds per scene at render before capturing statics.
- **One paused timeline**, built synchronously.
- Prefix your own ids and class names with \`<frame_id>-\` so parallel siblings
  cannot collide. \`#root\` is the exception.

## Never author an exit

Their rule, and it is not a style preference: *exit animations are banned except
on the final scene — the outgoing scene must be fully visible when the
transition starts, because the transition IS the exit.* A scene that fades
itself out followed by one that fades itself in is a jump cut with a dip. It
looks correct in every snapshot and stutters in motion.

The seams belong to \`index.html\`, which is the only layer that can see two
scenes at once. Reel writes them there. Your scene ends at full opacity.

Furniture *inside* the scene may fade — a lower third has to go away — as long
as it lands well before your last frame.

## Determinism — the renderer seeks frames out of order, in parallel

- No \`Date.now()\`, no \`performance.now()\`, no unseeded \`Math.random()\`.
- No CSS \`animation\` or \`transition\`; no \`repeat: -1\`, no yoyo.
- No hover, scroll or focus state.
- **Never fetch.** No CDN \`<script>\`, no webfont link, no remote image. GSAP is
  vendored at the project root and every font that has a file is already in
  \`compositions/frames/fonts/\`. A font you name with no \`@font-face\` backing it
  is a silent fallback in the MP4 — \`check\` rejects it.
- **One tween per property per element.** Two tweens on one property depend on
  GSAP's overwrite order, which is not guaranteed. When a slow drift and a beat
  punch both want \`scale\`, put the drift on a wrapper and the punch on the
  child: nested transforms multiply.
- Never pair a CSS \`transform\` with a GSAP tween of a transform property on the
  same element — GSAP overwrites the whole \`transform\` and the element jumps.
  Set the initial state in \`fromTo\`.
- Every \`class="clip"\` element, and every \`<video>\`/\`<audio>\`, carries
  \`data-start\` and \`data-duration\`. An id-less \`<audio>\` renders silent.

## What you do not decide

- **What is said.** Narration is locked. \`voiceover:\` is a timing cue you build
  to, never text you render.
- **Your duration.** Fixed in the packet. Build the shot to land inside it.
- **The seams.** See above.
- **Audio.** The bed, its ducking and the sound effects are assembled by the
  host and by compose. Do not add \`<audio>\` of your own; do not remove the
  elements already wired into a footage scene.
- **Design tokens.** Palette, type ramp and scale come from \`frame.md\`. Never
  lift a word or a label out of it as copy — it is a style spec, not content.

## Making it good rather than merely correct

This is the half that is actually your job; everything above is the law that
keeps your scene renderable.

- **Never fade an arrival.** Reveal each word with a zero-duration \`tl.set\` and
  whip it into place in 0.13–0.20s on \`power4.out\`, overlapping so the cascade
  accelerates. A 0.7s fade — which is what feels right when guessing — is four
  times too slow, and is the single thing that makes a card read as a slide.
- **Cut on the beats.** They are exact, because the driver caused them. A punch
  on a beat reads as direction; the same punch 200ms late reads as a mistake.
- **Build the whole scene.** Reveal across the full duration rather than dumping
  the canvas in the first quarter and holding it. A backdrop that stops moving
  once the words land leaves the frame dead for the rest of the shot.
- **One very large element, everything else small.** A card that tries to be
  balanced reads as a slide. Display type at 5–10% of the frame width is roughly
  twice what feels right when guessing.
- **Lower thirds go in a band at the bottom edge**, not floated over the
  picture. The app moves; anything laid on it collides eventually, and you find
  out per demo, after rendering.
- **Don't crop the footage.** \`object-fit: contain\`. A product demo cropped to
  fill the frame loses the thing it is about.
- Find a visual idea that reinforces the beat rather than restyling the words.
`;
}

/** Packets already on disk, for a status line. */
export async function listPackets(dir: string): Promise<string[]> {
  try {
    const names = await readdir(join(resolve(dir), PACKET_DIR));
    return names.filter((n) => n.endsWith(".md") && n !== "_role.md").sort();
  } catch {
    return [];
  }
}
