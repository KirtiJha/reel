import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { ScreenshotCapture, frameWriteError } from "../src/capture/screenshot.js";
import { synthesizeAll } from "../src/narrate/voice.js";
import { tempDir } from "./tmp.js";
import { onCleanup, runCleanup, pendingCleanups } from "../src/util/dispose.js";
import { progressPositionMs } from "../src/encode/ffmpeg.js";
import { duration } from "../src/util/progress.js";
import { ReelError } from "../src/util/log.js";

/**
 * The failure modes that take the whole process down with them.
 *
 * Everything here is about what happens when a render cannot finish: a disk
 * that fills at minute eight, a temp directory swept out from under the capture
 * loop, a Ctrl-C during the twenty minutes the encoder is busy. None of it is
 * reachable from a passing demo, which is exactly why it went unnoticed.
 */

const workDir = (): Promise<string> => tempDir("reel-robust");

// No test may leave a disposer registered for the next one to trip over.
afterEach(() => runCleanup());

/** A page that only does what ScreenshotCapture asks of it. */
function fakePage(shot: () => Buffer): Page {
  let n = 0;
  return {
    screenshot: async () => {
      n++;
      return shot();
    },
    evaluate: async () => undefined,
    get shots() {
      return n;
    },
  } as unknown as Page;
}

/** A distinct buffer each call, so nothing is deduped away. */
function changingFrames(): () => Buffer {
  let n = 0;
  return () => Buffer.from(`frame-${n++}`.padEnd(64, "."));
}

describe("a frame that cannot be written", () => {
  test("stop() raises it as a Reel error instead of crashing the process", async () => {
    const dir = await workDir();
    const framesDir = join(dir, "frames");
    const capture = new ScreenshotCapture(fakePage(changingFrames()), framesDir, { fps: 60 });
    await capture.start();

    // Exactly the reproduction: the frames directory goes away mid-capture.
    // Before the fix this rejected out of the fire-and-forget loop, which Node
    // turns into an immediate exit — outside the try that owns the cleanup.
    await rm(framesDir, { recursive: true, force: true });

    await assert.rejects(() => capture.stop(), (err: unknown) => {
      assert.ok(err instanceof ReelError, `expected a ReelError, got ${String(err)}`);
      assert.match(err.message, /frame directory disappeared/);
      assert.match(String(err.hint), /tmpwatch|reaper/i);
      return true;
    });
  });

  test("the sampling loop stops rather than failing once per tick", async () => {
    const dir = await workDir();
    const framesDir = join(dir, "frames");
    const capture = new ScreenshotCapture(fakePage(changingFrames()), framesDir, { fps: 120 });
    await capture.start();
    await rm(framesDir, { recursive: true, force: true });
    // Long enough for a 120fps loop to have tried a dozen more times.
    await new Promise((r) => setTimeout(r, 120));
    await assert.rejects(() => capture.stop());
    // Re-created so the assertion is about the loop, not about the directory.
    await mkdir(framesDir, { recursive: true });
    assert.deepEqual(await readdir(framesDir), []);
  });

  test("a driver-sampled frame fails where the driver can see it", async () => {
    const dir = await workDir();
    const framesDir = join(dir, "frames");
    const capture = new ScreenshotCapture(fakePage(changingFrames()), framesDir, {
      fps: 30,
      deterministic: true,
    });
    await capture.start();
    await rm(framesDir, { recursive: true, force: true });
    // `frameAt` is awaited by the driver inside `record()`'s try, so it throws
    // straight away rather than waiting for the end of the recording.
    await assert.rejects(() => capture.frameAt(100), ReelError);
  });

  test("a synthesized pan frame fails at the step that pushed it", async () => {
    const dir = await workDir();
    const framesDir = join(dir, "frames");
    const capture = new ScreenshotCapture(fakePage(changingFrames()), framesDir, { fps: 30 });
    await capture.start();
    await rm(framesDir, { recursive: true, force: true });
    await assert.rejects(() => capture.pushFrame(Buffer.from("pan"), 10), ReelError);
  });

  test("frames captured before the failure are still on disk", async () => {
    const dir = await workDir();
    const framesDir = join(dir, "frames");
    const capture = new ScreenshotCapture(fakePage(changingFrames()), framesDir, {
      fps: 30,
      deterministic: true,
    });
    await capture.start();
    await capture.frameAt(0);
    await capture.frameAt(33);
    assert.equal((await readdir(framesDir)).length, 2);
    assert.equal(capture.captured().length, 2);
  });
});

