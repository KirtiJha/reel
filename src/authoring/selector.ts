/**
 * Choosing the selector a captured step will be written with.
 *
 * This is the decision that determines whether a captured demo is still working
 * in six months. A selector that pins layout — `div > div:nth-child(3) > button`
 * — records where a button happened to be, not which button it was, and breaks
 * on the first refactor. One that names the thing the user actually clicked
 * survives, because the name is what the app promises its users.
 *
 * So the ranking is by *stability of meaning*, not by convenience: a test id is
 * a contract, an accessible name is a promise to users, a CSS path is neither.
 * The same vocabulary `reel heal` repairs into, for the obvious reason — a
 * captured spec should be repairable by the tool that ships with it.
 */

/** One way of naming an element, as observed in the page. */
export interface Candidate {
  kind: "testid" | "id" | "role" | "placeholder" | "label" | "text" | "css";
  selector: string;
  /** How many elements in the document this matches. Only 1 is usable. */
  matches: number;
}

/**
 * Preference order. Everything above `css` describes the element in the app's
 * own terms; `css` is what's left when nothing does.
 */
const RANK: Record<Candidate["kind"], number> = {
  testid: 0,
  id: 1,
  role: 2,
  label: 3,
  placeholder: 4,
  text: 5,
  css: 6,
};

/**
 * Ids and names that a framework generated rather than a person chose.
 *
 * `:r3:` (React useId), `mui-4821`, `headlessui-menu-button-7`, `radix-:r1a:`,
 * a bare hash. These are stable within a page load and worthless across one, so
 * a spec that pins them fails on the next run for no visible reason — the worst
 * possible failure to debug.
 */
const GENERATED =
  /(^:r[0-9a-z]+:$)|(^[0-9a-f]{8,}$)|(-[0-9a-f]{8,}$)|(^(mui|radix|headlessui|chakra|ember|ext-gen|yui)[-_:])|(:r[0-9a-z]+:)|(^[a-z]+-\d{4,}$)/i;

export function looksGenerated(value: string): boolean {
  if (!value) return true;
  if (GENERATED.test(value)) return true;
  // A long digit run in an otherwise readable name is usually a row id — the
  // demo would break as soon as the fixture data changes.
  if (/\d{6,}/.test(value)) return true;
  return value.split(/[-_]/).some(hashLike);
}

/**
 * A name segment that reads as a hash rather than a word.
 *
 * The shape emotion and styled-components produce — `css-1x2y3z4a` — where
 * digits are scattered through the segment rather than appended to a word.
 * `sha256`, `utf8` and `heading2` end in their digits and are names somebody
 * chose; the test is deliberately drawn to leave those alone, because rejecting
 * a good selector only costs a worse one while accepting a bad one costs a
 * demo that breaks on the next deploy.
 */
function hashLike(segment: string): boolean {
  if (segment.length < 6) return false;
  if (/^[A-Za-z]+\d+$/.test(segment)) return false; // heading2, sha256
  return (segment.match(/\d/g) ?? []).length >= 2 && /[A-Za-z]/.test(segment);
}

/**
 * The best available selector, or null when nothing identifies the element.
 *
 * Ambiguous candidates are discarded rather than disambiguated with an index:
 * `text=Delete` matching four rows is not "the first Delete", it is a selector
 * that will act on whichever one the layout puts first tomorrow.
 */
export function chooseSelector(candidates: Candidate[]): string | null {
  const usable = candidates
    .filter((c) => c.matches === 1 && c.selector.trim().length > 0)
    .filter(usableSelector)
    .sort((a, b) => RANK[a.kind] - RANK[b.kind]);
  return usable[0]?.selector ?? null;
}

/**
 * Reject the selectors that would look fine today and fail tomorrow.
 *
 * The page can only report what it sees; whether a name was chosen by a person
 * or minted by a framework is a judgement, and it belongs here where it can be
 * tested against the real shapes frameworks produce.
 */
function usableSelector(c: Candidate): boolean {
  if (c.kind === "id") return idSelector(c.selector.replace(/^#/, "")) !== null;
  if (c.kind === "testid" || c.kind === "placeholder") {
    const value = /=(?:"([^"]*)"|'([^']*)')\]$/.exec(c.selector);
    const inner = value?.[1] ?? value?.[2];
    return inner ? !looksGenerated(inner) : false;
  }
  if (c.kind === "text") return textSelector(c.selector.slice("text=".length)) !== null;
  if (c.kind === "role") {
    const name = /\[name=(?:"([^"]*)"|([^\]]*))\]/.exec(c.selector);
    const inner = name?.[1] ?? name?.[2];
    // A role with no name is a description of a shape, not of a thing — usable
    // only because uniqueness was already checked in the page.
    return inner ? inner.length <= MAX_TEXT_SELECTOR : true;
  }
  return true;
}

/** `role=button[name=Add]` — quoted only when the name needs it. */
export function roleSelector(role: string, name?: string): string {
  if (!name) return `role=${role}`;
  const needsQuotes = /[\s\]"']/.test(name);
  return `role=${role}[name=${needsQuotes ? JSON.stringify(name) : name}]`;
}

/**
 * Visible text is only a good selector when it is short.
 *
 * A whole paragraph identifies the element today and nothing tomorrow, and it
 * makes the spec unreadable — which matters, because the spec is the artifact a
 * person maintains.
 */
export const MAX_TEXT_SELECTOR = 40;

export function textSelector(text: string): string | null {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean || clean.length > MAX_TEXT_SELECTOR) return null;
  return `text=${clean}`;
}

/** `#id`, when the id reads like something a person wrote. */
export function idSelector(id: string): string | null {
  if (!id || looksGenerated(id)) return null;
  // An id that needs escaping is not worth the ambiguity it would introduce.
  return /^[A-Za-z][\w-]*$/.test(id) ? `#${id}` : null;
}

export function testIdSelector(attribute: string, value: string): string | null {
  if (!value || looksGenerated(value)) return null;
  return `[${attribute}=${JSON.stringify(value)}]`;
}
