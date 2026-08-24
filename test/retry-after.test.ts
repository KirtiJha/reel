import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseRetryAfter } from "../src/ai/llm.js";

describe("waiting as long as the provider asked", () => {
  // Reel already retried a 429; it just guessed how long to wait. Against
  // Gemini's free tier — which resets per minute — the guesses were four
  // retries inside about fifteen seconds, none of which could have worked.
  test("delta-seconds in the header", () => {
    assert.equal(parseRetryAfter("31", ""), 31_000);
  });

  test("an HTTP date in the header", () => {
    const at = new Date(Date.now() + 20_000).toUTCString();
    const ms = parseRetryAfter(at, "");
    assert.ok(ms !== undefined && ms > 15_000 && ms <= 21_000, `got ${ms}`);
  });

  test("Google sends no header and puts retryDelay in the body", () => {
    const body = JSON.stringify({
      error: { code: 429, message: "quota", details: [{ retryDelay: "44s" }] },
    });
    assert.equal(parseRetryAfter(undefined, body), 44_000);
  });

  test("the header wins over the body when both are present", () => {
    assert.equal(parseRetryAfter("5", '{"retryDelay": "44s"}'), 5_000);
  });

  test("nothing to go on means fall back to the exponential guess", () => {
    assert.equal(parseRetryAfter(undefined, "not json"), undefined);
    assert.equal(parseRetryAfter("", ""), undefined);
  });

  test("a past date, zero, or nonsense is ignored rather than waited on", () => {
    assert.equal(parseRetryAfter("0", ""), undefined);
    assert.equal(parseRetryAfter("-10", ""), undefined);
    assert.equal(parseRetryAfter("later", ""), undefined);
    assert.equal(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString(), ""), undefined);
  });

  test("an absurd delay is capped, not obeyed", () => {
    // A mistaken or hostile header must not park a recording for an hour.
    assert.equal(parseRetryAfter("86400", ""), 60_000);
  });

  test("a header array takes its first value", () => {
    assert.equal(parseRetryAfter(["12", "99"], ""), 12_000);
  });
});
