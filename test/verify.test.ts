import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertGifComplete, countGifFrames } from "../src/encode/verify.js";

/** A GIF byte stream with `n` Graphic Control Extension blocks. */
function gifWith(n: number): Buffer {
  const parts = [Buffer.from("GIF89a", "latin1")];
  for (let i = 0; i < n; i++) parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00]));
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

describe("countGifFrames", () => {
  test("counts one frame per graphic control block", () => {
    assert.equal(countGifFrames(gifWith(18)), 18);
  });

  test("reports zero for a file with no frames", () => {
    assert.equal(countGifFrames(Buffer.from("GIF89a;", "latin1")), 0);
  });
});

describe("assertGifComplete", () => {
  async function write(name: string, buf: Buffer): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "reel-verify-"));
    const p = join(dir, name);
    await writeFile(p, buf);
    return p;
  }

  test("accepts a GIF holding roughly the expected frames", async () => {
    const p = await write("ok.gif", gifWith(300));
    await assertGifComplete(p, 318, "out/demo.gif");
  });

  test("accepts mild frame coalescing rather than crying wolf", async () => {
    // Identical frames legitimately collapse; only gross loss is truncation.
    const p = await write("thin.gif", gifWith(170));
    await assertGifComplete(p, 318, "out/demo.gif");
  });

  test("rejects the truncation that ffmpeg reports as success", async () => {
    // The real case: 18 frames written for a ~318-frame demo, exit code 0.
    const p = await write("short.gif", gifWith(18));
    await assert.rejects(() => assertGifComplete(p, 318, "out/demo.gif"), /truncated/i);
  });

  test("rejects an empty file", async () => {
    const p = await write("empty.gif", Buffer.alloc(0));
    await assert.rejects(() => assertGifComplete(p, 318, "out/demo.gif"), /empty/i);
  });

  test("names the output so the error says which demo broke", async () => {
    const p = await write("short.gif", gifWith(2));
    await assert.rejects(
      () => assertGifComplete(p, 318, "out/my-demo.gif"),
      /out\/my-demo\.gif/,
    );
  });

  test("skips the check when the expected count is unknown", async () => {
    const p = await write("any.gif", gifWith(1));
    await assertGifComplete(p, 0, "out/demo.gif");
  });
});
