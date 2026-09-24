import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { HarnessController } from "../src/main/services/harness-controller.ts";
import { HarnessStore } from "../src/main/services/harness-store.ts";
import { assembleHarnessContext, bindCurrentExecutionState, compactHarnessHistory, harnessMemoryBudget, projectToolResult, providerMessages } from "../src/main/services/harness-context.ts";
import {recordHarnessVerdict} from "../src/main/services/harness-iteration.ts";
import {withWorkspaceWrite, withReadSlot} from "../src/main/services/workspace-execution-queue.ts";

const tool = (name) => ({type: "function", function: {name, description: name, parameters: {type: "object", properties: {path: {type: "string"}}, additionalProperties: false}}});
function rig(turns, overrides = {}) {
  const db = new DatabaseSync(":memory:"), store = new HarnessStore(db), calls = [], states = [];
  const host = {
    tools: [tool("workspace_read"), tool("workspace_propose_patch"), tool("proto_compile")],
    binding: async () => ({modelId: "qwen3.8-27b@q4_k_m", instanceId: "instance-1", contextLength: 32768}),
    count: async () => ({tokens: 2000, method: "exact"}),
    chat: async (_payload, onChunk) => {
      const turn = turns.shift();
      if (typeof turn === "function") return turn(_payload, onChunk);
      if (!turn) throw new Error("Unexpected extra generation");
      onChunk({usage: {completion_tokens: 12}, choices: [{finish_reason: turn.finish ?? "tool_calls", delta: {content: turn.content, reasoning_content: turn.reasoning, tool_calls: turn.calls?.map(([name, args], index) => ({index, id: `reused-provider-${index}`, function: {name, arguments: JSON.stringify(args)}}))}}]});
    },
    execute: async (name, args) => {calls.push({name, args}); return {ok: true, content: "file body", resource_id: "eligible:existing", parts_path: "build/parts.json"};},
    effect: name => name === "workspace_propose_patch" ? "write" : "read",
    verify: async () => ({ok: true, diagnostics: [], artifacts: ["build/result.md"]}),
    publish: (c) => states.push(c.state), delta() {}, ...overrides,
  };
  const controller = new HarnessController(store, host);
  const c = controller.create({schema: "proto-workbench.mission.v1", runId: "run", threadId: "thread", workspacePath: "fixture", goal: "Read input and save a result", modelId: "qwen3.8-27b@q4_k_m", mode: "act", contextTokens: 32768, scope: {writeRoots: ["build"], network: false, execution: false}, deliverables: [], budgets: {activeTimeMs: 10000, maxRounds: 8, maxGeneratedTokens: 20000}}, "Never change core constraints.");
  return {db, store, controller, c, calls, states, host};
}
const finish = () => ({calls: [["harness_finish", {summary: "Verified task result"}]]});
const read = () => ({calls: [["workspace_read", {path: "input.md"}]]});

test("a real tool result and independent acceptance gate produce completed state", async () => {
  const r = rig([read(), finish()]);
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(r.c.state, "completed"); assert.equal(r.calls.length, 1);
  assert.equal(r.store.get("run").state, "completed");
  assert.equal(r.store.read("run", r.c.resultHandles[0]).data.content, "file body");
  assert.ok(r.states.includes("checkpointing")); r.db.close();
});

for (const variant of [{content: "Done", finish: "stop"}, {content: "", finish: "stop"}, {content: "truncated", finish: "length"}, {reasoning:"Private deliberation without a tool decision or deliverable",finish:"stop"}]) {
  test(`prose, empty, truncated or reasoning-only terminal output cannot pass (${JSON.stringify(variant)})`, async () => {
    const r = rig([variant, variant]); await r.controller.run(r.c, new AbortController().signal);
    assert.equal(r.c.state, "incomplete"); assert.equal(r.calls.length, 0); r.db.close();
  });
}

test("finish diagnostics are returned to the model and do not become green completion", async () => {
  const r = rig([finish(), finish(), finish()], {verify: async () => ({ok: false, diagnostics: ["Missing compiled artifact"], artifacts: []})});
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(r.c.state, "needs-human"); assert.ok(r.c.messages.some(m => m.role === "tool" && m.content.includes("Missing compiled artifact"))); assert.equal(r.c.verdicts[0].action,"repair"); r.db.close();
});

test("finish before another queued tool cannot skip that tool", async () => {
  const r = rig([{calls: [["harness_finish", {summary: "early"}], ["workspace_read", {path: "input.md"}]]}, finish()]);
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(r.calls.length, 1); assert.equal(r.c.state, "completed"); r.db.close();
});

test("actual Qwen context must equal 32768 before any generation", async () => {
  const r = rig([finish()], {binding: async () => ({modelId: "qwen3.8-27b@q4_k_m", instanceId: "instance-1", contextLength: 8192})});
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(r.c.error.code, "MODEL_CONTEXT_MISMATCH"); assert.equal(r.c.round, 0); r.db.close();
});

test("provider call IDs reused in later rounds cannot replay a previous result", async () => {
  const r = rig([read(), {calls: [["workspace_read", {path: "second.md"}]]}, finish()]);
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(r.calls.length, 2); assert.notEqual(r.c.completedCalls[0], r.c.completedCalls[1]); r.db.close();
});

