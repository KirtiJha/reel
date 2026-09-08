import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScene, isTemplate } from "../src/scene/scene.js";
import { esc, escapeCss, renderTemplate, TEMPLATES } from "../src/scene/templates.js";
import { specSchema } from "../src/spec/schema.js";

const style = { accent: "#6d8bff", background: "#0b0b0f", theme: "dark" };

describe("renderTemplate", () => {
  test("every template draws something for a bare title", () => {
    for (const name of TEMPLATES) {
      const html = renderTemplate(name, { title: "Hello", items: ["a", "b"] }, style);
      assert.ok(html.includes("Hello"), `${name} dropped the title`);
      assert.ok(html.includes("<style>"), `${name} shipped no styles`);
    }
  });

  test("motion reads the seek variables, never a clock", () => {
    // The determinism layer suppresses CSS animation and transition inside
    // every document, deliberately. A template that animated with either would
    // simply not move — and a clock-driven entrance cannot be seeked anyway.
    for (const name of TEMPLATES) {
      const html = renderTemplate(name, { title: "T", items: ["a"] }, style);
      assert.ok(/var\(--(in|out|t|p)\)/.test(html), `${name} has no seek-driven motion`);
      assert.ok(!/\banimation\s*:/.test(html), `${name} uses a CSS animation`);
      assert.ok(!/\btransition\s*:/.test(html), `${name} uses a CSS transition`);
    }
  });

  test("the accent and background come from the spec", () => {
    const html = renderTemplate("title", { title: "T" }, {
      accent: "#ff0066",
      background: "#123456",
      theme: "dark",
    });
    assert.ok(html.includes("#ff0066"));
    assert.ok(html.includes("#123456"));
  });

  test("bullets stagger, so the list builds instead of appearing", () => {
    const html = renderTemplate("bullets", { items: ["one", "two", "three"] }, style);
    // Each line gets its own slice of --in; the first starts at 0.
    const starts = [...html.matchAll(/var\(--in\) - ([0-9.]+)\)/g)].map((m) => Number(m[1]));
    assert.equal(starts.length, 3);
    assert.equal(starts[0], 0);
    for (let i = 1; i < starts.length; i++) {
      assert.ok(starts[i]! > starts[i - 1]!, "each line starts after the one before");
    }
  });

  test("a single bullet does not divide by zero", () => {
    const html = renderTemplate("bullets", { items: ["only"] }, style);
    assert.ok(!html.includes("NaN"));
    assert.ok(!html.includes("Infinity"));
  });

  test("a light theme uses dark ink", () => {
    const dark = renderTemplate("title", { title: "T" }, style);
    const light = renderTemplate("title", { title: "T" }, { ...style, theme: "light" });
    assert.notEqual(dark, light);
    assert.ok(light.includes("#0d1017"));
  });
});

describe("escaping", () => {
  test("a title is text, not markup", () => {
    // A demo title is author-supplied. It ends up in a document that runs.
    const html = renderTemplate("title", { title: `<img src=x onerror=alert(1)>` }, style);
    assert.ok(!html.includes("<img"), "raw markup reached the document");
    assert.ok(html.includes("&lt;img"));
  });

  test("esc covers the characters that break out of markup", () => {
    assert.equal(esc(`<a href="x" class='y'>&</a>`), "&lt;a href=&quot;x&quot; class=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });

  test("a background cannot close its declaration and write new rules", () => {
    // `background` comes from the spec, and a spec is often reviewed less
    // carefully than code.
    assert.equal(escapeCss("red; } body { display: none"), "red  body  display: none");
    assert.ok(!escapeCss("#fff;}html{x:y}").includes(";"));
    assert.ok(!escapeCss("#fff;}html{x:y}").includes("}"));
  });

  test("an ordinary gradient survives escaping intact", () => {
    const g = "linear-gradient(135deg, #2b3a67, #1a1f36)";
    assert.equal(escapeCss(g), g);
  });
});

describe("buildScene", () => {
  test("produces a self-contained document with the seek runtime", async () => {
    const html = await buildScene(
      { template: "title", fields: { title: "Hello" }, style },
      process.cwd(),
    );
    assert.ok(html.startsWith("<!doctype html>"));
    assert.ok(html.includes("__reelSeek"), "no seek entry point");
    assert.ok(html.includes("Hello"));
    // Self-contained by construction: a scene that fetched a font or a script
    // would put someone's uptime between a spec and its output.
    assert.ok(!/<(script|link)[^>]+(src|href)=/.test(html), "the document loads something remote");
  });

  test("the runtime seeds itself, so frame zero is not unstyled", async () => {
    const html = await buildScene({ template: "title", fields: { title: "T" }, style }, ".");
    assert.ok(html.includes("__reelSeek(0)"), "the scene is not seeked on load");
  });

  test("reads a composition of your own", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reel-scene-"));
    await writeFile(join(dir, "own.html"), "<h1>Mine</h1>");
    const html = await buildScene({ file: "own.html", fields: {}, style }, dir);
    assert.ok(html.includes("<h1>Mine</h1>"));
    assert.ok(html.includes("__reelSeek"), "a custom scene still gets the runtime");
  });

  test("refuses a URL rather than fetching it", async () => {
    await assert.rejects(
      () => buildScene({ file: "https://example.com/s.html", fields: {}, style }, "."),
      /never fetches/,
    );
  });

  test("says which composition is missing, and where it looked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reel-scene-"));
    await assert.rejects(() => buildScene({ file: "nope.html", fields: {}, style }, dir), /was not found/);
  });
});

describe("isTemplate", () => {
  test("accepts what exists and refuses what does not", () => {
    assert.equal(isTemplate("title"), true);
    assert.equal(isTemplate("bullets"), true);
    assert.equal(isTemplate("carousel"), false);
  });
});

describe("the scene step", () => {
  const parse = (scene: unknown) =>
    specSchema.parse({ steps: [{ scene }], output: { html: "o/d.html" } }).steps[0] as {
      scene: Record<string, unknown>;
    };

  test("defaults to three seconds", () => {
    assert.equal(parse({ title: "T" }).scene.ms, 3000);
  });

  test("carries the template fields", () => {
    const { scene } = parse({
      template: "bullets",
      title: "T",
      items: ["a", "b"],
    });
    assert.equal(scene.template, "bullets");
    assert.deepEqual(scene.items, ["a", "b"]);
  });

  test("a template Reel cannot draw is refused, not ignored", () => {
    assert.throws(() => parse({ template: "carousel", title: "T" }));
  });

  test("an unknown key is refused, so a typo is not silently dropped", () => {
    assert.throws(() => parse({ title: "T", subtitel: "typo" }));
  });
});
