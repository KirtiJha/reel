import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadImage } from "../src/media/image.js";
import {
  diagramKey,
  diagramPath,
  diagramCacheDir,
  diagramSources,
  missingDiagrams,
} from "../src/media/diagram.js";
import { specSchema, type Step } from "../src/spec/schema.js";
import { imageFiles } from "../src/spec/fingerprint.js";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100" +
    "05fe02fea7b5f2000000000049454e44ae426082",
  "hex",
);

async function dir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "reel-media-"));
}

describe("loadImage", () => {
  test("reads a local file as a data URI", async () => {
    const d = await dir();
    await writeFile(join(d, "a.png"), PNG);
    const img = await loadImage(d, "a.png");
    assert.match(img.dataUri, /^data:image\/png;base64,/);
    assert.equal(img.bytes, PNG.length);
  });

  test("refuses a URL rather than fetching it", async () => {
    // The renderer never fetches: a network request would make the output
    // depend on a server being up, and would pull someone else's artwork into
    // a video that gets published.
    await assert.rejects(
      () => loadImage("/tmp", "https://example.com/logo.png"),
      /never fetches/,
    );
  });

  test("says which file is missing, and where it looked", async () => {
    const d = await dir();
    await assert.rejects(() => loadImage(d, "nope.png"), /was not found/);
  });

  test("refuses a file it cannot show", async () => {
    const d = await dir();
    await writeFile(join(d, "a.psd"), PNG);
    await assert.rejects(() => loadImage(d, "a.psd"), /not an image/);
  });

  test("refuses an empty file instead of emitting a blank data URI", async () => {
    const d = await dir();
    await writeFile(join(d, "a.png"), Buffer.alloc(0));
    await assert.rejects(() => loadImage(d, "a.png"), /is empty/);
  });

  test("trusts the magic bytes over the extension", async () => {
    // A JPEG named .png decodes fine in a browser, so the mismatch has to be
    // caught here or the data URI carries the wrong type.
    const d = await dir();
    await writeFile(join(d, "really-a-jpeg.png"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]));
    const img = await loadImage(d, "really-a-jpeg.png");
    assert.equal(img.mime, "image/jpeg");
  });
});

describe("diagram cache", () => {
  test("the key follows the source and the theme", () => {
    const a = diagramKey("flowchart LR\n a-->b", "dark");
    assert.equal(a, diagramKey("flowchart LR\n a-->b", "dark"), "stable for one input");
    assert.notEqual(a, diagramKey("flowchart LR\n a-->c", "dark"), "source changes it");
    assert.notEqual(a, diagramKey("flowchart LR\n a-->b", "light"), "theme changes it");
  });

  test("surrounding whitespace is not a different diagram", () => {
    assert.equal(diagramKey("  graph TD\n a-->b  \n", "dark"), diagramKey("graph TD\n a-->b", "dark"));
  });

  test("the key does not depend on the mermaid version", () => {
    // The committed picture is the authority. If the version were in the key, a
    // mermaid upgrade would silently redraw one machine's diagram and leave the
    // next machine disagreeing — and the key would be uncomputable without
    // mermaid installed, which is the normal case.
    assert.equal(diagramKey.length, 2, "source and theme, nothing else");
  });

  test("reports a diagram that has never been drawn", async () => {
    const d = await dir();
    const missing = await missingDiagrams([{ source: "graph TD\n a-->b", theme: "dark" }], d);
    assert.equal(missing.length, 1);
    assert.match(missing[0]!, /graph TD/);
  });

  test("says nothing about one already in the cache", async () => {
    const d = await dir();
    const cache = diagramCacheDir(d);
    await mkdir(cache, { recursive: true });
    await writeFile(diagramPath(cache, diagramKey("graph TD\n a-->b", "dark")), PNG);
    assert.deepEqual(await missingDiagrams([{ source: "graph TD\n a-->b", theme: "dark" }], d), []);
  });
});

describe("collecting media from a spec", () => {
  const parse = (steps: unknown[]) =>
    specSchema.parse({ steps, theme: "dark", output: { html: "out/d.html" } });

  test("a bare string is the file", () => {
    const spec = parse([{ image: "logo.png" }]);
    assert.deepEqual(imageFiles(spec.steps), ["logo.png"]);
  });

  test("images inside a branch path count as inputs too", () => {
    // A branch path is recorded, so its picture is an input; missing it means
    // `--if-changed` skips a render whose artwork changed.
    const spec = parse([
      {
        branch: {
          paths: [
            { label: "a", steps: [{ image: { file: "a.png" } }] },
            { label: "b", steps: [{ image: "b.png" }] },
          ],
        },
      },
    ]);
    assert.deepEqual(imageFiles(spec.steps).sort(), ["a.png", "b.png"]);
  });

  test("a diagram is not a referenced file — it is written in the spec", () => {
    const spec = parse([{ diagram: "graph TD\n a-->b" }]);
    assert.deepEqual(imageFiles(spec.steps), []);
  });

  test("diagrams inherit the spec's theme unless they say otherwise", () => {
    const spec = parse([
      { diagram: "graph TD\n a-->b" },
      { diagram: { mermaid: "graph TD\n c-->d", theme: "light" } },
    ]);
    assert.deepEqual(diagramSources(spec.steps as Step[], spec.theme), [
      { source: "graph TD\n a-->b", theme: "dark" },
      { source: "graph TD\n c-->d", theme: "light" },
    ]);
  });

  test("diagrams inside a branch are collected", () => {
    const spec = parse([
      {
        branch: {
          paths: [
            { label: "a", steps: [{ diagram: "graph TD\n x-->y" }] },
            { label: "b", steps: [{ click: "#b" }] },
          ],
        },
      },
    ]);
    assert.equal(diagramSources(spec.steps as Step[], spec.theme).length, 1);
  });
});

describe("the image and diagram steps", () => {
  const parse = (step: unknown) =>
    specSchema.parse({ steps: [step], output: { html: "out/d.html" } }).steps[0] as Record<
      string,
      Record<string, unknown>
    >;

  test("an image defaults to filling the frame", () => {
    const { image } = parse({ image: { file: "a.png" } });
    assert.equal(image!.as, "full");
    assert.equal(image!.corner, "br");
  });

  test("an inset picks a corner", () => {
    const { image } = parse({ image: { file: "a.png", as: "inset", corner: "tl" } });
    assert.equal(image!.as, "inset");
    assert.equal(image!.corner, "tl");
  });

  test("unknown placements and corners are refused", () => {
    assert.throws(() => parse({ image: { file: "a.png", as: "floating" } }));
    assert.throws(() => parse({ image: { file: "a.png", corner: "middle" } }));
  });

  test("a diagram needs a source", () => {
    assert.throws(() => parse({ diagram: { as: "full" } }));
    assert.throws(() => parse({ diagram: "" }));
  });

  test("a file is required, and empty is not a file", () => {
    assert.throws(() => parse({ image: { as: "full" } }));
    assert.throws(() => parse({ image: "" }));
  });
});
