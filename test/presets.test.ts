import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  chroma,
  deriveRoles,
  fontSizePx,
  luminance,
  normaliseFrontmatter,
  toRgb,
} from "../src/scene/presets.js";

describe("normaliseFrontmatter", () => {
  test("accepts the house style the presets are actually written in", () => {
    // Every FRAME.md writes its type ramp as `headline:{ … }` with no space,
    // which YAML reads as a compact mapping and rejects. A parser that refused
    // would refuse all thirteen presets.
    const src = `typography:\n  headline:{ fontFamily: "Newsreader", cqw: 4.6 }`;
    assert.equal(normaliseFrontmatter(src), `typography:\n  headline: { fontFamily: "Newsreader", cqw: 4.6 }`);
  });

  test("leaves well-formed YAML alone", () => {
    const src = `colors:\n  paper: "#E9E5DB"\n  ink: "#1B2566"`;
    assert.equal(normaliseFrontmatter(src), src);
  });

  test("does not touch a colon inside a value", () => {
    const src = `description: "a:{b}"`;
    assert.equal(normaliseFrontmatter(src), src);
  });
});

describe("colour", () => {
  test("reads hex, short hex and rgba", () => {
    assert.deepEqual(toRgb("#1B2566"), { r: 27, g: 37, b: 102 });
    assert.deepEqual(toRgb("#fff"), { r: 255, g: 255, b: 255 });
    assert.deepEqual(toRgb("rgba(255,255,255,0.3)"), { r: 255, g: 255, b: 255 });
    assert.equal(toRgb("chartreuse"), undefined);
  });

  test("luminance and chroma separate lightness from colourfulness", () => {
    assert.ok(luminance({ r: 255, g: 255, b: 255 }) > 0.99);
    assert.ok(luminance({ r: 0, g: 0, b: 0 }) < 0.01);
    assert.equal(chroma({ r: 40, g: 40, b: 40 }), 0);
    assert.ok(chroma({ r: 232, g: 93, b: 93 }) > 0.5);
  });
});

describe("deriveRoles", () => {
  test("reads biennale-yellow the way its own description does", () => {
    // "warm parchment ground, single deep indigo ink, solar yellow as bloom".
    // Deriving from colour alone got this wrong — yellow is the most extreme
    // thing in the palette — which is why names lead and colour breaks ties.
    const roles = deriveRoles({
      paper: "#E9E5DB",
      "paper-deep": "#DCD6C4",
      sun: "#F1EE2E",
      "sun-soft": "#F8F39B",
      haze: "#F0DA7C",
      ink: "#1B2566",
      ember: "#E26B4A",
    });
    assert.equal(roles.ground, "#E9E5DB");
    assert.equal(roles.ink, "#1B2566");
    assert.equal(roles.accent, "#F1EE2E");
    assert.equal(roles.dark, false);
  });

  test("reads cartesian's warm-stone palette", () => {
    const roles = deriveRoles({
      "bg-primary": "#EDE8E0",
      "bg-secondary": "#E2DBD1",
      "text-primary": "#1A1A1A",
      "text-secondary": "#5A5A5A",
      accent: "#8A8178",
      line: "#B8B0A4",
      "white-overlay": "rgba(255,255,255,0.3)",
    });
    // The translucent overlay must never win a role — it is a tint, not a surface.
    assert.equal(roles.ground, "#EDE8E0");
    assert.equal(roles.ink, "#1A1A1A");
    assert.equal(roles.accent, "#8A8178");
  });

  test("prefers the primary token over its dimmer variants", () => {
    const roles = deriveRoles({ paper: "#F0EBDE", "paper-deep": "#DCD6C4", ink: "#111111" });
    assert.equal(roles.ground, "#F0EBDE");
  });

  test("a dark ground is reported as dark", () => {
    const roles = deriveRoles({ "ink-black": "#111111", cream: "#F0ECE5", "fire-orange": "#E85D26" });
    assert.equal(roles.accent, "#E85D26");
    // cream is the surface here; ink-black is the type.
    assert.equal(roles.ground, "#F0ECE5");
    assert.equal(roles.dark, false);
  });

  test("a two-colour system keeps ink and accent distinct rather than inventing a third", () => {
    // cobalt-grid is paper plus one electric ink. Its accent should come from
    // the same family, not from somewhere else in the palette.
    const roles = deriveRoles({ paper: "#F0EBDE", ink: "#1F2BE0", "ink-soft": "#5560E5" });
    assert.equal(roles.ground, "#F0EBDE");
    assert.equal(roles.ink, "#1F2BE0");
    assert.equal(roles.accent, "#5560E5");
  });

  test("an empty palette falls back rather than throwing", () => {
    const roles = deriveRoles({});
    assert.ok(roles.ground);
    assert.ok(roles.ink);
    assert.equal(roles.dark, true);
  });

  test("muted is the ink at reduced alpha, clearing AA at body size", () => {
    const roles = deriveRoles({ cream: "#F5F0E8", black: "#1A1A1A", coral: "#E85D5D" });
    assert.equal(roles.muted, "rgba(26,26,26,0.78)");
  });
});

describe("fontSizePx", () => {
  test("cqw is a percentage of the frame's width", () => {
    // 10.4cqw at 1920 is ~200px — roughly twice what feels right when guessing,
    // and most of what separates their frames from a first attempt.
    assert.equal(fontSizePx({ fontFamily: "x", cqw: 10.4 }, 1920), 200);
    assert.equal(fontSizePx({ fontFamily: "x", cqw: 4.6 }, 1920), 88);
  });

  test("an explicit px wins over cqw", () => {
    assert.equal(fontSizePx({ fontFamily: "x", px: 13, cqw: 9 }, 1920), 13);
  });

  test("a step with no size at all still yields something drawable", () => {
    assert.ok(fontSizePx({ fontFamily: "x" }, 1920) > 0);
  });
});