test("recovery reuses a committed result without repeating the write", async () => {
  const r = rig([finish()]);
  const call = {id: "durable-call", type: "function", function: {name: "workspace_propose_patch", arguments: '{"path":"build/result.md"}'}};
  r.c.pendingCalls = [call]; r.c.messages.push({role: "assistant", content: "", tool_calls: [call]});
  r.store.intent("run", call.id, call.function.name, {path: "build/result.md"}, "write");
  r.store.record("run", call.id, call.function.name, {ok: true, artifacts: ["build/result.md"]}); r.store.save(r.c);
  const restored = r.store.get("run"); await r.controller.run(restored, new AbortController().signal);
  assert.equal(restored.state, "completed"); assert.equal(r.calls.length, 0); r.db.close();
});

test("interrupted effect cannot be replayed blindly", async () => {
  const r = rig([finish()]);
  const call = {id: "uncertain", type: "function", function: {name: "workspace_propose_patch", arguments: '{"path":"build/result.md"}'}};
  r.c.pendingCalls = [call]; r.store.intent("run", call.id, call.function.name, {path: "build/result.md"}, "write"); r.store.save(r.c);
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(r.c.state, "effect-unknown"); assert.equal(r.calls.length, 0); r.db.close();
});

test("journal reconciliation restores a write receipt without replaying it or refunding budget", async () => {
  let reconciled = 0;
  const r = rig([], {reconcile: async (name, args, callId) => {
    assert.equal(name, "workspace_propose_patch"); assert.equal(args.path, "build/result.md"); assert.equal(callId, "journal-call");
    reconciled++; return {ok: true, effect_state: "committed", artifacts: ["build/result.md"]};
  }});
  const call = {id: "journal-call", type: "function", function: {name: "workspace_propose_patch", arguments: '{"path":"build/result.md"}'}};
  r.c.pendingCalls = [call]; r.c.round = 8;
  r.store.intent("run", call.id, call.function.name, {path: "build/result.md"}, "write");
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(reconciled, 1); assert.equal(r.calls.length, 0); assert.equal(r.c.round, 8);
  assert.equal(r.c.state, "incomplete"); assert.equal(r.c.error.code, "TASK_BUDGET_EXHAUSTED");
  assert.equal(r.store.resultForCall("run", call.id).data.effect_state, "committed");
  assert.deepEqual(r.c.pendingCalls, []); assert.ok(r.c.deliveredPaths.includes("build/result.md")); r.db.close();
});

test("known-none write cancellation resumes without promoting its failed evidence to completion", async () => {
  const pause = new AbortController(); let attempts = 0;
  const r = rig([{calls: [["workspace_propose_patch", {path: "build/result.md"}]]}, finish()], {
    execute: async () => {attempts++; pause.abort({code: "HARNESS_PAUSED"}); throw Object.assign(new Error("Cancelled before mutation"), {code: "HARNESS_PAUSED", effectState: "none"});}
  });
  await r.controller.run(r.c, pause.signal);
  assert.equal(r.c.state, "paused"); assert.equal(r.c.error.effectState, "none"); assert.equal(attempts, 1);
  assert.deepEqual(r.c.pendingCalls, []);
  const receipt = r.store.read("run", r.c.resultHandles.at(-1));
  assert.equal(receipt.ok, false); assert.equal(receipt.data.effect_state, "none");
  assert.equal(r.store.uncertainEffect("run", r.c.completedCalls.at(-1)), false);
  await r.controller.run(r.store.get("run"), new AbortController().signal);
  assert.equal(r.store.get("run").state, "incomplete");assert.equal(r.store.get("run").evidenceStatus,"incomplete-evidence"); assert.equal(attempts, 1); r.db.close();
});

test("resumption preserves consumed rounds, tokens and active time", async () => {
  const r = rig([finish()]); r.c.round = 8; r.c.generatedTokens = 234; r.c.activeTimeMs = 4000; r.store.save(r.c);
  await r.controller.run(r.store.get("run"), new AbortController().signal);
  const restored = r.store.get("run"); assert.equal(restored.round, 8); assert.equal(restored.generatedTokens, 234); assert.ok(restored.activeTimeMs >= 4000); assert.equal(restored.state, "incomplete"); r.db.close();
});

test("queue waiting does not consume active execution time", async () => {
  const r = rig([async (payload, chunk) => {
    payload._onQueueState("queued"); await new Promise(resolve => setTimeout(resolve, 100)); payload._onQueueState("active");
    chunk({usage: {completion_tokens: 5}, choices: [{finish_reason: "tool_calls", delta: {tool_calls: [{index: 0, function: {name: "harness_finish", arguments: '{"summary":"done"}'}}]}}]});
  }]);
  r.c.contract.budgets.activeTimeMs = 80;
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(r.c.state, "completed"); assert.ok(r.c.activeTimeMs < 80); r.db.close();
});

