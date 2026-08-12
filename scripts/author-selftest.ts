/**
 * Self-test for AI authoring WITHOUT a live LLM: a scripted "model" returns a
 * fixed sequence of tool calls (resolving element refs from each snapshot, just
 * like a real model would), driving the real agent loop against the TaskFlow
 * app. Proves the browser tools, ref→selector mapping, step recording, and spec
 * assembly end-to-end. The emitted spec is then recorded by `reel record`.
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { BrowserAgent, buildSpecYaml } from "../src/ai/agent-tools.js";
import { runAgentLoop, type ChatFn } from "../src/ai/author.js";
import type { ChatResult, OaiMessage } from "../src/ai/llm.js";

const PORT = 4321;
const URL = `http://localhost:${PORT}`;

function toolCall(name: string, args: Record<string, unknown>): ChatResult {
  return {
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id: `call_${name}_${Math.round(performance.now())}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    },
    finishReason: "tool_calls",
  };
}

function lastSnapshot(messages: OaiMessage[]): string {
  // The most recent tool message that actually contains a ref listing.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "tool" && typeof m.content === "string" && /\[e\d+\]/.test(m.content)) return m.content;
  }
  return "";
}

/** Find a ref by matching the role/name line, e.g. `[e3] textbox "New task"`. */
function refWhere(snapshot: string, pred: (role: string, name: string) => boolean): string | undefined {
  for (const line of snapshot.split("\n")) {
    const m = /\[(\w+)\]\s+(\S+)(?:\s+"([^"]*)")?/.exec(line);
    if (m && pred(m[2]!, m[3] ?? "")) return m[1];
  }
  return undefined;
}

async function main() {
  const server = spawn("node", ["server.mjs"], {
    cwd: "examples/taskflow",
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
    detached: true,
  });
  await sleep(800);

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: "domcontentloaded" });
    const agent = new BrowserAgent(page, URL);

    // The scripted plan: each step resolves refs from the latest snapshot.
    let n = 0;
    const script: ChatFn = async (messages) => {
      const snap = lastSnapshot(messages);
      const step = n++;
      switch (step) {
        case 0: return toolCall("snapshot", {});
        case 1: return toolCall("card", { title: "TaskFlow", subtitle: "Capture work in a snap" });
        case 2: return toolCall("beat", { label: "hero" });
        case 3: return toolCall("caption", { text: "Meet TaskFlow — capture work in a snap" });
        case 4: return toolCall("type", { ref: refWhere(snap, (r) => r === "textbox"), text: "Ship the Reel demo" });
        case 5: return toolCall("click", { ref: refWhere(snap, (r, nm) => r === "button" && /add/i.test(nm)) });
        case 6: return toolCall("wait_for", { text: "Ship the Reel demo" });
        case 7: return toolCall("callout", { ref: refWhere(snap, (_r, nm) => /ship the reel demo/i.test(nm)), text: "Your task, captured" });
        case 8: return toolCall("caption", { text: "Click a task to complete it" });
        case 9: return toolCall("click", { ref: refWhere(snap, (_r, nm) => /ship the reel demo/i.test(nm)) });
        case 10: return toolCall("caption", { text: "That's it — demos as code" });
        case 11: return toolCall("card", { title: "Demos as code", subtitle: "One spec. Every format." });
        case 12: return toolCall("beat", { label: "outro" });
        default: return toolCall("finish", { name: "TaskFlow — add and complete a task" });
      }
    };

    const { name, turns } = await runAgentLoop(script, agent, "add a task and complete it", 20);
    console.log(`\nLoop finished in ${turns} turns. Demo name: ${name}`);
    console.log(`Recorded ${agent.steps.length} steps:`);
    for (const s of agent.steps) console.log("  " + JSON.stringify(s));

    const yaml = buildSpecYaml(agent.steps, { name: name || "demo", url: URL });
    await writeFile("scripts/authored.reel.yaml", yaml, "utf8");
    console.log("\nWrote scripts/authored.reel.yaml");
  } finally {
    await browser.close().catch(() => {});
    if (server.pid) {
      try { process.kill(-server.pid, "SIGTERM"); } catch { server.kill("SIGTERM"); }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
