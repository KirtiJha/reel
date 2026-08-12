import { stringify as yamlStringify } from "yaml";
import type { Page } from "playwright-core";
import { specSchema, type SpecInput } from "../spec/schema.js";
import { toPlaywrightSelector } from "../overlay/overlay.js";
import { ReelError, log } from "../util/log.js";
import type { OaiToolSpec } from "./llm.js";

/**
 * The browser tools the authoring agent drives, and the machinery that turns its
 * successful actions into a reproducible Reel spec.
 *
 * Each snapshot assigns a stable `ref` (e.g. `e3`) to every interactive element
 * and computes a durable selector for it (id / role+name / text). When the agent
 * acts on a ref, we execute it in Playwright AND record the corresponding spec
 * step using the durable selector — so the emitted spec replays reliably, and
 * the agent has verified each step works before it lands in the file.
 */

export interface ElementInfo {
  ref: string;
  role: string;
  name: string;
  selector: string;
}

export interface Snapshot {
  url: string;
  title: string;
  elements: ElementInfo[];
}

/**
 * Enumerate the page's interactive elements, assigning each a stable ref
 * (data-reel-ref) and a durable Reel selector. Shared by the authoring agent
 * and the self-healing repairer.
 */
export async function collectInteractive(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    // Shim esbuild/tsx's keepNames helper, absent in the browser context.
    (globalThis as unknown as { __name?: unknown }).__name ||= (f: unknown) => f;
    document.querySelectorAll("[data-reel-ref]").forEach((el) => el.removeAttribute("data-reel-ref"));
    const clean = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 60);
    const roleOf = (el: Element): string => {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "button") return "button";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        const t = (el as HTMLInputElement).type;
        if (["text", "email", "search", "url", "tel", "password", ""].includes(t)) return "textbox";
        if (t === "checkbox") return "checkbox";
        if (t === "radio") return "radio";
        return "textbox";
      }
      return "generic";
    };
    const nameOf = (el: Element): string => {
      const aria = el.getAttribute("aria-label");
      if (aria) return clean(aria);
      const ph = el.getAttribute("placeholder");
      const text = (el as HTMLElement).innerText || "";
      const val = (el as HTMLInputElement).value || "";
      return clean(text || ph || val || "");
    };
    const selOf = (el: Element, role: string, name: string): string => {
      const id = el.getAttribute("id");
      if (id && /^[A-Za-z][\w-]*$/.test(id)) return `#${id}`;
      if (role === "button" && name) return `role=button[name=${name}]`;
      if (el.tagName === "A" && name) return `text=${name}`;
      if (role === "textbox") {
        const ph = el.getAttribute("placeholder");
        if (ph) return `[placeholder="${ph}"]`;
        if (name) return `role=textbox[name=${name}]`;
      }
      return name ? `text=${name}` : el.tagName.toLowerCase();
    };

    const sels = "a[href], button, input:not([type=hidden]), textarea, select, [role=button], [contenteditable=true]";
    const base = Array.from(document.querySelectorAll(sels));
    // Also surface non-semantic clickables (cursor:pointer with short text).
    const pointer = Array.from(document.querySelectorAll("body *")).filter((el) => {
      if (base.includes(el)) return false;
      if (getComputedStyle(el as Element).cursor !== "pointer") return false;
      const txt = ((el as HTMLElement).innerText || "").trim();
      return txt.length > 0 && txt.length < 80;
    });
    let candidates = [...base, ...pointer];
    candidates = candidates.filter((el) => !candidates.some((o) => o !== el && el.contains(o)));

    const out: { ref: string; role: string; name: string; selector: string }[] = [];
    let i = 0;
    for (const el of candidates) {
      const he = el as HTMLElement;
      if (he.offsetParent === null && he.getClientRects().length === 0) continue; // not visible
      const ref = `e${++i}`;
      el.setAttribute("data-reel-ref", ref);
      const role = roleOf(el);
      const name = nameOf(el);
      out.push({ ref, role, name, selector: selOf(el, role, name) });
    }
    return { url: location.href, title: document.title, elements: out };
  });
}

/** Compact, model-friendly rendering of a snapshot. */
export function formatSnapshot(data: Snapshot): string {
  const lines = data.elements.map((e) => `  [${e.ref}] ${e.role}${e.name ? ` "${e.name}"` : ""}`);
  return `URL: ${data.url}\nTitle: ${data.title}\nInteractive elements:\n${lines.join("\n") || "  (none)"}`;
}

