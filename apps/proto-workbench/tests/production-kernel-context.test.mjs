import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { createProductionKernelContext, invokeJournaledTool } from "../src/main/services/execution-kernel.ts";
import { evaluateToolPolicy, issueHostPolicyGrant, rebindHostPolicyDecision, TOOL_POLICY_VERSION } from "../src/main/services/permissions.ts";
import { ToolExecutionJournal } from "../src/main/services/tool-execution-journal.ts";
import { McpClient } from "../src/main/services/mcp-client.ts";
import { HarnessWorkspace } from "../src/main/services/harness-workspace.ts";
import { withReadSlot, withWorkspaceWrite } from "../src/main/services/workspace-execution-queue.ts";

function fixture(t, { tool = "proto_compute_run", args = { path: "build/input.json" }, grants = [], operationId = "operation-1" } = {}) {
  const db = new DatabaseSync(":memory:"), journal = new ToolExecutionJournal(db);
  t.after(() => db.close());
  const scope = { surface: "compute", scopeId: "request-1" };
  const decision = evaluateToolPolicy({ tool, args, ...scope, operationId, grants });
  const request = { journal, scope, operationId, tool, arguments: args, decisionId: decision.decisionId, decision };
  return { request, journal, issue: () => createProductionKernelContext(request, resolve(".")) };
}
const grant = () => ({ id: "user-grant", source: "explicit-approval", actor: "user", surface: "compute", scopeId: "request-1",
  risks: ["network"], grantedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });

test("production refuses missing context, journal, decision and copied authority before dispatch", async t => {
  const { request, issue, journal } = fixture(t), context = issue();
  let dispatched = 0;
  const dispatch = async mark => { dispatched++; mark(); return { ok: true }; };
  for (const input of [request, { ...request, context: {} }, { ...request, context: { ...context } }]) {
    await assert.rejects(invokeJournaledTool(input, dispatch), { code: "KERNEL_CONTEXT_REQUIRED" });
  }
  assert.throws(() => createProductionKernelContext({ ...request, journal: undefined }, resolve(".")), { code: "TOOL_EXECUTION_JOURNAL_REQUIRED" });
  assert.throws(() => createProductionKernelContext({ ...request, decision: undefined }, resolve(".")), { code: "TOOL_POLICY_DECISION_REQUIRED" });
  assert.throws(() => createProductionKernelContext(request, "relative-workspace"), { code: "KERNEL_WORKSPACE_IDENTITY_REQUIRED" });
  assert.equal(dispatched, 0);
  assert.equal(journal.get(request.operationId), undefined);
});

test("fabricated grant, serialized decision and modified decision cannot acquire production authority", t => {
  const fake = fixture(t, { tool: "proto_pubmed_search", args: { query: "protein" }, grants: [grant()] });
  assert.equal(fake.request.decision.allowed, true, "policy simulation alone never confers live execution authority");
  assert.throws(fake.issue, { code: "POLICY_DENIED" });
  const valid = fixture(t, { tool: "proto_pubmed_search", args: { query: "protein" }, grants: [issueHostPolicyGrant(grant())] });
  assert.throws(() => createProductionKernelContext({ ...valid.request, decision: structuredClone(valid.request.decision) }, resolve(".")), { code: "POLICY_DENIED" });
  valid.request.decision.reason = "forged";
  assert.throws(valid.issue, { code: "POLICY_DENIED" });
});

test("production rejects wrong scope, operation, tool, journal and changed input bindings", async t => {
  const { request, issue } = fixture(t), context = issue();
  const other = fixture(t);
  let calls = 0;
  for (const change of [
    { scope: { ...request.scope, scopeId: "other" } }, { operationId: "other" }, { tool: "proto_compute_catalog" },
    { journal: other.journal }, { arguments: { path: "build/other.json" } }, { decision: undefined },
  ]) await assert.rejects(invokeJournaledTool({ ...request, context, ...change }, async mark => { calls++; mark(); return { ok: true }; }), { code: "KERNEL_CONTEXT_BINDING_MISMATCH" });
  assert.throws(() => createProductionKernelContext({ ...request, scope: { ...request.scope, scopeId: "other" } }, resolve(".")), { code: "POLICY_DENIED" });
  assert.throws(() => createProductionKernelContext({ ...request, arguments: { path: "build/other.json" } }, resolve(".")), { code: "POLICY_DENIED" });
  assert.equal(calls, 0);
});

test("production snapshots inputs and records rule version; receipt replay does not dispatch again", async t => {
  const { request, issue, journal } = fixture(t), context = issue();
  let calls = 0;
  const dispatch = async (mark, snapshot) => {
    assert.notEqual(snapshot, request.arguments);
    assert.equal(Object.isFrozen(snapshot), true);
    mark(); calls++;
    return { ok: true, input: snapshot.path };
  };
  await invokeJournaledTool({ ...request, context }, dispatch);
  await invokeJournaledTool({ ...request, context }, dispatch);
  assert.equal(calls, 1);
  assert.equal(journal.get(request.operationId).decision.policyVersion, TOOL_POLICY_VERSION);
  assert.equal(journal.get(request.operationId).decision.requiredRisk, "none");
  assert.equal(context.methodId, "compute.run");
});

