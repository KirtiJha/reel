/**
 * The interactive player's CSS and JS, kept apart from the data so the markup
 * builder stays readable and this can be reasoned about as a program.
 *
 * Everything here ships inside a single self-contained file — no hosting, no
 * network, no fonts to fetch.
 */

export const PLAYER_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  :root {
    color-scheme: light dark;
    --bg: #f5f6f8;
    --fg: #14161c;
    --muted: rgba(20,22,28,.58);
    --line: rgba(20,22,28,.14);
    --panel: rgba(255,255,255,.72);
    --shadow: 0 20px 60px rgba(10,14,25,.16);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0d12;
      --fg: #f3f5fa;
      --muted: rgba(255,255,255,.56);
      --line: rgba(255,255,255,.14);
      --panel: rgba(255,255,255,.06);
      --shadow: 0 26px 70px rgba(0,0,0,.5);
    }
  }
  html, body { min-height: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    display: flex; flex-direction: column; align-items: center;
    padding: 20px 16px 24px; -webkit-font-smoothing: antialiased;
  }
  body.embed { padding: 0; background: transparent; }
  body.embed header, body.embed .bar { display: none; }

  .wrap { width: 100%; max-width: 1180px; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
  h1 { font-size: 15px; font-weight: 650; letter-spacing: -.01em; margin: 0; }
  .spacer { margin-left: auto; }

  .chapters { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip {
    border: 1px solid var(--line); background: var(--panel); color: var(--muted);
    border-radius: 999px; padding: 4px 11px; font: inherit; font-size: 12px;
    cursor: pointer; transition: background .18s, color .18s;
  }
  .chip:hover { color: var(--fg); }
  .chip[aria-current="true"] { background: var(--accent); border-color: var(--accent); color: #0b0d12; font-weight: 600; }

  /* flex: none is load-bearing — as a shrinkable flex item the stage gets
     shorter than the image it contains, and hotspot percentages (which resolve
     against the stage) drift upward from their targets. */
  .stage {
    position: relative; flex: none; width: 100%; cursor: pointer;
    border-radius: var(--radius); overflow: hidden; background: #000;
    box-shadow: var(--shadow), 0 0 0 1px var(--line); line-height: 0;
    touch-action: pan-y;
  }
  .stage:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
  .stage img { width: 100%; height: auto; display: block; }

  .hotspot {
    position: absolute; border-radius: 10px; pointer-events: none;
    outline: 2px solid var(--accent); outline-offset: 3px;
    box-shadow: 0 0 0 9999px rgba(6,8,14,.55);
    animation: breathe 1.9s ease-in-out infinite;
  }
  @keyframes breathe {
    0%, 100% { outline-color: var(--accent); opacity: 1; }
    50% { outline-color: rgba(255,255,255,.55); opacity: .82; }
  }
  .nudge {
    position: absolute; transform: translate(-50%,-50%);
    width: 26px; height: 26px; border-radius: 50%;
    background: var(--accent); pointer-events: none;
    animation: ping 1.9s cubic-bezier(0,0,.2,1) infinite;
  }
  @keyframes ping {
    0% { transform: translate(-50%,-50%) scale(.5); opacity: .85; }
    80%, 100% { transform: translate(-50%,-50%) scale(2.6); opacity: 0; }
  }

  .caption {
    position: absolute; left: 50%; bottom: 5%; transform: translateX(-50%);
    max-width: 82%; padding: 11px 20px; border-radius: 12px;
    background: rgba(15,15,20,.9); color: #fff;
    font-size: clamp(13px, 1.5vw, 18px); font-weight: 600;
    text-align: center; line-height: 1.35; pointer-events: none;
  }
  .caption:empty { display: none; }

  .bar { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
  button.ctl {
    border: 1px solid var(--line); background: var(--panel); color: var(--fg);
    border-radius: 10px; padding: 8px 13px; font: inherit; font-size: 13px;
    cursor: pointer; transition: background .18s;
  }
  button.ctl:hover:not(:disabled) { border-color: var(--accent); }
  button.ctl:disabled { opacity: .4; cursor: default; }
  button.ctl:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .track { flex: 1 1 180px; display: flex; gap: 4px; min-width: 120px; }
  .tick {
    flex: 1; height: 5px; border-radius: 3px; background: var(--line);
    padding: 0; border: 0; cursor: pointer; position: relative; overflow: hidden;
  }
  .tick[data-on="1"] { background: var(--accent); }
  .tick .fill {
    position: absolute; inset: 0; width: 0; background: var(--accent);
    transform-origin: left;
  }
  .meta { font-size: 12px; color: var(--muted); white-space: nowrap; }
  kbd {
    font: inherit; font-size: 11px; padding: 1px 5px; border-radius: 4px;
    border: 1px solid var(--line); background: var(--panel);
  }
  /* Branch choice */
  .choices {
    position: absolute; inset: auto 0 0 0; padding: 18px 16px 20px;
    background: linear-gradient(to top, rgba(8,10,16,.94), rgba(8,10,16,.72) 70%, transparent);
    line-height: 1.4; text-align: center;
  }
  .choice-prompt {
    margin: 0 0 10px; color: #fff; font-size: clamp(13px, 1.4vw, 17px); font-weight: 650;
  }
  .choice-row { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
  button.choice {
    border: 1px solid rgba(255,255,255,.26); background: rgba(255,255,255,.1);
    color: #fff; border-radius: 999px; padding: 8px 16px;
    font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    transition: background .18s, border-color .18s;
  }
  button.choice:hover { background: rgba(255,255,255,.2); }
  button.choice[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #0b0d12; }
  button.choice:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  .choices[hidden] { display: none; }

  .sr {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .hotspot, .nudge { animation: none; }
    .tick .fill { transition: none !important; }
  }
  @media (max-width: 680px) {
    .chapters, .meta { display: none; }
  }
`;

export const PLAYER_JS = String.raw`
const params = new URLSearchParams(location.search);
const EMBED = params.get('embed') === '1';
if (EMBED) document.body.classList.add('embed');

const el = (id) => document.getElementById(id);
const shot = el('shot'), hotspot = el('hotspot'), nudge = el('nudge');
const caption = el('caption'), track = el('track'), chapters = el('chapters');
const prev = el('prev'), next = el('next'), play = el('play');
const stage = el('stage'), live = el('live'), counter = el('counter');
const link = el('link');

/* ---- branching -------------------------------------------------------
   Scenes are stored flat; the running order is computed. Trunk scenes belong
   to no path, so the order is every path-less scene, with the chosen path's
   scenes spliced in at its choice point. Switching a choice re-splices — the
   viewer's route is always trunk → their path → continuation. */
const BRANCHES = DATA.branches || [];
const choice = {};             // branch id → chosen path id
BRANCHES.forEach((b) => {
  const def = b.paths.find((p) => p.isDefault) || b.paths[0];
  if (def) choice[b.id] = def.id;
});
const branchAt = new Map(BRANCHES.map((b) => [b.atScene, b]));

function order() {
  const out = [];
  DATA.scenes.forEach((s, n) => {
    if (s.path) return;        // path scenes are spliced in, never listed flat
    out.push(n);
    const b = branchAt.get(n);
    if (!b) return;
    const chosen = b.paths.find((p) => p.id === choice[b.id]);
    if (chosen) out.push(...chosen.scenes);
  });
  return out;
}

/** Which branch/path a scene belongs to, so a deep link can select it. */
function pathOf(sceneIndex) {
  const p = DATA.scenes[sceneIndex] && DATA.scenes[sceneIndex].path;
  if (!p) return null;
  for (const b of BRANCHES) {
    const hit = b.paths.find((x) => x.id === p);
    if (hit) return { branch: b, path: hit };
  }
  return null;
}

let ORDER = order();
let i = 0, timer = null, playing = false;

/** Position in the running order → scene index. */
function sceneAt(pos) { return ORDER[Math.max(0, Math.min(ORDER.length - 1, pos))]; }
function posOfScene(n) {
  const at = ORDER.indexOf(n);
  return at >= 0 ? at : 0;
}

/* ---- deep links ------------------------------------------------------
   Links address a SCENE, not a position, so they survive a viewer switching
   paths — and landing on a scene inside a path selects that path. */
function hashFor(pos) {
  const n = sceneAt(pos);
  const s = DATA.scenes[n];
  return s && s.slug ? '#/' + s.slug : '#/step-' + (n + 1);
}
function posFromHash() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (!h) return 0;
  let scene = DATA.scenes.findIndex((s) => s.slug === h);
  if (scene < 0) {
    const m = /^step-(\d+)$/.exec(h);
    if (!m) return 0;
    scene = Math.max(0, Math.min(DATA.scenes.length - 1, Number(m[1]) - 1));
  }
  const owner = pathOf(scene);
  if (owner && choice[owner.branch.id] !== owner.path.id) {
    choice[owner.branch.id] = owner.path.id;
    rebuild();
  }
  return posOfScene(scene);
}

/* ---- ticks and chapters --------------------------------------------- */
function buildTicks() {
  track.innerHTML = '';
  ORDER.forEach((n, pos) => {
    const s = DATA.scenes[n];
    const t = document.createElement('button');
    t.className = 'tick';
    t.type = 'button';
    t.setAttribute('aria-label', 'Go to step ' + (pos + 1) + (s.label ? ': ' + s.label : ''));
    t.innerHTML = '<span class="fill"></span>';
    t.addEventListener('click', (e) => { e.stopPropagation(); stop(); go(pos, true); });
    track.appendChild(t);
  });
}

let chapterAt = [];
function buildChapters() {
  chapters.innerHTML = '';
  chapterAt = [];
  ORDER.forEach((n, pos) => {
    const s = DATA.scenes[n];
    if (!s.chapter) return;
    chapterAt.push(pos);
    const c = document.createElement('button');
    c.className = 'chip';
    c.type = 'button';
    c.textContent = s.chapter;
    c.addEventListener('click', (e) => { e.stopPropagation(); stop(); go(pos, true); });
    chapters.appendChild(c);
  });
}

/* Re-splice the running order after a choice changes. */
function rebuild() {
  ORDER = order();
  buildTicks();
  buildChapters();
}

/* ---- branch choice UI ------------------------------------------------ */
function renderChoice(branch) {
  choices.innerHTML = '';
  if (!branch) { choices.hidden = true; return; }
  choices.hidden = false;
  const q = document.createElement('p');
  q.className = 'choice-prompt';
  q.textContent = branch.prompt;
  choices.appendChild(q);
  const row = document.createElement('div');
  row.className = 'choice-row';
  branch.paths.forEach((p) => {
    const b = document.createElement('button');
    b.className = 'choice';
    b.type = 'button';
    b.textContent = p.label;
    b.setAttribute('aria-pressed', String(choice[branch.id] === p.id));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      stop();
      const scene = sceneAt(i);
      choice[branch.id] = p.id;
      rebuild();
      // Stay on the choice scene, then step into the path just picked.
      go(posOfScene(scene), false);
      post({ type: 'reel:branch', branch: branch.id, path: p.id, label: p.label });
      go(i + 1, true);
    });
    row.appendChild(b);
  });
  choices.appendChild(row);
}

/* ---- rendering ------------------------------------------------------- */
function preload(pos) {
  const n = ORDER[pos];
  if (n === undefined) return;
  const img = new Image();
  img.src = IMAGES[DATA.scenes[n].image];
}

function go(pos, pushHash) {
  i = Math.max(0, Math.min(ORDER.length - 1, pos));
  const n = sceneAt(i);
  const s = DATA.scenes[n];
  shot.src = IMAGES[s.image];
  shot.alt = s.label ? s.label : 'Step ' + (i + 1) + ' of ' + ORDER.length;
  caption.textContent = s.caption || '';

  renderChoice(s.branch ? branchAt.get(n) : null);

  if (s.hotspot) {
    const h = s.hotspot;
    hotspot.hidden = false; nudge.hidden = false;
    hotspot.style.left = (h.x * 100) + '%';
    hotspot.style.top = (h.y * 100) + '%';
    hotspot.style.width = (h.w * 100) + '%';
    hotspot.style.height = (h.h * 100) + '%';
    nudge.style.left = ((h.x + h.w / 2) * 100) + '%';
    nudge.style.top = ((h.y + h.h / 2) * 100) + '%';
  } else {
    hotspot.hidden = true; nudge.hidden = true;
  }

  [...track.children].forEach((t, n2) => {
    t.dataset.on = n2 < i ? '1' : '0';
    const fill = t.firstElementChild;
    fill.style.transition = 'none';
    fill.style.width = n2 < i ? '100%' : '0%';
  });
  [...chapters.children].forEach((c, n2) => {
    const start = chapterAt[n2];
    const end = chapterAt[n2 + 1] ?? ORDER.length;
    c.setAttribute('aria-current', String(i >= start && i < end));
  });

  prev.disabled = i === 0;
  next.textContent = i === ORDER.length - 1 ? 'Restart' : 'Next ›';
  counter.textContent = (i + 1) + ' / ' + ORDER.length;
  live.textContent = 'Step ' + (i + 1) + ' of ' + ORDER.length + (s.label ? '. ' + s.label : '');

  if (pushHash) {
    const h = hashFor(i);
    if (location.hash !== h) history.pushState(null, '', h);
  }
  preload(i + 1);
  post({
    type: 'reel:scene',
    index: i,
    scene: n,
    total: ORDER.length,
    label: s.label || null,
    chapter: s.chapter || null,
    path: s.path || null,
  });
  if (playing) schedule();
}

/* ---- playback -------------------------------------------------------- */
/* Paced by the durations actually recorded, so the click-through breathes the
   way the video does instead of marching at a fixed interval. */
function schedule() {
  clearTimeout(timer);
  const s = DATA.scenes[sceneAt(i)];
  // A choice is a question: autoplay stops rather than answering it for them.
  if (s.branch) { stop(); return; }
  const ms = Math.max(600, s.ms || 2000);
  const fill = track.children[i] && track.children[i].firstElementChild;
  if (fill) {
    fill.style.transition = 'none';
    fill.style.width = '0%';
    void fill.offsetWidth;
    fill.style.transition = 'width ' + ms + 'ms linear';
    fill.style.width = '100%';
  }
  timer = setTimeout(() => {
    if (i === ORDER.length - 1) { stop(); return; }
    go(i + 1, true);
  }, ms);
}
function stop() {
  clearTimeout(timer); timer = null; playing = false;
  play.textContent = '▶ Play';
  play.setAttribute('aria-label', 'Play the demo');
  const fill = track.children[i] && track.children[i].firstElementChild;
  if (fill) { fill.style.transition = 'none'; fill.style.width = '0%'; }
  post({ type: 'reel:pause', index: i });
}
function start() {
  if (i === ORDER.length - 1) go(0, true);
  playing = true;
  play.textContent = '❚❚ Pause';
  play.setAttribute('aria-label', 'Pause the demo');
  schedule();
  post({ type: 'reel:play', index: i });
}
function toggle() { playing ? stop() : start(); }
function advance() { stop(); go(i === ORDER.length - 1 ? 0 : i + 1, true); }

/* ---- host page API --------------------------------------------------- */
/* An embedded demo can report progress to the page around it, and be driven
   by it — enough to sync a tour with surrounding copy. */
function post(msg) {
  if (window.parent !== window) window.parent.postMessage(msg, '*');
}
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || typeof d !== 'object') return;
  if (d.type === 'reel:go' && Number.isInteger(d.index)) { stop(); go(d.index, true); }
  else if (d.type === 'reel:play') start();
  else if (d.type === 'reel:pause') stop();
  else if (d.type === 'reel:choose' && d.branch && d.path) {
    if (choice[d.branch] === undefined) return;
    stop();
    choice[d.branch] = d.path;
    rebuild();
    go(i, true);
  }
});

