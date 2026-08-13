import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { doctor, isHealthy, type CheckResult } from "../src/commands/doctor.js";

const check = (status: CheckResult["status"], name = "x"): CheckResult => ({
  name,
  status,
  detail: "",
});

describe("isHealthy", () => {
  test("a clean run is healthy", () => {
    assert.equal(isHealthy([check("ok"), check("ok")]), true);
  });

  test("a warning does not block recording", () => {
    // An unconfigured model only affects `author`; refusing to record over it
    // would be wrong.
    assert.equal(isHealthy([check("ok"), check("warn")]), true);
  });

  test("any hard failure makes it unhealthy", () => {
    assert.equal(isHealthy([check("ok"), check("fail"), check("warn")]), false);
  });

  test("no checks is vacuously healthy", () => {
    assert.equal(isHealthy([]), true);
  });
});

describe("doctor", () => {
  test("reports on every dependency recording needs", async () => {
    const r = await doctor();
    const names = r.checks.map((c) => c.name);
    for (const needed of ["Node", "Chromium", "ffmpeg", "sharp", "Temp space"]) {
      assert.ok(names.includes(needed), `missing check: ${needed}`);
    }
  });

  test("every check is fully formed", async () => {
    const r = await doctor();
    for (const c of r.checks) {
      assert.ok(c.name.length > 0, "has a name");
      assert.ok(["ok", "warn", "fail"].includes(c.status), `valid status: ${c.status}`);
      assert.equal(typeof c.detail, "string");
    }
  });

  test("anything not ok carries a fix", async () => {
    // A diagnosis without a remedy is just a nicer error message.
    const r = await doctor();
    for (const c of r.checks) {
      if (c.status !== "ok") assert.ok(c.fix, `${c.name} reports ${c.status} with no fix`);
    }
  });

  test("ok agrees with the individual checks", async () => {
    const r = await doctor();
    assert.equal(r.ok, isHealthy(r.checks));
  });
});
