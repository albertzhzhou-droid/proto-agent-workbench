import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { McpClient } from "../src/main/services/mcp-client.ts";
import { invokeJournaledTool, recordPolicyDenial } from "../src/main/services/execution-kernel.ts";
import { evaluateToolPolicy } from "../src/main/services/permissions.ts";
import { ToolExecutionJournal, executionActivityState } from "../src/main/services/tool-execution-journal.ts";

const paths = { packaged: false, resourcesPath: "C:/fixture", repoRoot: "C:/fixture", workspacePath: "C:/workspace", workspaceCapability: "42".repeat(32) };
const scope = { surface: "compute", scopeId: "request-1" };
function fixture() {
  const db = new DatabaseSync(":memory:"), journal = new ToolExecutionJournal(db);
  return { db, journal };
}
function request(journal, effect, operationId = "operation-1") {
  return { journal, operationId, scope, tool: effect === "read" ? "proto_pubmed_search" : "proto_compute_run", arguments: { value: 1 } };
}
function connected(journal) {
  const client = new McpClient(paths, { journal }), sent = [];
  client.child = { exitCode: null, stdin: { write(text, callback) { sent.push(JSON.parse(text)); callback?.(); } } };
  return { client, sent };
}

for (const effect of ["read", "write"]) for (const fault of ["intent", "dispatched", "server-rejection", "tool-error", "timeout", "process-exit"]) {
  test(`fault matrix: ${effect} / ${fault} preserves state, activity and retry behavior`, async () => {
    const { db, journal } = fixture(), input = request(journal, effect);
    let calls = 0;
    const dispatch = async mark => {
      calls++;
      if (fault === "intent") throw new Error("Crash before dispatch");
      mark();
      if (fault === "server-rejection") throw Object.assign(new Error("Server rejected parameters"), { effectState: "none" });
      if (fault === "tool-error") return { isError: true, content: [{ type: "text", text: "Tool failed with retained diagnostic" }] };
      throw new Error(`Injected ${fault}`);
    };
    if (fault === "tool-error") await invokeJournaledTool(input, dispatch);
    else await assert.rejects(invokeJournaledTool(input, dispatch));
    const unknown = effect === "write" && ["dispatched", "timeout", "process-exit"].includes(fault);
    const record = journal.get(input.operationId);
    assert.equal(record.state, unknown ? "effect-unknown" : fault === "tool-error" ? "completed" : "no-effect");
    assert.equal(record.outcome, fault === "tool-error" ? "tool-error" : undefined);
    assert.equal(executionActivityState(record), unknown ? "effect-unknown" : "error");
    if (unknown) {
      await assert.rejects(invokeJournaledTool(input, dispatch), error => error.code === "TOOL_EFFECT_UNKNOWN");
      assert.equal(calls, 1);
    } else if (fault === "tool-error") {
      const replay = await invokeJournaledTool(input, dispatch);
      assert.equal(replay.content[0].text, "Tool failed with retained diagnostic");
      assert.equal(calls, 1);
    } else {
      await invokeJournaledTool(input, async mark => { calls++; mark(); return { ok: true }; });
      assert.equal(calls, 2);
      assert.equal(executionActivityState(journal.get(input.operationId)), "complete");
    }
    db.close();
  });
}

test("MCP text-only errors and full content envelopes replay exactly without losing failure", async () => {
  const { db, journal } = fixture(), { client, sent } = connected(journal);
  const options = { scope, operationId: "text-error" }, envelope = { isError: true, content: [{ type: "text", text: "Precise server diagnostic" }], _meta: { trace: "trace-1" } };
  const pending = client.callEnvelope("proto_compute_run", {}, undefined, undefined, options);
  await new Promise(resolve => setImmediate(resolve));
  client.handleLine(JSON.stringify({ id: sent[0].id, result: envelope }));
  assert.deepEqual(await pending, envelope);
  assert.deepEqual(await client.callEnvelope("proto_compute_run", {}, undefined, undefined, options), envelope);
  assert.deepEqual(await client.call("proto_compute_run", {}, undefined, undefined, options), envelope);
  assert.deepEqual(journal.get("text-error").receipt, envelope);
  assert.equal(journal.get("text-error").outcome, "tool-error");
  assert.equal(sent.length, 1);
  db.close();
});

