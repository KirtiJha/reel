import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { publish, pagesAdvice, type PublishResult } from "../src/commands/publish.js";
import { tempDir } from "./tmp.js";

/**
 * A spec with real files behind it, because `publish` collects from disk — a
 * fixture that only describes outputs would exercise none of the copying.
 */
async function fixture(
  root: string,
  file: string,
  name: string,
  outputs: Record<string, string>,
  rendered: string[] = Object.values(outputs),
): Promise<void> {
  const lines = [
    `name: ${JSON.stringify(name)}`,
    "url: http://localhost:1/",
    "output:",
    ...Object.entries(outputs).map(([k, v]) => `  ${k}: ${v}`),
    "steps:",
    "  - hold: 100",
  ];
  await mkdir(join(root, "specs"), { recursive: true });
  await writeFile(join(root, file), lines.join("\n"), "utf8");
  for (const out of rendered) {
    const abs = join(root, out);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, `bytes of ${out}`, "utf8");
  }
}

const run = (root: string, out = "site"): Promise<PublishResult> =>
  publish(root, { out, specs: ["**/*.reel.yaml"] });

describe("publish", () => {
  test("collects what is rendered and skips what is not", async () => {
    const root = await tempDir("reel-publish");
    await fixture(root, "a.reel.yaml", "Alpha", { gif: "out/a.gif", mp4: "out/a.mp4" });
    await fixture(root, "b.reel.yaml", "Beta", { gif: "out/b.gif" }, []);

    const res = await run(root);
    assert.deepEqual(
      res.demos.map((d) => d.name),
      ["Alpha"],
    );
    assert.deepEqual(res.demos[0]?.files, [
      { path: "alpha/a.gif", label: "gif" },
      { path: "alpha/a.mp4", label: "mp4" },
    ]);
    assert.deepEqual(res.unrendered, ["b.reel.yaml"]);
    // Copied, not moved or linked: the source has to survive a publish.
    assert.equal(await readFile(join(root, "out/a.gif"), "utf8"), "bytes of out/a.gif");
    assert.equal(await readFile(join(res.dir, "alpha/a.gif"), "utf8"), "bytes of out/a.gif");
  });

  test("never renders — an unrendered spec is reported, not produced", async () => {
    const root = await tempDir("reel-publish");
    await fixture(root, "a.reel.yaml", "Alpha", { gif: "out/a.gif" }, []);
    await assert.rejects(run(root), /none of those specs have been rendered/);
  });

  test("the interactive build is the poster when there is one", async () => {
    const root = await tempDir("reel-publish");
    await fixture(root, "a.reel.yaml", "Alpha", {
      gif: "out/a.gif",
      webp: "out/a.webp",
      player: "out/a.html",
    });
    const res = await run(root);
    assert.equal(res.demos[0]?.poster, "alpha/a.html");
    const html = await readFile(res.index, "utf8");
    assert.match(html, /<iframe src="alpha\/a\.html\?embed=1"/);
  });

  test("a WebP outranks a GIF on the card, as it does everywhere else", async () => {
    const root = await tempDir("reel-publish");
    await fixture(root, "a.reel.yaml", "Alpha", { gif: "out/a.gif", webp: "out/a.webp" });
    assert.equal((await run(root)).demos[0]?.poster, "alpha/a.webp");
  });

  test("a video preview is muted, or the browser will not autoplay it", async () => {
    const root = await tempDir("reel-publish");
    await fixture(root, "a.reel.yaml", "Alpha", { mp4: "out/a.mp4" });
    const html = await readFile((await run(root)).index, "utf8");
    assert.match(html, /<video [^>]*\bmuted\b/);
  });

  test("two specs sharing a name get separate directories and say which is which", async () => {
    const root = await tempDir("reel-publish");
    await fixture(root, "a.reel.yaml", "Same", { gif: "out/a.gif" });
    await fixture(root, "b.reel.yaml", "Same", { gif: "out/b.gif" });

    const res = await run(root);
    const slugs = res.demos.map((d) => d.slug).sort();
    assert.deepEqual(slugs, ["same", "same-2"]);
    // A `-2` with nothing to explain it is the bug; the spec path is the answer.
    const html = await readFile(res.index, "utf8");
    assert.match(html, /class="from">a\.reel\.yaml</);
    assert.match(html, /class="from">b\.reel\.yaml</);
  });

  test("a unique name carries no spec path — it would just be noise", async () => {
    const root = await tempDir("reel-publish");
    await fixture(root, "a.reel.yaml", "Alpha", { gif: "out/a.gif" });
    const html = await readFile((await run(root)).index, "utf8");
    assert.doesNotMatch(html, /class="from"/);
  });

  test("a storyboard is one link to a contact sheet, not one chip per frame", async () => {
    const root = await tempDir("reel-publish");
    await fixture(root, "a.reel.yaml", "Alpha", { gif: "out/a.gif", storyboard: "out/board" }, [
      "out/a.gif",
    ]);
    for (const f of ["03.png", "01.png", "02.png"]) {
      await mkdir(join(root, "out/board"), { recursive: true });
      await writeFile(join(root, "out/board", f), f, "utf8");
    }
    const res = await run(root);
    assert.deepEqual(res.demos[0]?.files, [
      { path: "alpha/a.gif", label: "gif" },
      { path: "alpha/board/index.html", label: "storyboard (3)" },
    ]);

    // Every frame is still published, and now reachable: a directory on a
    // static host has no index, so without this page they were unopenable.
    const sheet = await readFile(join(res.dir, "alpha/board/index.html"), "utf8");
    assert.deepEqual(sheet.match(/src="0\d\.png"/g), ['src="01.png"', 'src="02.png"', 'src="03.png"']);
    assert.equal(await readFile(join(res.dir, "alpha/board/02.png"), "utf8"), "02.png");
  });

  test("a frame's caption is its beat, not its filename", async () => {
    const root = await tempDir("reel-publish");
    await fixture(root, "a.reel.yaml", "Alpha", { gif: "out/a.gif", storyboard: "out/board" }, [
      "out/a.gif",
    ]);
    await mkdir(join(root, "out/board"), { recursive: true });
    await writeFile(join(root, "out/board/02-one-spec-every-format-.png"), "x", "utf8");
    const sheet = await readFile(join((await run(root)).dir, "alpha/board/index.html"), "utf8");
    assert.match(sheet, /<figcaption>1\. one spec every format<\/figcaption>/);
    // The link still points at the real file, whatever the caption says.
    assert.match(sheet, /href="02-one-spec-every-format-\.png"/);
  });

  test("the contact sheet never becomes the card's poster", async () => {
    const root = await tempDir("reel-publish");
    await fixture(root, "a.reel.yaml", "Alpha", { gif: "out/a.gif", storyboard: "out/board" }, [
      "out/a.gif",
    ]);
    await mkdir(join(root, "out/board"), { recursive: true });
    await writeFile(join(root, "out/board/01.png"), "01", "utf8");
    // `.html` outranks everything in POSTER_ORDER, so without the guard the
    // card shows a grid of thumbnails instead of the demo running.
    assert.equal((await run(root)).demos[0]?.poster, "alpha/a.gif");
  });

  test("Jekyll is turned off, or an underscored file 404s with nothing to explain it", async () => {
    const root = await tempDir("reel-publish");
    await fixture(root, "a.reel.yaml", "Alpha", { gif: "out/a.gif" });
    const res = await run(root);
    assert.equal(await readFile(join(res.dir, ".nojekyll"), "utf8"), "");
  });

  test("a base path is written once, as a <base> element", async () => {
    const root = await tempDir("reel-publish");
    await fixture(root, "a.reel.yaml", "Alpha", { gif: "out/a.gif" });
    const res = await publish(root, { out: "site", specs: ["**/*.reel.yaml"], base: "/repo" });
    const html = await readFile(res.index, "utf8");
    // Trailing slash added: `<base href="/repo">` resolves `alpha/a.gif` to
    // `/alpha/a.gif`, which is the one mistake this element exists to make.
    assert.match(html, /<base href="\/repo\/" \/>/);
  });

  test("names that slug to nothing fall back to the spec filename", async () => {
    const root = await tempDir("reel-publish");
    await fixture(root, "cool-demo.reel.yaml", "!!!", { gif: "out/a.gif" });
    assert.equal((await run(root)).demos[0]?.slug, "cool-demo");
  });

  test("a site inside the repository is reported relative to it", async () => {
    const root = await tempDir("reel-publish");
    await fixture(root, "a.reel.yaml", "Alpha", { gif: "out/a.gif" });
    assert.equal((await run(root, "docs")).rel, "docs");
  });

  test("a site outside the repository has no relative path at all", async () => {
    const root = await tempDir("reel-publish");
    const elsewhere = await tempDir("reel-publish-out");
    await fixture(root, "a.reel.yaml", "Alpha", { gif: "out/a.gif" });
    assert.equal((await run(root, elsewhere)).rel, undefined);
  });
});

describe("pagesAdvice", () => {
  const advice = (rel: string | undefined): string =>
    pagesAdvice({ dir: "/x", index: "/x/index.html", demos: [], unrendered: [], ...(rel === undefined ? {} : { rel }) }).join(" ");

  test("the two folders Pages actually offers are the ones it recommends", () => {
    assert.match(advice(""), /main → \/ \(root\)/);
    assert.match(advice("docs"), /main → \/docs/);
  });

  test("any other folder is not offered, and saying so beats a wrong dropdown", () => {
    // The original bug: `set Pages → main → /site` sends somebody to a menu
    // that contains root and /docs and nothing else.
    const out = advice("site");
    assert.doesNotMatch(out, /main → \/site/);
    assert.match(out, /only from \/ or \/docs/);
    assert.match(out, /reel publish docs/);
  });

  test("a site outside the repository is not something you can commit", () => {
    const out = advice(undefined);
    assert.match(out, /outside the repository/);
    assert.doesNotMatch(out, /Deploy from a branch/);
  });
});
