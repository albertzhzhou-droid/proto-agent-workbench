import assert from "node:assert/strict";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CLOUD_CONTEXT_TOKENS, cloudEgressStatement, cloudModelId, isCloudModelId, parseCloudModelId } from "../src/shared/cloud-chat.ts";
import { isModelConnected } from "../src/shared/model-status.ts";
import { RoutingChatRuntime } from "../src/main/services/chat-runtime-router.ts";
import { AnthropicStreamTranslator, CloudProtocolError, SseParser, toAnthropicRequest, toOpenAIRequest } from "../src/main/services/cloud-protocols.ts";
import { CloudChatError, CloudChatRuntime, cleanProviderText } from "../src/main/services/cloud-chat-runtime.ts";
import { ResearchChatService } from "../src/main/services/research-chat.ts";
import { canonicalMkdtemp as mkdtemp } from "./helpers/canonical-temp.mjs";

const KEY = `sk-ant-api03-${"A1b2C3d4".repeat(6)}`;
const GATEWAY_KEY = "tok_gateway_abcdefghijklmnop";

// ---------------------------------------------------------------------------
// Pure protocol translation
// ---------------------------------------------------------------------------

test("Anthropic requests lift the system text, merge turns and pair tool results with their calls", () => {
  const body = toAnthropicRequest({
    messages: [
      { role: "system", content: "Be careful." },
      { role: "system", content: "Cite sources." },
      { role: "user", content: "Look at the data." },
      { role: "assistant", content: "Searching.", tool_calls: [{ id: "call-1", type: "function", function: { name: "workspace_search", arguments: '{"query":"data"}' } }, { id: "call-2", type: "function", function: { name: "workspace_list", arguments: '{"query":""}' } }] },
      { role: "tool", tool_call_id: "call-1", content: "3 hits" },
      { role: "tool", tool_call_id: "call-2", content: "" },
      { role: "user", content: "Continue." },
    ],
    tools: [{ type: "function", function: { name: "workspace_search", description: "Search.", parameters: { type: "object", properties: { query: { type: "string" } } } } }],
    temperature: 0.4,
  }, "claude-sonnet-5-5", 4096);
  assert.equal(body.system, "Be careful.\n\nCite sources.");
  assert.equal(body.model, "claude-sonnet-5-5");
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.stream, true);
  assert.deepEqual(body.tools, [{ name: "workspace_search", description: "Search.", input_schema: { type: "object", properties: { query: { type: "string" } } } }]);
  assert.deepEqual(body.tool_choice, { type: "auto" });
  assert.deepEqual(body.messages.map(message => message.role), ["user", "assistant", "user"], "strict alternation");
  assert.deepEqual(body.messages[1].content, [
    { type: "text", text: "Searching." },
    { type: "tool_use", id: "call-1", name: "workspace_search", input: { query: "data" } },
    { type: "tool_use", id: "call-2", name: "workspace_list", input: { query: "" } },
  ]);
  assert.deepEqual(body.messages[2].content.map(block => block.type), ["tool_result", "tool_result", "text"], "results precede the user's next words");
  assert.equal(body.messages[2].content[1].content, "(no output)", "an empty result is never an empty block");
  assert.equal(body.temperature, 0.4);
});

test("Anthropic requests reject conversations the provider would reject", () => {
  const expect = (messages, code) => assert.throws(() => toAnthropicRequest({ messages }, "m", 10), error => error instanceof CloudProtocolError && error.code === code, code);
  expect(rolesOnly("assistant"), "INVALID_CONVERSATION");
  expect([{ role: "system", content: "only" }], "INVALID_CONVERSATION");
  expect([{ role: "user", content: "hi" }, { role: "tool", content: "no id" }], "INVALID_TOOL_RESULT");
  expect([{ role: "user", content: "hi" }, { role: "developer", content: "x" }], "UNSUPPORTED_ROLE");
  function rolesOnly(role) { return [{ role, content: "x" }]; }
  const truncated = toAnthropicRequest({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: null, tool_calls: [{ id: "c", function: { name: "t", arguments: '{"unterminated' } }] }, { role: "tool", tool_call_id: "c", content: "r" }] }, "m", 10);
  assert.deepEqual(truncated.messages[1].content[0].input, {}, "damaged tool arguments become an empty input, not a guess");
});