test("MCP structured errors keep text and are never promoted to successful receipts", async () => {
  const { db, journal } = fixture(), { client, sent } = connected(journal);
  const options = { scope, operationId: "structured-error" };
  const envelope = { isError: true, structuredContent: { details: { source: 1 } }, content: [{ type: "text", text: "Tool detail" }] };
  const pending = client.call("proto_compute_run", {}, undefined, undefined, options);
  await new Promise(resolve => setImmediate(resolve));
  client.handleLine(JSON.stringify({ id: sent[0].id, result: envelope }));
  const result = await pending;
  assert.deepEqual(result, { details: { source: 1 }, isError: true, ok: false, content: envelope.content });
  assert.deepEqual(await client.call("proto_compute_run", {}, undefined, undefined, options), result);
  assert.equal(sent.length, 1);
  db.close();
});

test("a server JSON-RPC no-effect rejection settles a dispatched write", async () => {
  const { db, journal } = fixture(), { client, sent } = connected(journal);
  const pending = client.call("proto_compute_run", {}, undefined, undefined, { scope, operationId: "rejected" });
  await new Promise(resolve => setImmediate(resolve));
  client.handleLine(JSON.stringify({ id: sent[0].id, error: { code: -32602, message: "Invalid input", data: { effect_state: "none" } } }));
  await assert.rejects(pending, error => error.effectState === "none" && error.code === -32602);
  assert.equal(journal.get("rejected").state, "no-effect");
  db.close();
});

test("a no-effect tool-error envelope is replayed, while its state remains no-effect", async () => {
  const { db, journal } = fixture(), input = request(journal, "write");
  const envelope = { isError: true, structuredContent: { ok: false, effect_state: "none" }, content: [{ type: "text", text: "Input rejected" }] };
  await invokeJournaledTool(input, async mark => { mark(); return envelope; });
  assert.equal(journal.get(input.operationId).state, "no-effect");
  assert.equal(journal.get(input.operationId).outcome, "tool-error");
  assert.deepEqual(await invokeJournaledTool(input, async () => { throw new Error("Must not dispatch"); }), envelope);
  db.close();
});

test("unknown tools fail before dispatch and an effect override cannot turn a write into a read", async () => {
  const { db, journal } = fixture();
  let calls = 0;
  await assert.rejects(invokeJournaledTool({ ...request(journal, "write"), tool: "unregistered_tool" }, async mark => { calls++; mark(); return { ok: true }; }), error => error.code === "UNKNOWN_CAPABILITY");
  assert.equal(calls, 0);
  assert.equal(journal.get("operation-1"), undefined);
  await assert.rejects(invokeJournaledTool({ ...request(journal, "write"), effect: "read" }, async mark => { mark(); throw new Error("Process exit"); }));
  assert.equal(journal.get("operation-1").effect, "write");
  assert.equal(journal.get("operation-1").state, "effect-unknown");
  db.close();
});

test("production MCP requires explicit scope and preserves the same contract across entry points", async () => {
  const { db, journal } = fixture(), { client, sent } = connected(journal);
  await assert.rejects(client.call("proto_compute_run", {}), /TOOL_EXECUTION_SCOPE_REQUIRED/);
  assert.equal(sent.length, 0);
  for (const surface of ["chat", "compute", "workflow"]) {
    await invokeJournaledTool({ ...request(journal, "write", surface), scope: { surface, scopeId: "same-request" } }, async mark => { mark(); return { ok: true }; });
    assert.equal(journal.get(surface).effect, "write");
    assert.equal(journal.get(surface).scope.surface, surface);
  }
  db.close();
});

test("reconciliation is evidence-bound, append-only, final and does not reexecute either verdict", async () => {
  const { db, journal } = fixture();
  for (const verdict of ["applied", "not-applied"]) {
    const input = request(journal, "write", `reconcile-${verdict}`);
    await assert.rejects(invokeJournaledTool(input, async mark => { mark(); throw new Error("Lost receipt"); }));
    assert.throws(() => journal.reconcile(input.operationId, verdict, "", "evidence"), /TOOL_RECONCILIATION_INVALID/);
    const record = journal.reconcile(input.operationId, verdict, "reviewer", "build/evidence/inspection.json");
    assert.equal(record.state, `reconciled-${verdict}`);
    assert.notEqual(executionActivityState(record), "effect-unknown");
    assert.equal(journal.reconciliationHistory(input.operationId)[0].actor, "reviewer");
    await assert.rejects(invokeJournaledTool(input, async () => { throw new Error("Must not dispatch"); }), error => error.code === "TOOL_OPERATION_RECONCILED");
    assert.throws(() => journal.reconcile(input.operationId, verdict, "reviewer", "duplicate"), /REQUIRES_UNKNOWN_EFFECT/);
  }
  assert.throws(() => db.exec("DELETE FROM tool_execution_reconciliations"), /append-only/);
  assert.throws(() => db.exec("UPDATE tool_execution_reconciliations SET actor='changed'"), /append-only/);
  db.close();
});