for (const type of ["write", "read"]) test(`shared workspace ${type} queue time is excluded before the tool deadline starts`, async () => {
  let release; const gate = new Promise(resolve => {release = resolve;});
  const held = type === "write" ? [withWorkspaceWrite("budget-test-lane", undefined, () => gate)] : Array.from({length:3},()=>withReadSlot(undefined,()=>gate));
  await new Promise(resolve=>setImmediate(resolve));
  const r = rig([read(), finish()], {execute: async (_name, _args, _callId, _c, signal, queueState) => {
    const operation = async () => {signal.throwIfAborted(); return {ok:true};};
    return type === "write" ? withWorkspaceWrite("budget-test-lane", signal, operation, queueState) : withReadSlot(signal, operation, queueState);
  }});
  r.c.contract.budgets.activeTimeMs = 80;
  const timer = setTimeout(release, 140);
  try {await r.controller.run(r.c,new AbortController().signal);assert.equal(r.c.state,"completed");assert.ok(r.c.activeTimeMs<80);}
  finally {clearTimeout(timer);release();await Promise.all(held);r.db.close();}
});

test("registered tools remain discoverable and repeatedly callable", async () => {
  const r = rig([{calls: [["harness_discover_tools", {query: "proto_compile"}]]}, {calls: [["proto_compile", {path: "a.proto"}]]}, {calls: [["proto_compile", {path: "b.proto"}]]}, finish()]);
  r.c.contract.materialBinding={partsPath:"build/unit-fixture.json",partsSha256:"a".repeat(64)};
  await r.controller.run(r.c, new AbortController().signal); assert.equal(r.c.state, "completed"); assert.equal(r.calls.length, 2); assert.ok(r.c.selectedTools.includes("proto_compile")); r.db.close();
});

test("full results are digest-bound, task-bound and page-readable", () => {
  const r = rig([]); const content = "nucleotide source body ".repeat(3000);
  const result = r.store.record("run", "call", "workspace_read", {ok: true, content, resource_id: "known-id", snapshot_id: "reviewed", parts_path: "build/parts.json", next_cursor: "next-page"});
  const projected = JSON.parse(projectToolResult(result)); assert.equal(projected.data.resource_id, "known-id"); assert.equal(projected.data.parts_path, "build/parts.json"); assert.equal(projected.truncated, true);
  let offset = 0, body = ""; do {const page = r.store.page("run", result.handle, offset, 4096); body += page.content; offset = page.next_offset;} while (offset !== null);
  assert.equal(JSON.parse(body).content, content); assert.throws(() => r.store.read("another-run", result.handle));
  r.db.prepare("UPDATE harness_results SET payload=? WHERE handle=?").run("{}", result.handle); assert.throws(() => r.store.read("run", result.handle), /DIGEST_MISMATCH/); r.db.close();
});

test("compaction preserves core constraints and original goal or rejects the request", async () => {
  const messages = [{role: "system", content: "NEVER change source identities."}, {role: "user", content: "Original goal"}, ...Array.from({length: 100}, () => ({role: "assistant", content: "verbose obsolete narration".repeat(100)}))];
  const context = await assembleHarnessContext(messages, [], "Original goal", 32768);
  assert.equal(context.compacted, true); assert.equal(context.messages[0].content, messages[0].content); assert.ok(context.messages.some(m => m.content === "Original goal"));
  await assert.rejects(assembleHarnessContext([{role: "system", content: "x".repeat(40000)}], [], "Goal", 32768), /CONTEXT_BUDGET_EXHAUSTED/);
});

test("budget heartbeat persists active time and partial output before an interrupted generation", async () => {
  const pause = new AbortController();
  const r = rig([async (_payload, onChunk, signal) => {
    onChunk({choices: [{delta: {content: "partially generated output"}}]});
    await new Promise(resolve => setTimeout(resolve, 45));
    const durable = r.store.get("run");
    assert.ok(durable.activeTimeMs >= 20);
    assert.ok(durable.inFlightGenerationTokens >= 20);
    pause.abort({code: "HARNESS_PAUSED"});
    signal.throwIfAborted();
  }]);
  const controller = new HarnessController(r.store, r.host, {checkpointIntervalMs: 10});
  await controller.run(r.c, pause.signal);
  assert.equal(r.c.state, "paused");
  assert.equal(r.c.error.code, "HARNESS_PAUSED");
  assert.ok(r.c.generatedTokens >= 20);
  assert.equal(r.c.inFlightGenerationTokens, undefined);
  r.db.close();
});

test("resumption charges the last durable partial generation without resetting budgets", async () => {
  const r = rig([finish()]);
  r.c.generatedTokens = 100;
  r.c.inFlightGenerationTokens = 50;
  r.store.save(r.c);
  const restored = r.store.get("run");
  await r.controller.run(restored, new AbortController().signal);
  assert.equal(restored.state, "completed");
  assert.equal(restored.generatedTokens, 162);
  assert.equal(restored.inFlightGenerationTokens, undefined);
  r.db.close();
});

test("exhausted budget reconciles durable results but never starts a pending write", async () => {
  const r = rig([]);
  r.c.round = r.c.contract.budgets.maxRounds;
  const call = {id: "unstarted-write", type: "function", function: {name: "workspace_propose_patch", arguments: '{"path":"build/result.md"}'}};
  r.c.pendingCalls = [call];
  r.store.save(r.c);
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(r.c.state, "incomplete");
  assert.equal(r.c.error.code, "TASK_BUDGET_EXHAUSTED");
  assert.equal(r.calls.length, 0);
  assert.equal(r.store.uncertainEffect("run", call.id), false);
  r.db.close();
});