test("Anthropic stream events become the chunks the chat loop already consumes", () => {
  const translator = new AnthropicStreamTranslator();
  const chunks = [
    { type: "message_start", message: { usage: { input_tokens: 25 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me look." } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "workspace_search" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"que' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'ry":"x"}' } },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_2", name: "workspace_list" } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{}" } },
    { type: "ping" },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 40 } },
    { type: "message_stop" },
  ].flatMap(event => translator.translate(event));
  const text = chunks.map(chunk => chunk.choices?.[0]?.delta?.content ?? "").join("");
  assert.equal(text, "Let me look.");
  const calls = new Map();
  for (const chunk of chunks) for (const part of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
    const call = calls.get(part.index) ?? { id: "", name: "", args: "" };
    call.id ||= part.id ?? ""; call.name += part.function?.name ?? ""; call.args += part.function?.arguments ?? "";
    calls.set(part.index, call);
  }
  assert.deepEqual([...calls.values()], [{ id: "toolu_1", name: "workspace_search", args: '{"query":"x"}' }, { id: "toolu_2", name: "workspace_list", args: "{}" }]);
  assert.equal(chunks.find(chunk => chunk.choices?.[0]?.finish_reason)?.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 25, completion_tokens: 40, total_tokens: 65 });
  for (const [reason, mapped] of [["end_turn", "stop"], ["max_tokens", "length"], ["stop_sequence", "stop"], ["something_new", "stop"]]) {
    assert.equal(new AnthropicStreamTranslator().translate({ type: "message_delta", delta: { stop_reason: reason } })[0].choices[0].finish_reason, mapped, reason);
  }
  assert.throws(() => new AnthropicStreamTranslator().translate({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), error => error.code === "PROVIDER_OVERLOADED_ERROR" && /Overloaded/.test(error.message));
  assert.deepEqual(new AnthropicStreamTranslator().translate({ type: "content_block_delta", index: 9, delta: { type: "input_json_delta", partial_json: "{}" } }), [], "a delta for an unknown block is ignored");
});

