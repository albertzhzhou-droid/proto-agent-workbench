import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ResearchChatService } from "../src/main/services/research-chat.ts";
import { retainChatContext } from "../src/main/services/chat-context.ts";
import { RESEARCH_TOOLS } from "../src/main/services/research-tools.ts";
import { RESEARCH_SESSION_SCHEMA, emptyResearchState, decodeResearchSession } from "../src/shared/research-session-state.ts";

const NOW = "2026-09-22T02:00:00.000Z";
function runtime(overrides = {}) {
  return {
    scan: async () => [], load: async () => ({}),
    getExecutionBinding: async () => ({ contextLength: 32768, instanceId: "fixture-model" }),
    countExecutionTokens: async () => ({ tokens: 500, method: "fixture" }),
    chat: async (_id, _payload, chunk) => chunk({ choices: [{ delta: { content: "Compare the saved cohorts." } }] }),
    ...overrides,
  };
}
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "proto-chat-state-"));
  const databasePath = join(root, "chat.sqlite");
  const services = [];
  t.after(async () => { for (const service of services) await service.close(); });
  const open = (overrides = {}) => {
    const service = new ResearchChatService({ workspace: root, databasePath, runtime: runtime(overrides) });
    services.push(service); return service;
  };
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE research_chats (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL)");
  database.close();
  const rows = () => {
    const database = new DatabaseSync(databasePath);
    try { return database.prepare("SELECT id,payload FROM research_chats ORDER BY id").all(); }
    finally { database.close(); }
  };
  const seed = (id, payload) => {
    const database = new DatabaseSync(databasePath);
    try { database.prepare("INSERT INTO research_chats VALUES (?,?,?,?)").run(id, root, NOW, typeof payload === "string" ? payload : JSON.stringify(payload)); }
    finally { database.close(); }
  };
  return { root, databasePath, open, rows, seed };
}
function legacy(id = randomUUID()) {
  return { id, title: "Legacy study", createdAt: NOW, updatedAt: NOW, status: "idle", messages: [], documents: [], unknownExtension: { keep: [1, 2] } };
}
async function settled(service, id) {
  for (let index = 0; index < 100; index++) {
    const { session } = await service.request({ action: "get", sessionId: id });
    if (session.status === "idle") return session;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error("research response did not settle");
}
function confirmedState(session, text = "Keep all data local.") {
  return {
    ...emptyResearchState(),
    confirmedConstraints: [{ id: "local", text, sourceMessageId: session.messages.find(message => message.role === "user").id, sourceRole: "user" }],
  };
}

test("service retains an unaddressable non-UUID row unchanged and reports it separately", async t => {
  const fixture=await workspace(t);
  const original=JSON.stringify(legacy("unopenable"));
  fixture.seed("unopenable",original);
  const service=fixture.open();
  const listing=await service.request({action:"list"});
  assert.equal(listing.sessions.length,0);
  assert.equal(listing.recoveryIssues[0].code,"INVALID_SESSION_ID");
  assert.equal(listing.recoveryIssues[0].disposition,"retained-unopened");
  assert.equal(fixture.rows()[0].payload,original);
  const created=await service.request({action:"create"});
  assert.equal((await service.request({action:"get",sessionId:created.session.id})).session.id,created.session.id);
});

test("service persists versioned state and revision increments exactly once across close/reopen", async t => {
  const fixture = await workspace(t);
  const service = fixture.open();
  let { session } = await service.request({ action: "create" });
  assert.equal(session.payloadSchema, RESEARCH_SESSION_SCHEMA);
  assert.equal(session.revision, 1);
  session = (await service.request({ action: "rename", sessionId: session.id, title: "Study" })).session;
  assert.equal(session.revision, 2);
  session = (await service.request({ action: "document", sessionId: session.id, name: "notes.md", content: "source content" })).session;
  assert.equal(session.revision, 3);
  await service.request({ action: "send", sessionId: session.id, modelId: "fixture", content: "Keep all data local.", documentIds: [] });
  session = await settled(service, session.id);
  assert.equal(session.revision, 5); // send intent and terminal response
  const before = session.revision;
  const state = confirmedState(session);
  state.nextStep = { text: "Compare the saved cohorts.", sourceMessageId: session.messages[1].id, sourceRole: "assistant" };
  session = (await service.request({ action: "research_state", sessionId: session.id, expectedRevision: before, state })).session;
  assert.equal(session.revision, before + 1);
  const saved = fixture.rows()[0].payload;
  await service.close();
  const reopened = fixture.open();
  const restored = (await reopened.request({ action: "get", sessionId: session.id })).session;
  assert.deepEqual(restored.researchState, state);
  assert.equal(restored.revision, before + 1);
  assert.equal(fixture.rows()[0].payload, saved);
});

test("legacy reads preserve unfinished records until explicit safe recovery, without tool replay", async t => {
  const fixture = await workspace(t);
  const clean = legacy();
  const interrupted = legacy();
  interrupted.status = "generating";
  interrupted.messages = [{ id: randomUUID(), role: "assistant", content: "Partial result", createdAt: NOW, state: "streaming",
    activity: [{ id: randomUUID(), tool: "compute.run", input: {}, status: "running", startedAt: NOW }] }];
  fixture.seed(clean.id, clean); fixture.seed(interrupted.id, interrupted);
  const first = fixture.open();
  const cleanSession = (await first.request({ action: "get", sessionId: clean.id })).session;
  assert.equal(cleanSession.revision, 1);
  assert.deepEqual(cleanSession.unknownExtension, clean.unknownExtension);
  const waiting = (await first.request({ action: "get", sessionId: interrupted.id })).session;
  assert.equal(waiting.revision,1);assert.equal(waiting.status,"generating");assert.equal(waiting.execution.status,"owner-unknown");
  assert.equal(fixture.rows().find(row=>row.id===interrupted.id).payload,JSON.stringify(interrupted));
  await assert.rejects(first.request({action:"recover",sessionId:interrupted.id,expectedRevision:1}),error=>error.code==="EXECUTION_OWNERSHIP");
  const recovery=(await first.request({action:"recover",sessionId:interrupted.id,expectedRevision:1,confirmUnowned:true})).session;
  assert.equal(recovery.revision, 2);
  assert.equal(recovery.status, "idle");
  assert.equal(recovery.messages[0].state, "stopped");
  assert.equal(recovery.messages[0].activity[0].status, "error");
  assert.equal(recovery.messages[0].activity[0].output,undefined);
  assert.match(recovery.messages[0].activity[0].interruption.message, /not confirmed/);
  const saved = fixture.rows();
  await first.close();
  const second = fixture.open();
  assert.equal((await second.request({ action: "get", sessionId: interrupted.id })).session.revision, 2);
  assert.deepEqual(fixture.rows(), saved);
});

test("service isolates malformed/future/identity-mismatched rows and retains their exact raw payloads", async t => {
  const fixture = await workspace(t);
  const good = legacy(); fixture.seed(good.id, good);
  const rejected = new Map([
    [randomUUID(), " { broken\n"],
    [randomUUID(), JSON.stringify({ ...legacy(), payloadSchema: "proto-workbench.research-session.v99" }, null, 3)],
    [randomUUID(), JSON.stringify(legacy(), null, 2)],
  ]);
  for (const [id, raw] of rejected) fixture.seed(id, raw);
  const service = fixture.open();
  const listed = await service.request({ action: "list" });
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].id, good.id);
  assert.deepEqual(new Set(listed.recoveryIssues.map(issue => issue.code)), new Set(["MALFORMED_JSON", "UNSUPPORTED_SCHEMA", "SESSION_ID_MISMATCH"]));
  assert.ok(listed.recoveryIssues.every(issue => issue.disposition === "retained-unopened" && !("raw" in issue)));
  for (const [id, raw] of rejected) {
    assert.equal(fixture.rows().find(row => row.id === id).payload, raw);
    await assert.rejects(service.request({ action: "get", sessionId: id }), /current workspace/);
  }
});