test("cached completion is independently reverified after a restart", async () => {
  const r = rig([], {verify: async () => ({ok: false, diagnostics: ["artifact changed after crash"], artifacts: []})});
  const call = {id: "old-finish", type: "function", function: {name: "harness_finish", arguments: '{"summary":"done"}'}};
  r.c.pendingCalls = [call];
  r.store.record("run", call.id, call.function.name, {ok: true, artifacts: ["build/result.md"], summary: "done"});
  r.store.save(r.c);
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(r.c.state, "incomplete");
  assert.ok(r.c.messages.some(message => message.role === "tool" && message.content.includes("artifact changed after crash")));
  r.db.close();
});

test("multiword discovery ranks exact names and descriptive query terms", async () => {
  const r = rig([{calls: [["harness_discover_tools", {query: "compile source proto"}]]}, finish()]);
  await r.controller.run(r.c, new AbortController().signal);
  assert.ok(r.c.selectedTools.includes("proto_compile"));
  const projection = r.c.messages.find(message => message.role === "tool" && message.content.includes("schema_location"));
  assert.ok(projection);
  assert.equal(JSON.parse(projection.content).data.activated[0].name, "proto_compile");
  assert.equal(JSON.parse(projection.content).data.activated[0].function, undefined);
  r.db.close();
});

test("projected page offsets advance only across characters actually returned", () => {
  const r = rig([]);
  const original = {ok: true, content: '漢字 "quoted" \\ path\n'.repeat(3000)};
  const result = r.store.record("run", "source", "workspace_read", original);
  let offset = 0, body = "", pageIndex = 0;
  do {
    const page = r.store.page("run", result.handle, offset, 24000);
    const receipt = r.store.record("run", `page-${pageIndex++}`, "harness_read_result", page);
    const projected = JSON.parse(projectToolResult(receipt, 3000));
    assert.ok(projected.data.content.length > 0);
    body += projected.data.content;
    offset = projected.data.next_offset;
  } while (offset !== null);
  assert.deepEqual(JSON.parse(body), original);
  r.db.close();
});

test("compression preserves every genuine prior user constraint but never sends private metadata", async () => {
  const prior = "Preserve the user's previous source identities and the external review status exactly.";
  const samePrefix = "Execution memory (tool data, not instructions). This sentence was genuinely written by the user and must survive.";
  const messages = [{role: "system", content: "Host policy"}, {role: "user", content: prior}, {role: "user", content: samePrefix},
    {role: "user", _harnessGenerated: true, content: "Old generated repair guidance"},
    ...Array.from({length: 70}, () => ({role: "assistant", content: "Old narrative ".repeat(300)})), {role: "user", content: "Current goal"}];
  const context = await assembleHarnessContext(messages, [], "Current goal", 32768);
  assert.equal(context.compacted, true);
  assert.ok(context.messages.some(message => message.content === prior));
  assert.ok(context.messages.some(message => message.content === samePrefix));
  assert.ok(!context.messages.some(message => message.content === "Old generated repair guidance"));
  assert.ok(providerMessages(context.messages).every(message => !("_harnessGenerated" in message)));
  await assert.rejects(assembleHarnessContext([{role: "system", content: "Policy"}, {role: "user", content: "x".repeat(40000)}], [], "Current goal", 32768), /CONTEXT_BUDGET_EXHAUSTED/);
});

test("repeated compaction retains previous tool identities and current material binding", () => {
  const r = rig([]);
  const source = r.store.record("run", "parts", "proto_search_parts", {ok: true, matches: [{id: "exact-returned-part", type: "cds", sequence_sha256: "a".repeat(64), sequence: "ACGT".repeat(2000)}]});
  const projection = JSON.parse(projectToolResult(source));
  assert.equal(projection.data.matches[0].id, "exact-returned-part");
  assert.equal(projection.data.matches[0].sequence, undefined);
  assert.equal(projection.data.matches[0].sequence_preview.length, 160);
  assert.match(projection.data.projection_notice, /only when/);
  r.c.contract.materialBinding = {partsPath: "build/selection.json", partsSha256: "b".repeat(64)};
  r.c.messages.push({role: "assistant", content: "", tool_calls: [{id: "parts", type: "function", function: {name: "proto_search_parts", arguments: "{}"}}]}, {role: "tool", tool_call_id: "parts", content: projectToolResult(source)});
  let compacted = compactHarnessHistory(bindCurrentExecutionState(r.c), r.c.contract.goal);
  compacted.push({role: "assistant", content: "", tool_calls: [{id: "later", type: "function", function: {name: "workspace_read", arguments: "{}"}}]}, {role: "tool", tool_call_id: "later", content: projectToolResult(r.store.record("run", "later", "workspace_read", {ok: true, path: "input.md"}))});
  compacted = compactHarnessHistory(compacted, r.c.contract.goal);
  const memory = compacted.find(message => message._harnessGenerated && message.content.startsWith("Execution memory"));
  assert.match(memory.content, /exact-returned-part/);
  assert.match(memory.content, /"type":"cds"/);
  assert.ok(compacted.some(message => message._harnessGenerated && message.content.includes("build/selection.json")));
  assert.equal(compacted.filter(message => message._harnessGenerated && message.content.startsWith("Execution memory")).length, 1);
  r.db.close();
});