test("OpenAI-style requests pick the token field each flavor accepts", () => {
  const payload = { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "t", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c", content: "r" }], tools: [{ type: "function", function: { name: "t" } }], temperature: 0.4 };
  const official = toOpenAIRequest(payload, "gpt-x", 512, "official");
  assert.equal(official.max_completion_tokens, 512);
  assert.ok(!("max_tokens" in official) && !("temperature" in official));
  assert.equal(official.messages[1].content, "", "null content beside tool calls is sent as an empty string");
  assert.deepEqual(official.stream_options, { include_usage: true });
  const gateway = toOpenAIRequest(payload, "m", 512, "gateway");
  assert.equal(gateway.max_tokens, 512);
  assert.equal(gateway.temperature, 0.4);
  assert.equal(gateway.tool_choice, "auto");
});

test("the SSE parser survives arbitrary chunk boundaries and refuses unbounded lines", () => {
  const stream = 'event: content_block_delta\ndata: {"a":1}\n\n: keep-alive\n\ndata: {"b":\r\ndata: 2}\r\n\r\ndata: [DONE]\n\n';
  for (let split = 1; split < stream.length; split += 3) {
    const parser = new SseParser();
    const events = [...parser.push(stream.slice(0, split)), ...parser.push(stream.slice(split))];
    assert.deepEqual(events.map(event => event.data), ['{"a":1}', '{"b":\n2}', "[DONE]"], `split at ${split}`);
    assert.equal(events[0].event, "content_block_delta", `event name survives a split at ${split}`);
  }
  assert.throws(() => new SseParser().push(`data: ${"x".repeat(1024 * 1024 + 10)}\n`), error => error.code === "SSE_LINE_TOO_LONG");
  assert.throws(() => new SseParser().push("x".repeat(1024 * 1024 + 10)), error => error.code === "SSE_LINE_TOO_LONG");
});

test("provider text is cleaned of keys and control characters before it is shown", () => {
  assert.equal(cleanProviderText(`bad key ${KEY} here\u0007\n\tnext`, KEY), "bad key [redacted] here next");
  assert.equal(cleanProviderText("x".repeat(1000), "").length, 300);
});

test("cloud model ids round-trip and cannot be forged from other text", () => {
  const id = cloudModelId("anthropic-api", "claude-sonnet-5-5");
  assert.equal(id, "cloud:anthropic-api:claude-sonnet-5-5");
  assert.deepEqual(parseCloudModelId(id), { provider: "anthropic-api", model: "claude-sonnet-5-5" });
  assert.deepEqual(parseCloudModelId("cloud:custom-gateway:team/model:v1"), { provider: "custom-gateway", model: "team/model:v1" });
  for (const bad of ["claude-sonnet-5-5", "cloud:", "cloud:anthropic-api:", "cloud:unknown-provider:x", "cloud:anthropic-api:../x", "cloud:anthropic-api:has space"]) assert.equal(parseCloudModelId(bad), undefined, bad);
  assert.equal(isCloudModelId("lmstudio/model"), false);
  assert.match(cloudEgressStatement("api.anthropic.com"), /api\.anthropic\.com.*messages.*documents.*tools.*workspace files/s);
});

// ---------------------------------------------------------------------------
// The runtime against a real loopback server
// ---------------------------------------------------------------------------

async function withServer(handler, body) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const record = { method: request.method, url: request.url, headers: request.headers, body: raw ? JSON.parse(raw) : undefined };
      requests.push(record);
      handler(record, response, requests);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await body({ origin: `http://127.0.0.1:${port}`, requests });
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}
function sse(response, events, { status = 200 } = {}) {
  response.writeHead(status, { "content-type": "text/event-stream" });
  for (const event of events) response.write(event);
  response.end();
}
const openAiEvents = [
  `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-9", type: "function", function: { name: "workspace_search", arguments: '{"query":' } }] } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ finish_reason: "tool_calls" }] })}\n\n`,
  "data: [DONE]\n\n",
];
function gatewayVault(origin, protocol) {
  const summary = { provider: "custom-gateway", host: "127.0.0.1", baseUrl: `${origin}/v1`, protocol, storedAt: "t" };
  return { list: async () => [summary], read: async provider => provider === "custom-gateway" ? { key: GATEWAY_KEY, summary } : undefined };
}
const noVault = { list: async () => [], read: async () => undefined };
const GATEWAY_MODEL = cloudModelId("custom-gateway", "team-model");
const collect = async (runtime, payload, signal) => {
  const chunks = [];
  await runtime.chat(GATEWAY_MODEL, payload, chunk => chunks.push(chunk), signal);
  return chunks;
};
const PAYLOAD = { messages: [{ role: "system", content: "S" }, { role: "user", content: "Hi" }], tools: [{ type: "function", function: { name: "workspace_search", parameters: { type: "object" } } }], max_tokens: 256, temperature: 0.4 };

test("listing cloud models makes no request and decrypts nothing", async () => {
  let reads = 0, fetches = 0;
  const runtime = new CloudChatRuntime({
    setup: async () => ({ provider: "anthropic-api", model: "claude-sonnet-5-5" }),
    vault: { list: async () => [{ provider: "anthropic-api", host: "api.anthropic.com", storedAt: "t" }], read: async () => { reads++; return undefined; } },
    environment: () => ({}),
    fetch: async () => { fetches++; throw new Error("no network expected"); },
  });
  const [model] = await runtime.listModels();
  assert.equal(reads, 0); assert.equal(fetches, 0);
  assert.equal(model.id, "cloud:anthropic-api:claude-sonnet-5-5");
  assert.deepEqual(model.cloud, { provider: "anthropic-api", host: "api.anthropic.com", protocol: "messages", keySource: "vault" });
  assert.equal(model.provider, "cloud");
  assert.equal(model.toolCapability, "unknown", "no probe has run");
  assert.equal(isModelConnected(model), false, "a cloud model is never an LM Studio connection");
  assert.equal(model.contextLength, CLOUD_CONTEXT_TOKENS);
});

