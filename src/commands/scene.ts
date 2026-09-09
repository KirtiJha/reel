import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium, type Browser } from "playwright-core";
import sharp from "sharp";
import { DETERMINISTIC_LAUNCH_ARGS } from "../driver/determinism.js";
import { buildScene } from "../scene/scene.js";
import { isLook, LOOK_NAMES, lookFor, type Look, type LookName } from "../scene/looks.js";
import { fontRequests, loadPresets, presetToLook, type Preset } from "../scene/presets.js";
import { inlineFaceRules } from "../compose/fonts.js";
import { isTemplate } from "../scene/scene.js";
import type { SceneFields } from "../scene/templates.js";
import { log, ReelError } from "../util/log.js";

/**
 * `reel scene` — look at a scene without rendering a film.
 *
 * ## Why this exists
 *
 * A scene is motion, and the only way to judge motion is to see it. Before this
 * command, the loop for "does this composition work?" was: edit it, run a full
 * `reel record` against a real app, wait for capture and encode, scrub an mp4.
 * Minutes per iteration, most of it spent re-filming an app that did not change.
 *
 * That loop is bad for a person and fatal for an agent, which cannot scrub an
 * mp4 at all. `reel scene` seeks the composition at a handful of positions and
 * tiles the results into one image — a contact sheet, in the photographic sense.
 * An agent can read that image, see that its title is still blurred at 60%, and
 * fix it without ever starting a browser of its own.
 *
 * The frames are shot exactly the way a render shoots them — same seek runtime,
 * same deterministic launch flags — so a sheet that looks right is not a
 * different picture from the one that ends up in the film.
 */

/** Positions across the scene, chosen to catch the arrival rather than miss it. */
function seekPoints(n: number): number[] {
  // Not evenly spaced: `--in` is spent in the first 28% of a scene, so an even
  // spread puts one frame in the entrance and five in the hold — which is the
  // opposite of where the interesting frames are.
  if (n <= 1) return [0.35];
  const early = Math.max(2, Math.round(n * 0.55));
  const out: number[] = [];
  for (let i = 0; i < early; i++) out.push((i / early) * 0.34);
  for (let i = 0; i < n - early; i++) out.push(0.34 + ((i + 1) / (n - early)) * 0.62);
  return out.map((p) => Number(p.toFixed(4)));
}

export interface ShotOptions {
  width: number;
  height: number;
  frames: number;
}

/** One scene, seeked and screenshotted at each point. */
async function shoot(
  browser: Browser,
  html: string,
  points: number[],
  size: { width: number; height: number },
): Promise<Buffer[]> {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
  try {
    await page.setContent(html, { waitUntil: "load" });
    const shots: Buffer[] = [];
    for (const p of points) {
      await page.evaluate((v) => {
        (window as unknown as { __reelSeek(p: number): void }).__reelSeek(v);
      }, p);
      shots.push(await page.screenshot({ type: "png" }));
    }
    return shots;
  } finally {
    await page.close();
  }
}

const SHEET_BG = "#0b0b0f";
const LABEL_H = 26;
const GAP = 10;

/** A caption strip for one tile — the seek position, or a look's name. */
async function label(text: string, width: number): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LABEL_H}">
    <rect width="100%" height="100%" fill="${SHEET_BG}"/>
    <text x="6" y="18" font-family="monospace" font-size="14" fill="#9aa3b2">${text.replace(/[<&>]/g, "")}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Tile labelled shots into one contact sheet. */
async function sheet(
  tiles: { shot: Buffer; caption: string }[],
  thumbWidth: number,
  columns: number,
  outPath: string,
): Promise<void> {
  const scaled = await Promise.all(
    tiles.map(async (t) => sharp(t.shot).resize({ width: thumbWidth }).png().toBuffer()),
  );
  const meta = await sharp(scaled[0]!).metadata();
  const th = meta.height ?? Math.round(thumbWidth * 0.5625);
  const cols = Math.min(columns, tiles.length);
  const rows = Math.ceil(tiles.length / cols);
  const cellH = th + LABEL_H;

  const labels = await Promise.all(tiles.map((t) => label(t.caption, thumbWidth)));
  const composite: sharp.OverlayOptions[] = [];
  scaled.forEach((input, i) => {
    const left = (i % cols) * (thumbWidth + GAP);
    const top = Math.floor(i / cols) * (cellH + GAP);
    composite.push({ input, left, top });
    composite.push({ input: labels[i]!, left, top: top + th });
  });

  await mkdir(dirname(outPath), { recursive: true });
  await sharp({
    create: {
      width: cols * thumbWidth + (cols - 1) * GAP,
      height: rows * cellH + (rows - 1) * GAP,
      channels: 3,
      background: SHEET_BG,
    },
  })
    .composite(composite)
    .png()
    .toFile(outPath);
}