test("repeated operations get one repair opportunity before no-progress termination", async () => {
  const recovered = rig([read(), read(), read(), finish()]);
  await recovered.controller.run(recovered.c, new AbortController().signal);
  assert.equal(recovered.c.state, "completed");
  assert.equal(recovered.calls.length, 2, "The detected duplicate must not execute another effect");
  assert.ok(recovered.c.messages.some(message => message._harnessGenerated && /last bounded progress repair/.test(message.content)));
  recovered.db.close();
  const repeated = rig([read(), read(), read(), read()]);
  await repeated.controller.run(repeated.c, new AbortController().signal);
  assert.equal(repeated.c.error.code, "NO_PROGRESS");
  assert.equal(repeated.calls.length, 2);
  repeated.db.close();
});

test("cross-batch stale observation cycles receive one repair and persist incomplete without hiding receipts", async () => {
  const turns = Array.from({length: 40}, (_, index) => ({calls: [["workspace_read", {path: ["first.md", "second.md", "third.md"][index % 3]}]]}));
  const r = rig(turns); r.c.contract.budgets.maxRounds = 60;
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(r.c.state, "incomplete"); assert.equal(r.c.error.code, "NO_PROGRESS");
  assert.equal(r.c.recoveryCounters.progressRepairs, 1); assert.equal(r.c.observationProgress.repairIssued, true);
  assert.equal(r.calls.length, 23); assert.equal(r.c.resultHandles.length, 23);
  assert.ok(r.c.messages.some(message => message._harnessGenerated && message.content.includes("Reordering old reads")));
  assert.equal(r.store.get("run").observationProgress.unchanged, 8);
  assert.ok(r.c.resultHandles.every(handle => r.store.read("run", handle).data.content === "file body")); r.db.close();
});

test("a changed artifact after observation repair can still finish through actual verification", async () => {
  const turns = Array.from({length: 15}, (_, index) => ({calls: [["workspace_read", {path: ["first.md", "second.md", "third.md"][index % 3]}]]}));
  const r = rig([...turns, {calls: [["workspace_propose_patch", {path: "build/result.md"}]]}, finish()]); r.c.contract.budgets.maxRounds = 60;
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(r.c.state, "completed"); assert.equal(r.c.recoveryCounters.progressRepairs, 1);
  assert.equal(r.calls.at(-1).name, "workspace_propose_patch"); r.db.close();
});

test("resuming a no-progress checkpoint can observe a changed source without refunding the spent repair", async () => {
  const r = rig([{calls: [["workspace_read", {path: "changed-source.md"}]]}, finish()]);
  r.c.round = 3; r.c.generatedTokens = 45; r.c.activeTimeMs = 20;
  r.c.observationProgress = {seen: ["old-observation"], unchanged: 8, repairIssued: true, obligations: "old"};
  r.c.recoveryCounters = {transportRetries: 0, outputRepairs: 0, progressRepairs: 1, instanceRebinds: 0, journalReconciliations: 0, resumes: 0};
  await r.controller.run(r.c, new AbortController().signal, {resumed: true});
  assert.equal(r.c.state, "completed"); assert.equal(r.c.recoveryCounters.progressRepairs, 1); assert.equal(r.c.recoveryCounters.resumes, 1);
  assert.ok(r.c.generatedTokens > 45); assert.ok(r.c.activeTimeMs >= 20); assert.equal(r.calls[0].args.path, "changed-source.md"); r.db.close();
});

test("a reverified replacement of the same model and context resumes with a durable binding audit", async () => {
  const r = rig([finish()]); r.c.instanceId = "previous-owned-instance";
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(r.c.state, "completed");
  assert.equal(r.c.instanceId, "instance-1");
  const audit = r.c.resultHandles.map(handle => r.store.read("run", handle)).find(result => result.tool === "harness_model_rebind");
  assert.equal(audit.data.previous_instance_id, "previous-owned-instance");
  assert.equal(audit.data.model_id, r.c.contract.modelId);
  assert.equal(audit.data.context_tokens, 32768);
  const projection = r.store.project(r.c);
  assert.equal(projection.hostRecovered, false); // Legacy static fallback flag.
  assert.equal(projection.recoveryCounters.instanceRebinds, 1);
  projection.recoveryCounters.instanceRebinds = 99;
  assert.equal(r.c.recoveryCounters.instanceRebinds, 1);
  r.db.close();
  for (const binding of [{modelId: "another-model", instanceId: "new", contextLength: 32768}, {modelId: "qwen3.8-27b@q4_k_m", instanceId: "new", contextLength: 8192}]) {
    const changed = rig([finish()], {binding: async () => binding}); changed.c.instanceId = "old";
    await changed.controller.run(changed.c, new AbortController().signal);
    assert.equal(changed.c.state, "incomplete");
    assert.match(changed.c.error.code, /MODEL_(?:BINDING_CHANGED|CONTEXT_MISMATCH)/);
    assert.equal(changed.c.round, 0);
    changed.db.close();
  }
});