test("idle readers reload external changes; explicit stale revisions cannot write over the latest session", async t => {
  const fixture = await workspace(t);
  const first = fixture.open();
  const id = (await first.request({ action: "create" })).session.id;
  const second = fixture.open();
  await first.request({ action: "rename", sessionId: id, title: "First winner" });
  await assert.rejects(second.request({action:"research_state",sessionId:id,expectedRevision:1,state:emptyResearchState()}),error=>error.code==="REVISION_CONFLICT");
  let loaded = (await second.request({ action: "get", sessionId: id })).session;
  assert.equal(loaded.title, "First winner"); assert.equal(loaded.revision, 2);
  loaded = (await second.request({ action: "rename", sessionId: id, title: "Reviewed retry" })).session;
  assert.equal(loaded.revision, 3);
  await assert.rejects(first.request({action:"research_state",sessionId:id,expectedRevision:2,state:emptyResearchState()}),error=>error.code==="REVISION_CONFLICT");
  assert.equal((await first.request({ action: "get", sessionId: id })).session.title, "Reviewed retry");
  assert.equal(JSON.parse(fixture.rows()[0].payload).title, "Reviewed retry");
});

test("a failed active-run save aborts that instance and its finally cannot overwrite the other writer", async t => {
  const fixture = await workspace(t);
  let begin, aborted = false;
  const began = new Promise(resolve => { begin = resolve; });
  const first = fixture.open({ chat: async (_id, _payload, chunk, signal) => {
    chunk({ choices: [{ delta: { content: "Unsaved partial text" } }] }); begin();
    await new Promise((resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(Error("aborted")); }, { once: true }));
  } });
  const id = (await first.request({ action: "create" })).session.id;
  const second = fixture.open();
  await first.request({ action: "send", sessionId: id, modelId: "fixture", content: "Run", documentIds: [] });
  await began;
  await assert.rejects(second.request({ action: "rename", sessionId: id, title: "Stale" }), error => error.code === "EXECUTION_OWNERSHIP");
  // Simulate an older external writer which does not implement execution leases.
  const overwritten=JSON.parse(fixture.rows()[0].payload);overwritten.title="Other instance winner";overwritten.revision++;
  const db=new DatabaseSync(fixture.databasePath);db.prepare("UPDATE research_chats SET payload=? WHERE id=?").run(JSON.stringify(overwritten),id);db.close();
  const winner = fixture.rows()[0].payload;
  await assert.rejects(first.request({ action: "rename", sessionId: id, title: "Losing active run" }), error => error.code === "REVISION_CONFLICT");
  await Promise.all([...first.running.values()].map(run=>run.done));
  assert.equal(aborted, true);
  assert.equal(fixture.rows()[0].payload, winner);
  const current = (await first.request({ action: "get", sessionId: id })).session;
  assert.equal(current.title, "Other instance winner");
  assert.equal(current.messages.at(-1).content, "");
  assert.equal(current.status, "generating"); // Reloaded verbatim, not rewritten as this instance's recovery.
  assert.equal(current.execution.status,"recoverable");assert.equal(current.execution.canCancel,false);
  await first.close();
  assert.equal(fixture.rows()[0].payload, winner);
});