describe("frameWriteError", () => {
  const at = { framesDir: "/tmp/reel-abc/frames", frames: 4210, written: 4_500_000_000 };

  test("a full disk names the volume, the amount and the way out", () => {
    const err = frameWriteError({ code: "ENOSPC", message: "ENOSPC" } as NodeJS.ErrnoException, at);
    assert.match(err.message, /disk space/i);
    // The two facts the raw errno does not carry: how much had been staged, and
    // where — which is never the directory the author is looking at.
    assert.match(err.message, /4\.2GB/);
    assert.match(err.message, /\/tmp\/reel-abc\/frames/);
    assert.match(String(err.hint), /TMPDIR/);
  });

  test("the size is quoted in units a human reads", () => {
    const small = frameWriteError({ code: "ENOSPC" } as NodeJS.ErrnoException, {
      ...at,
      written: 900,
    });
    assert.match(small.message, /900B/);
  });

  test("an unrecognised errno still says what failed and where", () => {
    const err = frameWriteError(
      { code: "EROFS", message: "read-only file system" } as NodeJS.ErrnoException,
      at,
    );
    assert.match(err.message, /read-only file system/);
    assert.match(err.message, /\/tmp\/reel-abc\/frames/);
  });
});

describe("the cleanup registry", () => {
  test("runs disposers once, most recent first", () => {
    const order: string[] = [];
    onCleanup(() => order.push("app"));
    onCleanup(() => order.push("frames"));
    runCleanup();
    runCleanup();
    assert.deepEqual(order, ["frames", "app"]);
  });

  test("a disposer that throws does not strand the ones after it", () => {
    const order: string[] = [];
    onCleanup(() => order.push("app"));
    onCleanup(() => {
      throw new Error("already gone");
    });
    runCleanup();
    assert.deepEqual(order, ["app"]);
  });

  test("unregistering leaves nothing behind for the normal path", () => {
    const before = pendingCleanups();
    const forget = onCleanup(() => assert.fail("should not run"));
    assert.equal(pendingCleanups(), before + 1);
    forget();
    assert.equal(pendingCleanups(), before);
    runCleanup();
  });

  test("a capture registers its frames directory and releases it on request", async () => {
    const dir = await workDir();
    const capture = new ScreenshotCapture(fakePage(changingFrames()), join(dir, "frames"), {
      fps: 30,
      deterministic: true,
    });
    const before = pendingCleanups();
    await capture.start();
    assert.equal(pendingCleanups(), before + 1);
    capture.release();
    assert.equal(pendingCleanups(), before);
  });

  test("the registered disposer removes the staged frames", async () => {
    const dir = await workDir();
    const framesDir = join(dir, "frames");
    const capture = new ScreenshotCapture(fakePage(changingFrames()), framesDir, {
      fps: 30,
      deterministic: true,
    });
    await capture.start();
    await capture.frameAt(0);
    assert.equal((await readdir(framesDir)).length, 1);
    runCleanup(); // what the CLI's SIGINT handler does
    await assert.rejects(() => readdir(framesDir));
  });

  test("REEL_KEEP_FRAMES survives the signal path too", async () => {
    const dir = await workDir();
    const framesDir = join(dir, "frames");
    const capture = new ScreenshotCapture(fakePage(changingFrames()), framesDir, {
      fps: 30,
      deterministic: true,
    });
    await capture.start();
    await capture.frameAt(0);
    process.env.REEL_KEEP_FRAMES = "1";
    try {
      runCleanup();
      assert.equal((await readdir(framesDir)).length, 1);
    } finally {
      delete process.env.REEL_KEEP_FRAMES;
    }
  });
});