const blocked = (reason = "No available tool can produce the required receipt.", unmet = ["build/report.png renderer receipt"]) =>
  ({calls: [["harness_report_blocked", {reason, unmet_requirements: unmet}]]});

test("a declared stop is a terminal outcome, not a failure, and records what is unmet", async () => {
  const r = rig([read(), blocked()]);
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(r.c.state, "abstained");
  assert.equal(r.c.error, undefined, "An intentional stop must not be reported as an error");
  assert.equal(r.c.abstention.reason, "No available tool can produce the required receipt.");
  assert.deepEqual(r.c.abstention.unmetRequirements, ["build/report.png renderer receipt"]);
  assert.ok(r.c.abstention.declaredAt);
  assert.equal(r.store.get("run").state, "abstained");
  assert.equal(r.store.project(r.c).resumable, false);
  assert.equal(r.store.read("run", r.c.resultHandles[0]).data.content, "file body", "Saved receipts stay readable");
  r.db.close();
});

test("a declared stop runs no further rounds and drops anything batched behind it", async () => {
  const r = rig([{calls: [["harness_report_blocked", {reason: "Insufficient evidence", unmet_requirements: []}], ["workspace_propose_patch", {path: "build/result.md"}]]}]);
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(r.c.state, "abstained");
  assert.equal(r.calls.length, 0, "No workspace effect may run after the task is handed to a person");
  assert.deepEqual(r.c.pendingCalls, []);
  assert.equal(r.c.round, 1);
  r.db.close();
});

test("the abstain tool is always callable without discovery and is never a write", async () => {
  const r = rig([blocked()]);
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(r.c.state, "abstained");
  assert.equal(r.store.uncertainEffect("run", r.c.completedCalls[0]), false);
  r.db.close();
});

test("repair allowances are spent once per task and are not refunded by resuming", async () => {
  const stalling = () => ({content: "no tool call", finish: "stop"});
  const first = rig([stalling(), read(), finish()]);
  await first.controller.run(first.c, new AbortController().signal);
  assert.equal(first.c.state, "completed");
  assert.equal(first.c.repairBudget.outputRepairs, 0, "The single output repair is consumed");
  assert.equal(first.c.recoveryCounters.outputRepairs, 1);
  first.db.close();

  // A run that stalls, is resumed, and stalls again must not get a second repair.
  const r = rig([stalling(), stalling()]);
  r.c.repairBudget = {outputRepairs: 0, progressRepairs: 1};
  await r.controller.run(r.c, new AbortController().signal, {resumed: true});
  assert.equal(r.c.state, "incomplete");
  assert.equal(r.c.error.code, "COMPLETION_UNVERIFIED");
  assert.equal(r.c.recoveryCounters.outputRepairs, 0, "A spent allowance issues no further repair");
  r.db.close();
});

test("a checkpoint written before repair budgets existed is migrated from its counters", async () => {
  const r = rig([{content: "no tool call", finish: "stop"}, {content: "still no tool call", finish: "stop"}]);
  delete r.c.repairBudget;
  r.c.recoveryCounters = {transportRetries: 0, outputRepairs: 1, progressRepairs: 0, instanceRebinds: 0, journalReconciliations: 0, resumes: 1};
  await r.controller.run(r.c, new AbortController().signal, {resumed: true});
  assert.equal(r.c.repairBudget.outputRepairs, 0, "The already-spent output repair is not granted again");
  assert.equal(r.c.repairBudget.progressRepairs, 1, "An unspent allowance survives migration");
  assert.equal(r.c.state, "incomplete");
  r.db.close();
});

const diagnostic = (blockingClass, message = "acceptance failure") =>
  ({code: "TEST_DIAGNOSTIC", blockingClass, subject: "build/report.png", message});

test("an unsupported acceptance failure goes to human review in one verify cycle", async () => {
  const r = rig([read(), finish(), finish(), finish()], {
    verify: async () => ({ok: false, diagnostics: [diagnostic("unsupported", "No tool can produce a renderer receipt")], artifacts: []}),
  });
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(r.c.state, "needs-human");
  assert.equal(r.c.error, undefined, "An unresolvable check is a review handoff, not a failure");
  assert.equal(r.c.round, 2, "The round budget is not consumed retrying an unresolvable check");
  assert.ok(r.c.abstention.unmetRequirements[0].startsWith("unsupported: "));
  assert.equal(r.store.project(r.c).resumable, false);
  r.db.close();
});

for (const blockingClass of ["stale", "conflicting"]) {
  test(`a ${blockingClass} acceptance failure is never retried`, async () => {
    const r = rig([finish(), finish()], {verify: async () => ({ok: false, diagnostics: [diagnostic(blockingClass)], artifacts: []})});
    await r.controller.run(r.c, new AbortController().signal);
    assert.equal(r.c.state, "needs-human");
    assert.equal(r.c.round, 1);
    r.db.close();
  });
}