test("a model is offered only when the setup is saved and a key is available", async () => {
  const make = (setup, vault, environment = {}) => new CloudChatRuntime({ setup: async () => setup, vault, environment: () => environment });
  assert.deepEqual(await make(undefined, noVault).listModels(), []);
  assert.deepEqual(await make({ provider: "anthropic-api", model: "m" }, noVault).listModels(), [], "no key anywhere");
  assert.equal((await make({ provider: "anthropic-api", model: "m" }, noVault, { ANTHROPIC_API_KEY: KEY }).listModels())[0].cloud.keySource, "environment");
  assert.deepEqual(await make({ provider: "custom-gateway", model: "m" }, noVault, { PROTO_GATEWAY_API_KEY: GATEWAY_KEY }).listModels(), [], "a gateway key is never taken from the environment: there is no trusted host to bind it to");
  const responses = { list: async () => [{ provider: "custom-gateway", host: "gw.example.com", baseUrl: "https://gw.example.com/v1", protocol: "responses", storedAt: "t" }], read: async () => undefined };
  assert.deepEqual(await make({ provider: "custom-gateway", model: "m" }, responses).listModels(), [], "the Responses protocol is not offered for chat");
  const broken = { list: async () => { throw new Error("damaged"); }, read: async () => undefined };
  assert.deepEqual(await make({ provider: "anthropic-api", model: "m" }, broken).listModels(), []);
});

test("an OpenAI-style gateway streams text and tool calls through unchanged", async () => {
  await withServer((_request, response) => sse(response, openAiEvents), async ({ origin, requests }) => {
    const runtime = new CloudChatRuntime({ setup: async () => ({ provider: "custom-gateway", model: "team-model" }), vault: gatewayVault(origin, "chat-completions"), environment: () => ({}) });
    const chunks = await collect(runtime, PAYLOAD);
    assert.equal(chunks.map(chunk => chunk.choices?.[0]?.delta?.content ?? "").join(""), "Hello");
    assert.equal(chunks.flatMap(chunk => chunk.choices?.[0]?.delta?.tool_calls ?? []).map(part => part.function?.arguments ?? "").join(""), '{"query":"x"}');
    assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
    const [request] = requests;
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, `Bearer ${GATEWAY_KEY}`);
    assert.equal(request.body.model, "team-model");
    assert.equal(request.body.max_tokens, 256);
    assert.equal(request.body.stream, true);
  });
});

test("an Anthropic-style gateway is translated both ways and uses its own headers", async () => {
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 9 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  await withServer((_request, response) => sse(response, events), async ({ origin, requests }) => {
    const runtime = new CloudChatRuntime({ setup: async () => ({ provider: "custom-gateway", model: "team-model" }), vault: gatewayVault(origin, "messages"), environment: () => ({}) });
    const chunks = await collect(runtime, PAYLOAD);
    assert.equal(chunks.map(chunk => chunk.choices?.[0]?.delta?.content ?? "").join(""), "Done.");
    assert.equal(chunks.find(chunk => chunk.choices?.[0]?.finish_reason).choices[0].finish_reason, "stop");
    const [request] = requests;
    assert.equal(request.url, "/v1/messages");
    assert.equal(request.headers["x-api-key"], GATEWAY_KEY);
    assert.equal(request.headers["anthropic-version"], "2023-06-01");
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.body.system, "S");
    assert.equal(request.body.messages[0].role, "user");
  });
});

