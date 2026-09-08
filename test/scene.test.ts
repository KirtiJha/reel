import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScene, isTemplate } from "../src/scene/scene.js";
import { esc, escapeCss, renderTemplate, TEMPLATES } from "../src/scene/templates.js";
import { DEFAULT_LOOK, isLook, LOOK_NAMES, lookFor } from "../src/scene/looks.js";
import { specSchema } from "../src/spec/schema.js";

const style = { accent: "#6d8bff" };

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

  test("the accent comes from the spec, the ground from the look", () => {
    // A look never owns the accent: every backdrop in the catalogue is built
    // out of it, which is why one look on two products is two pictures.
    const html = renderTemplate("title", { title: "T" }, { accent: "#ff0066", look: "neon" });
    assert.ok(html.includes("#ff0066"));
    assert.ok(html.includes(lookFor("neon").ground));
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

  test("a title arrives a word at a time, not as a block", () => {
    // The difference between "a slide" and "a launch film". Each word gets its
    // own slice of --in, so the line ripples in.
    const html = renderTemplate("title", { title: "one two three four" }, style);
    const spans = [...html.matchAll(/class="w" style="--t: ([^"]+)"/g)].map((m) => m[1]!);
    assert.equal(spans.length, 4);
    const starts = spans.map((s) => Number(/var\(--in\) - ([0-9.]+)\)/.exec(s)![1]));
    assert.equal(starts[0], 0);
    for (let i = 1; i < starts.length; i++) {
      assert.ok(starts[i]! > starts[i - 1]!, "each word starts after the one before");
    }
    // …and they all finish inside the entrance rather than trailing into the
    // body of the scene, which would read as a typewriter.
    assert.ok(starts[starts.length - 1]! < 1);
  });

  test("a one-word title does not divide by zero", () => {
    const html = renderTemplate("title", { title: "Reel" }, style);
    assert.ok(!html.includes("NaN"));
    assert.ok(!html.includes("Infinity"));
  });

  test("the slate is drawn only when asked for", () => {
    const without = renderTemplate("chapter", { title: "T" }, style);
    assert.ok(!without.includes(`class="slate"`));
    const with_ = renderTemplate("chapter", { title: "T", slate: "03 · Chapter", slateNote: "reel" }, style);
    assert.ok(with_.includes(`class="slate"`));
    assert.ok(with_.includes("03 · Chapter"));
    assert.ok(with_.includes("reel"));
  });

  test("the slate is text too", () => {
    const html = renderTemplate("title", { title: "T", slate: "<b>x</b>" }, style);
    assert.ok(!html.includes("<b>"));
  });

});

describe("looks", () => {
  test("every look draws a backdrop that moves for the whole scene", () => {
    // --in is spent by the end of the entrance; a backdrop that only read --in
    // would arrive and then sit still for the rest of the scene.
    for (const look of LOOK_NAMES) {
      const html = renderTemplate("title", { title: "T" }, { ...style, look });
      const backdrop = lookFor(look).backdrop("#6d8bff");
      assert.ok(backdrop.markup.includes("<i"), `${look} draws no backdrop layers`);
      assert.ok(/var\(--p\)/.test(backdrop.css), `${look}'s backdrop does not read --p`);
      assert.ok(html.includes(backdrop.markup), `${look}'s layers never reached the document`);
    }
  });

  test("no look reaches for a clock", () => {
    for (const look of LOOK_NAMES) {
      const html = renderTemplate("bullets", { title: "T", items: ["a", "b"] }, { ...style, look });
      assert.ok(!/\banimation\s*:/.test(html), `${look} uses a CSS animation`);
      assert.ok(!/\btransition\s*:/.test(html), `${look} uses a CSS transition`);
    }
  });

  test("every look is built from the spec's accent, not its own", () => {
    for (const look of LOOK_NAMES) {
      const html = renderTemplate("title", { title: "T" }, { accent: "#ff0066", look });
      assert.ok(html.includes("#ff0066"), `${look} ignores the spec accent`);
    }
  });

  test("looks actually differ — ground, ink and entrance", () => {
    // The whole point of the layer. If two looks render the same document,
    // one of them is decoration rather than an identity.
    const seen = new Set(
      LOOK_NAMES.map((look) => renderTemplate("title", { title: "T" }, { ...style, look })),
    );
    assert.equal(seen.size, LOOK_NAMES.length, "two looks render identically");
  });

  test("a dark look uses light ink and a light look dark ink", () => {
    // Relative luminance rather than a list of hexes, so adding a look to the
    // catalogue cannot quietly pair a white ground with white type.
    const lum = (hex: string) => {
      const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
      assert.ok(m, `ink ${hex} is not a plain hex colour`);
      const n = parseInt(m[1]!, 16);
      return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
    };
    for (const look of LOOK_NAMES) {
      const l = lookFor(look);
      assert.equal(lum(l.ink) > 0.5, l.dark, `${look} pairs a ${l.dark ? "dark" : "light"} ground with ink ${l.ink}`);
    }
  });

  test("the catalogue is the source of truth for what a spec may name", () => {
    assert.ok(isLook(DEFAULT_LOOK));
    assert.ok(isLook("neon"));
    assert.equal(isLook("chartreuse"), false);
    assert.ok(LOOK_NAMES.includes(DEFAULT_LOOK));
  });

  test("a plate is drawn only by looks loud enough to need one", () => {
    const neon = renderTemplate("title", { title: "T" }, { ...style, look: "neon" });
    assert.ok(neon.includes(`class="plate"`), "neon needs a well for its type");
    const swiss = renderTemplate("title", { title: "T" }, { ...style, look: "swiss" });
    assert.ok(!swiss.includes(`class="plate"`), "swiss is quiet and should get no plate");
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