test("v1 migration retains exact receipts and refuses orphaned writes without claiming a legacy outcome", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE tool_execution_journal(operation_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,tool TEXT NOT NULL,effect TEXT NOT NULL CHECK(effect IN ('read','write')),arguments_sha256 TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('intent','dispatched','no-effect','effect-unknown','completed')),receipt_json TEXT,receipt_sha256 TEXT,receipt_bytes INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
  const payload = JSON.stringify({ ok: false, detail: "legacy failure" }), sha = value => createHash("sha256").update(value).digest("hex");
  db.prepare("INSERT INTO tool_execution_journal VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("legacy-complete", "run-1", "proto_compute_run", "write", sha("{}"), "completed", payload, sha(payload), Buffer.byteLength(payload), "2026-09-01", "2026-09-01");
  db.prepare("INSERT INTO tool_execution_journal VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("legacy-dispatched", "run-1", "proto_compute_run", "write", sha("{}"), "dispatched", null, null, null, "2026-09-01", "2026-09-01");
  const journal = new ToolExecutionJournal(db);
  assert.equal(journal.migrationReport.entries.length, 3);
  assert.equal(journal.get("legacy-complete").capabilityId,"compute.run");
  assert.deepEqual(journal.get("legacy-complete").receipt, JSON.parse(payload));
  assert.equal(journal.get("legacy-complete").outcome, undefined);
  assert.equal(journal.get("legacy-complete").scope.surface, "legacy");
  assert.equal(journal.get("legacy-dispatched").state, "effect-unknown");
  assert.equal(new ToolExecutionJournal(db).migrationReport.entries.every(entry => entry.status === "verified"), true);
  assert.equal(db.prepare("SELECT receipt_json FROM tool_execution_journal WHERE operation_id='legacy-complete'").get().receipt_json, payload);
  db.close();
});

test("Chem raw responses share outcome classification and full policy decision evidence", async () => {
  const { db, journal } = fixture();
  const decision = { decisionId: "decision-1", tool: "chemistry.formula_properties", surface: "chemistry", scopeId: "chem-run", operationId: "chem-operation", allowed: true, code: "POLICY_ALLOWED", requiredRisk: "none", reason: "Local calculation", decidedAt: new Date().toISOString(), grant: { id: "grant-1", source: "explicit-approval", actor: "user", surface: "chemistry", scopeId: "chem-run", risks: [], grantedAt: new Date().toISOString() } };
  const input = { journal, operationId: "chem-operation", scope: { surface: "chemistry", scopeId: "chem-run" }, tool: "chemistry.formula_properties", arguments: { formula: "H2O" }, decisionId: decision.decisionId, decision };
  await invokeJournaledTool(input, async mark => { mark(); return { ok: true, data: { status: "failed", error: "Calculation failed" } }; });
  assert.equal(journal.get("chem-operation").outcome, "tool-error");
  assert.deepEqual(journal.get("chem-operation").decision, decision);
  await assert.rejects(invokeJournaledTool({ ...input, operationId: "different" }, async () => { throw new Error("Must not dispatch"); }), error => error.code === "POLICY_DENIED");
  db.exec("UPDATE tool_execution_journal SET policy_decision_json='{}' WHERE operation_id='chem-operation'");
  assert.throws(() => journal.get("chem-operation"), /POLICY_DECISION_DIGEST_MISMATCH/);
  db.close();
});

test("dispatched read recovers as no-effect on reopen and active reconciliation is refused", () => {
  const { db, journal } = fixture();
  const identity = { ...request(journal, "read"), effect: "read" };
  const started = journal.begin(identity);
  journal.markDispatched(identity, started.leaseId);
  assert.throws(() => journal.reconcile(identity.operationId, "not-applied", "user", "inspection"), error => error.code === "TOOL_OPERATION_IN_PROGRESS");
  const reopened = new ToolExecutionJournal(db);
  assert.equal(reopened.get(identity.operationId).state, "no-effect");
  db.close();
});

test("a contract-valid receipt larger than 4 MiB is durably replayed", async () => {
  const { db, journal } = fixture(), { client, sent } = connected(journal);
  const options = { scope, operationId: "large-receipt" }, envelope = { structuredContent: { ok: true, data: "x".repeat(5 * 1024 * 1024) } };
  const pending = client.callEnvelope("proto_compute_run", {}, undefined, undefined, options);
  await new Promise(resolve => setImmediate(resolve));
  client.handleStdout(JSON.stringify({ id: sent[0].id, result: envelope }) + "\n");
  assert.deepEqual(await pending, envelope);
  assert.equal(journal.get(options.operationId).state, "completed");
  assert.deepEqual(await client.callEnvelope("proto_compute_run", {}, undefined, undefined, options), envelope);
  assert.equal(sent.length, 1);
  db.close();
});

// A refusal is a decision about a real request. Without a durable row an audit
// cannot tell a call the policy denied from one that was never attempted.
const chatScope = { surface: "chat", scopeId: "message-1", parentOperationId: "session-1" };
const denialInput = (journal, tool = "proto_pubmed_search", operationId = "denied-1", grants = []) => {
  const decision = evaluateToolPolicy({ tool, args: {}, surface: "chat", scopeId: chatScope.scopeId, operationId, grants });
  return { request: { journal, operationId, scope: chatScope, tool, arguments: {}, decision }, decision };
};

test("a denied chat call is journalled as a terminal no-effect row carrying its decision", () => {
  const { db, journal } = fixture();
  const { request: denied, decision } = denialInput(journal);
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "POLICY_DENIED");
  assert.equal(decision.requiredRisk, "network");

  recordPolicyDenial(denied);
  const record = journal.get("denied-1");
  assert.equal(record.state, "no-effect");
  assert.equal(record.outcome, "tool-error");
  assert.equal(record.tool, "proto_pubmed_search");
  assert.deepEqual(record.scope, chatScope);
  assert.equal(record.decisionId, decision.decisionId);
  assert.equal(record.decision.code, "POLICY_DENIED");
  assert.equal(record.receipt.code, "POLICY_DENIED");
  assert.equal(executionActivityState(record), "error");
  // The refusal is terminal but left no effect, so an authorized retry may reuse it.
  assert.equal(journal.list(chatScope).length, 1);
  db.close();
});