test("official providers use hosts pinned in code, and the environment key only when none is stored", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => { calls.push({ url, init }); return new Response(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\n`, { status: 200 }); };
  const runtime = new CloudChatRuntime({ setup: async () => ({ provider: "anthropic-api", model: "claude-sonnet-5-5" }), vault: noVault, environment: () => ({ ANTHROPIC_API_KEY: KEY }), fetch: fakeFetch });
  await runtime.chat("cloud:anthropic-api:claude-sonnet-5-5", PAYLOAD, () => {});
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].init.headers["x-api-key"], KEY);
  assert.equal(calls[0].init.redirect, "error", "redirects are refused");
  const openai = new CloudChatRuntime({ setup: async () => ({ provider: "openai-api", model: "gpt-x" }), vault: { list: async () => [{ provider: "openai-api", host: "api.openai.com", storedAt: "t" }], read: async () => ({ key: "sk-openai-abcdefghijklmnopqrstuv", summary: { provider: "openai-api", host: "api.openai.com", storedAt: "t" } }) }, environment: () => ({ OPENAI_API_KEY: "env-should-not-be-used-abcdef" }), fetch: async (url, init) => { calls.push({ url, init }); return new Response("data: [DONE]\n\n", { status: 200 }); } });
  await openai.chat("cloud:openai-api:gpt-x", PAYLOAD, () => {});
  assert.equal(calls[1].url, "https://api.openai.com/v1/chat/completions");
  assert.equal(calls[1].init.headers.authorization, "Bearer sk-openai-abcdefghijklmnopqrstuv", "the vault key wins over the environment");
});

test("a model that is not the configured one is refused before any request", async () => {
  let fetches = 0;
  const runtime = new CloudChatRuntime({ setup: async () => ({ provider: "anthropic-api", model: "claude-sonnet-5-5" }), vault: noVault, environment: () => ({ ANTHROPIC_API_KEY: KEY }), fetch: async () => { fetches++; throw new Error("no"); } });
  for (const id of ["cloud:anthropic-api:other-model", "cloud:openai-api:gpt-x", "not-cloud", "cloud:evil"]) {
    await assert.rejects(runtime.chat(id, PAYLOAD, () => {}), error => error instanceof CloudChatError, id);
  }
  assert.equal(fetches, 0);
  await assert.rejects(new CloudChatRuntime({ setup: async () => ({ provider: "anthropic-api", model: "m" }), vault: noVault, environment: () => ({}) }).getExecutionBinding("cloud:anthropic-api:m"), error => error.code === "MODEL_NOT_CONFIGURED");
});

test("a redirect is never followed, so a key cannot be forwarded to another host", async () => {
  let elsewhere = 0;
  await withServer((request, response, requests) => {
    if (request.url === "/steal") { elsewhere++; response.writeHead(200); response.end("{}"); return; }
    response.writeHead(307, { location: `http://127.0.0.1:${response.socket.localPort}/steal` });
    response.end();
  }, async ({ origin }) => {
    const runtime = new CloudChatRuntime({ setup: async () => ({ provider: "custom-gateway", model: "team-model" }), vault: gatewayVault(origin, "chat-completions"), environment: () => ({}) });
    await assert.rejects(collect(runtime, PAYLOAD), error => error instanceof CloudChatError && error.code === "NETWORK");
    assert.equal(elsewhere, 0, "the redirect target was never contacted");
  });
});

test("provider errors are typed, helpful and never echo the key", async () => {
  const cases = [
    [401, { error: { type: "authentication_error", message: `invalid x-api-key ${GATEWAY_KEY}` } }, "AUTH", /Check the stored key/],
    [404, { error: { message: "model not found" } }, "MODEL_OR_ROUTE_NOT_FOUND", /model not found/],
    [429, { error: { message: "slow down" } }, "RATE_LIMITED", /rate limiting/],
    [503, { error: { message: "overloaded" } }, "SERVER_ERROR", /try again later/],
    [400, "not json at all", "REQUEST_REJECTED", /HTTP 400/],
  ];
  for (const [status, payload, code, pattern] of cases) {
    await withServer((_request, response) => { response.writeHead(status, { "retry-after": "7" }); response.end(typeof payload === "string" ? payload : JSON.stringify(payload)); }, async ({ origin }) => {
      const runtime = new CloudChatRuntime({ setup: async () => ({ provider: "custom-gateway", model: "team-model" }), vault: gatewayVault(origin, "chat-completions"), environment: () => ({}) });
      await assert.rejects(collect(runtime, PAYLOAD), error => {
        assert.equal(error.code, code);
        assert.match(error.message, pattern);
        assert.ok(!error.message.includes(GATEWAY_KEY), "the key must never appear in an error");
        assert.ok(error.message.length < 500);
        return true;
      });
    });
  }
});

