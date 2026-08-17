import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import {
  encodeOutputs,
  findSpecs,
  githubOutputs,
  globToRegExp,
  isGlob,
  markdownCi,
  matchesGlob,
  reviewable,
  worstOverall,
  type CiReport,
  type CiSpecResult,
} from "../src/commands/ci.js";

const spec = (over: Partial<CiSpecResult> = {}): CiSpecResult => ({
  spec: "demo.reel.yaml",
  name: "Demo",
  ok: true,
  outputs: [],
  changed: false,
  ...over,
});

const report = (results: CiSpecResult[], over: Partial<CiReport> = {}): CiReport => ({
  mode: "record",
  results,
  verdict: worstOverall(results),
  failed: false,
  ...over,
});

describe("glob matching", () => {
  test("* stops at a directory boundary", () => {
    assert.ok(matchesGlob("examples/*.reel.yaml", "examples/demo.reel.yaml"));
    assert.ok(!matchesGlob("examples/*.reel.yaml", "examples/taskflow/demo.reel.yaml"));
  });

  test("** crosses them, and may match nothing at all", () => {
    // `**/*.reel.yaml` has to find a spec at the root too, or the default
    // pattern misses the most common layout there is.
    assert.ok(matchesGlob("**/*.reel.yaml", "demo.reel.yaml"));
    assert.ok(matchesGlob("**/*.reel.yaml", "a/b/c/demo.reel.yaml"));
  });

  test("? matches one character but not a slash", () => {
    assert.ok(matchesGlob("demo?.yaml", "demo1.yaml"));
    assert.ok(!matchesGlob("demo?yaml", "demo/yaml"));
  });

  test("dots are literal, not any-character", () => {
    // Without escaping, `*.reel.yaml` would match `demoXreelYyaml`.
    assert.ok(!matchesGlob("*.reel.yaml", "demoXreelYyaml"));
  });

  test("a plain path is not a glob", () => {
    assert.ok(!isGlob("examples/demo.reel.yaml"));
    assert.ok(isGlob("examples/*.reel.yaml"));
    assert.ok(isGlob("**/demo.reel.yaml"));
  });

  test("the pattern is anchored at both ends", () => {
    const re = globToRegExp("*.yaml");
    assert.ok(re.test("a.yaml"));
    assert.ok(!re.test("a.yaml.bak"));
    assert.ok(!re.test("dir/a.yaml"));
  });
});

describe("finding specs", () => {
  async function tree(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "reel-ci-"));
    for (const p of ["demo.reel.yaml", "examples/one.reel.yaml", "examples/deep/two.reel.yaml"]) {
      await mkdir(join(dir, p, ".."), { recursive: true });
      await writeFile(join(dir, p), "name: x\n");
    }
    await mkdir(join(dir, "node_modules/pkg"), { recursive: true });
    await writeFile(join(dir, "node_modules/pkg/vendored.reel.yaml"), "name: x\n");
    await writeFile(join(dir, "notes.md"), "not a spec");
    return dir;
  }

  test("the default pattern finds every spec at any depth", async () => {
    const dir = await tree();
    const found = (await findSpecs(dir, ["**/*.reel.yaml"])).map((f) => relative(dir, f));
    assert.deepEqual(found.sort(), [
      "demo.reel.yaml",
      join("examples", "deep", "two.reel.yaml"),
      join("examples", "one.reel.yaml"),
    ].sort());
  });

  test("never walks into node_modules", async () => {
    // A vendored package with its own demo spec is not this repository's demo,
    // and recording it would run somebody else's `run.cmd`.
    const dir = await tree();
    const found = await findSpecs(dir, ["**/*.reel.yaml"]);
    assert.ok(!found.some((f) => f.includes("node_modules")), found.join(", "));
  });

  test("a named path is taken at its word", async () => {
    const dir = await tree();
    const found = await findSpecs(dir, ["examples/one.reel.yaml"]);
    assert.equal(found.length, 1);
    assert.match(found[0]!, /one\.reel\.yaml$/);
  });

  test("a named path that does not exist is an error, not an empty run", async () => {
    // The dangerous outcome is a green build for a demo nobody ran.
    const dir = await tree();
    await assert.rejects(() => findSpecs(dir, ["nope.reel.yaml"]), /No such spec/);
  });

  test("a path and a glob naming the same spec run it once", async () => {
    // The two branches produce paths independently; if one came back relative
    // the set would hold both forms and the demo would be recorded twice.
    const dir = await tree();
    const found = await findSpecs(dir, ["examples/one.reel.yaml", "examples/*.reel.yaml"]);
    assert.equal(found.length, 1, found.join(", "));
  });

  test("every result is an absolute path, whichever branch found it", async () => {
    const dir = await tree();
    const found = await findSpecs(dir, ["demo.reel.yaml", "examples/**/*.reel.yaml"]);
    assert.ok(
      found.every((f) => isAbsolute(f)),
      found.join(", "),
    );
  });

  test("results are sorted, so two runs report in the same order", async () => {
    const dir = await tree();
    const a = await findSpecs(dir, ["**/*.reel.yaml"]);
    const b = await findSpecs(dir, ["**/*.reel.yaml"]);
    assert.deepEqual(a, b);
    assert.deepEqual([...a].sort(), a);
  });
});

