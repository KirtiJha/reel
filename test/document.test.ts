import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildDocumentHtml, jsonForScript, type Timeline } from "../src/encode/document.js";

function timeline(over: Partial<Timeline> = {}): Timeline {
  return {
    durationMs: 10_000,
    viewport: { w: 1280, h: 800 },
    accent: "#6d8bff",
    background: "#0b0b0f",
    frames: [{ t: 0, i: 0 }, { t: 4000, i: 1 }],
    camera: [{ t: 0, rect: { x: 0, y: 0, w: 1280, h: 800 } }],
    transitionMs: 480,
    captions: [{ t: 0, text: "Hello", position: "bottom" }],
    highlights: [],
    fades: [],
    beats: [{ label: "hero", t: 0 }],
    ...over,
  };
}

const IMG = ["data:image/webp;base64,AAAA", "data:image/webp;base64,BBBB"];

describe("jsonForScript", () => {
  test("neutralises a closing script tag", () => {
    // A caption is author text. `</script>` inside a string literal ends the
    // element regardless of JSON quoting, so the document would simply break.
    const out = jsonForScript({ text: "</script><img src=x onerror=alert(1)>" });
    assert.ok(!out.includes("</script>"));
    assert.ok(out.includes("\\u003c"));
  });

  test("escapes the separators that are line breaks in JavaScript", () => {
    // U+2028 and U+2029 are legal in JSON and are line terminators in JS
    // source, so an unescaped one is a syntax error in the embedded script.
    const out = jsonForScript({ text: "a b c" });
    assert.ok(!out.includes(" "));
    assert.ok(!out.includes(" "));
    assert.ok(out.includes("\\u2028") && out.includes("\\u2029"));
  });

  test("still parses back to the same value", () => {
    const value = { text: "a</script>b c", n: 4 };
    // The player parses this with JSON.parse, so the escaping has to survive it.
    assert.deepEqual(JSON.parse(jsonForScript(value)), value);
  });
});

describe("buildDocumentHtml", () => {
  test("is self-contained — nothing is fetched at read time", () => {
    const html = buildDocumentHtml("Demo", timeline(), IMG, "");
    // Same rule the renderer keeps: a document that pulled a font or a script
    // would put someone's uptime between a spec and what a reader sees.
    assert.ok(!/<(script|link|img)[^>]+(src|href)="(?!data:)/.test(html), "loads something remote");
  });

  test("carries the timeline as data, not as baked pixels", () => {
    const html = buildDocumentHtml("Demo", timeline(), IMG, "");
    const m = /<script id="timeline"[^>]*>(.*?)<\/script>/s.exec(html)!;
    const parsed = JSON.parse(m[1]!) as Timeline;
    assert.equal(parsed.durationMs, 10_000);
    assert.equal(parsed.captions[0]!.text, "Hello");
    assert.deepEqual(parsed.camera[0]!.rect, { x: 0, y: 0, w: 1280, h: 800 });
  });

  test("caption text survives into the document as text", () => {
    // The whole point: the words stay words, so they can be selected, indexed,
    // translated and read aloud.
    const html = buildDocumentHtml("Demo", timeline({
      captions: [{ t: 0, text: "Byte-identical, every time", position: "bottom" }],
    }), IMG, "");
    assert.ok(html.includes("Byte-identical, every time"));
  });

  test("a hostile caption cannot break out of the data block", () => {
    const html = buildDocumentHtml("Demo", timeline({
      captions: [{ t: 0, text: "</script><script>alert(1)</script>", position: "bottom" }],
    }), IMG, "");
    // Exactly three scripts: timeline, images, player. A fourth means the data
    // block was escaped from.
    assert.equal(html.match(/<script/g)!.length, 3);
  });

  test("the demo name is escaped in the title", () => {
    const html = buildDocumentHtml('A <b>bold</b> "demo"', timeline(), IMG, "");
    assert.ok(!html.includes("<b>bold</b>"));
    assert.ok(html.includes("&lt;b&gt;bold&lt;/b&gt;"));
  });

  test("the audio element appears only when there is narration", () => {
    assert.ok(!buildDocumentHtml("D", timeline(), IMG, "").includes('id="audio"'));
    assert.ok(buildDocumentHtml("D", timeline(), IMG, "data:audio/mp4;base64,AA").includes('id="audio"'));
  });

  test("annotations are drawn inside the camera, not beside it", () => {
    // A mark sits in the same transformed space as the frame, or it drifts away
    // from the thing it marks the moment the camera moves.
    const html = buildDocumentHtml("D", timeline(), IMG, "");
    const shot = html.indexOf('id="shot"');
    const marks = html.indexOf('id="marks"');
    const shotEnd = html.indexOf("</div>", shot);
    assert.ok(marks > shot && marks < shotEnd, "#marks is not inside #shot");
  });

  test("a mark keeps its stroke weight as the camera pushes in", () => {
    assert.ok(buildDocumentHtml("D", timeline(), IMG, "").includes("non-scaling-stroke"));
  });

  test("the camera scales against the stage, not the viewport", () => {
    // Against the viewport the scale is 1 at full frame, which leaves the shot
    // at its authored pixel size inside a stage that is usually smaller.
    assert.ok(buildDocumentHtml("D", timeline(), IMG, "").includes("stage.clientWidth / c.w"));
  });
});