test("a repairable diagnostic still returns to the model and can finish", async () => {
  let attempt = 0;
  const r = rig([finish(), finish()], {verify: async () => (++attempt === 1
    ? {ok: false, diagnostics: [diagnostic("repairable", "Missing compiled artifact")], artifacts: []}
    : {ok: true, diagnostics: [], artifacts: ["build/result.md"]})});
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(r.c.state, "completed");
  assert.ok(r.c.messages.some(m => m.role === "tool" && m.content.includes("Missing compiled artifact")));
  r.db.close();
});

test("a permanent diagnostic stops even when other diagnostics are repairable", async () => {
  let attempt = 0;
  const r = rig([finish(), finish()], {verify: async () => (++attempt === 1
    ? {ok: false, diagnostics: [diagnostic("unsupported"), diagnostic("repairable", "Fixable gap")], artifacts: []}
    : {ok: true, diagnostics: [], artifacts: ["build/result.md"]})});
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(r.c.state, "needs-human", "Fixing a separate gap cannot resolve an unsupported requirement");
  assert.equal(attempt,1);assert.equal(r.c.repairBudget.verifyRepairs,1);
  r.db.close();
});

test("an unclassified diagnostic stays repairable within the persisted allowance", async () => {
  const r = rig([finish(), finish(), finish()], {verify: async () => ({ok: false, diagnostics: ["Missing compiled artifact"], artifacts: []})});
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(r.c.verdicts[0].diagnostics[0].blockingClass,"repairable");
  assert.equal(r.c.verdicts[0].action,"repair");assert.equal(r.c.round,2);
  assert.equal(r.c.state,"needs-human","The shared repair allowance still bounds unknown diagnostics");
  r.db.close();
});

test("a missing dependency receives one exact hint before human review",async()=>{
  const r=rig([finish(),finish()],{verify:async()=>({ok:false,diagnostics:[{...diagnostic("dependency-missing"),subject:"required-input.txt"}],artifacts:[]})});
  await r.controller.run(r.c,new AbortController().signal);
  assert.equal(r.c.state,"needs-human");assert.equal(r.c.round,2);
  assert.equal(r.c.dependencyHints.length,1);assert.equal(r.c.repairBudget.verifyRepairs,0);
  assert.equal(r.c.messages.filter(m=>m._harnessGenerated&&m.content.includes("One bounded verification repair")).length,1);
  const exported=r.store.project(r.c);assert.deepEqual(exported.diagnosticCounts,{"dependency-missing":2});
  assert.ok(exported.verdicts.every(v=>v.diagnostics[0].evidenceRefs.length===1));r.db.close();
});

test("verification reservations survive crash and five repeated resume attempts",async()=>{
  const r=rig([finish()],{verify:async()=>({ok:false,diagnostics:[diagnostic("repairable")],artifacts:[]})});
  const result=r.store.record("run","saved-finish","harness_finish",{ok:false,summary:"Unverified summary",diagnostics:[diagnostic("repairable")]});
  const first=recordHarnessVerdict(r.c,"saved-finish",result);assert.equal(first.action,"repair");
  r.store.save(r.c);
  const restored=r.store.get("run");recordHarnessVerdict(restored,"saved-finish",result);
  assert.equal(restored.repairBudget.verifyRepairs,0);assert.equal(restored.verdicts.length,1);
  await r.controller.run(restored,new AbortController().signal,{resumed:true});
  for(let i=0;i<5;i++)await r.controller.run(restored,new AbortController().signal,{resumed:true});
  assert.equal(restored.state,"needs-human");assert.equal(restored.round,1);assert.equal(restored.verdicts.length,2);r.db.close();
});

test("a checkpoint after a permanent verdict cannot dispatch its pending batch on resume",async()=>{
  const r=rig([]);const result=r.store.record("run","stop","harness_finish",{ok:false,summary:"Retain this summary",diagnostics:[diagnostic("conflicting")]});
  recordHarnessVerdict(r.c,"stop",result);r.c.state="checkpointing";
  r.c.pendingCalls=[{id:"never-write",type:"function",function:{name:"workspace_propose_patch",arguments:'{"path":"build/out.txt"}'}}];r.store.save(r.c);
  const restored=r.store.get("run");await r.controller.run(restored,new AbortController().signal,{resumed:true});
  assert.equal(restored.state,"needs-human");assert.equal(restored.fullContent,"Retain this summary");assert.equal(r.calls.length,0);assert.equal(restored.round,0);r.db.close();
});

test("call limits migrate old reservations and survive resume without dispatching beyond the cap",async()=>{
  const r=rig([read(),{calls:[["workspace_read",{path:"second.txt"}]]},finish()]);
  for(let i=0;i<63;i++)r.store.intent("run",`historic-${i}`,"workspace_read",{path:`old-${i}.txt`},"read");
  await r.controller.run(r.c,new AbortController().signal);
  assert.equal(r.calls.length,1);assert.equal(r.c.toolCallCounts.workspace_read,64);
  const limitResult=r.c.resultHandles.map(h=>r.store.read("run",h)).find(r=>r.data.code==="TOOL_CALL_LIMIT_EXCEEDED");assert.ok(limitResult);
  assert.equal(r.store.get("run").toolCallCounts.workspace_read,64);r.db.close();
});

