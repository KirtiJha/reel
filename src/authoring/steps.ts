import type { StepInput } from "../spec/schema.js";
import { chooseSelector, type Candidate } from "./selector.js";
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

  let navigations = 0;

  for (const event of events) {
    if (event.type === "nav") {
      navigations++;
      flush();
      // The first navigation is the spec's own `url:` — recording a wait for
      // the page the demo opens on would be waiting for something that has
      // already happened.
      if (navigations === 1) continue;
      const target = relativeUrl(event.url, baseUrl);
      if (target && lastStep(steps) !== `waitForUrl:${target}`) steps.push({ waitForUrl: target });
      continue;
    }

    if (event.type === "finish") break;

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
    return target.pathname + target.search + target.hash;
  } catch {
    return null;
  }
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
