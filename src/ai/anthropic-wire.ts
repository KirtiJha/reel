import type { ChatResult, OaiMessage, OaiToolCall, OaiToolSpec } from "./llm.js";

/**
 * Translation between Reel's canonical (OpenAI-shaped) chat format and
 * Anthropic's Messages API.
 *
 * Reel keeps one internal message format so the agent, healer and translator
 * don't each need to know which vendor is answering. Nearly every provider
 * speaks that format on the wire already; Anthropic does not, and the
 * differences are structural rather than cosmetic:
 *
 *  - the system prompt is a top-level field, not a message with `role: system`
 *  - tool calls and their results are content *blocks* inside user/assistant
 *    turns, rather than a separate `tool` role and a `tool_calls` array
 *  - tool arguments are JSON values, not JSON encoded as a string
 *  - `max_tokens` is required
 *
 * Keeping that translation here means the rest of the codebase — and every
 * other provider — is unaffected by it.
 */

/** Anthropic requires max_tokens; this is a generous ceiling for spec authoring. */
const DEFAULT_MAX_TOKENS = 8192;

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: { role: "user" | "assistant"; content: AnthropicBlock[] }[];
  tools?: { name: string; description: string; input_schema: Record<string, unknown> }[];
  temperature?: number;
}

/** Canonical messages → an Anthropic Messages request body. */
export function toAnthropicRequest(
  model: string,
  messages: OaiMessage[],
  tools: OaiToolSpec[] | undefined,
  opts: { temperature?: number; maxTokens?: number } = {},
): AnthropicRequest {
  // System turns are hoisted out; several concatenate the way the API expects.
  const system = messages
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => m.content as string)
    .join("\n\n");

  const out: AnthropicRequest["messages"] = [];
  for (const m of messages) {
    if (m.role === "system") continue;

    if (m.role === "tool") {
      // A tool result is a user turn carrying a tool_result block. Consecutive
      // results merge into one turn — the API rejects a tool_result that isn't
      // adjacent to the tool_use it answers.
      const block: AnthropicBlock = {
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content: m.content ?? "",
      };
      const prev = out[out.length - 1];
      if (prev?.role === "user" && prev.content.every((b) => b.type === "tool_result")) {
        prev.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }

    const content: AnthropicBlock[] = [];
    if (typeof m.content === "string" && m.content !== "") {
      content.push({ type: "text", text: m.content });
    }
    for (const call of m.tool_calls ?? []) {
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        // Anthropic takes parsed arguments; OpenAI sends them as a JSON string.
        input: safeParse(call.function.arguments),
      });
    }
    // A turn with no content at all is rejected; an empty assistant turn can
    // legitimately occur when a model replies with tool calls only.
    if (content.length === 0) content.push({ type: "text", text: "" });
    out.push({ role: m.role === "assistant" ? "assistant" : "user", content });
  }

  const req: AnthropicRequest = {
    model,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: out,
  };
  if (system) req.system = system;
  if (opts.temperature !== undefined) req.temperature = opts.temperature;
  if (tools?.length) {
    req.tools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }
  return req;
}

/** An Anthropic Messages response → Reel's canonical result. */
export function fromAnthropicResponse(res: any): ChatResult {
  const blocks: AnthropicBlock[] = Array.isArray(res?.content) ? res.content : [];

  const text = blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");

  const toolCalls: OaiToolCall[] = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      id: String(b.id ?? ""),
      type: "function" as const,
      function: {
        name: String(b.name ?? ""),
        // Callers parse arguments as JSON, so re-encode what Anthropic parsed.
        arguments: JSON.stringify(b.input ?? {}),
      },
    }));

  const message: OaiMessage = {
    role: "assistant",
    content: text === "" ? null : text,
  };
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    message,
    // `tool_use` is Anthropic's spelling of OpenAI's `tool_calls` finish reason;
    // callers branch on the OpenAI spelling.
    finishReason: res?.stop_reason === "tool_use" ? "tool_calls" : (res?.stop_reason ?? null),
    usage: {
      prompt_tokens: res?.usage?.input_tokens,
      completion_tokens: res?.usage?.output_tokens,
    },
  };
}

/** Tool arguments arrive as a JSON string; a malformed one shouldn't kill the run. */
function safeParse(s: string): unknown {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}
