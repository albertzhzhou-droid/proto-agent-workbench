import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { AgentService } from "../src/main/services/agent-service.ts";
import { AppDatabase } from "../src/main/services/database.ts";
import { WorkspaceFiles } from "../src/main/services/workspace-files.ts";
import { HarnessStore } from "../src/main/services/harness-store.ts";
import { projectRunExecution } from "../src/shared/run-execution.ts";

const call = (name, args = {}) => [name, args];
const finish = summary => call("harness_finish", { summary });
const discover = query => call("harness_discover_tools", { query });
const schema = (name, properties = {}, required = []) => ({name, description: name, inputSchema: {type: "object", properties, required, additionalProperties: false}});
const timeout = promise => new Promise((resolveValue, reject) => {
  const timer = setTimeout(() => reject(new Error("Agent service did not emit a terminal event within 5 seconds")), 5000);
  promise.then(value => {clearTimeout(timer); resolveValue(value);}, error => {clearTimeout(timer); reject(error);});
});

async function rig(t, turns, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "proto-agent-harness-service-"));
  await mkdir(join(root, "build"));
  await writeFile(join(root, "input.md"), "Controlled software-only fixture input.\n");
  const database = new AppDatabase(":memory:");
  const workspace = new WorkspaceFiles(root, database);
  const store = new HarnessStore(database.db);
  const events = [], calls = [], sessions = [], bindings = [], tokenCounts = [];
  const model = {id: "service-fixture-model", name: "Service fixture", loadState: "active"};
  let chats = 0;
  const models = {
    get: () => model, getActiveModel: () => model, setToolCapability() {},
    getExecutionBinding: async (_id, signal) => {
      signal.throwIfAborted(); bindings.push(_id);
      return {modelId: model.id, instanceId: "service-fixture-instance", contextLength: options.contextLength ?? 32768, observedAt: new Date().toISOString(), ownedByWorkbench: false};
    },
    countExecutionTokens: async (_id, messages, tools, signal) => {
      signal.throwIfAborted(); tokenCounts.push({messages, tools}); return {tokens: 1024, method: "exact"};
    },
    chat: async (_id, payload, onChunk, signal) => {
      chats++; signal.throwIfAborted(); payload._onQueueState?.("active");
      const turn = turns.shift();
      if (typeof turn === "function") return turn(payload, onChunk, signal);
      if (turn === undefined) throw new Error("No more scripted fixture model responses");
      if (typeof turn === "string") {
        onChunk({usage: {completion_tokens: 10}, choices: [{finish_reason: "stop", delta: {content: turn}}]}); return;
      }
      onChunk({usage: {completion_tokens: 20}, choices: [{finish_reason: "tool_calls", delta: {tool_calls: turn.map(([name, args], index) => ({index, id: `provider-reused-${index}`, type: "function", function: {name, arguments: JSON.stringify(args)}}))}}]});
    },
  };
  const mcp = {
    fork() {
      if (options.forkError) throw new Error(options.forkError);
      const session = {stopped: false, tools: async () => {if (options.toolsError) throw new Error(options.toolsError); return options.tools ?? [];},
        call: async (name, args, signal, authorization) => {signal?.throwIfAborted(); calls.push({name, args, authorization}); return options.execute ? options.execute(name, args, authorization) : {ok: true, results: []};},
        stop: async () => {await options.stop?.(); session.stopped = true;},
      };
      sessions.push(session); return session;
    },
  };
  let terminalResolve;
  const terminal = new Promise(resolveTerminal => {terminalResolve = resolveTerminal;});
  const agent = new AgentService(database, models, workspace, mcp, event => {
    events.push(event);
    options.observe?.(event, agent, sessions);
    if (event.type === "message-complete" || event.type === "error") terminalResolve(event);
  }, undefined, root);
  t.after(async () => {
    await agent.cancelAll(); database.close();
    assert.equal(dirname(root), resolve(tmpdir())); assert.ok(root.includes("proto-agent-harness-service-"));
    await rm(root, {recursive: true, force: true});
  });
  const thread = agent.createThread({workspacePath: root, title: "Controlled service mission", mode: options.mode ?? "act", modelId: model.id});
  return {root, database, workspace, store, agent, thread, events, calls, sessions, bindings, tokenCounts,
    get chats() {return chats;},
    async start(goal, preflight) {await agent.send(thread.id, goal, [], preflight);},
    async complete() {
      const event = await timeout(terminal); await agent.cancelAll();
      const runId = events.find(item => item.type === "run-event" && item.runEvent.stage === "goal")?.runEvent.runId;
      return {event, checkpoint: runId ? store.get(runId) : undefined, runId};
    },
    results(checkpoint) {return checkpoint.resultHandles.map(handle => store.read(checkpoint.contract.runId, handle));},
  };
}