describe("ffmpeg -progress parsing", () => {
  test("reads the output position, in whichever field the build emits", () => {
    // Both fields carry microseconds — `out_time_ms` is a naming mistake ffmpeg
    // keeps for compatibility, and reading it as milliseconds would report a
    // render as 1000× further along than it is.
    assert.equal(progressPositionMs("out_time_us=2500000"), 2500);
    assert.equal(progressPositionMs("out_time_ms=2500000"), 2500);
    assert.equal(progressPositionMs("out_time_ms=2500000\r"), 2500);
  });

  test("ignores everything that is not a position", () => {
    for (const line of ["frame=120", "speed=1.02x", "progress=continue", "", "out_time=00:00:02.5"]) {
      assert.equal(progressPositionMs(line), null, line);
    }
  });

  test("ignores the negative position ffmpeg reports before the first frame", () => {
    assert.equal(progressPositionMs("out_time_us=-64000"), null);
  });
});

describe("estimates", () => {
  test("are phrased in units someone can plan around", () => {
    assert.equal(duration(8_400), "8s");
    assert.equal(duration(95_000), "1m 35s");
    assert.equal(duration(5_400_000), "1h 30m");
  });
});

describe("the voice cache", () => {
  /**
   * A stand-in TTS endpoint. The cache is checked for existence and never for
   * integrity, so whatever lands under a key is believed by every later render
   * — which makes *how* it lands the whole question.
   */
  async function speaking(
    reply: (res: ServerResponse) => void,
  ): Promise<{ base: string; close: () => Promise<void> }> {
    const server = createServer((_req, res) => reply(res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    return {
      base: `http://127.0.0.1:${port}/v1`,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }

  const voice = {
    provider: "openai" as const,
    speed: 1,
    fit: "stretch" as const,
  } as unknown as Parameters<typeof synthesizeAll>[1];

  test("a spoken line lands whole, with no partial file beside it", async () => {
    const dir = await workDir();
    const tts = await speaking((res) => {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.end(Buffer.from("ID3 a whole sentence"));
    });
    process.env.REEL_VOICE_API_BASE = tts.base;
    process.env.REEL_VOICE_API_KEY = "test-key";
    try {
      const out = await synthesizeAll(["Meet TaskFlow"], voice, dir);
      assert.equal(out.synthesized, 1);
      const files = await readdir(dir);
      assert.equal(files.filter((f) => f.endsWith(".mp3")).length, 1);
      // The scratch file is renamed into place, not left lying about: a `.tmp`
      // here would be the next render's mystery.
      assert.deepEqual(files.filter((f) => f.endsWith(".tmp")), []);
    } finally {
      delete process.env.REEL_VOICE_API_BASE;
      delete process.env.REEL_VOICE_API_KEY;
      await tts.close();
    }
  });

  test("a line that never arrives leaves nothing under its key", async () => {
    const dir = await workDir();
    // A refusal rather than a 5xx, so the test is not waiting out the retry
    // backoff that a transient failure earns.
    const tts = await speaking((res) => {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("bad key");
    });
    process.env.REEL_VOICE_API_BASE = tts.base;
    process.env.REEL_VOICE_API_KEY = "test-key";
    try {
      await assert.rejects(() => synthesizeAll(["Meet TaskFlow"], voice, dir));
      assert.deepEqual(await readdir(dir), [], "a failed line must leave the cache untouched");
    } finally {
      delete process.env.REEL_VOICE_API_BASE;
      delete process.env.REEL_VOICE_API_KEY;
      await tts.close();
    }
  });
});
