import type { StepInput } from "../spec/schema.js";
import { chooseSelector, looksGenerated, type Candidate } from "./selector.js";
import type { ObservedEvent } from "./observe.js";

/**
 * Turning what somebody did into a spec they'd have written.
 *
 * A literal transcript of DOM events is not a demo. Clicking into a field
 * before typing is one intention, not two; typing "hello" is one step, not
 * five; and the click that submits a form is worth recording while the click
 * that dismissed a tooltip is not. This is where the recording becomes
 * something a person would be willing to maintain.
 *
 * Pure, so every one of those judgements is testable without a browser.
 */

/** A navigation observed by the driver rather than by the page. */
export interface NavigationEvent {
  type: "nav";
  url: string;
}

export type CaptureEvent = (ObservedEvent & { type: Exclude<ObservedEvent["type"], never> }) | NavigationEvent;

export interface CaptureResult {
  steps: StepInput[];
  /** Things that happened but couldn't be written down, and why. */
  skipped: string[];
}

export function toSteps(events: CaptureEvent[], baseUrl: string): CaptureResult {
  const steps: StepInput[] = [];
  const skipped: string[] = [];

  // Typing is accumulated and only committed when something else happens, so a
  // field filled character by character lands as the one step it was.
  let typing: { selector: string; value: string } | null = null;
  const flush = (): void => {
    if (!typing) return;
    if (typing.value) steps.push({ type: { selector: typing.selector, text: typing.value } });
    typing = null;
  };

  // A navigation only means something once the user has done something to cause
  // it. Before that it is the app routing itself — a single-page app commonly
  // boots through two or three URLs (`/` → `/dashboard` → `/setup`) before it
  // settles, and recording those as waits opens the draft with waits for pages
  // the demo has not navigated to yet.
  let acted = false;
  // Held rather than emitted, because one action often causes a chain of
  // redirects and only where it came to rest is worth waiting for.
  let pendingNav: string | null = null;
  const settle = (): void => {
    if (pendingNav && lastStep(steps) !== `waitForUrl:${pendingNav}`) {
      steps.push({ waitForUrl: pendingNav });
    }
    pendingNav = null;
  };

  for (const event of events) {
    if (event.type === "nav") {
      flush();
      if (!acted) continue;
      pendingNav = relativeUrl(event.url, baseUrl);
      continue;
    }

    if (event.type === "finish") break;

    // Anything the user does closes off the navigation the last one caused.
    settle();

    if (event.type === "caption") {
      flush();
      if (event.text) steps.push({ caption: event.text });
      continue;
    }

    if (event.type === "beat") {
      flush();
      steps.push({ beat: true });
      continue;
    }

    // Captions and beats are annotations, not actions: they neither cause a
    // navigation nor prove the user has started.
    acted = true;

    const selector = event.candidates ? chooseSelector(event.candidates as Candidate[]) : null;

    if (event.type === "input") {
      if (!selector) {
        skipped.push(describeUnnamed("typing", event));
        continue;
      }
      // A different field ends the previous one.
      if (typing && typing.selector !== selector) flush();
      typing = { selector, value: event.value ?? "" };
      // Clicking into the field is how you get to type in it; recording both
      // would make every text entry two steps.
      if (lastStep(steps) === `click:${selector}`) steps.pop();
      continue;
    }

    flush();

    if (event.type === "key") {
      if (!event.key) continue;
      steps.push(selector ? { press: { selector, key: event.key } } : { press: { key: event.key } });
      continue;
    }

    if (event.type === "click" || event.type === "dblclick") {
      if (!selector) {
        skipped.push(describeUnnamed("click", event));
        continue;
      }
      // A double-click arrives as two clicks and a dblclick; the pair is the
      // same gesture, not three.
      if (event.type === "dblclick" && lastStep(steps) === `click:${selector}`) steps.pop();
      steps.push(event.type === "click" ? { click: selector } : { dblclick: selector });
    }
  }

  flush();
  settle();
  return { steps, skipped };
}

/** `click:#save` — a cheap identity for the "is this the same target" checks. */
function lastStep(steps: StepInput[]): string | null {
  const step = steps[steps.length - 1];
  if (!step) return null;
  if ("click" in step) return `click:${step.click}`;
  if ("waitForUrl" in step) return `waitForUrl:${step.waitForUrl}`;
  return null;
}

/**
 * A path when the demo stays on its own site, the full URL when it doesn't.
 *
 * A spec that hard-codes `http://localhost:3000/settings` records the port the
 * dev server happened to use, so the demo only replays on the machine it was
 * captured on.
 */
export function relativeUrl(url: string, baseUrl: string): string | null {
  try {
    const target = new URL(url);
    const base = new URL(baseUrl);
    if (target.origin !== base.origin) return target.toString();
    return generalizeUrl(target.pathname) + target.search + target.hash;
  } catch {
    return null;
  }
}

/**
 * A path segment the app minted is a wildcard, not a value to wait for.
 *
 * Creating something in an app usually lands you on it, at a URL containing
 * its brand-new id — n8n's "Build a workflow" goes to
 * `/workflow/xOKY1J9Z2cJ40cBe?new=true`. Recorded literally, that step waits
 * for a workflow that will never be created again, and the spec fails on its
 * first replay rather than on some later drift.
 *
 * The same judgement that rejects a generated selector applies here, and for
 * the same reason: what the demo means is "wait until we are looking at a
 * workflow", not "wait for that one".
 */
export function generalizeUrl(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => (segment && (looksGenerated(segment) || opaqueSegment(segment)) ? "*" : segment))
    .join("/");
}

/**
 * An opaque token, as URL path segments go.
 *
 * `looksGenerated` is tuned for DOM ids, where a scattering of digits is the
 * tell. The ids apps mint for URLs are often nanoid-shaped — long, mixed case,
 * and with as little as one digit — so n8n's `xOKY1J9Z2cJ40cBe` is caught by
 * that rule and `HlrOEDBVg5crbhQY`, from the very next run, is not. Detection
 * that depends on how many digits the random generator happened to pick is not
 * detection.
 *
 * Deliberately narrow, because a rule that eats real paths is worse than one
 * that misses: all three of long, mixed case and at least one digit have to
 * hold. `userProfileSettings` has no digit, `mainNavigation` is too short, and
 * `tutorial---basics` is neither.
 */
function opaqueSegment(segment: string): boolean {
  if (segment.length < 16) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return false;
  return /[a-z]/.test(segment) && /[A-Z]/.test(segment) && /\d/.test(segment);
}

/**
 * Say what was dropped, rather than dropping it quietly.
 *
 * A demo that is missing the step nobody was told about is discovered when it
 * plays wrong, which is far too late.
 */
function describeUnnamed(action: string, event: ObservedEvent): string {
  const best = event.candidates?.[0];
  const where = best ? ` (nearest match: ${best.selector}, ${best.matches} elements)` : "";
  return `${action} on an element with no stable selector${where}`;
}
