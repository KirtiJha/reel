import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { compositesCaptions, framingEnabled } from "../src/polish/frame.js";
import { specSchema } from "../src/spec/schema.js";

/**
 * A resolved spec fragment. The gate reads the steps as well as the polish
 * block — an annotation needs the render path even when nothing else does.
 */
function spec(p: Record<string, unknown>, steps: unknown[] = [{ goto: "/" }]) {
  return specSchema.parse({
    steps,
    polish: p,
    output: { html: "out/d.html" },
  });
}

describe("compositesCaptions", () => {
  test("auto-zoom composites", () => {
    assert.equal(compositesCaptions(spec({ zoom: "auto", frame: "none" })), true);
  });

  test("a device frame composites even with zoom off", () => {
    // The regression: this returned false while the renderer still ran, so the
    // caption was drawn into the page *and* composited on top of it.
    assert.equal(compositesCaptions(spec({ zoom: false, frame: "browser" })), true);
  });

  test("padding alone composites", () => {
    assert.equal(compositesCaptions(spec({ zoom: false, frame: "none", padding: 40 })), true);
  });

  test("nothing to composite when zoom is off and there is no framing", () => {
    assert.equal(compositesCaptions(spec({ zoom: false, frame: "none" })), false);
  });

  test("a highlight composites on its own", () => {
    // Without this the fast concat encoder runs and every annotation is
    // silently dropped — the render succeeds and the marks are simply absent.
    assert.equal(
      compositesCaptions(
        spec({ zoom: false, frame: "none" }, [{ highlight: { selector: "#a" } }]),
      ),
      true,
    );
  });

  test("a highlight inside a branch path counts too", () => {
    assert.equal(
      compositesCaptions(
        spec({ zoom: false, frame: "none" }, [
          {
            branch: {
              paths: [
                { label: "a", steps: [{ highlight: { selector: "#a" } }] },
                { label: "b", steps: [{ click: "#b" }] },
              ],
            },
          },
        ]),
      ),
      true,
    );
  });

  test("it is exactly the renderer's own condition", () => {
    // Both call sites must agree; this is the property that keeps them honest.
    for (const zoom of ["auto", false] as const) {
      for (const frame of ["none", "browser", "window"] as const) {
        for (const padding of [0, 40]) {
          const sp = spec({ zoom, frame, padding });
          assert.equal(
            compositesCaptions(sp),
            sp.polish.zoom === "auto" || framingEnabled(sp.polish),
            `disagreement for zoom=${zoom} frame=${frame} padding=${padding}`,
          );
        }
      }
    }
  });
});
