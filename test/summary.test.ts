import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../src/ui/summary.js";

const base = `
name: Demo
url: http://localhost:3000
steps:
  - goto: /
  - caption: Hello
output:
  gif: out/d.gif
`;

describe("summarize", () => {
  test("reads a valid spec", () => {
    const s = summarize(base);
    assert.equal(s.valid, true);
    assert.equal(s.name, "Demo");
    assert.equal(s.stepCount, 2);
    assert.equal(s.kind, "web");
  });

  test("reports YAML errors instead of throwing", () => {
    const s = summarize("name: [unclosed");
    assert.equal(s.valid, false);
    assert.ok(s.errors.length > 0);
  });

  test("reports schema errors with the offending field", () => {
    const s = summarize("steps: []\noutput: {}");
    assert.equal(s.valid, false);
    assert.ok(s.errors.some((e) => e.includes("steps") || e.includes("output")));
  });

  test("labels steps the way the driver logs them", () => {
    const s = summarize(`
name: D
steps:
  - click: "#save"
  - type: { selector: "#a", text: hi }
  - card: { title: Welcome }
output: { gif: g.gif }
`);
    assert.equal(s.outline[0]!.kind, "click");
    assert.match(s.outline[0]!.label, /#save/);
    assert.match(s.outline[1]!.label, /#a/);
    assert.match(s.outline[2]!.label, /Welcome/);
  });

  test("detects a terminal spec and its run steps", () => {
    const s = summarize(`
name: CLI
terminal: { cols: 80, rows: 20 }
steps:
  - run: npm test
output: { gif: g.gif }
`);
    assert.equal(s.kind, "terminal");
    assert.equal(s.outline[0]!.kind, "run");
    assert.match(s.outline[0]!.label, /npm test/);
  });

  test("a terminal spec needs no app URL", () => {
    // The schema substitutes about:blank; the Studio shouldn't show localhost.
    const s = summarize(`
name: CLI
terminal: { cols: 80 }
steps: [{ run: ls }]
output: { gif: g.gif }
`);
    assert.equal(s.url, "about:blank");
  });

  test("expands a branch into its paths", () => {
    const s = summarize(`
name: B
steps:
  - goto: /
  - branch:
      prompt: Pick one
      paths:
        - label: First
          steps: [{ click: "#a" }]
        - label: Second
          default: true
          steps: [{ click: "#b" }, { caption: hi }]
output: { html: d.html }
`);
    assert.equal(s.branchCount, 1);
    const b = s.outline[1]!.branch!;
    assert.equal(b.prompt, "Pick one");
    assert.equal(b.paths.length, 2);
    assert.equal(b.paths[1]!.isDefault, true, "the marked path is the default");
    assert.equal(b.paths[1]!.steps.length, 2);
    assert.equal(b.paths[0]!.steps[0]!.kind, "click");
  });

  test("counts matrix variants", () => {
    const s = summarize(`
name: M
matrix:
  viewports:
    - { name: desktop, width: 1280, height: 800 }
    - { name: mobile, width: 390, height: 844 }
  themes: [light, dark]
steps: [{ goto: / }]
output: { gif: "out/{viewport}-{theme}.gif" }
`);
    assert.equal(s.variants, 4);
    assert.deepEqual(s.matrix?.viewports, ["desktop", "mobile"]);
  });

  test("a spec with no matrix renders one variant", () => {
    assert.equal(summarize(base).variants, 1);
    assert.equal(summarize(base).matrix, undefined);
  });

  test("surfaces the options the spec actually sets", () => {
    // The form hydrates from this — showing defaults instead would silently
    // overwrite whatever the author wrote.
    const s = summarize(`
name: O
polish: { frame: browser, speed: 1.5, trimIdle: 700, captions: false }
deterministic: { timeline: false }
retries: 2
steps: [{ goto: / }]
output: { preset: hq, gif: g.gif, targetDuration: 30s, subtitles: true, languages: [es] }
`);
    assert.equal(s.options.preset, "hq");
    assert.equal(s.options.frame, "browser");
    assert.equal(s.options.speed, 1.5);
    assert.equal(s.options.trimIdle, 700);
    assert.equal(s.options.targetDuration, "30s");
    assert.equal(s.options.retries, 2);
    assert.equal(s.options.timeline, false);
    assert.equal(s.options.captions, false);
    assert.equal(s.options.subtitles, true);
    assert.deepEqual(s.options.languages, ["es"]);
  });

  test("defaults are reported when the spec omits them", () => {
    const s = summarize(base);
    assert.equal(s.options.speed, 1);
    assert.equal(s.options.timeline, true, "deterministic timeline is the default");
    assert.equal(s.options.retries, 0);
    assert.equal(s.options.trimIdle, undefined);
  });
});