/* ---- input ----------------------------------------------------------- */
stage.addEventListener('click', advance);
stage.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); advance(); }
});
next.addEventListener('click', (e) => { e.stopPropagation(); advance(); });
prev.addEventListener('click', (e) => { e.stopPropagation(); stop(); go(i - 1, true); });
play.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });

if (link) {
  link.addEventListener('click', async (e) => {
    e.stopPropagation();
    const url = location.origin + location.pathname + location.search + hashFor(i);
    try { await navigator.clipboard.writeText(url); link.textContent = 'Copied'; }
    catch { link.textContent = 'Copy failed'; }
    setTimeout(() => { link.textContent = 'Copy link'; }, 1600);
  });
}

window.addEventListener('keydown', (e) => {
  if (e.target !== document.body && e.target !== stage) return;
  if (e.key === 'ArrowRight') { stop(); go(i + 1, true); }
  else if (e.key === 'ArrowLeft') { stop(); go(i - 1, true); }
  else if (e.key === 'Home') { stop(); go(0, true); }
  else if (e.key === 'End') { stop(); go(ORDER.length - 1, true); }
  else if (e.key === ' ') { e.preventDefault(); toggle(); }
});

// Swipe, so the click-through works on a phone.
let touchX = null;
stage.addEventListener('touchstart', (e) => { touchX = e.changedTouches[0].clientX; }, { passive: true });
stage.addEventListener('touchend', (e) => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) < 40) return;
  stop();
  go(dx < 0 ? i + 1 : i - 1, true);
}, { passive: true });

window.addEventListener('popstate', () => go(posFromHash(), false));
window.addEventListener('hashchange', () => go(posFromHash(), false));

/* A same-origin host page (or a test) can drive the player directly, without
   going through postMessage. */
window.reelDemo = {
  scenes: DATA.scenes,
  branches: BRANCHES,
  get total() { return ORDER.length; },
  get index() { return i; },
  get scene() { return sceneAt(i); },
  get choices() { return { ...choice }; },
  choose(branchId, pathId) { stop(); choice[branchId] = pathId; rebuild(); go(i, true); },
  go(n) { stop(); go(n, true); },
  play: start,
  pause: stop,
};

rebuild();
go(posFromHash(), false);
`;
