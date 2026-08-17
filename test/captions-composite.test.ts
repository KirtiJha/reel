import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { compositesCaptions, framingEnabled } from "../src/polish/frame.js";
import { specSchema } from "../src/spec/schema.js";

/** The resolved polish block for a spec fragment. */
function polish(p: Record<string, unknown>) {
  return specSchema.parse({
    steps: [{ goto: "/" }],
    polish: p,
    output: { html: "out/d.html" },
  }).polish;
}

describe("compositesCaptions", () => {
  test("auto-zoom composites", () => {
    assert.equal(compositesCaptions(polish({ zoom: "auto", frame: "none" })), true);
  });

  test("a device frame composites even with zoom off", () => {
    // The regression: this returned false while the renderer still ran, so the
    // caption was drawn into the page *and* composited on top of it.
    assert.equal(compositesCaptions(polish({ zoom: false, frame: "browser" })), true);
  });

  test("padding alone composites", () => {
    assert.equal(compositesCaptions(polish({ zoom: false, frame: "none", padding: 40 })), true);
  });

  test("nothing to composite when zoom is off and there is no framing", () => {
    assert.equal(compositesCaptions(polish({ zoom: false, frame: "none" })), false);
  });

  test("it is exactly the renderer's own condition", () => {
    // Both call sites must agree; this is the property that keeps them honest.
    for (const zoom of ["auto", false] as const) {
      for (const frame of ["none", "browser", "window"] as const) {
        for (const padding of [0, 40]) {
          const p = polish({ zoom, frame, padding });
          assert.equal(
            compositesCaptions(p),
            p.zoom === "auto" || framingEnabled(p),
            `disagreement for zoom=${zoom} frame=${frame} padding=${padding}`,
          );
        }
      }
    }
  });
});
