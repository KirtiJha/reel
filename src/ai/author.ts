import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { chat, loadLlmConfig, type ChatResult, type OaiMessage, type OaiToolSpec } from "./llm.js";
import { BrowserAgent, AGENT_TOOLS, buildSpecYaml } from "./agent-tools.js";
import { applyDeterminism } from "../driver/determinism.js";
import { log, ReelError } from "../util/log.js";

export interface AuthorOptions {
  url: string;
  out: string;
  model?: string;
}

/** A chat function — the real one calls the LiteLLM proxy; tests inject a fake. */
export type ChatFn = (messages: OaiMessage[], tools: OaiToolSpec[]) => Promise<ChatResult>;

const MAX_TURNS = 40;

/**
 * AI authoring (product plan §10) — the wedge. An agent drives your real app to
 * demonstrate a plain-English story, verifying each step, and emits a spec you
 * own and edit. Model access goes through a LiteLLM proxy (provider-agnostic,
 * BYO-key); see `llm.ts`.
 */
export async function authorSpec(story: string, opts: AuthorOptions): Promise<void> {
  const cfg = loadLlmConfig(opts.model); // throws a clear error if unconfigured
  log.phase(`Authoring from: “${story}”`);
  log.info(`Model: ${cfg.model} · via ${cfg.apiBase}${cfg.sslVerify ? "" : " (SSL verify off)"}`);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    // Keep the app steady while the agent explores (same controls used at record).
    await applyDeterminism(context, {
      disableAnimations: true,
      reducedMotion: false,
      timeline: true,
    });
    const page = await context.newPage();
    await page.goto(opts.url, { waitUntil: "domcontentloaded" });

    const agent = new BrowserAgent(page, opts.url);
    const chatFn: ChatFn = (messages, tools) => chat(cfg, messages, tools);

    const { name } = await runAgentLoop(chatFn, agent, story);

    if (agent.steps.length === 0) {
      throw new ReelError("The agent produced no steps.", "Check the app URL is reachable and interactive.");
    }

    const yaml = buildSpecYaml(agent.steps, { name: name || story, url: opts.url });
    const outPath = resolve(process.cwd(), opts.out);
    await writeFile(outPath, yaml, "utf8");

    log.ok(`Wrote ${outPath} (${agent.steps.length} steps)`);
    log.info(`Review it, then: reel record ${opts.out}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * The agent loop, decoupled from the provider so it can be driven by a scripted
 * chat function in tests. Runs tool calls against the browser agent and returns
 * the finished demo name.
 */
export async function runAgentLoop(
  chatFn: ChatFn,
  agent: BrowserAgent,
  story: string,
  maxTurns = MAX_TURNS,
): Promise<{ name?: string; turns: number }> {
  const messages: OaiMessage[] = [
    { role: "system", content: systemPrompt(story) },
    { role: "user", content: `Create the demo for this story: ${story}` },
  ];

  let finishedName: string | undefined;
  let nudged = false;
  let turn = 0;

  for (; turn < maxTurns; turn++) {
    const result = await chatFn(messages, AGENT_TOOLS);
    const msg = result.message;
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });

    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      // No tool call. Nudge once to get started; otherwise treat as end.
      if (!nudged) {
        nudged = true;
        messages.push({ role: "user", content: "Use the tools to drive the app — start by calling snapshot." });
        continue;
      }
      break;
    }

    for (const call of calls) {
      let input: Record<string, unknown> = {};
      try {
        input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        input = {};
      }
      const step = agent.steps.length;
      const out = await agent.handle(call.function.name, input);
      log.step(`${call.function.name}${describeInput(input)}${agent.steps.length > step ? " ✓" : ""}`);
      messages.push({ role: "tool", tool_call_id: call.id, content: out.text });
      if (out.done) finishedName = out.name || story;
    }
    if (finishedName !== undefined) break;
  }

  return { name: finishedName, turns: turn + 1 };
}

function describeInput(input: Record<string, unknown>): string {
  if (input.ref) return ` ${input.ref}${input.text ? ` "${input.text}"` : ""}`;
  if (input.text) return ` "${input.text}"`;
  if (input.label) return ` ${input.label}`;
  if (input.path) return ` ${input.path}`;
  if (input.name) return ` "${input.name}"`;
  return "";
}

function systemPrompt(story: string): string {
  return `You are Reel's demo author. You drive a real web app in a headless browser to produce a short, polished product demo. Your successful actions are recorded as a reproducible demo script that will be replayed to render a video/GIF.

Your goal: demonstrate this story end-to-end — "${story}".

How to work:
- Call snapshot to see the page and its interactive elements. Each element has a ref (like e3), a role, and a name. Act on elements by ref.
- click and type (by ref) perform the story. type takes { ref, text, submit? }. click/type/navigate return a fresh snapshot, so you don't need to snapshot again right after them.
- After an action that changes the page, call wait_for with a short piece of text that should now be visible. This verifies the step actually worked and records a reliable, state-based wait in the demo.
- Narrate with caption at natural moments: short, benefit-oriented, present tense (e.g. "Add a task in one click"). Mark beat "hero" at the very start (establishing shot) and beat "outro" at the end.
- Direct the demo, don't just click through it. Open with a card (product name + a one-line value proposition) before the hero beat, and close with a card carrying the takeaway before the outro beat.
- When the story reaches its payoff — the result the user came for — spotlight it with callout and one short line on why it matters. Use callout on the outcome, never on a control you are about to click.
- Keep it tight — a great demo is about 6 to 12 actions. Do not explore beyond the story.
- If an action doesn't produce the expected state, adjust your approach rather than repeating the same failing action.
- When the story is fully demonstrated, call finish with a short human-readable demo name.

Use only the provided tools. Do not ask the user any questions — proceed autonomously.`;
}
