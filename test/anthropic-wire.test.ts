import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fromAnthropicResponse, toAnthropicRequest } from "../src/ai/anthropic-wire.js";
import type { OaiMessage, OaiToolSpec } from "../src/ai/llm.js";

const TOOLS: OaiToolSpec[] = [
  {
    type: "function",
    function: {
      name: "click",
      description: "Click an element",
      parameters: { type: "object", properties: { selector: { type: "string" } } },
    },
  },
];

describe("toAnthropicRequest", () => {
  test("hoists the system turn out of messages into the top-level field", () => {
    const req = toAnthropicRequest("m", [
      { role: "system", content: "You author demos." },
      { role: "user", content: "Hello" },
    ] as OaiMessage[], undefined);
    assert.equal(req.system, "You author demos.");
    assert.equal(req.messages.length, 1, "the system turn must not remain a message");
    assert.equal(req.messages[0]!.role, "user");
  });

  test("joins several system turns rather than dropping any", () => {
    const req = toAnthropicRequest("m", [
      { role: "system", content: "A" },
      { role: "system", content: "B" },
      { role: "user", content: "hi" },
    ] as OaiMessage[], undefined);
    assert.equal(req.system, "A\n\nB");
  });

  test("always sets max_tokens, which the API requires", () => {
    const req = toAnthropicRequest("m", [{ role: "user", content: "hi" }] as OaiMessage[], undefined);
    assert.ok(req.max_tokens > 0);
  });

  test("converts a tool call into a tool_use block with parsed input", () => {
    const req = toAnthropicRequest("m", [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "click", arguments: '{"selector":"#go"}' } },
        ],
      },
    ] as OaiMessage[], TOOLS);
    const block = req.messages[0]!.content.find((b) => b.type === "tool_use")!;
    assert.equal(block.name, "click");
    // Anthropic takes parsed arguments; OpenAI sends a JSON string.
    assert.deepEqual(block.input, { selector: "#go" });
  });

  test("survives malformed tool arguments instead of throwing mid-run", () => {
    const req = toAnthropicRequest("m", [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c", type: "function", function: { name: "click", arguments: "{oops" } }],
      },
    ] as OaiMessage[], TOOLS);
    assert.deepEqual(req.messages[0]!.content[0]!.input, {});
  });

  test("turns a tool result into a user turn carrying tool_result", () => {
    const req = toAnthropicRequest("m", [
      { role: "tool", content: "ok", tool_call_id: "call_1" },
    ] as OaiMessage[], TOOLS);
    assert.equal(req.messages[0]!.role, "user");
    assert.equal(req.messages[0]!.content[0]!.type, "tool_result");
    assert.equal(req.messages[0]!.content[0]!.tool_use_id, "call_1");
  });

  test("merges consecutive tool results into one turn", () => {
    // The API rejects a tool_result that isn't adjacent to its tool_use, so
    // two results from one parallel call must not become two user turns.
    const req = toAnthropicRequest("m", [
      { role: "tool", content: "a", tool_call_id: "1" },
      { role: "tool", content: "b", tool_call_id: "2" },
    ] as OaiMessage[], TOOLS);
    assert.equal(req.messages.length, 1);
    assert.equal(req.messages[0]!.content.length, 2);
  });

  test("never emits a turn with empty content", () => {
    const req = toAnthropicRequest("m", [{ role: "assistant", content: null }] as OaiMessage[], undefined);
    assert.ok(req.messages[0]!.content.length > 0, "an empty content array is rejected by the API");
  });

  test("maps tool specs into Anthropic's input_schema shape", () => {
    const req = toAnthropicRequest("m", [{ role: "user", content: "x" }] as OaiMessage[], TOOLS);
    assert.equal(req.tools![0]!.name, "click");
    assert.deepEqual(req.tools![0]!.input_schema, TOOLS[0]!.function.parameters);
  });

  test("omits tools entirely when none are given", () => {
    const req = toAnthropicRequest("m", [{ role: "user", content: "x" }] as OaiMessage[], undefined);
    assert.equal(req.tools, undefined);
  });
});

describe("fromAnthropicResponse", () => {
  test("concatenates text blocks into the message content", () => {
    const r = fromAnthropicResponse({
      content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }],
      stop_reason: "end_turn",
    });
    assert.equal(r.message.content, "Hello world");
    assert.equal(r.message.role, "assistant");
  });

  test("converts tool_use blocks back into tool_calls with string arguments", () => {
    const r = fromAnthropicResponse({
      content: [{ type: "tool_use", id: "tu_1", name: "click", input: { selector: "#go" } }],
      stop_reason: "tool_use",
    });
    const call = r.message.tool_calls![0]!;
    assert.equal(call.function.name, "click");
    // Callers JSON.parse these, so the object must be re-encoded.
    assert.deepEqual(JSON.parse(call.function.arguments), { selector: "#go" });
  });

  test("reports tool_use as the OpenAI finish reason callers branch on", () => {
    const r = fromAnthropicResponse({ content: [], stop_reason: "tool_use" });
    assert.equal(r.finishReason, "tool_calls");
  });

  test("passes other stop reasons through unchanged", () => {
    assert.equal(fromAnthropicResponse({ content: [], stop_reason: "max_tokens" }).finishReason, "max_tokens");
  });

  test("uses null content when the model only called tools", () => {
    const r = fromAnthropicResponse({
      content: [{ type: "tool_use", id: "t", name: "click", input: {} }],
      stop_reason: "tool_use",
    });
    assert.equal(r.message.content, null);
  });

  test("maps usage onto the canonical token fields", () => {
    const r = fromAnthropicResponse({
      content: [],
      stop_reason: "end_turn",
      usage: { input_tokens: 11, output_tokens: 7 },
    });
    assert.equal(r.usage?.prompt_tokens, 11);
    assert.equal(r.usage?.completion_tokens, 7);
  });

  test("tolerates a response with no content array", () => {
    const r = fromAnthropicResponse({ stop_reason: "end_turn" });
    assert.equal(r.message.content, null);
  });
});

describe("round trip", () => {
  test("a tool call survives the trip out and back", () => {
    const out = fromAnthropicResponse({
      content: [{ type: "tool_use", id: "tu_9", name: "click", input: { selector: "#a" } }],
      stop_reason: "tool_use",
    });
    const back = toAnthropicRequest("m", [out.message], TOOLS);
    const block = back.messages[0]!.content[0]!;
    assert.equal(block.type, "tool_use");
    assert.equal(block.id, "tu_9");
    assert.deepEqual(block.input, { selector: "#a" });
  });
});