test("same invalid argument identity stays rejected after compaction while a repaired call runs",async()=>{
  const bad={calls:[["workspace_read",{unexpected:true}]]};
  const r=rig([bad,bad,bad,read(),finish()]);await r.controller.run(r.c,new AbortController().signal);
  assert.equal(r.calls.length,1);assert.ok(r.c.resultHandles.map(h=>r.store.read("run",h)).some(r=>r.data.code==="PREVIOUS_INVALID_CALL"));
  const compacted=compactHarnessHistory(bindCurrentExecutionState(r.c),r.c.contract.goal,8192);
  assert.ok(compacted.some(m=>m.content.includes('"negative_results"')&&m.content.includes("INVALID_TOOL_ARGUMENTS")));
  assert.ok(compacted.some(m=>m.content.includes('"last_verdict"')));
  assert.ok(harnessMemoryBudget(8192).characters<harnessMemoryBudget(32768).characters);r.db.close();
});

for(const outcome of ["completed","abstained"]){
  test(`the ${outcome} receipt and terminal checkpoint cannot leave a resumable gap`,async()=>{
    const r=rig([outcome==="completed"?finish():blocked()]);
    const save=r.store.save.bind(r.store),snapshots=[];
    r.store.save=c=>{save(c);snapshots.push(r.store.get("run"));};
    await r.controller.run(r.c,new AbortController().signal);
    const consumed=snapshots.filter(c=>c.completedCalls.length);
    assert.ok(consumed.length);assert.ok(consumed.every(c=>c.state===outcome));
    const restored=consumed[0];await r.controller.run(restored,new AbortController().signal,{resumed:true});
    assert.equal(restored.round,1);assert.equal(r.calls.length,0);r.db.close();
  });
}

test("prose repair is durable before the next asynchronous binding lookup",async()=>{
  const r=rig([{content:"Unverified answer",finish:"stop"},finish()]);
  const binding=r.host.binding;let lookups=0;
  r.host.binding=async signal=>{if(++lookups===2){const saved=r.store.get("run");assert.equal(saved.repairBudget.outputRepairs,0);assert.equal(saved.recoveryCounters.outputRepairs,1);assert.ok(saved.messages.some(m=>m._harnessGenerated&&m.content.includes("prose alone")));}return binding(signal);};
  await r.controller.run(r.c,new AbortController().signal);assert.equal(r.c.state,"completed");r.db.close();
});

test("nonempty permanent diagnostics cannot be hidden by an inconsistent ok flag",async()=>{
  const r=rig([finish()],{verify:async()=>({ok:true,diagnostics:[diagnostic("conflicting")],artifacts:[]})});
  await r.controller.run(r.c,new AbortController().signal);assert.equal(r.c.state,"needs-human");assert.equal(r.c.repairBudget.verifyRepairs,1);r.db.close();
});

for (const outcome of ["completed", "abstained", "needs-human"]) {
  test(`a publication exception preserves committed ${outcome} and cannot resume execution`, async () => {
    const notificationFailure = new Error("Fixture notification sink closed after terminal commit");
    const r = rig([read(), outcome === "abstained" ? blocked() : finish()], {
      ...(outcome === "needs-human" ? {verify: async () => ({ok: false, diagnostics: [diagnostic("unsupported")], artifacts: []})} : {}),
      publish: c => {if (c.state === outcome) throw notificationFailure;},
    });
    await assert.rejects(r.controller.run(r.c, new AbortController().signal), error => error === notificationFailure);
    const restored = r.store.get("run");
    assert.equal(restored.state, outcome);
    assert.equal(r.c.state, outcome);
    assert.deepEqual(restored.pendingCalls, []);
    assert.equal(restored.error, undefined, "presentation failure must not become an execution failure");
    assert.equal(restored.resultHandles.length, 2, "prior evidence remains intact");
    assert.equal(r.calls.length, 1);
    assert.equal(r.store.project(restored).resumable, false);
    const revision = restored.revision;
    await r.controller.run(restored, new AbortController().signal, {resumed: true});
    assert.equal(restored.revision, revision, "no model call or checkpoint rewrite follows the terminal outcome");
    assert.equal(r.calls.length, 1);
    r.db.close();
  });
}

test("a failed terminal checkpoint write still follows the execution failure path", async () => {
  const r = rig([finish()]);
  const save = r.store.save.bind(r.store);
  let attemptedTerminalWrite = false;
  r.store.save = c => {
    if (c.state === "completed" && !attemptedTerminalWrite) {
      attemptedTerminalWrite = true;
      throw Object.assign(new Error("Fixture terminal checkpoint could not be committed"), {code: "FIXTURE_STORE_WRITE_FAILED"});
    }
    return save(c);
  };
  await r.controller.run(r.c, new AbortController().signal);
  assert.equal(attemptedTerminalWrite, true);
  assert.equal(r.store.get("run").state, "incomplete");
  assert.equal(r.store.get("run").error.code, "FIXTURE_STORE_WRITE_FAILED");
  assert.equal(r.states.includes("completed"), false, "an uncommitted terminal outcome is never published");
  r.db.close();
});