test("AgentService commits a scoped model-authored artifact and completes only through checked finish", {timeout: 10000}, async t => {
  const content = "# Fixture result\n\nThe controlled input was inspected. Software test only.\n";
  const r = await rig(t, [
    [call("workspace_read", {path: "input.md"})],
    [call("harness_plan", {deliverables: [{path: "build/result.md", kind: "document"}]})],
    [call("workspace_propose_patch", {path: "build/result.md", content, rationale: "Fulfill the source-bound fixture task"})],
    [finish("The requested fixture artifact was saved and checked.")],
  ]);
  await r.start("Read input.md and write build/result.md.");
  const {checkpoint, event} = await r.complete();
  assert.equal(checkpoint.state, "completed", JSON.stringify(checkpoint.error));
  assert.equal(await readFile(join(r.root, "build/result.md"), "utf8"), content);
  assert.equal(event.type, "message-complete");
  assert.ok(r.events.some(item => item.type === "patch-proposal" && item.patch.status === "approved"));
  assert.equal(r.events.some(item => item.type === "approval-required"), false);
  assert.ok(r.results(checkpoint).some(item => item.tool === "workspace_propose_patch" && item.data.operation.state === "verified"));
  assert.ok(r.bindings.length > 0 && r.tokenCounts.length > 0);
  assert.equal(r.sessions.length, 1); assert.equal(r.sessions[0].stopped, true);
  const persisted = r.database.getRunEvents(checkpoint.contract.runId);
  const graph = projectRunExecution(persisted);
  const readStep = persisted.find(item => item.tool === "workspace_read");
  const writeStep = persisted.find(item => item.tool === "workspace_propose_patch");
  assert.ok(graph.topologyEdges.some(edge => edge.kind === "execution" && edge.sourceStepId === readStep?.id && edge.targetStepId === writeStep?.id));
  assert.equal(graph.quarantined.length, 0);
});

test("material finish rejects a transcribed hash and lets the model repair the saved report without host content fallback", {timeout: 10000}, async t => {
  const records = [1, 2, 3].map(index => ({resource_id: `catalog:fixture-${index}`, sequence_sha256: String(index).repeat(64), sequence_length: index * 20,
    source: {provider: "Controlled catalogue", record_id: `fixture-${index}`, url: `https://catalog.example/fixture-${index}`}, license: {id: `License-${index}`}}));
  const good = JSON.stringify(records, null, 2), bad = good.replace(records[0].sequence_sha256, records[0].sequence_sha256.slice(2));
  const path = "build/material-report.json";
  const r = await rig(t, [
    [discover("proto_materials_search")],
    [call("proto_materials_search", {limit: 3})],
    [call("workspace_propose_patch", {path, content: bad, rationale: "Write the requested exact material metadata report"})],
    [finish(good)],
    [call("workspace_read", {path})],
    [call("workspace_propose_patch", {path, content: good, rationale: "Repair the exact sequence hash diagnosed by completion verification"})],
    [finish("The current saved report now matches the three retrieved material records.")],
  ], {tools: [schema("proto_materials_search", {limit: {type: "integer", minimum: 1, maximum: 20}})], execute: async name => {
    assert.equal(name, "proto_materials_search"); return {ok: true, matches: records};
  }});
  await r.start(`Search the catalogue and record three exact resource IDs, sequence hashes, source and license fields. Create ${path}.`);
  const {checkpoint, event} = await r.complete();
  assert.equal(checkpoint.state, "completed", JSON.stringify(checkpoint.error)); assert.equal(event.type, "message-complete");
  assert.deepEqual(checkpoint.contract.evidenceRequirements, [{kind: "materials", minimumRecords: 3, fields: ["sequence_sha256", "source", "license"], recordKind: "catalogue"}]);
  const finishes = r.results(checkpoint).filter(result => result.tool === "harness_finish");
  assert.equal(finishes.length, 2); assert.equal(finishes[0].ok, false); assert.equal(finishes[1].ok, true);
  assert.ok(finishes[0].data.diagnostics.some(value => value.includes("MATERIAL_HASH_MISMATCH") && value.includes(records[0].resource_id)));
  assert.equal(await readFile(join(r.root, path), "utf8"), good);
  const writes = r.results(checkpoint).filter(result => result.tool === "workspace_propose_patch");
  assert.equal(writes.length, 2); assert.ok(writes.every(result => result.ok));
  assert.equal(checkpoint.hostRecovered, false); assert.equal(r.events.some(event => event.type === "approval-required"), false);
});