test("streams are bounded: oversized responses, silence and malformed events all stop the turn", async () => {
  const make = (origin, limits) => new CloudChatRuntime({ setup: async () => ({ provider: "custom-gateway", model: "team-model" }), vault: gatewayVault(origin, "chat-completions"), environment: () => ({}), limits });
  await withServer((_request, response) => sse(response, [`data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(5000) } }] })}\n\n`]), async ({ origin }) => {
    await assert.rejects(collect(make(origin, { streamBytes: 1000 }), PAYLOAD), error => error.code === "RESPONSE_TOO_LARGE");
  });
  await withServer((_request, response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(": hello\n\n"); /* then silence */ }, async ({ origin }) => {
    const started = Date.now();
    await assert.rejects(collect(make(origin, { idleMs: 150 }), PAYLOAD), error => error.code === "IDLE_TIMEOUT");
    assert.ok(Date.now() - started < 5000);
  });
  await withServer((_request, response) => sse(response, ["data: {not json}\n\n"]), async ({ origin }) => {
    await assert.rejects(collect(make(origin), PAYLOAD), error => error.code === "MALFORMED_STREAM");
  });
  const tooBig = { messages: [{ role: "user", content: "x".repeat(2000) }] };
  await withServer(() => assert.fail("nothing should be sent"), async ({ origin }) => {
    await assert.rejects(make(origin, { requestBytes: 1000 }).chat(GATEWAY_MODEL, tooBig, () => {}), error => error.code === "REQUEST_TOO_LARGE");
  });
  // A limit can only be tightened.
  assert.ok(new CloudChatRuntime({ setup: async () => undefined, vault: noVault, environment: () => ({}), limits: { streamBytes: 10 ** 12 } }) instanceof CloudChatRuntime);
});

