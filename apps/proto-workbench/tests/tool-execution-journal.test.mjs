import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { McpClient } from "../src/main/services/mcp-client.ts";
import { ToolExecutionJournal } from "../src/main/services/tool-execution-journal.ts";
import { RuntimeFailure } from "../src/main/services/runtime-control.ts";

const paths = { packaged: false, resourcesPath: "C:/fixture", repoRoot: "C:/fixture", workspacePath: "C:/workspace", workspaceCapability: "42".repeat(32) };
const makeIdentity = (overrides = {}) => ({
  operationId: "operation-1",
  runId: "run-1",
  scope: { surface: "compute", scopeId: "run-1" },
  tool: "proto_compute_run",
  arguments: { path: "build/compute-inputs/operation-1.json" },
  effect: "write",
  ...overrides,
});

function connected(options = {}) {
  const client = new McpClient(paths, options);
  const sent = [];
  const child = { exitCode: null, stdin: { write(text, callback) { sent.push(JSON.parse(text)); callback?.(); } } };
  client.child = child;
  return { client, sent };
}

async function reply(client, sent, structuredContent) {
  await new Promise(resolve => setImmediate(resolve));
  const request = sent.filter(message => message.method === "tools/call").at(-1);
  assert.ok(request, "the test operation was dispatched");
  client.handleLine(JSON.stringify({ id: request.id, result: { structuredContent } }));
}

test("a durable receipt is returned exactly for the same operation without another dispatch", async () => {
  const db = new DatabaseSync(":memory:");
  const journal = new ToolExecutionJournal(db), { client, sent } = connected({ journal });
  const input = makeIdentity();
  const call = client.call(input.tool, input.arguments, undefined, undefined, input);
  await reply(client, sent, { ok: true, run_id: "saved-run", details: { value: 2 } });
  const receipt = await call;
  const replay = await client.call(input.tool, input.arguments, undefined, undefined, input);
  assert.deepEqual(replay, receipt);
  assert.equal(sent.filter(message => message.method === "tools/call").length, 1);
  assert.equal(journal.get(input.operationId).state, "completed");
  db.close();
});

test("a write interrupted after dispatch stays unknown and cannot be dispatched again", async () => {
  const db = new DatabaseSync(":memory:");
  const journal = new ToolExecutionJournal(db), { client, sent } = connected({ journal });
  const input = makeIdentity();
  const call = client.call(input.tool, input.arguments, undefined, undefined, input);
  await new Promise(resolve => setImmediate(resolve));
  client.rejectAll(new RuntimeFailure("TOOL_SESSION_INTERRUPTED", "test", "Controlled interruption.", { effectState: "unknown" }));
  await assert.rejects(call, error => error.effectState === "unknown");
  assert.equal(journal.get(input.operationId).state, "effect-unknown");
  const dispatched = sent.filter(message => message.method === "tools/call").length;
  await assert.rejects(client.call(input.tool, input.arguments, undefined, undefined, input), error => error.code === "TOOL_EFFECT_UNKNOWN" && error.effectState === "unknown");
  assert.equal(sent.filter(message => message.method === "tools/call").length, dispatched);
  db.close();
});

test("a pre-dispatch cancellation records no effect and allows the same operation to be retried", async () => {
  const db = new DatabaseSync(":memory:");
  const journal = new ToolExecutionJournal(db), { client, sent } = connected({ journal });
  const input = makeIdentity(), controller = new AbortController();
  controller.abort();
  await assert.rejects(client.call(input.tool, input.arguments, controller.signal, undefined, input), error => error.code === "USER_CANCELLED");
  assert.equal(journal.get(input.operationId).state, "no-effect");
  const call = client.call(input.tool, input.arguments, undefined, undefined, input);
  await reply(client, sent, { ok: true, run_id: "retry-run" });
  assert.equal((await call).run_id, "retry-run");
  assert.equal(sent.filter(message => message.method === "tools/call").length, 1);
  db.close();
});

test("read-only interruption is retryable, while operation IDs reject changed arguments", async () => {
  const db = new DatabaseSync(":memory:");
  const journal = new ToolExecutionJournal(db), { client, sent } = connected({ journal });
  const read = { operationId: "read-1", scope: { surface: "compute", scopeId: "run-1" }, tool: "proto_compute_catalog", arguments: {}, effect: "read" };
  const first = client.call(read.tool, read.arguments, undefined, undefined, read);
  await new Promise(resolve => setImmediate(resolve));
  client.rejectAll(new RuntimeFailure("TOOL_SESSION_INTERRUPTED", "test", "Controlled read interruption.", { effectState: "unknown" }));
  await assert.rejects(first);
  assert.equal(journal.get(read.operationId).state, "no-effect");
  const retry = client.call(read.tool, read.arguments, undefined, undefined, read);
  await reply(client, sent, { ok: true, tools: [] });
  assert.deepEqual(await retry, { ok: true, tools: [] });
  assert.equal(sent.filter(message => message.method === "tools/call").length, 2);
  await assert.rejects(client.call(read.tool, { changed: true }, undefined, undefined, read), error => error.code === "TOOL_OPERATION_CONFLICT");
  db.close();
});

test("a dispatched operation without an observed receipt is unknown after journal reopen", () => {
  const db = new DatabaseSync(":memory:");
  const identity = makeIdentity(), first = new ToolExecutionJournal(db), lease = first.begin(identity);
  assert.equal(lease.kind, "start");
  first.markDispatched(identity, lease.leaseId);
  const recovered = new ToolExecutionJournal(db);
  assert.throws(() => recovered.begin(identity), error => error.code === "TOOL_EFFECT_UNKNOWN" && error.effectState === "unknown");
  assert.equal(recovered.get(identity.operationId).state, "effect-unknown");
  db.close();
});

test("a tool-reported unknown effect keeps its structured observation but is never replayed", async () => {
  const db = new DatabaseSync(":memory:");
  const journal = new ToolExecutionJournal(db), { client, sent } = connected({ journal });
  const input = makeIdentity(), observed = { ok: false, effect_state: "unknown", message: "The provider did not confirm completion." };
  const call = client.call(input.tool, input.arguments, undefined, undefined, input);
  await reply(client, sent, observed);
  assert.deepEqual(await call, observed);
  const stored = journal.get(input.operationId);
  assert.equal(stored.state, "effect-unknown");
  assert.deepEqual(stored.receipt, { structuredContent: observed });
  await assert.rejects(client.call(input.tool, input.arguments, undefined, undefined, input), error => error.code === "TOOL_EFFECT_UNKNOWN");
  assert.equal(sent.filter(message => message.method === "tools/call").length, 1);
  db.close();
});

test("concurrent duplicates are coalesced by refusal and do not dispatch twice", async () => {
  const db = new DatabaseSync(":memory:");
  const journal = new ToolExecutionJournal(db), { client, sent } = connected({ journal });
  const input = makeIdentity({ operationId: randomBytes(8).toString("hex") });
  const first = client.call(input.tool, input.arguments, undefined, undefined, input);
  await assert.rejects(client.call(input.tool, input.arguments, undefined, undefined, input), error => error.code === "TOOL_OPERATION_IN_PROGRESS");
  await reply(client, sent, { ok: true, run_id: "single-dispatch" });
  await first;
  assert.equal(sent.filter(message => message.method === "tools/call").length, 1);
  db.close();
});
