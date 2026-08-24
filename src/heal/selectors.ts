import type { Step } from "../spec/schema.js";

/**
 * Read/replace/describe the selector a step targets. Used by self-healing to
 * locate the broken part of a step and swap in a repaired selector.
 */

/** The selector a step targets, or null if it isn't selector-based. */
export function stepSelector(step: Step): string | null {
  if ("click" in step) return step.click;
  if ("dblclick" in step) return step.dblclick;
  // The thing being dragged is the half that breaks: a destination is usually a
  // container that outlives a redesign, and the card inside it is not.
  if ("drag" in step) return step.drag.from;
  if ("hover" in step) return step.hover;
  if ("scrollTo" in step) return step.scrollTo;
  if ("waitFor" in step) return typeof step.waitFor === "string" ? step.waitFor : step.waitFor.selector;
  if ("type" in step) return step.type.selector;
  if ("fill" in step) return step.fill.selector;
  if ("press" in step) return step.press.selector ?? null;
  if ("callout" in step) return step.callout.selector;
  if ("expect" in step) return step.expect.selector;
  if ("scroll" in step) return typeof step.scroll.to === "string" ? step.scroll.to : null;
  if ("zoom" in step) return typeof step.zoom === "object" ? step.zoom.to ?? null : null;
  return null;
}

/** Return a copy of the step with its selector replaced. */
export function withStepSelector(step: Step, selector: string): Step {
  if ("click" in step) return { click: selector };
  if ("dblclick" in step) return { dblclick: selector };
  if ("drag" in step) return { drag: { ...step.drag, from: selector } };
  if ("hover" in step) return { hover: selector };
  if ("scrollTo" in step) return { scrollTo: selector };
  if ("waitFor" in step) return { waitFor: selector };
  if ("type" in step) return { type: { ...step.type, selector } };
  if ("fill" in step) return { fill: { ...step.fill, selector } };
  if ("press" in step) return { press: { ...step.press, selector } };
  if ("callout" in step) return { callout: { ...step.callout, selector } };
  if ("expect" in step) return { expect: { ...step.expect, selector } };
  if ("scroll" in step) return { scroll: { ...step.scroll, to: selector } };
  if ("zoom" in step && typeof step.zoom === "object") return { zoom: { ...step.zoom, to: selector } };
  return step;
}

/** A short human description of a step's intent, for the repair prompt. */
export function describeStep(step: Step): string {
  if ("click" in step) return `click the element "${step.click}"`;
  if ("dblclick" in step) return `double-click the element "${step.dblclick}"`;
  if ("drag" in step) {
    const to = typeof step.drag.to === "string" ? `"${step.drag.to}"` : "a point on the page";
    return `drag "${step.drag.from}" onto ${to}`;
  }
  if ("hover" in step) return `hover the element "${step.hover}"`;
  if ("scrollTo" in step) return `scroll to the element "${step.scrollTo}"`;
  if ("waitFor" in step) return `wait for "${step.waitFor}" to be visible`;
  if ("type" in step) return `type "${step.type.text}" into the field "${step.type.selector}"`;
  if ("fill" in step) return `fill "${step.fill.text}" into the field "${step.fill.selector}"`;
  if ("press" in step) return `press ${step.press.key} on "${step.press.selector ?? "(page)"}"`;
  if ("callout" in step) {
    return `spotlight the element "${step.callout.selector}"${step.callout.text ? ` labelled "${step.callout.text}"` : ""}`;
  }
  if ("expect" in step) {
    return `assert the element "${step.expect.selector}"${step.expect.text ? ` contains "${step.expect.text}"` : ""}`;
  }
  if ("scroll" in step) return `scroll to "${step.scroll.to}"`;
  if ("zoom" in step && typeof step.zoom === "object" && step.zoom.to) {
    return `point the camera at "${step.zoom.to}"`;
  }
  return "run the step";
}
