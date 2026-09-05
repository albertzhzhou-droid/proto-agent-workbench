import assert from "node:assert/strict";
import test from "node:test";
import { LmStudioTokenizer } from "../src/main/services/lm-studio-tokenizer.ts";

function fixture(overrides = {}) {
  const calls = [];
  const model = {
    identifier: "exact-instance",
    async getModelInfo() { return { identifier: "exact-instance", instanceReference: "immutable-1" }; },
    async applyPromptTemplate(history, options) { calls.push({ history, options }); return "formatted prompt including tools"; },
    async countTokens(text) { assert.equal(text, "formatted prompt including tools"); return 42; },
    ...overrides,
  };
  const tokenizer = new LmStudioTokenizer({ clientFactory: () => ({ llm: {
    async listLoaded() { return [model]; },
    model() { assert.fail("model() could implicitly load"); },
    load() { assert.fail("tokenizer must never load"); },
  } }) });
  return { tokenizer, calls };
}

test("formats exact tool definitions and tool request/result pairs on a loaded specific handle", async () => {
  const { tokenizer, calls } = fixture();
  const tools = [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }];
  const count = await tokenizer.countPrompt("exact-instance", { tools, messages: [
    { role: "system", content: "policy" },
    { role: "user", content: "read this" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"designs/a.proto"}' } }] },
    { role: "tool", tool_call_id: "c1", content: "file contents" },
  ] });
  assert.equal(count, 42);
  assert.deepEqual(calls[0].options.toolDefinitions, tools);
  assert.equal(calls[0].history.messages[2].content[0].toolCallRequest.arguments.path, "designs/a.proto");
  assert.deepEqual(calls[0].history.messages[3], { role: "tool", content: [{ type: "toolCallResult", content: "file contents", toolCallId: "c1" }] });
});

test("absent or replaced instances are rejected without loading another model", async () => {
  const normal = fixture();
  await assert.rejects(normal.tokenizer.countPrompt("absent", { messages: [] }), /not loaded/);
  let calls = 0;
  const replaced = fixture({ async getModelInfo() { return { identifier: "exact-instance", instanceReference: ++calls === 1 ? "old" : "new" }; } });
  await assert.rejects(replaced.tokenizer.countPrompt("exact-instance", { messages: [] }), /changed/);
});

test("multimodal payload is never mislabeled as an exact text count", async () => {
  const { tokenizer } = fixture();
  await assert.rejects(tokenizer.countPrompt("exact-instance", { messages: [{ role: "user", content: [{ type: "image_url" }] }] }), /conservative/);
});

test("a stalled SDK request is bounded and cannot accumulate more requests", async () => {
  let calls = 0;
  const tokenizer = new LmStudioTokenizer({ timeoutMs: 15, clientFactory: () => ({ llm: { listLoaded() { calls++; return new Promise(() => {}); } } }) });
  await assert.rejects(tokenizer.countPrompt("exact", { messages: [] }), /timed out/);
  await assert.rejects(tokenizer.countPrompt("exact", { messages: [] }), /earlier request/);
  assert.equal(calls, 1);
});
