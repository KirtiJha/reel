import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { expandMatrix } from "../src/spec/matrix.js";
import { specSchema } from "../src/spec/schema.js";
import type { LoadedSpec } from "../src/spec/load.js";

function load(raw: Record<string, unknown>): LoadedSpec {
  return {
    spec: specSchema.parse({ steps: [{ goto: "/" }], ...raw }),
    path: "/demo/demo.reel.yaml",
    dir: "/demo",
  };
}

describe("expandMatrix", () => {
  test("a spec without a matrix is a single variant", () => {
    const v = expandMatrix(load({ output: { gif: "out/demo.gif" } }));
    assert.equal(v.length, 1);
    assert.equal(v[0]!.loaded.spec.output.gif, "out/demo.gif");
  });

  test("expands the full viewport × theme product", () => {
    const v = expandMatrix(
      load({
        output: { gif: "out/{viewport}-{theme}.gif" },
        matrix: {
          viewports: [
            { name: "desktop", width: 1280, height: 800 },
            { name: "mobile", width: 390, height: 844 },
          ],
          themes: ["light", "dark"],
        },
      }),
    );
    assert.equal(v.length, 4);
    assert.deepEqual(
      v.map((x) => x.loaded.spec.output.gif).sort(),
      [
        "out/desktop-dark.gif",
        "out/desktop-light.gif",
        "out/mobile-dark.gif",
        "out/mobile-light.gif",
      ],
    );
  });

  test("each variant carries its own viewport and theme", () => {
    const v = expandMatrix(
      load({
        output: { gif: "out/{viewport}.gif" },
        matrix: {
          viewports: [{ name: "mobile", width: 390, height: 844, scale: 3 }],
          themes: ["dark"],
        },
      }),
    );
    assert.equal(v[0]!.loaded.spec.viewport.width, 390);
    assert.equal(v[0]!.loaded.spec.viewport.scale, 3);
    assert.equal(v[0]!.loaded.spec.theme, "dark");
  });

  test("the variant viewport carries no leftover name field", () => {
    // It is spread straight into the browser context options.
    const v = expandMatrix(
      load({
        output: { gif: "out/{viewport}.gif" },
        matrix: { viewports: [{ name: "mobile", width: 390, height: 844 }] },
      }),
    );
    assert.ok(!("name" in v[0]!.loaded.spec.viewport));
  });

  test("refuses to render variants that would overwrite each other", () => {
    assert.throws(
      () =>
        expandMatrix(
          load({
            output: { gif: "out/demo.gif" },
            matrix: { themes: ["light", "dark"] },
          }),
        ),
      /no output path distinguishes them/,
    );
  });

  test("templates every kind of output path", () => {
    const v = expandMatrix(
      load({
        output: {
          gif: "out/{theme}.gif",
          mp4: "out/{theme}.mp4",
          webm: "out/{theme}.webm",
          storyboard: "out/sb-{theme}",
          html: "out/{theme}.html",
          subtitles: "out/{theme}",
        },
        matrix: { themes: ["light", "dark"] },
      }),
    );
    const dark = v.find((x) => x.loaded.spec.theme === "dark")!.loaded.spec.output;
    assert.equal(dark.mp4, "out/dark.mp4");
    assert.equal(dark.webm, "out/dark.webm");
    assert.equal(dark.storyboard, "out/sb-dark");
    assert.equal(dark.html, "out/dark.html");
    assert.equal(dark.subtitles, "out/dark");
  });

  test("substitutes tokens even for a single variant", () => {
    // Otherwise a templated path would write a literal "{theme}" to disk.
    const v = expandMatrix(load({ theme: "dark", output: { gif: "out/{theme}.gif" } }));
    assert.equal(v[0]!.loaded.spec.output.gif, "out/dark.gif");
  });

  test("a themes-only matrix keeps the spec's own viewport", () => {
    const v = expandMatrix(
      load({
        viewport: { width: 1000, height: 720 },
        output: { gif: "out/{theme}.gif" },
        matrix: { themes: ["light", "dark"] },
      }),
    );
    assert.equal(v[0]!.loaded.spec.viewport.width, 1000);
  });
});
