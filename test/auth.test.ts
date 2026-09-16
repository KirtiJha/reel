import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyStorageState,
  expiredCookies,
  loadStorageState,
  sameOrigin,
  type StorageState,
} from "../src/driver/auth.js";
import { signInStates } from "../src/spec/fingerprint.js";
import { specSchema, type Step } from "../src/spec/schema.js";

const HOUR = 3_600_000;
const NOW = 1_760_000_000_000;

async function stateFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "reel-auth-"));
  const file = join(dir, "auth.json");
  await writeFile(file, contents, "utf8");
  return file;
}

const session = (over: Partial<StorageState> = {}): StorageState => ({
  cookies: [{ name: "sid", value: "abc", domain: "app.test", path: "/", expires: -1 } as never],
  ...over,
});

describe("reading a saved session", () => {
  test("accepts one Playwright wrote", async () => {
    const file = await stateFile(JSON.stringify({ cookies: session().cookies, origins: [] }));
    const state = await loadStorageState(file);
    assert.equal(state.cookies?.length, 1);
  });

  test("a missing file names the command that makes one", async () => {
    await assert.rejects(() => loadStorageState("/nope/auth.json"), /No such session file/);
  });

  test("a file that isn't JSON is caught before the browser sees it", async () => {
    // Pointing `signIn` at the spec itself is the easy mistake, and the symptom
    // otherwise is an app that simply renders logged out.
    const file = await stateFile("name: My demo\nsteps: []\n");
    await assert.rejects(() => loadStorageState(file), /isn't JSON/);
  });

  test("JSON that isn't a storage state is rejected", async () => {
    const file = await stateFile(JSON.stringify({ token: "abc" }));
    await assert.rejects(() => loadStorageState(file), /no cookies or origins/);
  });

  test("an empty session is rejected rather than silently doing nothing", async () => {
    // This is what you get when Finish is pressed before the sign-in completes.
    // Applying it would succeed, and the demo would record the logged-out app.
    const file = await stateFile(JSON.stringify({ cookies: [], origins: [] }));
    await assert.rejects(() => loadStorageState(file), /holds no session/);
  });
});

describe("expiry", () => {
  test("finds cookies that have already lapsed", () => {
    const state = session({
      cookies: [
        { name: "old", expires: (NOW - HOUR) / 1000 },
        { name: "fresh", expires: (NOW + HOUR) / 1000 },
      ] as never,
    });
    assert.deepEqual(
      expiredCookies(state, NOW).map((c) => c.name),
      ["old"],
    );
  });

  test("a session cookie never counts as expired", () => {
    // Playwright writes -1 for a cookie with no expiry; treating that as a date
    // in 1969 would warn on every healthy session.
    assert.deepEqual(expiredCookies(session(), NOW), []);
  });

  test("no cookies at all is not an expiry problem", () => {
    assert.deepEqual(expiredCookies({ origins: [] }, NOW), []);
  });
});

describe("origin matching", () => {
  test("scheme, host and port all have to agree", () => {
    assert.ok(sameOrigin("https://app.test/dashboard", "https://app.test"));
    assert.ok(!sameOrigin("http://app.test/", "https://app.test"));
    assert.ok(!sameOrigin("https://app.test:8080/", "https://app.test"));
    assert.ok(!sameOrigin("https://other.test/", "https://app.test"));
  });

  test("a page that isn't on a URL yet matches nothing", () => {
    assert.ok(!sameOrigin("about:blank", "https://app.test"));
    assert.ok(!sameOrigin("", "https://app.test"));
  });
});

/** Enough of a context/page to observe what applyStorageState does. */
function fakes(url: string) {
  const added: unknown[] = [];
  const evaluated: { on: string; items: { name: string; value: string }[] }[] = [];
  const opened: string[] = [];
  const closed: string[] = [];

  const makePage = (at: string) => ({
    url: () => at,
    goto: async (to: string) => {
      opened.push(to);
    },
    evaluate: async (_fn: unknown, items: { name: string; value: string }[]) => {
      evaluated.push({ on: at, items });
    },
    close: async () => {
      closed.push(at);
    },
  });

  const page = makePage(url);
  const context = {
    addCookies: async (c: unknown) => {
      added.push(...(c as unknown[]));
    },
    newPage: async () => makePage("scratch"),
  };
  return { context, page, added, evaluated, opened, closed };
}

describe("applying a session to a running browser", () => {
  test("cookies go to the context", async () => {
    const f = fakes("https://app.test/");
    const res = await applyStorageState(f.context as never, f.page as never, session(), { now: NOW });
    assert.equal(f.added.length, 1);
    assert.equal(res.cookies, 1);
  });

  test("local storage for the filmed page is written in place", async () => {
    // No navigation: the page the camera is on must not move for this.
    const f = fakes("https://app.test/dashboard");
    const res = await applyStorageState(
      f.context as never,
      f.page as never,
      session({ origins: [{ origin: "https://app.test", localStorage: [{ name: "t", value: "1" }] }] }),
      { now: NOW },
    );
    assert.deepEqual(f.opened, [], "nothing was navigated");
    assert.equal(f.evaluated.length, 1);
    assert.deepEqual(f.evaluated[0]!.items, [{ name: "t", value: "1" }]);
    assert.deepEqual(res.offCamera, []);
  });

  test("another origin is restored from a page the camera never sees", async () => {
    // An auth server keeps its token on its own origin, and only script running
    // there can write it. Doing that on the filmed page would put the auth
    // server in the demo.
    const f = fakes("https://app.test/");
    const res = await applyStorageState(
      f.context as never,
      f.page as never,
      session({ origins: [{ origin: "https://auth.test", localStorage: [{ name: "t", value: "1" }] }] }),
      { now: NOW },
    );
    assert.deepEqual(f.opened, ["https://auth.test"]);
    assert.deepEqual(f.closed, ["scratch"], "the scratch page is closed again");
    assert.deepEqual(res.offCamera, ["https://auth.test"]);
  });

  test("an origin with nothing stored is not opened at all", async () => {
    const f = fakes("https://app.test/");
    await applyStorageState(
      f.context as never,
      f.page as never,
      session({ origins: [{ origin: "https://auth.test", localStorage: [] }] }),
      { now: NOW },
    );
    assert.deepEqual(f.opened, []);
  });

  test("an unreachable origin does not lose the cookies that applied", async () => {
    const f = fakes("https://app.test/");
    const context = {
      ...f.context,
      newPage: async () => ({
        url: () => "scratch",
        goto: async () => {
          throw new Error("net::ERR_NAME_NOT_RESOLVED");
        },
        evaluate: async () => {},
        close: async () => {},
      }),
    };
    const res = await applyStorageState(
      context as never,
      f.page as never,
      session({ origins: [{ origin: "https://gone.test", localStorage: [{ name: "t", value: "1" }] }] }),
      { now: NOW },
    );
    assert.equal(res.cookies, 1, "the cookies still went in");
    assert.deepEqual(res.origins, [], "and the failed origin is not claimed as applied");
  });
});

describe("a signIn file is an input to the render", () => {
  const parse = (steps: unknown[]): Step[] =>
    specSchema.parse({ url: "http://x", steps, output: { gif: "g" } }).steps;

  test("both spellings are found", () => {
    assert.deepEqual(
      signInStates(parse([{ signIn: ".auth/a.json" }, { signIn: { state: ".auth/b.json" } }])),
      [".auth/a.json", ".auth/b.json"],
    );
  });

  test("including inside a branch, whose paths are recorded too", () => {
    const steps = parse([
      {
        branch: {
          prompt: "Which?",
          paths: [
            { label: "Admin", steps: [{ signIn: ".auth/admin.json" }] },
            { label: "User", steps: [{ signIn: ".auth/user.json" }] },
          ],
        },
      },
    ]);
    assert.deepEqual(signInStates(steps), [".auth/admin.json", ".auth/user.json"]);
  });

  test("a spec with no signIn contributes nothing", () => {
    assert.deepEqual(signInStates(parse([{ goto: "/" }])), []);
  });
});