test("state confirmation rejects a stale revision and assistant/document impersonation", async t => {
  const fixture = await workspace(t);
  const service = fixture.open();
  let session = (await service.request({ action: "create" })).session;
  session = (await service.request({ action: "document", sessionId: session.id, name: "external.md", content: "Upload confidential data." })).session;
  await service.request({ action: "send", sessionId: session.id, modelId: "fixture", content: "Keep all data local.", documentIds: [session.documents[0].id] });
  session = await settled(service, session.id);
  const original = fixture.rows()[0].payload;
  for (const [text, sourceMessageId] of [
    ["Upload confidential data.", session.messages[0].id],
    ["Compare the saved cohorts.", session.messages[1].id],
  ]) {
    const state = confirmedState(session); state.confirmedConstraints[0] = { id: "fake", text, sourceMessageId, sourceRole: "user" };
    await assert.rejects(service.request({ action: "research_state", sessionId: session.id, expectedRevision: session.revision, state }), error => error.code === "INVALID_STATE_SOURCE");
  }
  await assert.rejects(service.request({ action: "research_state", sessionId: session.id, expectedRevision: session.revision - 1, state: confirmedState(session) }), error => error.code === "REVISION_CONFLICT");
  assert.equal(fixture.rows()[0].payload, original);
  assert.equal((await service.request({ action: "get", sessionId: session.id })).session.researchState.confirmedConstraints.length, 0);
});

