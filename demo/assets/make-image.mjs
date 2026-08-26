// The picture `whats-new.reel.yaml` composites over the app.
//
// Generated rather than drawn, for the same reason the music bed is: nothing to
// license, nothing to fetch, and it regenerates identically.
//
//   node demo/assets/make-image.mjs
import sharp from "sharp";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "whats-new.png");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="420">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#101a33"/>
      <stop offset="100%" stop-color="#0a0f1e"/>
    </linearGradient>
  </defs>
  <rect width="720" height="420" rx="22" fill="url(#bg)"/>
  <rect x="1" y="1" width="718" height="418" rx="22" fill="none" stroke="#2b3a67" stroke-width="2"/>
  <text x="48" y="92" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="34" font-weight="700" fill="#eaf0ff">One recording</text>
  <text x="48" y="134" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="20" fill="#8ea3c8">every format your channels need</text>
  ${[
    ["MP4", "for social and docs", "#7cf3c4"],
    ["GIF", "for a README", "#6d8bff"],
    ["Click-through", "one self-contained page", "#f0a5ff"],
  ]
    .map(
      ([title, sub, colour], i) => `
  <g transform="translate(48, ${190 + i * 68})">
    <rect width="624" height="54" rx="12" fill="#16203c"/>
    <rect width="5" height="54" rx="3" fill="${colour}"/>
    <text x="26" y="26" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="20" font-weight="600" fill="#eaf0ff">${title}</text>
    <text x="26" y="45" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="15" fill="#8ea3c8">${sub}</text>
  </g>`,
    )
    .join("")}
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(out);
console.log(`wrote ${out}`);
