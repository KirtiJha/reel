import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { embedSnippets, formatEmbeds } from "../src/encode/embed.js";

const code = (files: string[], opts = {}) =>
  embedSnippets(files, opts).map((s) => s.code);

describe("embedSnippets", () => {
  test("an animation is Markdown image syntax", () => {
    assert.deepEqual(embedSnippets(["out/demo.gif"], { title: "Demo" })[0]?.code, "![Demo](out/demo.gif)");
    assert.deepEqual(embedSnippets(["out/demo.webp"], { title: "Demo" })[0]?.code, "![Demo](out/demo.webp)");
  });

  test("a video is raw HTML, because Markdown has no video tag", () => {
    const c = code(["out/demo.mp4"], { title: "Demo" })[0]!;
    assert.match(c, /^<video /);
    assert.match(c, /src="out\/demo\.mp4"/);
  });

  test("a video is muted, or no browser will autoplay it", () => {
    // Not decoration: without `muted` the demo is a still frame with a play
    // button, which looks broken rather than deliberate.
    for (const c of code(["a.mp4", "b.webm"])) {
      assert.match(c, /\bmuted\b/);
      assert.match(c, /\bautoplay\b/);
      assert.match(c, /\bplaysinline\b/);
    }
  });

  test("the interactive build is an iframe in embed mode", () => {
    const c = code(["out/demo.html"])[0]!;
    assert.match(c, /^<iframe /);
    assert.match(c, /demo\.html\?embed=1/);
  });

  test("a video and an iframe carry an accessible name", () => {
    assert.match(code(["a.mp4"], { title: "Sign up" })[0]!, /aria-label="Sign up"/);
    assert.match(code(["a.html"], { title: "Sign up" })[0]!, /title="Sign up"/);
  });

  test("paths are web paths, whatever the platform used", () => {
    // A Windows render printing `out\demo.gif` is a snippet that breaks
    // silently everywhere it is pasted: GitHub reads a backslash as an escape.
    for (const c of code(["out/nested/demo.gif", "out/nested/demo.mp4"])) {
      assert.ok(!c.includes("\\"), c);
    }
  });

  test("paths are relative to where the command ran", () => {
    const c = code(["/repo/docs/demo.gif"], { from: "/repo" })[0]!;
    assert.match(c, /\(docs\/demo\.gif\)/);
  });

  test("with no title, the filename becomes readable alt text", () => {
    assert.equal(code(["out/sign-up_flow.gif"])[0], "![sign up flow](out/sign-up_flow.gif)");
  });

  test("outputs with nowhere sensible to go are left out", () => {
    // A storyboard is a directory and an audio track is not an embed; inventing
    // a line for either would be worse than saying nothing.
    assert.deepEqual(embedSnippets(["out/storyboard", "out/track.m4a", "out/.reel-stamp.json"]), []);
  });

  test("every deliverable in one render gets its own line", () => {
    const s = embedSnippets(["a.gif", "a.webp", "a.mp4", "a.webm", "a.html"]);
    assert.deepEqual(s.map((x) => x.kind), ["GIF", "WEBP", "MP4", "WEBM", "interactive build"]);
  });
});

describe("formatEmbeds", () => {
  test("prints the kind, the code, and the reason when there is one", () => {
    const lines = formatEmbeds(embedSnippets(["a.mp4"]));
    assert.equal(lines[0], "MP4");
    assert.match(lines[1]!, /^\s+<video /);
    assert.match(lines[2]!, /Markdown has no video tag/);
  });

  test("an image needs no explanation, so gets none", () => {
    assert.equal(formatEmbeds(embedSnippets(["a.gif"])).length, 2);
  });
});