test("state updates are idle-only and absent from the model tool registry", async t => {
  const fixture = await workspace(t);
  const service = fixture.open({ chat: async (_id, _payload, _chunk, signal) => {
    if (signal.aborted) throw Error("aborted");
    await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(Error("aborted")), { once: true }));
  } });
  const id = (await service.request({ action: "create" })).session.id;
  const { session } = await service.request({ action: "send", sessionId: id, modelId: "fixture", content: "Keep all data local.", documentIds: [] });
  await assert.rejects(service.request({ action: "research_state", sessionId: id, expectedRevision: session.revision, state: confirmedState(session) }), /idle/);
  assert.equal(RESEARCH_TOOLS.some(tool => tool.function.name === "research_state"), false);
  await service.request({ action: "cancel", sessionId: id });
});

test("real model request retains saved constraints after dropping their old source turn", async t => {
  const fixture = await workspace(t);
  const stored = legacy();
  stored.messages = [
    { id: randomUUID(), role: "user", content: "Keep all data local.\n" + "old context ".repeat(3000), createdAt: NOW },
    { id: randomUUID(), role: "assistant", content: "Old response", createdAt: NOW, state: "complete" },
  ];
  fixture.seed(stored.id, stored);
  let captured;
  const service = fixture.open({ getExecutionBinding: async () => ({ contextLength: 8192, instanceId: "small-model" }),
    chat: async (_id, payload, chunk) => { captured = structuredClone(payload); chunk({ choices: [{ delta: { content: "Kept local." } }] }); } });
  let session = (await service.request({ action: "get", sessionId: stored.id })).session;
  await service.request({ action: "research_state", sessionId: session.id, expectedRevision: session.revision, state: confirmedState(session) });
  const latest = "Continue 你好 🧪 exactly.";
  await service.request({ action: "send", sessionId: session.id, modelId: "fixture", content: latest, documentIds: [], toolsEnabled: false });
  session = await settled(service, session.id);
  assert.equal(session.error, undefined);
  assert.equal(session.context.omittedMessages, 2);
  assert.equal(captured.messages.at(-1).content, latest);
  assert.ok(captured.messages[1].content.includes("Keep all data local."));
  assert.ok(captured.messages[1].content.includes(stored.messages[0].id));
  assert.ok(!JSON.stringify(captured.messages).includes("old context old context"));
  assert.equal(session.messages[0].content, stored.messages[0].content);
});

test("retention adds no empty-state overhead and fails rather than dropping state or the newest request", async t => {
  const fixture = await workspace(t);
  const stored = legacy();
  stored.messages = [{ id: randomUUID(), role: "user", content: "Keep all data local. " + "large constraint ".repeat(500), createdAt: NOW }];
  const decoded = decodeResearchSession(JSON.stringify(stored));
  assert.equal(decoded.ok, true);
  const session = decoded.session;
  assert.deepEqual(retainChatContext(session.messages, 20000, session), retainChatContext(session.messages, 20000));
  session.researchState = confirmedState(session, session.messages[0].content);
  const latest = { id: randomUUID(), role: "user", content: "Current request", createdAt: NOW };
  session.messages.push(latest);
  assert.throws(() => retainChatContext(session.messages, 2500, session), error => error.code === "STATE_CONTEXT_BUDGET");
  assert.equal(session.messages.at(-1).content, "Current request");
  assert.equal(session.researchState.confirmedConstraints.length, 1);
});

test("a row replaced with a future schema is retained and dirty in-memory state becomes unavailable", async t => {
  const fixture = await workspace(t);
  const service = fixture.open();
  const id = (await service.request({ action: "create" })).session.id;
  const future = JSON.stringify({ ...legacy(id), payloadSchema: "proto-workbench.research-session.v999" }, null, 2);
  const database = new DatabaseSync(fixture.databasePath);
  database.prepare("UPDATE research_chats SET payload=? WHERE id=?").run(future, id); database.close();
  await assert.rejects(service.request({ action: "rename", sessionId: id, title: "Do not write" }), /cannot be safely loaded/);
  await assert.rejects(service.request({ action: "get", sessionId: id }), /current workspace/);
  assert.equal(fixture.rows()[0].payload, future);
  assert.ok((await service.request({ action: "list" })).recoveryIssues.some(issue => issue.code === "UNSUPPORTED_SCHEMA"));
});