test("input changes and grant expiry during adapter preparation settle with no effect", async t => {
  const mutable = fixture(t), context = mutable.issue();
  let actualCalls = 0;
  await assert.rejects(invokeJournaledTool({ ...mutable.request, context }, async mark => {
    mutable.request.arguments.path = "build/swapped.json";
    mark(); actualCalls++; return { ok: true };
  }), { code: "KERNEL_CONTEXT_BINDING_MISMATCH", effectState: "none" });
  assert.equal(mutable.journal.get(mutable.request.operationId).state, "no-effect");
  const liveGrant = issueHostPolicyGrant(grant());
  const expiry = fixture(t, { tool: "proto_pubmed_search", args: { query: "protein" }, grants: [liveGrant] });
  const expiryContext = expiry.issue();
  await assert.rejects(invokeJournaledTool({ ...expiry.request, context: expiryContext }, async mark => {
    const original = Date.now;
    Date.now = () => Date.parse(liveGrant.expiresAt) + 1;
    try { mark(); actualCalls++; return { ok: true }; } finally { Date.now = original; }
  }), { code: "POLICY_DENIED", effectState: "none" });
  assert.equal(actualCalls, 0);
  assert.equal(expiry.journal.get(expiry.request.operationId).state, "no-effect");
});

test("offline exemption cannot be reused for online inputs and denial remains durable", async t => {
  const { request, journal } = fixture(t, { tool: "proto_pubmed_search", args: { query: "protein", offline: true } });
  const args = { query: "protein", offline: false };
  const decision = rebindHostPolicyDecision(request.decision, args);
  const denied = { ...request, arguments: args, decision, decisionId: decision.decisionId };
  const context = createProductionKernelContext(denied, resolve("."));
  await assert.rejects(invokeJournaledTool({ ...denied, context }, async () => { assert.fail("denied request dispatched"); }), { code: "POLICY_DENIED" });
  assert.equal(journal.get(request.operationId).state, "no-effect");
  assert.equal(journal.get(request.operationId).decision.allowed, false);
});

test("production MCP refuses a missing journal and does not start the sidecar", async () => {
  const client = new McpClient({ packaged: false, resourcesPath: "", repoRoot: resolve("."), workspacePath: resolve("."), workspaceCapability: "42".repeat(32) });
  client.start = async () => assert.fail("sidecar started before kernel authorization");
  await assert.rejects(client.call("proto_compute_run", {}, undefined, undefined, { scope: { surface: "compute", scopeId: "request-1" } }), { code: "TOOL_EXECUTION_JOURNAL_REQUIRED" });
});

function localHarness(t, read) {
  const db = new DatabaseSync(":memory:"), journal = new ToolExecutionJournal(db), root = resolve(".");
  t.after(() => db.close());
  const client = new McpClient({packaged:false,resourcesPath:"",repoRoot:root,workspacePath:root,workspaceCapability:"42".repeat(32)},{journal});
  const host = new HarnessWorkspace({read},{},client,{},async()=>[],()=>{});
  const checkpoint = {createdAt:new Date().toISOString(),contract:{runId:"queued-host-call",workspacePath:root,mode:"act",scope:{network:false,execution:false}}};
  return {host,journal,checkpoint,root};
}
const deferred = () => {let resolve; const promise = new Promise(done => {resolve=done;}); return {promise,resolve};};

test("queued Harness local calls consume the kernel snapshot after caller inputs change",async t=>{
  const held=deferred(),occupied=Array.from({length:3},()=>withReadSlot(undefined,async()=>held.promise));
  const {host,journal,checkpoint}=localHarness(t,async path=>({path})),queued=deferred(),input={path:"original.txt"};
  try {
    const call=host.execute("workspace_read",input,"queued-read",checkpoint,new AbortController().signal,state=>{if(state==="queued")queued.resolve();});
    await queued.promise;
    input.path="swapped.txt";
    held.resolve();
    const result=await call;
    assert.equal(result.path,"original.txt");
    assert.equal(journal.get("queued-read").state,"completed");
    assert.equal(journal.get("queued-read").receipt.path,"original.txt");
  } finally {held.resolve();await Promise.all(occupied);}
});

test("cancelling a queued local write retains explicit no-effect evidence",async t=>{
  const {host,journal,checkpoint,root}=localHarness(t,async()=>assert.fail("A cancelled operation entered workspace execution"));
  const held=deferred(),active=deferred(),queued=deferred(),controller=new AbortController();
  const occupied=withWorkspaceWrite(root,undefined,async()=>{active.resolve();await held.promise;});
  await active.promise;
  try {
    const call=host.execute("proto_structure_import_workspace",{path:"build/fixture.pdb"},"queued-write",checkpoint,controller.signal,state=>{if(state==="queued")queued.resolve();});
    const rejected=assert.rejects(call,error=>error.effectState==="none");
    await queued.promise;controller.abort(new Error("cancelled while queued"));
    await rejected;
    assert.equal(journal.get("queued-write").state,"no-effect");
    assert.equal(journal.recoverySummary().unknownEffects,0);
  } finally {held.resolve();await occupied;}
});

test("ephemeral execution capability is unavailable outside the test runner", () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const url = new URL("../src/main/services/execution-kernel.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import { createEphemeralKernelContext } from ${JSON.stringify(url)}; createEphemeralKernelContext({});`], { env, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /KERNEL_EPHEMERAL_CONTEXT_TEST_ONLY/);
});
