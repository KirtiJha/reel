import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isRetryable, retryDelayMs } from "../src/driver/retry.js";
import { specSchema, type Step } from "../src/spec/schema.js";

function step(raw: unknown): Step {
  return specSchema.parse({ steps: [raw], output: { gif: "g" } }).steps[0]!;
}

const timeout = new Error("locator.click: Timeout 8000ms exceeded.\nCall log: waiting for locator('#a')");
const detached = new Error("Element is not attached to the DOM");
const unknown = new Error("Something else went wrong");

describe("isRetryable", () => {
  test("steps that change nothing are always safe to repeat", () => {
    for (const raw of [
      { waitFor: "#a" },
      { waitForUrl: "/done" },
      { expect: { selector: "#a", text: "hi" } },
      { goto: "/" },
      { scrollTo: "#a" },
      { hover: "#a" },
      { callout: { selector: "#a" } },
    ]) {
      assert.equal(isRetryable(step(raw), unknown), true, JSON.stringify(raw));
    }
  });

  test("a mutating step is retried when the failure proves it never acted", () => {
    // Playwright waits for actionability first, so a timeout means no click.
    assert.equal(isRetryable(step({ click: "#a" }), timeout), true);
    assert.equal(isRetryable(step({ type: { selector: "#a", text: "hi" } }), timeout), true);
  });

  test("a mutating step is NOT retried when the action may have landed", () => {
    // Re-running here could submit twice or duplicate typed text.
    assert.equal(isRetryable(step({ click: "#a" }), unknown), false);
    assert.equal(isRetryable(step({ type: { selector: "#a", text: "hi" } }), unknown), false);
    assert.equal(isRetryable(step({ press: { key: "Enter" } }), unknown), false);
  });

  test("recognizes the actionability failures as never-acted", () => {
    assert.equal(isRetryable(step({ click: "#a" }), detached), true);
    assert.equal(
      isRetryable(step({ click: "#a" }), new Error("element is not visible")),
      true,
    );
  });

  test("tolerates a non-Error rejection", () => {
    assert.equal(isRetryable(step({ click: "#a" }), "boom"), false);
    assert.equal(isRetryable(step({ waitFor: "#a" }), undefined), true);
  });
});

describe("retryDelayMs", () => {
  test("backs off exponentially", () => {
    assert.ok(retryDelayMs(1) > retryDelayMs(0));
    assert.ok(retryDelayMs(2) > retryDelayMs(1));
  });

  test("is capped so a retry budget can't stall a build", () => {
    assert.ok(retryDelayMs(10) <= 2000);
  });
});
