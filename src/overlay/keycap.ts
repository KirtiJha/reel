/**
 * Turning a Playwright key string into caps a viewer can read.
 *
 * A spec writes keys the way the driver needs them — `Meta+K`, `Escape`,
 * `ArrowDown` — because that is what Playwright presses. None of those are what
 * is printed on a keyboard, and a demo that flashed the literal string
 * `Control+Shift+P` on screen would be showing the viewer an API, not a
 * shortcut.
 *
 * So this is a translation, and it is deliberately a pure one: the same key
 * string always produces the same caps, with no lookup at draw time and nothing
 * to measure. The overlay renders whatever comes back, in order.
 *
 * ## Choosing between a symbol and a word
 *
 * A symbol only helps where it is actually printed on the key. `⌘` and `⇧` are;
 * `⌃` is a Mac convention that most people read as "a caret", and `⌥` says Alt
 * on the majority of keyboards in the world. So modifiers split: the two that
 * are universally engraved render as glyphs, the rest render as the short word
 * that appears on the keycap. The same rule settles the arrows (engraved) and
 * `Esc`/`Del`/`PgUp` (abbreviated, because that is how they are printed).
 */

/**
 * What each named key is called on a keyboard. Keyed lowercase so the aliases
 * Playwright accepts — `Meta`, `OS`, `Cmd` — all land on the same cap.
 */
const NAMED: Record<string, string> = {
  // Modifiers.
  meta: "⌘",
  command: "⌘",
  cmd: "⌘",
  os: "⌘",
  super: "⌘",
  control: "Ctrl",
  ctrl: "Ctrl",
  shift: "⇧",
  alt: "Alt",
  option: "Alt",
  altgraph: "AltGr",
  // Named keys.
  escape: "Esc",
  esc: "Esc",
  enter: "Enter",
  return: "Enter",
  numpadenter: "Enter",
  tab: "Tab",
  backspace: "⌫",
  delete: "Del",
  del: "Del",
  space: "Space",
  " ": "Space",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  pageup: "PgUp",
  pagedown: "PgDn",
  home: "Home",
  end: "End",
  insert: "Ins",
  capslock: "Caps",
};

/** The caps that modify another key, in the order a shortcut is written. */
const MODIFIERS = ["Ctrl", "Alt", "AltGr", "⇧", "⌘"];

/**
 * The caps for one key or chord: `Meta+K` → `["⌘", "K"]`.
 *
 * Modifiers are sorted into the conventional order and de-duplicated, so
 * `Shift+Meta+P` and `Meta+Shift+P` — the same chord, written two ways — draw
 * the same three caps. Everything else keeps the order it was written in.
 */
export function keyCaps(key: string): string[] {
  const caps = splitCombo(key).map(capFor).filter((c) => c.length > 0);
  const mods = [...new Set(caps.filter(isModifier))].sort(
    (a, b) => MODIFIERS.indexOf(a) - MODIFIERS.indexOf(b),
  );
  return [...mods, ...caps.filter((c) => !isModifier(c))];
}

function isModifier(cap: string): boolean {
  return MODIFIERS.includes(cap);
}

/**
 * Split a chord on `+` without eating a literal plus.
 *
 * `Control++` is Playwright for control-and-the-plus-key. Splitting naively
 * gives an empty third part and the demo shows `Ctrl` pressed with nothing,
 * which is exactly the kind of quietly-wrong output this project exists to
 * avoid. A separator only separates when there is something before it.
 */
function splitCombo(key: string): string[] {
  const parts: string[] = [];
  let buf = "";
  for (const ch of key) {
    if (ch === "+" && buf.length > 0) {
      parts.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

/** One key's cap. Unknown names are drawn as written rather than dropped. */
function capFor(raw: string): string {
  const key = raw.trim() === "" ? raw : raw.trim();
  const named = NAMED[key.toLowerCase()];
  if (named) return named;

  // The physical-key spellings: `KeyA`, `Digit1`, `Numpad7`.
  const physical = /^(?:Key([A-Za-z])|Digit(\d)|Numpad(\d))$/.exec(key);
  if (physical) return (physical[1] ?? physical[2] ?? physical[3]!).toUpperCase();

  // Function keys keep their number but not their casing.
  if (/^f\d{1,2}$/i.test(key)) return key.toUpperCase();

  // A single character is a keycap: they are engraved in upper case, and
  // `press: { key: k }` and `press: { key: K }` are the same key — the second
  // is that key with Shift, which is already drawn as its own cap.
  if ([...key].length === 1) return key.toUpperCase();

  return key;
}