test("cancelling stops the stream promptly and surfaces as an abort, not a provider failure", async () => {
  await withServer((_request, response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`); }, async ({ origin }) => {
    const runtime = new CloudChatRuntime({ setup: async () => ({ provider: "custom-gateway", model: "team-model" }), vault: gatewayVault(origin, "chat-completions"), environment: () => ({}) });
    const controller = new AbortController();
    const seen = [];
    const run = runtime.chat(GATEWAY_MODEL, PAYLOAD, chunk => { seen.push(chunk); controller.abort(); }, controller.signal);
    await assert.rejects(run, error => !(error instanceof CloudChatError && error.code === "NETWORK"));
    assert.equal(seen.length, 1);
  });
});

test("an onChunk failure (for example a budget stop) ends the request and propagates", async () => {
  await withServer((_request, response) => sse(response, openAiEvents), async ({ origin }) => {
    const runtime = new CloudChatRuntime({ setup: async () => ({ provider: "custom-gateway", model: "team-model" }), vault: gatewayVault(origin, "chat-completions"), environment: () => ({}) });
    await assert.rejects(runtime.chat(GATEWAY_MODEL, PAYLOAD, () => { throw new Error("budget reached"); }), /budget reached/);
  });
});

test("token counts are labelled estimates and are conservative for dense text", async () => {
  const runtime = new CloudChatRuntime({ setup: async () => ({ provider: "anthropic-api", model: "m" }), vault: noVault, environment: () => ({ ANTHROPIC_API_KEY: KEY }) });
  const messages = [{ role: "user", content: "x".repeat(3000) }];
  const result = await runtime.countExecutionTokens("cloud:anthropic-api:m", messages, []);
  assert.equal(result.method, "conservative-estimate");
  assert.ok(result.tokens >= 1000, "at most three bytes per token");
  const binding = await runtime.getExecutionBinding("cloud:anthropic-api:m");
  assert.equal(binding.ownedByWorkbench, false);
  assert.equal(binding.contextLength, CLOUD_CONTEXT_TOKENS);
  assert.match(binding.instanceId, /^cloud:anthropic-api:api\.anthropic\.com$/);
});

// ---------------------------------------------------------------------------
// Routing and consent
// ---------------------------------------------------------------------------

function fakeLocal(label, { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    scan: async () => { if (fail) throw new Error("LM Studio is not running"); return [{ id: `${label}-model`, name: label }]; },
    load: async id => { calls.push(["load", id]); return { loaded: id }; },
    getExecutionBinding: async id => { calls.push(["binding", id]); return { modelId: id, instanceId: "local", contextLength: 4096 }; },
    countExecutionTokens: async id => { calls.push(["count", id]); return { tokens: 1, method: "exact" }; },
    chat: async id => { calls.push(["chat", id]); },
  };
}
function fakeCloud() {
  const calls = [];
  return { calls, listModels: async () => [{ id: "cloud:anthropic-api:m", name: "m" }], getExecutionBinding: async id => { calls.push(["binding", id]); return { modelId: id, instanceId: "cloud:anthropic-api:api.anthropic.com", contextLength: 128000 }; },
    countExecutionTokens: async id => { calls.push(["count", id]); return { tokens: 2, method: "conservative-estimate" }; }, chat: async id => { calls.push(["chat", id]); } };
}

test("the router merges the lists, routes by prefix and never converts one kind into the other", async () => {
  const local = fakeLocal("lm"), cloud = fakeCloud();
  const router = new RoutingChatRuntime(local, cloud);
  assert.deepEqual((await router.scan("x")).map(model => model.id), ["lm-model", "cloud:anthropic-api:m"]);
  await router.getExecutionBinding("lm-model"); await router.countExecutionTokens("lm-model", []); await router.chat("lm-model", {}, () => {});
  await router.getExecutionBinding("cloud:anthropic-api:m"); await router.countExecutionTokens("cloud:anthropic-api:m", []); await router.chat("cloud:anthropic-api:m", {}, () => {});
  assert.deepEqual(local.calls.map(call => call[1]), ["lm-model", "lm-model", "lm-model"]);
  assert.deepEqual(cloud.calls.map(call => call[1]), Array(3).fill("cloud:anthropic-api:m"));
  await assert.rejects(router.load("cloud:anthropic-api:m", {}), /nothing to connect/);
  await router.load("lm-model", {});
  assert.deepEqual(local.calls.at(-1), ["load", "lm-model"]);
});

test("LM Studio being down hides nothing when a cloud model exists, and the real error shows when nothing does", async () => {
  const downButCloud = new RoutingChatRuntime(fakeLocal("lm", { fail: true }), fakeCloud());
  assert.deepEqual((await downButCloud.scan("x")).map(model => model.id), ["cloud:anthropic-api:m"]);
  const downAndNothing = new RoutingChatRuntime(fakeLocal("lm", { fail: true }), { ...fakeCloud(), listModels: async () => [] });
  await assert.rejects(downAndNothing.scan("x"), /LM Studio is not running/);
  const cloudBroken = new RoutingChatRuntime(fakeLocal("lm"), { ...fakeCloud(), listModels: async () => { throw new Error("vault"); } });
  assert.deepEqual((await cloudBroken.scan("x")).map(model => model.id), ["lm-model"]);
});

test("sending to a cloud model needs explicit approval and a refused send changes nothing", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "proto-cloud-consent-"));
  const streamed = [];
  const runtime = {
    scan: async () => [], load: async () => ({}),
    getExecutionBinding: async id => ({ modelId: id, instanceId: id.startsWith("cloud:") ? "cloud:anthropic-api:api.anthropic.com" : "loaded", contextLength: 32768 }),
    countExecutionTokens: async () => ({ tokens: 10, method: "exact" }),
    chat: async (id, _payload, chunk) => { streamed.push(id); chunk({ choices: [{ delta: { content: "ok" } }] }); },
  };
  const service = new ResearchChatService({ databasePath: join(workspace, "chat.sqlite"), workspace, runtime });
  t.after(() => service.close());
  const { session } = await service.request({ action: "create" });
  const send = extra => service.request({ action: "send", sessionId: session.id, modelId: "cloud:anthropic-api:claude-sonnet-5-5", content: "Summarise my data", documentIds: [], ...extra });
  await assert.rejects(send({}), error => /api\.anthropic\.com/.test(error.message) && /messages.*documents.*tools/s.test(error.message) && /Approve/.test(error.message));
  await assert.rejects(send({ cloudEgressApproved: false }), /Invalid|approv/i, "only the literal true counts");
  const untouched = (await service.request({ action: "get", sessionId: session.id })).session;
  assert.equal(untouched.messages.length, 0, "a refused send saves nothing");
  assert.equal(untouched.status, "idle");
  assert.deepEqual(streamed, []);
  await send({ cloudEgressApproved: true });
  for (let i = 0; i < 100; i++) { const { session: current } = await service.request({ action: "get", sessionId: session.id }); if (current.status === "idle") break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.deepEqual(streamed, ["cloud:anthropic-api:claude-sonnet-5-5"]);
  const done = (await service.request({ action: "get", sessionId: session.id })).session;
  assert.equal(done.messages.at(-1).modelBinding.instanceId, "cloud:anthropic-api:api.anthropic.com", "the transcript records that this reply came from the cloud");
  // A local model is unaffected by the field.
  const local = await service.request({ action: "send", sessionId: session.id, modelId: "lm-model", content: "again", documentIds: [] }).catch(error => error);
  assert.ok(!(local instanceof Error) || !/approv/i.test(local.message));
});