for (const [label, response] of [["prose-only", "I completed the task."], ["empty", ""]]) {
  test(`${label} responses cannot activate automatic toy workflows or mark a mission completed`, {timeout: 10000}, async t => {
    const r = await rig(t, [response, response]);
    await r.start("Read input.md and write build/result.md.");
    const {checkpoint, event} = await r.complete();
    assert.equal(checkpoint.state, "incomplete");
    assert.notEqual(event.message.content, "I completed the task.");
    assert.equal(r.calls.length, 0);
    assert.equal(r.chats, 2);
    await assert.rejects(readFile(join(r.root, "build/result.md")), {code: "ENOENT"});
  });
}

test("a mission-scoped online tool receives a run-bound capability without a second approval", {timeout: 10000}, async t => {
  const r = await rig(t, [[discover("proto_pubmed_search")], [call("proto_pubmed_search", {query: "controlled fixture", offline: false})], [finish("The source returned zero records; the evidence gap remains explicit.")]], {
    tools: [schema("proto_pubmed_search", {query: {type: "string"}, offline: {type: "boolean"}}, ["query"])],
  });
  await r.start("Inspect the source response.", {digest: "0".repeat(64), state: "ready", requirements: [], intent: {network: true, execution: false, writes: false}});
  const {checkpoint} = await r.complete();
  assert.equal(checkpoint.state, "completed", JSON.stringify(checkpoint.error));
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].authorization.runId, checkpoint.contract.runId);
  const goal = r.events.find(item => item.type === "run-event" && item.runEvent.stage === "goal").runEvent;
  assert.equal(goal.payload.missionPreflight.digest, "0".repeat(64));
  assert.deepEqual(goal.payload.missionPreflight.requirementIds, []);
  assert.match(r.calls[0].authorization.approvalId, /^mission:/);
  assert.equal(r.events.some(item => item.type === "approval-required"), false);
  assert.deepEqual(r.results(checkpoint).find(item => item.tool === "proto_pubmed_search").data.results, []);
});

test("out-of-scope network calls produce a durable denial and never reach MCP", {timeout: 10000}, async t => {
  const r = await rig(t, [[discover("proto_pubmed_search")], [call("proto_pubmed_search", {query: "controlled fixture", offline: false})], [finish("The online request is blocked by mission scope.")]], {
    tools: [schema("proto_pubmed_search", {query: {type: "string"}, offline: {type: "boolean"}}, ["query"])],
  });
  await r.start("Inspect available sources.");
  const {checkpoint} = await r.complete();
  assert.equal(r.calls.length, 0);
  assert.equal(r.results(checkpoint).find(item => item.tool === "proto_pubmed_search").data.code, "MISSION_SCOPE_REQUIRED");
});

test("plan-mode attempted writes leave no filesystem effect", {timeout: 10000}, async t => {
  const r = await rig(t, [[call("workspace_propose_patch", {path: "build/result.md", content: "# Attempt", rationale: "Fixture denial"})], [finish("No file was written in plan mode.")]], {mode: "plan"});
  await r.start("Inspect the available workspace context.");
  const {checkpoint} = await r.complete();
  assert.equal(r.results(checkpoint).find(item => item.tool === "workspace_propose_patch").data.code, "INVALID_TOOL_ARGUMENTS");
  assert.equal(r.tokenCounts[0].tools.some(tool => tool.function.name === "workspace_propose_patch"), false);
  await assert.rejects(readFile(join(r.root, "build/result.md")), {code: "ENOENT"});
});

test("an unbound DNA check does not fall back to the toy parts library", {timeout: 10000}, async t => {
  const r = await rig(t, [[discover("proto_check")], [call("proto_check", {path: "build/fixture.proto"})], [finish("DNA checking requires a materialized source binding.")]], {tools: [schema("proto_check", {path: {type: "string"}}, ["path"])]});
  await r.start("Inspect available DNA software checks.");
  const {checkpoint} = await r.complete();
  assert.equal(r.calls.length, 0);
  assert.equal(r.results(checkpoint).find(item => item.tool === "proto_check").data.code, "MATERIAL_BINDING_REQUIRED");
});

test("MCP session startup failures emit a terminal error and a failed execution event", {timeout: 10000}, async t => {
  const r = await rig(t, [], {forkError: "Controlled session startup failure"});
  await r.start("Inspect the workspace.");
  const {event} = await r.complete();
  assert.equal(event.type, "error"); assert.match(event.error, /Controlled session startup failure/);
  assert.ok(r.events.some(item => item.type === "run-event" && item.runEvent.status === "failed"));
  assert.equal(r.chats, 0);
});

test("cancelAll persists cancellation and waits for the owned session to stop", {timeout: 10000}, async t => {
  let activeResolve;
  const active = new Promise(resolveActive => {activeResolve = resolveActive;});
  const r = await rig(t, [async (_payload, onChunk, signal) => {
    onChunk({choices: [{delta: {reasoning_content: "Partial controlled reasoning"}}]}); activeResolve();
    await new Promise((resolveDone, reject) => {signal.addEventListener("abort", () => reject(signal.reason), {once: true}); if (signal.aborted) reject(signal.reason);});
  }]);
  await r.start("Inspect input.md."); await timeout(active); await r.agent.cancelAll();
  const {checkpoint} = await r.complete();
  assert.equal(checkpoint.state, "cancelled"); assert.equal(r.sessions[0].stopped, true);
  assert.ok(checkpoint.generatedTokens > 0);
  assert.equal(r.events.some(item => item.type === "message-complete" && item.harness?.state === "completed"), false);
});