export interface ToolResult {
  text: string;
  done?: boolean;
  name?: string;
}

export class BrowserAgent {
  readonly steps: Record<string, unknown>[] = [];
  private refs = new Map<string, ElementInfo>();

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
  ) {}

  async handle(tool: string, input: Record<string, unknown>): Promise<ToolResult> {
    switch (tool) {
      case "snapshot":
        return { text: await this.snapshot() };
      case "click":
        return this.click(String(input.ref ?? ""));
      case "type":
        return this.type(String(input.ref ?? ""), String(input.text ?? ""), Boolean(input.submit));
      case "navigate":
        return this.navigate(String(input.path ?? "/"));
      case "wait_for":
        return this.waitFor(String(input.text ?? ""));
      case "caption":
        this.steps.push({ caption: String(input.text ?? "") });
        return { text: `Caption added: "${input.text}"` };
      case "beat":
        this.steps.push({ beat: String(input.label ?? "beat") });
        return { text: `Beat marked: ${input.label}` };
      case "card":
        return this.card(String(input.title ?? ""), input.subtitle ? String(input.subtitle) : undefined);
      case "callout":
        return this.callout(String(input.ref ?? ""), String(input.text ?? ""));
      case "finish":
        return { text: "Demo complete.", done: true, name: String(input.name ?? "") };
      default:
        return { text: `Unknown tool: ${tool}` };
    }
  }

  /** Assign refs + selectors to interactive elements; return a compact listing. */
  private async snapshot(): Promise<string> {
    const data = await collectInteractive(this.page);
    this.refs.clear();
    for (const e of data.elements) this.refs.set(e.ref, e);
    return formatSnapshot(data);
  }

  private locator(ref: string) {
    return this.page.locator(`[data-reel-ref="${ref}"]`).first();
  }

  private info(ref: string): ElementInfo | undefined {
    return this.refs.get(ref);
  }

  private async click(ref: string): Promise<ToolResult> {
    const el = this.info(ref);
    if (!el) return { text: `No element ${ref}. Call snapshot first.` };
    try {
      await this.locator(ref).click({ timeout: 8_000 });
    } catch (e) {
      return { text: `Could not click ${ref} (${el.selector}): ${(e as Error).message.split("\n")[0]}` };
    }
    this.steps.push({ click: el.selector });
    await this.settle();
    return { text: `Clicked "${el.name || el.selector}".\n\n${await this.snapshot()}` };
  }

  private async type(ref: string, text: string, submit: boolean): Promise<ToolResult> {
    const el = this.info(ref);
    if (!el) return { text: `No element ${ref}. Call snapshot first.` };
    try {
      const loc = this.locator(ref);
      await loc.click({ timeout: 8_000 });
      await loc.fill(text);
    } catch (e) {
      return { text: `Could not type into ${ref}: ${(e as Error).message.split("\n")[0]}` };
    }
    this.steps.push({ type: { selector: el.selector, text } });
    if (submit) {
      await this.locator(ref).press("Enter").catch(() => {});
      this.steps.push({ press: { selector: el.selector, key: "Enter" } });
    }
    await this.settle();
    return { text: `Typed "${text}"${submit ? " and pressed Enter" : ""}.\n\n${await this.snapshot()}` };
  }

  /**
   * A title card. No browser action — it's pure scene structure, so it can't
   * fail, but an empty title would render a blank card, which is worse than
   * refusing it.
   */
  private card(title: string, subtitle?: string): ToolResult {
    if (!title.trim()) return { text: "A card needs a title. Provide a short one and try again." };
    this.steps.push({ card: subtitle ? { title, subtitle } : { title } });
    return { text: `Title card added: "${title}"${subtitle ? ` — "${subtitle}"` : ""}` };
  }

  /**
   * Spotlight an element and label it. Verified like any other action: if the
   * ref doesn't resolve to something visible, the step never lands in the spec.
   */
  private async callout(ref: string, text: string): Promise<ToolResult> {
    const el = this.info(ref);
    if (!el) return { text: `No element ${ref}. Call snapshot first.` };
    try {
      await this.locator(ref).waitFor({ state: "visible", timeout: 8_000 });
    } catch {
      return { text: `${ref} (${el.selector}) isn't visible, so it can't be spotlighted.` };
    }
    this.steps.push(text ? { callout: { selector: el.selector, text } } : { callout: { selector: el.selector } });
    return { text: `Spotlighted "${el.name || el.selector}"${text ? ` with the label "${text}"` : ""}.` };
  }

  private async navigate(path: string): Promise<ToolResult> {
    const target = /^https?:\/\//.test(path) ? path : new URL(path, this.baseUrl).toString();
    await this.page.goto(target, { waitUntil: "domcontentloaded" }).catch(() => {});
    this.steps.push({ goto: path });
    await this.settle();
    return { text: `Navigated to ${path}.\n\n${await this.snapshot()}` };
  }

  private async waitFor(text: string): Promise<ToolResult> {
    const selector = `text=${text}`;
    try {
      await this.page.locator(toPlaywrightSelector(selector)).first().waitFor({ state: "visible", timeout: 8_000 });
    } catch {
      return { text: `"${text}" did not appear — the previous step may not have worked as expected.` };
    }
    this.steps.push({ waitFor: selector });
    return { text: `Verified "${text}" is visible.` };
  }

  /** Best-effort settle so the next snapshot reflects the new state. */
  private async settle(): Promise<void> {
    await Promise.race([
      this.page.waitForLoadState("networkidle").catch(() => {}),
      this.page.waitForTimeout(1200),
    ]);
  }
}

