import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { emit, jsonEnabled, useJson } from "../src/util/report.js";

/** Capture what the reporter writes to stdout. */
function capture(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    chunks.push(s);
    return true;
  };
  try {
    fn();
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
  return chunks.join("");
}

beforeEach(() => useJson(false));
afterEach(() => useJson(false));

describe("report envelope", () => {
  test("prints nothing unless --json was passed", () => {
    assert.equal(capture(() => emit("record", true)), "");
    assert.equal(jsonEnabled(), false);
  });

  test("emits one parseable object", () => {
    useJson(true);
    const out = capture(() => emit("check", true, { result: { steps: 3 } }));
    const d = JSON.parse(out);
    assert.equal(d.tool, "reel");
    assert.equal(d.version, 1);
    assert.equal(d.command, "check");
    assert.equal(d.ok, true);
    assert.deepEqual(d.result, { steps: 3 });
  });

  test("always carries the fields a caller branches on", () => {
    // A consumer should be able to read ok/command without knowing the payload.
    useJson(true);
    const d = JSON.parse(capture(() => emit("record", false)));
    for (const k of ["tool", "version", "command", "ok", "elapsedMs"]) {
      assert.ok(k in d, `missing ${k}`);
    }
  });

  test("reports elapsed time as a number", () => {
    useJson(true);
    const d = JSON.parse(capture(() => emit("record", true)));
    assert.equal(typeof d.elapsedMs, "number");
    assert.ok(d.elapsedMs >= 0);
  });

  test("carries failure detail including artifact paths", () => {
    useJson(true);
    const d = JSON.parse(
      capture(() =>
        emit("check", false, {
          error: {
            message: "Timeout",
            step: { number: 4, label: 'click "#a"' },
            artifacts: { screenshot: "/tmp/failure.png" },
          },
        }),
      ),
    );
    assert.equal(d.ok, false);
    assert.equal(d.error.step.number, 4);
    assert.equal(d.error.artifacts.screenshot, "/tmp/failure.png");
  });

  test("ends with a newline, so it can be appended to a log", () => {
    useJson(true);
    assert.ok(capture(() => emit("record", true)).endsWith("\n"));
  });

  test("a second call re-emits rather than accumulating state", () => {
    useJson(true);
    const a = JSON.parse(capture(() => emit("record", true)));
    const b = JSON.parse(capture(() => emit("heal", false)));
    assert.equal(a.command, "record");
    assert.equal(b.command, "heal");
    assert.equal(b.ok, false);
  });
});
