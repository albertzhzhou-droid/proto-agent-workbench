import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ResearchChatRepository } from "../src/main/services/research-chat-repository.ts";
import { encodeResearchSession, emptyResearchState } from "../src/shared/research-session-state.ts";
import { retainChatContext } from "../src/main/services/chat-context.ts";

function makeSession(messageCount, revision = 1) {
  const now = "2026-09-22T12:00:00.000Z";
  return {
    id: randomUUID(), title: "Transcript paging", createdAt: now, updatedAt: now,
    messages: Array.from({ length: messageCount }, (_, index) => ({
      id: randomUUID(), role: index % 2 ? "assistant" : "user", content: `message ${index}`, createdAt: now,
      ...(index % 2 ? { state: "complete" } : {}),
    })),
    documents: [], status: "idle", payloadSchema: "proto-workbench.research-session.v1", revision,
    researchState: emptyResearchState(),
  };
}

test("normalized transcript pages are bounded, ordered and stable across later appends", async t => {
  const directory = await mkdtemp(join(tmpdir(), "proto-transcript-"));
  const repository = new ResearchChatRepository(join(directory, "chat.sqlite"), directory);
  t.after(() => repository.close());
  let session = makeSession(93), raw = encodeResearchSession(session);
  repository.write(session, raw);

  const latest = repository.messagePage(session.id, undefined, 40);
  assert.equal(latest.startIndex, 53);
  assert.equal(latest.messages.length, 40);
  assert.ok(latest.nextCursor);
  const cursor = latest.nextCursor;

  session = { ...session, revision: 2, updatedAt: "2026-09-22T12:01:00.000Z", messages: [...session.messages, {
    id: randomUUID(), role: "user", content: "new message", createdAt: "2026-09-22T12:01:00.000Z",
  }] };
  const nextRaw = encodeResearchSession(session);
  repository.write(session, nextRaw, raw);
  raw = nextRaw;
  const older = repository.messagePage(session.id, cursor, 40);
  assert.equal(older.startIndex, 13);
  assert.equal(older.messages.length, 40);
  assert.equal(older.resetRequired, undefined);
  assert.equal(older.messages[0].id, session.messages[13].id);

  // A cursor whose source prefix changed resets to the latest page instead of
  // mixing pages from two different transcript histories.
  session = { ...session, revision: 3, updatedAt: "2026-09-22T12:02:00.000Z", messages: session.messages.map((message, index) => index === 0 ? { ...message, content: "edited source" } : message) };
  const changedRaw = encodeResearchSession(session);
  repository.write(session, changedRaw, raw);
  const reset = repository.messagePage(session.id, cursor, 40);
  assert.equal(reset.resetRequired, true);
  assert.equal(reset.startIndex, session.messages.length - 40);
  assert.equal(reset.messages.at(-1).id, session.messages.at(-1).id);
});

test("legacy rows materialize lazily and corrupted page payloads fail closed", async t => {
  const directory = await mkdtemp(join(tmpdir(), "proto-transcript-legacy-"));
  const repository = new ResearchChatRepository(join(directory, "chat.sqlite"), directory);
  t.after(() => repository.close());
  const session = makeSession(2);
  const legacy = { ...session };
  delete legacy.payloadSchema; delete legacy.revision; delete legacy.researchState;
  const raw = JSON.stringify(legacy);
  repository.db.prepare("INSERT INTO research_chats(id,workspace,updated_at,payload) VALUES(?,?,?,?)").run(session.id,directory,session.updatedAt,raw);
  const migrated = repository.messagePage(session.id);
  assert.equal(migrated.messages.length, 2);
  assert.match(migrated.transcriptSha256, /^[a-f0-9]{64}$/);

  repository.db.prepare("UPDATE research_chat_messages SET payload=? WHERE session_id=? AND ordinal=0").run("{}", session.id);
  const latest=repository.messagePage(session.id,undefined,1);
  await assert.rejects(async () => repository.messagePage(session.id,latest.nextCursor??undefined,1), /failed its stored digest|invalid message/i);
  assert.ok(repository.issues().recoveryIssueCount > 0);
});

test("context retention records exact omitted ranges, hashes and receipt source references", () => {
  const history=[
    {id:"user-old",role:"user",content:"Prior question ".repeat(240),createdAt:"2026-09-22T12:00:00.000Z"},
    {id:"assistant-old",role:"assistant",content:"Prior result",createdAt:"2026-09-22T12:00:01.000Z",state:"complete",activity:[{id:"receipt-1",tool:"workspace_search",input:{query:"prior"},status:"complete",artifactPath:"build/chat/result.json",artifactSha256:"a".repeat(64),startedAt:"2026-09-22T12:00:01.000Z"}]},
    {id:"user-current",role:"user",content:"Keep this request",createdAt:"2026-09-22T12:00:02.000Z"},
  ];
  const retained=retainChatContext(history,2200);
  assert.equal(retained.retention.omittedMessages,2);
  assert.equal(retained.retention.omittedRanges.length,1);
  assert.equal(retained.retention.omittedRanges[0].startIndex,0);
  assert.equal(retained.retention.omittedRanges[0].endIndex,1);
  assert.deepEqual(retained.retention.omittedRanges[0].receiptMessageIds,["assistant-old"]);
  assert.match(retained.retention.sourceTranscriptSha256,/^[a-f0-9]{64}$/);
  assert.match(retained.retention.omittedRanges[0].receiptPointerSha256,/^[a-f0-9]{64}$/);
  assert.equal(retained.messages.at(-1).content,"Keep this request");
  assert.match(retained.messages[0].content,/conversation_read/);
});