/** OpenAI-style tool definitions the agent can call. */
export const AGENT_TOOLS: OaiToolSpec[] = [
  {
    type: "function",
    function: {
      name: "snapshot",
      description:
        "Inspect the current page. Returns the URL, title, and a list of interactive elements, each with a ref (like e3), role, and name. Call this first, and again after any action, to see the current state.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "click",
      description: "Click an interactive element by its ref from the latest snapshot.",
      parameters: {
        type: "object",
        properties: { ref: { type: "string", description: "Element ref, e.g. e3" } },
        required: ["ref"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "type",
      description: "Type text into an input/textbox element by ref. Set submit=true to press Enter after.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string" },
          text: { type: "string" },
          submit: { type: "boolean" },
        },
        required: ["ref", "text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "navigate",
      description: "Navigate to a path or URL (e.g. '/' or '/signup').",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait_for",
      description:
        "Verify that a piece of visible text has appeared, confirming the previous step reached the expected state. Records a reliable state-based wait in the demo. Use after actions that change the page.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "Visible text to wait for" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "caption",
      description: "Add an on-screen caption at this point in the demo, narrating what's happening.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "beat",
      description:
        "Mark a hero/key frame the demo should hold on. Use label 'hero' for the opening establishing shot and 'outro' for the closing one.",
      parameters: {
        type: "object",
        properties: { label: { type: "string" } },
        required: ["label"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "card",
      description:
        "Show a full-screen title card. Use one at the very start (the product name and a one-line value proposition) and one at the end (the takeaway). Also use one to separate chapters when the demo covers distinct parts.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short — a product or chapter name" },
          subtitle: { type: "string", description: "One line of supporting context" },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "callout",
      description:
        "Spotlight an element by ref: the rest of the page dims and a label explains it. Use for the payoff moment — the result the user came for — not for things you are about to click.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Element ref, e.g. e3" },
          text: { type: "string", description: "Short label explaining why it matters" },
        },
        required: ["ref", "text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "Call when the story is fully demonstrated. Provide a short human-readable demo name.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
];

/** Assemble a validated, reproducible spec from the recorded steps. */
export function buildSpecYaml(
  steps: Record<string, unknown>[],
  meta: { name: string; url: string },
): string {
  const slug = meta.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "") || "demo";

  // Ensure the demo starts from the base route.
  const ordered = steps[0] && "goto" in steps[0] ? steps : [{ goto: "/" }, ...steps];

  const spec: SpecInput = {
    name: meta.name,
    url: meta.url,
    viewport: { width: 1280, height: 800, scale: 2 },
    theme: "light",
    deterministic: { disableAnimations: true },
    polish: { zoom: "auto", cursor: "smooth", captions: true },
    steps: ordered as SpecInput["steps"],
    output: { preset: "share", mp4: `out/${slug}.mp4`, gif: `out/${slug}.gif` },
  };

  const parsed = specSchema.safeParse(spec);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  • ${i.path.join(".")}: ${i.message}`).join("\n");
    log.warn(`Authored spec needed adjustment:\n${issues}`);
    throw new ReelError("The authored steps did not form a valid spec.", issues);
  }

  return `# Authored by \`reel author\`. Review, tweak captions/beats, then: reel record <file>\n${yamlStringify(spec, { lineWidth: 0 })}`;
}
