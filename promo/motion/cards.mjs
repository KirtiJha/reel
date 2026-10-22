// The promo's motion graphics: animated typography, drawn as a real page.
//
// Every animated property is a pure function of `t` and nothing uses CSS
// animation or requestAnimationFrame. A renderer that samples a real-time
// animation gets a different film on every run; one that samples a function
// gets the same film forever. `render.mjs` steps `window.setT(seconds)` and
// screenshots.
//
// The look is the look of Reel's own site — Inter Display, JetBrains Mono,
// near-black with mint and violet — so the cards and the captures read as one
// piece rather than as titles bolted onto footage.

const MINT = "#7cf3c4";
const PERI = "#8aa2ff";
const VIOLET = "#b78cff";
const CORAL = "#ff9d7c";

/** Clamp to 0..1. */
const C = "const c=(x)=>x<0?0:x>1?1:x;";
/** Easings. Expo-out for entrances, cubic-in-out for drifts. */
const EASE = `
const outExpo=(x)=>x>=1?1:1-Math.pow(2,-10*x);
const outCubic=(x)=>1-Math.pow(1-x,3);
const inCubic=(x)=>x*x*x;
const inOut=(x)=>x<0.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2;
const seg=(t,a,d)=>c((t-a)/d);
`;

/**
 * The page every card is built on.
 *
 * The background is two slow-drifting radial fields and a fine grid, which is
 * what stops a full-screen title from reading as a flat colour — on a 1080p
 * upload a static dark frame looks like a dropout.
 */
function shell({ body, css = "", script, accent = MINT }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1920px; height: 1080px; overflow: hidden; background: #06080d; }
  body {
    font-family: "Inter Display", Inter, system-ui, sans-serif;
    color: #eef2f8;
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
  }
  #stage { position: absolute; inset: 0; }
  .field {
    position: absolute; border-radius: 50%;
    filter: blur(90px); will-change: transform, opacity;
  }
  #f1 { width: 1500px; height: 1100px; background: ${accent}; opacity: .11; }
  #f2 { width: 1200px; height: 950px; background: ${VIOLET}; opacity: .10; }
  #grid {
    position: absolute; inset: -10%;
    background-image:
      linear-gradient(to right, rgba(255,255,255,.055) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(255,255,255,.055) 1px, transparent 1px);
    background-size: 78px 78px;
    mask-image: radial-gradient(ellipse 72% 62% at 50% 48%, #000 25%, transparent 78%);
  }
  #vig {
    position: absolute; inset: 0; pointer-events: none;
    background: radial-gradient(ellipse 85% 75% at 50% 50%, transparent 42%, rgba(0,0,0,.72) 100%);
  }
  #content { position: absolute; inset: 0; display: grid; place-items: center; }
  .wrap { text-align: center; width: 1500px; will-change: transform, opacity, filter; }
  .eyebrow {
    font-size: 28px; font-weight: 650; letter-spacing: .34em; text-transform: uppercase;
    color: ${accent}; margin-bottom: 40px; will-change: transform, opacity;
  }
  .line { display: block; overflow: hidden; padding-bottom: .1em; }
  .w {
    display: inline-block; will-change: transform, opacity, filter;
    font-family: "Inter Display", Inter, sans-serif;
    font-weight: 800; letter-spacing: -.035em; line-height: 1.02;
  }
  .sub {
    margin-top: 56px; font-size: 40px; font-weight: 450; line-height: 1.45;
    color: #9fb0c8; letter-spacing: -.012em; will-change: transform, opacity;
  }
  .rule {
    height: 3px; margin: 54px auto 0; border-radius: 3px;
    background: linear-gradient(90deg, transparent, ${accent}, ${PERI}, transparent);
    will-change: transform, opacity;
  }
${css}
</style></head>
<body><div id="stage">
  <div class="field" id="f1"></div>
  <div class="field" id="f2"></div>
  <div id="grid"></div>
  <div id="content">${body}</div>
  <div id="vig"></div>