function deferred() {
  let resolveValue;
  const promise = new Promise(resolve => {resolveValue = resolve;});
  return {promise, resolve: resolveValue};
}

test("owned cleanup failure persists an incomplete non-resumable diagnostic instead of a green completion",async t=>{
  const r=await rig(t,[[call("workspace_read",{path:"input.md"})],[finish("Inspected the controlled input.")]],{stop:async()=>{throw Object.assign(new Error("Controlled owned process did not close"),{code:"OWNED_PROCESS_STREAM_TIMEOUT"});}});
  await r.start("Inspect input.md.");const {checkpoint,event}=await r.complete();
  assert.equal(event.type,"error");assert.equal(checkpoint.state,"incomplete");assert.equal(checkpoint.error.code,"OWNED_RESOURCE_CLEANUP_FAILED");assert.equal(r.store.project(checkpoint).resumable,false);
  const diagnostic=r.database.getRunEvents(checkpoint.contract.runId).find(event=>event.payload?.cleanup);
  assert.equal(diagnostic.payload.cleanup.processAndStreamsClosed,false);assert.equal(diagnostic.payload.cleanup.code,"OWNED_PROCESS_STREAM_TIMEOUT");
  assert.equal(r.events.some(event=>event.type==="message-complete"),false);assert.equal(r.database.getMessages(r.thread.id).some(message=>message.role==="assistant"),false);
  await assert.rejects(r.agent.resumeExecution(checkpoint.contract.runId),/not resumable/);
});

for (const terminalPath of ["completed", "error", "pause", "cancel", "cancelAll"]) {
  test(`${terminalPath} UI terminal notification waits for owned teardown and active-map release`, {timeout: 10000}, async t => {
    const chatting = deferred(), stopping = deferred(), releaseStop = deferred();
    const observations = [];
    const turns = terminalPath === "completed"
      ? [[call("workspace_read", {path: "input.md"})], [finish("Inspected the controlled fixture input.")]]
      : [async (_payload, _chunk, signal) => {
          chatting.resolve();
          await new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {once: true});
            if (signal.aborted) reject(signal.reason);
          });
        }];
    const r = await rig(t, turns, {
      toolsError: terminalPath === "error" ? "Controlled catalog failure" : undefined,
      stop: async () => {stopping.resolve(); await releaseStop.promise;},
      observe: (event, agent, sessions) => {
        if (["message-complete", "error", "cancelled"].includes(event.type)) {
          observations.push({type: event.type, active: agent.hasActiveRuns(), stopped: sessions.every(session => session.stopped)});
        }
      },
    });
    let cancellation, cancellationSettled = false;
    try {
      await r.start("Inspect input.md.");
      if (["pause", "cancel", "cancelAll"].includes(terminalPath)) {
        await timeout(chatting.promise);
        const runId = r.events.find(event => event.runEvent?.stage === "goal").runEvent.runId;
        cancellation = (terminalPath === "pause" ? r.agent.pauseExecution(runId) : terminalPath === "cancel" ? r.agent.cancel(r.thread.id) : r.agent.cancelAll()).then(() => {cancellationSettled = true;});
      }
      await timeout(stopping.promise);
      assert.equal(r.agent.hasActiveRuns(), true, "generation ownership must remain until MCP teardown settles");
      assert.equal(observations.length, 0, "no terminal event may enable controls while teardown is pending");
      if (cancellation) assert.equal(cancellationSettled, false);
      if (terminalPath === "pause") {
        const paused = r.agent.listExecutions().find(item => item.state === "paused");
        assert.ok(paused, "the durable paused checkpoint may be visible before teardown finishes");
        await assert.rejects(r.agent.resumeExecution(paused.runId), /already running/);
      }
    } finally {releaseStop.resolve();}
    if (cancellation) await timeout(cancellation);
    const {event, checkpoint} = await r.complete();
    assert.deepEqual(observations, [{type: terminalPath === "error" ? "error" : "message-complete", active: false, stopped: true}]);
    assert.equal(r.agent.hasActiveRuns(), false);
    if (terminalPath === "pause") assert.equal(checkpoint.state, "paused");
    if (terminalPath === "cancel" || terminalPath === "cancelAll") assert.equal(checkpoint.state, "cancelled");
    if (terminalPath === "error") assert.match(event.error, /Controlled catalog failure/);
  });
}