describe("which render gets reviewed", () => {
  test("prefers a lossless container to a GIF", () => {
    // A GIF is palette-quantised, so two renders of the same frame can differ
    // in dithering alone — a change nobody made.
    assert.equal(reviewable(["out/demo.gif", "out/demo.mp4"]), "out/demo.mp4");
    assert.equal(reviewable(["out/demo.gif", "out/demo.webm"]), "out/demo.webm");
    assert.equal(reviewable(["out/demo.gif"]), "out/demo.gif");
  });

  test("a spec that renders no video has nothing to review", () => {
    assert.equal(reviewable(["out/storyboard", "out/demo.html"]), null);
  });
});

describe("the run's verdict", () => {
  const reviewed = (verdict: CiSpecResult["review"] extends undefined ? never : "cosmetic" | "content" | "stale-caption" | "unreviewed") =>
    spec({ changed: true, review: { verdict, model: "m", findings: [] } });

  test("is the worst any spec came back with", () => {
    assert.equal(worstOverall([reviewed("cosmetic"), reviewed("stale-caption"), reviewed("content")]), "stale-caption");
  });

  test("is cosmetic when nothing was reviewed", () => {
    assert.equal(worstOverall([spec(), spec()]), "cosmetic");
  });

  test("an unjudged spec outranks a clean one", () => {
    assert.equal(worstOverall([reviewed("cosmetic"), reviewed("unreviewed")]), "unreviewed");
  });
});

describe("the pull-request comment", () => {
  test("leads with the failures when there are any", () => {
    const md = markdownCi(report([spec({ ok: false, error: "step 3 timed out" }), spec()]));
    assert.match(md, /1 of 2 demos failed to run/);
    assert.match(md, /step 3 timed out/);
  });

  test("leads with what needs a look when everything ran", () => {
    const md = markdownCi(
      report([
        spec({
          changed: true,
          review: {
            verdict: "stale-caption",
            model: "m",
            findings: [
              { startMs: 3200, endMs: 4800, verdict: "stale-caption", summary: "Caption names a gone button." },
            ],
          },
        }),
      ]),
    );
    assert.match(md, /1 change worth a look/);
    assert.match(md, /3\.2s–4\.8s/);
    assert.match(md, /Caption names a gone button/);
  });

  test("cosmetic findings never reach the list", () => {
    // The comment is a decision surface. A row per anti-aliasing change is how
    // a bot comment becomes wallpaper.
    const md = markdownCi(
      report([
        spec({
          changed: true,
          review: {
            verdict: "cosmetic",
            model: "m",
            findings: [{ startMs: 0, endMs: 100, verdict: "cosmetic", summary: "Spacing." }],
          },
        }),
      ]),
    );
    assert.match(md, /nothing but cosmetic changes/);
    assert.doesNotMatch(md, /Spacing\./);
  });

  test("says so when nothing moved at all", () => {
    assert.match(markdownCi(report([spec(), spec()])), /Every demo is unchanged/);
  });

  test("says when the changes were located but not judged", () => {
    const md = markdownCi(
      report([
        spec({
          changed: true,
          review: { verdict: "unreviewed", model: null, findings: [], unconfigured: "No key." },
        }),
      ]),
    );
    assert.match(md, /located but not judged/);
  });

  test("never lets a truncated table read as the whole list", () => {
    const md = markdownCi(report(Array.from({ length: 6 }, () => spec())), { maxRows: 2 });
    assert.match(md, /4 more not listed/);
  });

  test("a pipe in an error cannot break the table", () => {
    const md = markdownCi(report([spec({ ok: false, error: "a | b" })]));
    assert.match(md, /a \\\| b/);
  });
});

describe("what the runner is told", () => {
  test("reports counts, the verdict and every rendered file", () => {
    const out = githubOutputs(
      report([spec({ outputs: ["docs/demo.gif"], changed: true }), spec({ outputs: ["docs/two.mp4"] })], {
        failed: true,
        verdict: "content",
      }),
    );
    assert.equal(out.specs, "2");
    assert.equal(out.failed, "true");
    assert.equal(out.changed, "true");
    assert.equal(out.verdict, "content");
    assert.deepEqual(JSON.parse(out.outputs!), ["docs/demo.gif", "docs/two.mp4"]);
  });

  test("a value can never start a second output", () => {
    // A newline in a $GITHUB_OUTPUT value is an injection, not a formatting nit.
    const encoded = encodeOutputs({ a: "one\ntwo", b: "plain" });
    assert.equal(encoded.split("\n").filter(Boolean).length, 2);
    assert.match(encoded, /^a="one\\ntwo"$/m);
  });

  test("outputs are one key=value per line", () => {
    assert.equal(encodeOutputs({ a: "1", b: "2" }), "a=1\nb=2\n");
  });
});