</div>
<script>
${C}${EASE}
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
function bg(t){
  // Slow counter-drifting fields. The periods are deliberately coprime so the
  // pair never visibly repeats inside a card's few seconds.
  const a = t / 7.3, b = t / 9.1;
  $('#f1').style.transform = 'translate(' + (150 + Math.sin(a) * 120) + 'px,' + (-120 + Math.cos(a * .8) * 90) + 'px)';
  $('#f2').style.transform = 'translate(' + (1020 + Math.cos(b) * 140) + 'px,' + (520 + Math.sin(b * .9) * 100) + 'px)';
  $('#grid').style.transform = 'translate(' + (-t * 7) + 'px,' + (-t * 4) + 'px)';
}
${script}
window.setT = (t) => { bg(t); frame(t); };
window.setT(0);
</script></body></html>`;
}

/**
 * A word-by-word rise, which is the house move for every statement card.
 *
 * Words come up through a mask with a little blur that resolves, staggered by
 * index. The stagger is what makes a line read as spoken rather than as a
 * slide transition — all eight words arriving together is a PowerPoint.
 */
function kineticScript({ hold, out = 0.55, exitScale = 1.06 }) {
  return `
const words = $$('.w');
const DELAY = 0.052, RISE = 0.72;
function frame(t){
  words.forEach((w, i) => {
    const p = outExpo(seg(t, 0.12 + i * DELAY, RISE));
    w.style.transform = 'translateY(' + ((1 - p) * 112) + 'px)';
    w.style.opacity = String(Math.min(1, p * 1.5));
    w.style.filter = 'blur(' + ((1 - p) * 11) + 'px)';
  });
  const eb = $('.eyebrow');
  if (eb) {
    const p = outExpo(seg(t, 0, 0.6));
    eb.style.opacity = String(p);
    eb.style.transform = 'translateY(' + ((1 - p) * 22) + 'px)';
  }
  const rule = $('.rule');
  if (rule) {
    const p = outExpo(seg(t, 0.42, 0.85));
    rule.style.width = (p * 520) + 'px';
    rule.style.opacity = String(p);
  }
  const sub = $('.sub');
  if (sub) {
    const p = outExpo(seg(t, 0.62, 0.8));
    sub.style.opacity = String(p);
    sub.style.transform = 'translateY(' + ((1 - p) * 28) + 'px)';
  }
  // The exit is a push through the lens rather than a fade: the cut that
  // follows lands on footage, and scaling out of a title into a screen
  // capture reads as moving forward instead of as a slideshow advancing.
  const e = inCubic(seg(t, ${hold}, ${out}));
  const wrap = $('.wrap');
  wrap.style.transform = 'scale(' + (1 + e * ${exitScale - 1}) + ')';
  wrap.style.opacity = String(1 - e);
  wrap.style.filter = 'blur(' + (e * 16) + 'px)';
}`;
}

/** Markup for a headline, split into per-word spans. */
function lines(ls, size) {
  return ls
    .map(
      (l) =>
        `<span class="line">${l
          .split(" ")
          .map((w) => `<span class="w" style="font-size:${size}px">${w}&nbsp;</span>`)
          .join("")}</span>`,
    )
    .join("");
}

function statement({ eyebrow, head, sub, size = 168, accent = MINT, seconds = 3.2, rule = true }) {
  const hold = seconds - 0.62;
  return {
    seconds,
    accent,
    html: shell({
      accent,
      body: `<div class="wrap">
        ${eyebrow ? `<div class="eyebrow">${eyebrow}</div>` : ""}
        <div class="head">${lines(head, size)}</div>
        ${rule ? `<div class="rule"></div>` : ""}
        ${sub ? `<div class="sub">${sub}</div>` : ""}
      </div>`,
      script: kineticScript({ hold }),
    }),
  };
}

/* ------------------------------------------------------------------ cards */

export const CARDS = {
  opener: {
    seconds: 4.6,
    accent: MINT,
    html: shell({
      accent: MINT,
      css: `
  .mark { display:flex; align-items:center; justify-content:center; gap:30px; margin-bottom: 18px; }
  .glyph {
    width: 156px; height: 156px; border-radius: 38px;
    background: linear-gradient(145deg, ${MINT}, ${PERI} 55%, ${VIOLET});
    display:grid; place-items:center; will-change: transform, opacity;
    box-shadow: 0 24px 90px rgba(124,243,196,.30);
  }
  .glyph svg { width: 80px; height: 80px; }
  .word {
    font-size: 246px; font-weight: 850; letter-spacing: -.055em;
    background: linear-gradient(100deg, #ffffff 18%, ${MINT} 52%, ${PERI} 86%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
    will-change: transform, opacity;
  }
  .tag { font-size: 46px; font-weight: 500; color: #a7b6cc; letter-spacing: -.016em; }`,
      body: `<div class="wrap">
        <div class="mark">
          <div class="glyph"><svg viewBox="0 0 24 24" fill="none"><path d="M8 5.5v13l11-6.5-11-6.5z" fill="#06080d"/></svg></div>
          <div class="word">Reel</div>
        </div>
        <div class="rule"></div>
        <div class="sub tag">Demos as code — for web apps and CLIs</div>
      </div>`,
      script: `
const glyph=$('.glyph'), word=$('.word'), rule=$('.rule'), sub=$('.sub'), wrap=$('.wrap');
function frame(t){
  const g = outExpo(seg(t, 0.05, 0.9));
  glyph.style.transform = 'scale(' + (0.55 + g * 0.45) + ') rotate(' + ((1 - g) * -22) + 'deg)';
  glyph.style.opacity = String(g);
  const w = outExpo(seg(t, 0.26, 0.95));
  word.style.transform = 'translateX(' + ((1 - w) * -70) + 'px)';
  word.style.opacity = String(w);
  word.style.filter = 'blur(' + ((1 - w) * 14) + 'px)';
  const r = outExpo(seg(t, 0.8, 0.9));
  rule.style.width = (r * 700) + 'px'; rule.style.opacity = String(r);
  const s = outExpo(seg(t, 1.0, 0.9));
  sub.style.opacity = String(s); sub.style.transform = 'translateY(' + ((1 - s) * 26) + 'px)';
  const e = inCubic(seg(t, 3.95, 0.62));
  wrap.style.transform = 'scale(' + (1 + e * 0.1) + ')';
  wrap.style.opacity = String(1 - e);
  wrap.style.filter = 'blur(' + (e * 18) + 'px)';
}`,
    }),
  },

  written: statement({
    eyebrow: "Nobody recorded that",
    head: ["It was written down,", "then run."],
    size: 158,
    accent: MINT,
    seconds: 3.4,
  }),

  formats: statement({
    eyebrow: "One recording",
    head: ["One spec.", "Every format."],
    sub: "GIF · MP4 · WebM · storyboard · interactive",
    size: 176,
    accent: PERI,
    seconds: 3.4,
  }),

  sound: statement({
    eyebrow: "Narration · music · sound design",
    head: ["And it talks —", "in any language."],
    size: 148,
    accent: VIOLET,
    seconds: 3.3,
  }),

  interactive: statement({
    eyebrow: "The format a GIF can't be",
    head: ["One file.", "The viewer drives."],
    size: 158,
    accent: VIOLET,
    seconds: 3.3,
  }),

  ci: statement({
    eyebrow: "When the app moves on",
    head: ["It fails", "your build."],
    sub: "Not a GIF that quietly goes wrong",
    size: 184,
    accent: CORAL,
    seconds: 3.5,
  }),

  bytes: statement({
    eyebrow: "Run it again",
    head: ["Same spec.", "Same bytes."],
    sub: "So a diff means the app changed — not the renderer",
    size: 176,
    accent: MINT,
    seconds: 3.5,
  }),

  studio: statement({
    eyebrow: "Or skip the terminal",
    head: ["A workspace", "for your demos."],
    size: 148,
    accent: MINT,
    seconds: 3.1,
  }),

  endcard: {
    seconds: 5.4,
    accent: MINT,
    html: shell({
      accent: MINT,
      css: `
  .mark { display:flex; align-items:center; justify-content:center; gap:26px; margin-bottom: 44px; }
  .glyph {
    width: 120px; height: 120px; border-radius: 30px;
    background: linear-gradient(145deg, ${MINT}, ${PERI} 55%, ${VIOLET});
    display:grid; place-items:center; box-shadow: 0 20px 70px rgba(124,243,196,.28);
  }
  .glyph svg { width: 62px; height: 62px; }
  .word { font-size: 158px; font-weight: 850; letter-spacing: -.05em; color: #fff; }
  .cmd {
    display:inline-flex; align-items:center; gap: 20px;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 50px; font-weight: 500; color: #dfe8f4;
    background: rgba(255,255,255,.055); border: 1px solid rgba(255,255,255,.14);
    border-radius: 18px; padding: 26px 42px; will-change: transform, opacity;
  }
  .cmd .d { color: ${MINT}; }
  .url { margin-top: 50px; font-size: 38px; color: #93a4bd; letter-spacing: -.01em; }
  .pills { margin-top: 40px; display:flex; gap: 16px; justify-content:center; }
  .pill {
    font-size: 26px; font-weight: 600; color: #b9c7dc; letter-spacing: .02em;
    border: 1px solid rgba(255,255,255,.16); border-radius: 999px; padding: 12px 26px;
    will-change: transform, opacity;
  }`,
      body: `<div class="wrap">
        <div class="mark">
          <div class="glyph"><svg viewBox="0 0 24 24" fill="none"><path d="M8 5.5v13l11-6.5-11-6.5z" fill="#06080d"/></svg></div>
          <div class="word">Reel</div>
        </div>
        <div class="cmd"><span class="d">$</span><span>npx @kirti_jha/reel init</span></div>
        <div class="url">github.com/KirtiJha/reel</div>
        <div class="pills">
          <span class="pill">MIT licensed</span>
          <span class="pill">Runs locally and in CI</span>
          <span class="pill">No API key needed</span>
        </div>
      </div>`,
      script: `
const mark=$('.mark'), cmd=$('.cmd'), url=$('.url'), pills=$$('.pill'), wrap=$('.wrap');
function frame(t){
  const m = outExpo(seg(t, 0.08, 0.9));
  mark.style.opacity = String(m);
  mark.style.transform = 'translateY(' + ((1 - m) * 44) + 'px) scale(' + (0.94 + m * 0.06) + ')';
  const c1 = outExpo(seg(t, 0.62, 0.85));
  cmd.style.opacity = String(c1);
  cmd.style.transform = 'translateY(' + ((1 - c1) * 34) + 'px)';
  const u = outExpo(seg(t, 0.95, 0.8));
  url.style.opacity = String(u);
  url.style.transform = 'translateY(' + ((1 - u) * 24) + 'px)';
  pills.forEach((p, i) => {
    const q = outExpo(seg(t, 1.2 + i * 0.09, 0.7));
    p.style.opacity = String(q);
    p.style.transform = 'translateY(' + ((1 - q) * 20) + 'px)';
  });
  // The end card fades rather than pushing — nothing follows it.
  const e = outCubic(seg(t, 4.5, 0.9));
  wrap.style.opacity = String(1 - e);
  $('#stage').style.opacity = String(1 - e * 0.98);
}`,
    }),
  },
};

export function card(name) {
  const c = CARDS[name];
  if (!c) throw new Error(`unknown card: ${name}`);
  return c.html;
}
