import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deCdn, familiesInUrl } from "../src/compose/catalog.js";

const BLOCK = `<!doctype html>
<html>
  <head>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      @import url("https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Bebas+Neue&display=block");
      body { margin: 0 }
    </style>
  </head>
  <body><div id="root" data-composition-id="x"></div></body>
</html>`;

describe("familiesInUrl", () => {
  test("reads the families out of a Google Fonts URL", () => {
    assert.deepEqual(
      familiesInUrl("https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Bebas+Neue&display=block"),
      ["Space Mono", "Bebas Neue"],
    );
  });

  test("drops the weights, because a local face either exists or does not", () => {
    // Naming a weight the machine cannot supply would be a claim it can't honour.
    assert.deepEqual(familiesInUrl("?family=Inter:wght@100..900"), ["Inter"]);
  });

  test("a URL naming no family yields none rather than an empty string", () => {
    assert.deepEqual(familiesInUrl("https://fonts.googleapis.com/css2?display=swap"), []);
  });
});

describe("deCdn", () => {
  test("re-points GSAP at the vendored copy", () => {
    const { html, gsap } = deCdn(BLOCK, "../gsap.min.js");
    assert.equal(gsap, 1);
    assert.ok(html.includes(`src="../gsap.min.js"`));
    assert.ok(!html.includes("cdn.jsdelivr.net"));
  });

  test("drops the remote font import and declares the families locally", () => {
    // Dropping alone would be worse than leaving it: `check` rejects a family
    // it cannot resolve, and a silently substituted face is not the typography
    // the block's author chose.
    const { html, fonts } = deCdn(BLOCK, "../gsap.min.js");
    assert.deepEqual(fonts, ["Space Mono", "Bebas Neue"]);
    assert.ok(!html.includes("fonts.googleapis.com"));
    assert.ok(html.includes(`@font-face { font-family: "Space Mono"; src: local("Space Mono"); }`));
    assert.ok(html.includes(`@font-face { font-family: "Bebas Neue"; src: local("Bebas Neue"); }`));
  });

  test("leaves everything else exactly as the catalog wrote it", () => {
    // A block edited beyond recognition is no longer the block you installed.
    const { html } = deCdn(BLOCK, "../gsap.min.js");
    assert.ok(html.includes(`<div id="root" data-composition-id="x"></div>`));
    assert.ok(html.includes("body { margin: 0 }"));
  });

  test("a block that links nothing remote is reported as untouched", () => {
    const clean = `<html><head><script src="./gsap.min.js"></script><style>body{}</style></head></html>`;
    const { gsap, fonts } = deCdn(clean, "../gsap.min.js");
    assert.equal(gsap, 0);
    assert.deepEqual(fonts, []);
  });

  test("a stylesheet <link> to Google Fonts is handled too, not just @import", () => {
    const withLink = `<html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">` +
      `<style>body{}</style></head></html>`;
    const { html, fonts } = deCdn(withLink, "../gsap.min.js");
    assert.deepEqual(fonts, ["Inter"]);
    assert.ok(!html.includes("<link"));
  });

  test("the same family named twice is declared once", () => {
    const twice = `<html><head><style>@import url("https://fonts.googleapis.com/css2?family=Inter");` +
      `@import url("https://fonts.googleapis.com/css2?family=Inter&family=Lato");</style></head></html>`;
    const { fonts } = deCdn(twice, "../gsap.min.js");
    assert.deepEqual(fonts, ["Inter", "Lato"]);
  });
});
