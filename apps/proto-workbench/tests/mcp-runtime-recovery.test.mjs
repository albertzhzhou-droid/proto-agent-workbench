import assert from "node:assert/strict";
import test from "node:test";
import {EventEmitter} from "node:events";
import { McpClient, toolDeadlineMs, MCP_MAX_TOOL_TIMEOUT_MS, MCP_CANCELLATION_GRACE_MS } from "../src/main/services/mcp-client.ts";

const paths = { packaged: false, resourcesPath: "C:/fixture", repoRoot: "C:/fixture", workspacePath: "C:/workspace", workspaceCapability: "42".repeat(32) };

function connected(options = {}) {
  const client = new McpClient(paths, options);
  const sent = [];
  const terminated = [];
  const child = { exitCode: null, stdin: { write(text, callback) { sent.push(JSON.parse(text)); callback?.(); } } };
  client.child = child;
  client.terminateCurrent = async (error) => {
    terminated.push(error);
    client.child = undefined;
    client.rejectAll(error);
  };
  return { client, sent, terminated, child };
}

test("execution request deadline covers the complete Python limit plus cleanup", () => {
  assert.equal(MCP_CANCELLATION_GRACE_MS, 10_000);
  assert.equal(toolDeadlineMs("proto_run_analysis", { timeout: 600 }), 630_000);
  assert.equal(toolDeadlineMs("proto_run_notebook", { timeout: 240 }), 270_000);
  assert.equal(toolDeadlineMs("proto_workflow_run", {}), MCP_MAX_TOOL_TIMEOUT_MS);
  assert.throws(() => toolDeadlineMs("proto_run_r", { timeout: 601 }), /600/);
});

test("cancelling A leaves B live when the per-request worker acknowledges completion", async () => {
  const { client, sent, terminated } = connected({ cancellationGraceMs: 25 });
  const controller = new AbortController();
  const a = client.call("proto_check", {}, controller.signal);
  const rejected = assert.rejects(a, (error) => error.code === "USER_CANCELLED");
  const b = client.call("proto_check", {});
  await new Promise((resolve) => setImmediate(resolve));
  const [requestA, requestB] = sent.filter((message) => message.method === "tools/call");
  controller.abort();
  await rejected;
  assert.equal(terminated.length, 0);
  assert.equal(sent.at(-1).method, "notifications/cancelled");
  assert.equal(sent.at(-1).params.requestId, requestA.id);
  client.handleLine(JSON.stringify({ method: "notifications/proto-request-finished", params: { requestId: requestA.id } }));
  client.handleLine(JSON.stringify({ id: requestB.id, result: { structuredContent: { ok: true, value: "B completed" } } }));
  assert.equal((await b).value, "B completed");
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(terminated.length, 0);
});

test("a worker without cancellation acknowledgement is terminated only after grace", async () => {
  const { client, terminated } = connected({ cancellationGraceMs: 20 });
  const controller = new AbortController();
  const call = client.call("proto_check", {}, controller.signal);
  const rejected = assert.rejects(call, (error) => error.name === "AbortError");
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await rejected;
  assert.equal(terminated.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(terminated.length, 1);
  assert.equal(terminated[0].code, "TOOL_SESSION_INTERRUPTED");
});

test("tool deadline returns structured timeout and a late result clears forced cleanup", async () => {
  const { client, sent, terminated } = connected({ cancellationGraceMs: 30 });
  const call = client.call("proto_check", {}, undefined, undefined, { timeoutMs: 10 });
  // The keepalive represents the owning task; production timers are deliberately unref'ed.
  const hold = setTimeout(() => {}, 100);
  try {
    await assert.rejects(call, (error) => error.code === "TOOL_TIMEOUT" && error.effectState === "unknown");
    const request = sent.find((message) => message.method === "tools/call");
    client.handleLine(JSON.stringify({ id: request.id, result: { structuredContent: { ok: true } } }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(terminated.length, 0);
  } finally { clearTimeout(hold); }
});

test("progress is request-bound, monotonic, bounded, and never resets the hard deadline", async () => {
  const { client, sent } = connected();
  const progress = [];
  const call = client.call("proto_check", {}, undefined, undefined, { onProgress: (value) => progress.push(value) });
  await new Promise((resolve) => setImmediate(resolve));
  const request = sent[0];
  assert.equal(request.params._meta.progressToken, request.id);
  const notify = (params) => client.handleLine(JSON.stringify({ method: "notifications/progress", params }));
  notify({ progressToken: request.id, progress: 2, total: 4, message: "x".repeat(1500) });
  notify({ progressToken: request.id, progress: 1, total: 4 });
  notify({ progressToken: request.id + 1, progress: 3, total: 4 });
  notify({ progressToken: request.id, progress: 5, total: 4 });
  assert.equal(progress.length, 1);
  assert.equal(progress[0].message.length, 1024);
  client.handleLine(JSON.stringify({ id: request.id, result: { structuredContent: { ok: true } } }));
  await call;
});

test("forked run sessions have independent pending and process state", async () => {
  const root = new McpClient(paths, { cancellationGraceMs: 20 });
  const a = root.fork();
  const b = root.createSession();
  assert.notEqual(a, b);
  assert.notEqual(a.pending, b.pending);
  assert.notEqual(a.paths, b.paths);
  assert.equal(a.paths.workspaceCapability, b.paths.workspaceCapability);
  await a.stop();
  assert.equal(a.stopped, true);
  assert.equal(b.stopped, false);
});

test("stop joins an owned process termination already started by a protocol failure", async () => {
  const client = new McpClient(paths), child = new EventEmitter();
  // Controlled process-handle fixture: no PID means no OS process is targeted.
  child.exitCode = null; child.signalCode = null; client.child = child;
  const protocolCleanup = client.terminateCurrent(new Error("Controlled protocol failure"));
  assert.equal(client.child, undefined);
  assert.equal(client.terminatingChildren.size, 1);
  let settled = false;
  const teardown = client.stop().then(() => {settled = true;});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "detached child handle is not proof of completed cleanup");
  child.exitCode = 0; child.emit("exit", 0);
  await Promise.all([protocolCleanup, teardown]);
  assert.equal(settled, true); assert.equal(client.terminatingChildren.size, 0);
});