test("an allowed call records the grant that authorized it", async () => {
  const { db, journal } = fixture();
  const grant = { id: "grant-1", source: "session-send", actor: "user", surface: "chat",
    scopeId: chatScope.scopeId, risks: ["network"], grantedAt: new Date(Date.now() - 1000).toISOString() };
  const { request: allowed, decision } = denialInput(journal, "proto_pubmed_search", "allowed-1", [grant]);
  assert.equal(decision.allowed, true);
  assert.equal(decision.grantId, "grant-1");

  recordPolicyDenial(allowed); // An allowed decision is not a denial and records nothing.
  assert.equal(journal.get("allowed-1"), undefined);

  await invokeJournaledTool({ ...allowed, decisionId: decision.decisionId }, async mark => { mark(); return { ok: true }; });
  const record = journal.get("allowed-1");
  assert.equal(record.state, "completed");
  assert.equal(record.decision.grantId, "grant-1");
  assert.equal(record.decision.grant.risks[0], "network");
  db.close();
});

test("a late denial never overwrites a receipt already recorded for that operation", async () => {
  const { db, journal } = fixture();
  const grant = { id: "grant-2", source: "session-send", actor: "user", surface: "chat",
    scopeId: chatScope.scopeId, risks: ["network"], grantedAt: new Date(Date.now() - 1000).toISOString() };
  const { request: allowed } = denialInput(journal, "proto_pubmed_search", "settled-1", [grant]);
  await invokeJournaledTool(allowed, async mark => { mark(); return { ok: true, hits: 3 }; });

  const { request: denied } = denialInput(journal, "proto_pubmed_search", "settled-1");
  recordPolicyDenial(denied);
  const record = journal.get("settled-1");
  assert.equal(record.state, "completed");
  assert.equal(record.receipt.hits, 3);
  db.close();
});

test("an unregistered tool is refused without claiming an effect in the journal", () => {
  const { db, journal } = fixture();
  const { request: denied, decision } = denialInput(journal, "proto_not_a_tool", "unknown-1");
  assert.equal(decision.code, "UNKNOWN_CAPABILITY");
  recordPolicyDenial(denied);
  // No contract means no effect class, so no row may assert one either way.
  assert.equal(journal.get("unknown-1"), undefined);
  db.close();
});