export interface PreviewOptions extends ShotOptions {
  /** A composition of your own, or undefined to draw a built-in template. */
  file?: string;
  template?: string;
  look?: string;
  accent: string;
  fields: SceneFields;
  out: string;
}

/**
 * Shoot one scene across its seek range and write a contact sheet.
 *
 * Returns the sheet's path and the positions shot, so `--json` callers and the
 * skill can say what they looked at.
 */
export async function previewScene(
  opts: PreviewOptions,
  specDir: string,
): Promise<{ out: string; points: number[] }> {
  const look = resolveLook(opts.look);
  if (opts.template && !isTemplate(opts.template)) {
    throw new ReelError(
      `\`${opts.template}\` is not a template Reel draws.`,
      `Templates: title, chapter, statement, bullets. For anything else, write the composition and pass its path.`,
    );
  }

  const html = await buildScene(
    {
      ...(opts.file ? { file: opts.file } : {}),
      ...(opts.template && !opts.file ? { template: opts.template as "title" } : {}),
      fields: opts.fields,
      style: { accent: opts.accent, ...(look ? { look } : {}) },
    },
    specDir,
  );

  const points = seekPoints(opts.frames);
  const browser = await chromium.launch({ headless: true, args: DETERMINISTIC_LAUNCH_ARGS });
  try {
    const shots = await shoot(browser, html, points, { width: opts.width, height: opts.height });
    const out = resolve(opts.out);
    await sheet(
      shots.map((shot, i) => ({ shot, caption: `p = ${points[i]!.toFixed(2)}` })),
      Math.min(opts.width, 480),
      3,
      out,
    );
    return { out, points };
  } finally {
    await browser.close();
  }
}

export interface LookSheetOptions extends ShotOptions {
  accent: string;
  title: string;
  out: string;
  /** Where in the scene to shoot each look. Mid-hold shows the look, not the entrance. */
  at: number;
}

/**
 * Shoot every look in the catalogue at the same moment, side by side.
 *
 * The point is comparison. A look reads as good or bad relative to the others,
 * and a list of names in `--help` tells you nothing about what you are choosing
 * between — the same reason `reel themes` prints swatches instead of words.
 */
export async function lookSheet(opts: LookSheetOptions): Promise<{ out: string; looks: string[] }> {
  // Reel's own catalogue first, then every installed HyperFrames frame preset.
  // They are shown together because the choice is one choice: a preset is a
  // look by every behaviour that matters, and a list that hid them behind a
  // flag would be a list nobody scrolled past.
  const presets = await loadPresets();
  const entries: { name: string; look: Look; preset?: Preset }[] = [
    ...LOOK_NAMES.map((name) => ({ name: name as string, look: lookFor(name) })),
    ...presets.map((p) => ({ name: p.name, look: presetToLook(p), preset: p })),
  ];

  const browser = await chromium.launch({ headless: true, args: DETERMINISTIC_LAUNCH_ARGS });
  try {
    const tiles: { shot: Buffer; caption: string }[] = [];
    for (const { name, look, preset } of entries) {
      // A preset drawn in a system fallback is not the identity you would be
      // choosing between, so its real faces are fetched and inlined here.
      const faces = preset ? await inlineFaceRules(fontRequests(preset)) : "";
      // A preset is shown in its own accent, not the caller's. You are picking
      // an identity here, and a preset repainted in someone else's colour is
      // not the identity you would get.
      const accent = preset ? preset.accent : opts.accent;
      const html = await buildScene(
        {
          template: "title",
          fields: { title: opts.title, subtitle: look.mood.slice(0, 110), slate: name.toUpperCase() },
          style: { accent, resolved: look, ...(faces ? { faces } : {}) },
        },
        process.cwd(),
      );
      const [shot] = await shoot(browser, html, [opts.at], {
        width: opts.width,
        height: opts.height,
      });
      tiles.push({ shot: shot!, caption: name });
    }
    const out = resolve(opts.out);
    await sheet(tiles, Math.min(opts.width, 420), 3, out);
    log.info(`Wrote ${out} — ${entries.length} identities`);
    return { out, looks: entries.map((e) => e.name) };
  } finally {
    await browser.close();
  }
}

function resolveLook(name: string | undefined): LookName | undefined {
  if (!name) return undefined;
  if (!isLook(name)) {
    throw new ReelError(
      `\`${name}\` is not a look Reel ships.`,
      `Looks: ${LOOK_NAMES.join(", ")}. Run \`reel looks\` to see them.`,
    );
  }
  return name;
}
