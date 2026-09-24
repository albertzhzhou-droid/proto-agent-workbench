import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, unlink, link } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ResearchChatService } from "../src/main/services/research-chat.ts";
import { ResearchClaimsService } from "../src/main/services/research-claims.ts";
import { RESEARCH_TOOLS } from "../src/main/services/research-tools.ts";
import { assertResearchClaims, RESEARCH_CLAIM_LIMITS } from "../src/shared/research-claims.ts";
import { decodeResearchSession } from "../src/shared/research-session-state.ts";
import { pdfFixture, docxFixture, xlsxFixture } from "./helpers/research-document-fixtures.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function fixture(t, runtime = {}) {
  const base = resolve(import.meta.dirname, "../../../build/research-claims-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "case-")), databasePath = join(root, "chat.sqlite");
  const instances = [];
  const open = () => {
    const service = new ResearchChatService({ workspace: root, databasePath, runtime: {
      scan: async () => [], load: async () => ({}), getExecutionBinding: async () => ({ contextLength: 32768, instanceId: "fixture" }),
      countExecutionTokens: async () => ({ tokens: 500, method: "fixture" }),
      chat: async (_id, _payload, chunk) => chunk({ choices: [{ delta: { content: "Response" } }] }), ...runtime,
    }, readFile: async path => { const bytes = await readFile(join(root, path)); return { path, content: bytes.toString("utf8"), sha256: sha(bytes) }; } });
    instances.push(service); return service;
  };
  t.after(async () => { for (const instance of instances) await instance.close(); });
  const service = open();
  const session = (await service.request({ action: "create" })).session;
  const raw = () => { const db = new DatabaseSync(databasePath); try { return db.prepare("SELECT payload FROM research_chats WHERE id=?").get(session.id).payload; } finally { db.close(); } };
  const replace = payload => { const db = new DatabaseSync(databasePath); try { db.prepare("UPDATE research_chats SET payload=? WHERE id=?").run(payload, session.id); } finally { db.close(); } };
  return { root, service, session, open, raw, replace };
}
const get = async (service, id) => (await service.request({ action: "get", sessionId: id })).session;
async function textDocument(service, session, content = "📊 mean = 5; mean = 6.") {
  return (await service.request({ action: "document", sessionId: session.id, name: "study.txt", content })).session;
}
async function source(service, session, documentId = session.documents[0].id, extra = {}) {
  return (await service.request({ action: "claim_source", sessionId: session.id, documentId, ...extra })).claimSource;
}
function quote(read, text, relation = "supports", start = read.unitText.indexOf(text)) {
  return { readId: read.readId, start, end: start + text.length, quote: text, relation };
}
async function save(service, session, evidence, extra = {}) {
  return (await service.request({ action: "claim_save", sessionId: session.id, expectedRevision: session.revision, text: "The reported mean differs across records.", evidence, ...extra })).session;
}
async function review(service, session, claimId = session.claims[0].id, state = "reviewed") {
  return (await service.request({ action: "claim_review", sessionId: session.id, expectedRevision: session.revision, claimId, state })).session;
}
function durableClaims(claims) {
  const copy = structuredClone(claims);
  for (const claim of copy) {
    delete claim.freshness;
    for (const version of [claim, ...claim.history]) {
      delete version.review.needsReconfirmation;
      for (const entry of version.evidence) delete entry.freshness;
    }
  }
  return copy;
}

test("real service saves exact supporting/contradicting passages and explicit review across SQLite close/reopen", async t => {
  const f = await fixture(t); let session = await textDocument(f.service, f.session);
  const read = await source(f.service, session);
  assert.equal(read.documentSha256, sha(session.documents[0].content));
  assert.equal(read.unitSha256, sha(read.unitText)); assert.equal(read.readingScope.fullDocument, false);
  const revision = session.revision;
  session = await save(f.service, session, [quote(read, "mean = 5"), quote(read, "mean = 6", "contradicts")]);
  assert.equal(session.revision, revision + 1); assert.equal(session.claims[0].review.state, "unreviewed");
  assert.deepEqual(session.claims[0].evidence.map(item => item.relation), ["supports", "contradicts"]);
  assert.equal(session.claims[0].evidence[0].source.quoteStart, 3); // emoji is two UTF-16 code units
  assert.equal(session.claims[0].freshness.status, "current");
  session = await review(f.service, session);
  assert.equal(session.claims[0].review.actor, "user"); assert.equal(session.claims[0].history[0].review.state, "unreviewed");
  const stored = f.raw(); await f.service.close(); const reopened = f.open();
  const restored = await get(reopened, session.id);
  assert.deepEqual(durableClaims(restored.claims), durableClaims(session.claims));
  assert.equal(restored.claims[0].freshness.status, "current");
  assert.equal(f.raw(), stored);
  const previous = restored.claims[0];
  const changed = await save(reopened, restored, previous.evidence.map(entry => ({ evidenceId: entry.id, relation: "context" })), { claimId: previous.id });
  assert.equal(changed.claims[0].review.state, "unreviewed");
  assert.equal(changed.claims[0].history.at(-1).review.state, "reviewed");
  assert.deepEqual(changed.claims[0].history.at(-1).evidence.map(entry => entry.relation), ["supports", "contradicts"]);
});

test("fabricated quote, bad offsets, surrogate splits, duplicate passages and cross-session preview cannot write", async t => {
  const f = await fixture(t); const session = await textDocument(f.service, f.session);
  const read = await source(f.service, session); const original = f.raw();
  const other = (await f.service.request({ action: "create" })).session;
  for (const evidence of [
    [quote(read, "invented", "supports", 0)],
    [{ ...quote(read, "mean = 5"), start: -1 }],
    [quote(read, read.unitText.slice(1, 2), "supports", 1)],
    [quote(read, "mean = 5"), quote(read, "mean = 5", "contradicts")],
    [{ ...quote(read, "mean = 5"), fullDocument: true }],
  ]) await assert.rejects(save(f.service, session, evidence));
  await assert.rejects(save(f.service, other, [quote(read, "mean = 5")]), /preview/);
  await assert.rejects(source(f.service, session, other.id), /attached/);
  await assert.rejects(source(f.service, session, session.documents[0].id, { startOffset: 1 }), /surrogate/);
  await assert.rejects(save(f.service, session, [], { review: { state: "reviewed", actor: "assistant" } }));
  assert.equal(f.raw(), original);
});

test("preview windows retain absolute offsets and exact returned scope without claiming all text read", async t => {
  const f = await fixture(t); let session = await textDocument(f.service, f.session, "x".repeat(12500) + "Later evidence 🧪.");
  const read = await source(f.service, session, session.documents[0].id, { startOffset: 12490 });
  session = await save(f.service, session, [quote(read, "Later evidence 🧪")]);
  const evidence = session.claims[0].evidence[0];
  assert.equal(evidence.source.quoteStart, 12500); assert.equal(evidence.source.quoteEnd, 12517);
  assert.deepEqual(evidence.source.readingScope, { unitIndices: [0], start: 12490, end: 12518, offsetUnit: "utf16-code-units", fullDocument: false, meaning: "returned-source-range-only" });
  assert.equal(evidence.source.totalCharacters, 12518);
});

for (const [format, bytes, unitIndex, excerpt] of [
  ["pdf", pdfFixture(), 1, "Mean = 6"],
  ["docx", docxFixture(), 2, "After table"],
  ["xlsx", xlsxFixture(), 0, "Scientific label"],
]) test(`${format} sources use real parser units and separately bind original/extraction/text bytes`, async t => {
  const f = await fixture(t); let session = (await f.service.request({ action: "import", sessionId: f.session.id, name: `study.${format}`, base64: bytes.toString("base64") })).session;
  const read = await source(f.service, session, session.documents[0].id, { unitIndex });
  session = await save(f.service, session, [quote(read, excerpt)]);
  const saved = session.claims[0].evidence[0].source;
  assert.equal(saved.sourceSha256, sha(bytes)); assert.equal(saved.extractionSha256, sha(await readFile(join(f.root, saved.extractionPath))));
  assert.equal(saved.textArtifactSha256, sha(await readFile(join(f.root, saved.textArtifactPath))));
  assert.equal(saved.kind, "parsed"); assert.equal(saved.unitIndex, unitIndex); assert.deepEqual(saved.readingScope.unitIndices, [unitIndex]);
  assert.equal(saved.originalSourcePath, null); assert.equal(session.claims[0].freshness.status, "current");
  await assert.rejects(source(f.service, session, session.documents[0].id, { unitIndex: 50000 }), /absent/);
});

for (const [field, code] of [["sourcePath", "SOURCE_BYTES_CHANGED"], ["extractionPath", "EXTRACTION_CHANGED"], ["textPath", "SOURCE_SNAPSHOT_CHANGED"]]) {
  test(`changing saved ${field} is observed, latched across restored bytes/restart, and cannot reuse review`, async t => {
    const f = await fixture(t); let session = (await f.service.request({ action: "import", sessionId: f.session.id, name: "study.docx", base64: docxFixture().toString("base64") })).session;
    const read = await source(f.service, session); session = await save(f.service, session, [quote(read, "Hello & evidence")]); session = await review(f.service, session);
    const artifact = join(f.root, session.documents[0].extraction[field]); const original = await readFile(artifact);
    const savedSource = structuredClone(session.claims[0].evidence[0].source), reviewDecision = structuredClone(session.claims[0].review);
    await writeFile(artifact, "changed bytes");
    const before = session.revision;
    session = await get(f.service, session.id);
    assert.equal(session.claims[0].evidence[0].freshness.code, code); assert.equal(session.claims[0].freshness.status, "stale");
    assert.equal(session.revision, before + 1); assert.equal(session.claims[0].review.needsReconfirmation, true);
    assert.deepEqual(session.claims[0].evidence[0].source, savedSource);
    assert.equal(session.claims[0].review.decidedAt, reviewDecision.decidedAt);
    const invalidated = session.claims[0].evidence[0].invalidated;
    await writeFile(artifact, original); await f.service.close(); const reopened = f.open();
    session = await get(reopened, session.id);
    assert.equal(session.claims[0].freshness.code, "PREVIOUSLY_INVALIDATED");
    assert.deepEqual(session.claims[0].evidence[0].invalidated, invalidated);
    await assert.rejects(review(reopened, session), /replace stale evidence/);
    const reloaded = await source(reopened, session);
    session = await save(reopened, session, [quote(reloaded, "Hello & evidence")], { claimId: session.claims[0].id });
    assert.equal(session.claims[0].review.state, "unreviewed"); assert.equal(session.claims[0].freshness.status, "current");
    session = await review(reopened, session); assert.equal(session.claims[0].review.needsReconfirmation, false);
    assert.ok(session.claims[0].history.some(version => version.evidence[0].invalidated));
  });
}

test("list claim summaries honestly remain pending; opening detects original changes independently of the saved parsed snapshot", async t => {
  const f = await fixture(t); const path = "original.docx"; const bytes = docxFixture(); await writeFile(join(f.root, path), bytes);
  let session = (await f.service.request({ action: "read", sessionId: f.session.id, path })).session;
  const read = await source(f.service, session); session = await save(f.service, session, [quote(read, "Hello & evidence")]);
  assert.equal(session.claims[0].evidence[0].source.originalSourceSha256, sha(bytes));
  await writeFile(join(f.root, path), docxFixture("Replacement"));
  const listed = await f.service.request({ action: "list" }); assert.equal(listed.sessions[0].claimSummary,undefined);assert.equal(listed.sessions[0].claimReviewSummary.sourceChecks,"pending");
  assert.equal(JSON.parse(f.raw()).claims[0].evidence[0].invalidated,undefined);
  session=await get(f.service,session.id);assert.equal(session.claims[0].freshness.status,"stale");
  const saved = JSON.parse(f.raw()); assert.equal(saved.claims[0].evidence[0].invalidated.code, "ORIGINAL_SOURCE_CHANGED");
  assert.equal(sha(await readFile(join(f.root, session.documents[0].extraction.sourcePath))), sha(bytes));
});

test("deleted sources are unavailable and restored files do not recertify the historical source", async t => {
  const f = await fixture(t); await writeFile(join(f.root, "notes.txt"), "Mean = 5");
  let session = (await f.service.request({ action: "read", sessionId: f.session.id, path: "notes.txt" })).session;
  session = await save(f.service, session, [quote(await source(f.service, session), "Mean = 5")]);
  await unlink(join(f.root, "notes.txt")); session = await get(f.service, session.id);
  assert.equal(session.claims[0].freshness.status, "unavailable");
  await writeFile(join(f.root, "notes.txt"), "Mean = 5"); session = await get(f.service, session.id);
  assert.equal(session.claims[0].freshness.code, "PREVIOUSLY_INVALIDATED");
});

test("editable revision/current content hashes reject an old preview and invalidate saved citations independently of sourceSha256", async t => {
  const f = await fixture(t); await writeFile(join(f.root, "notes.txt"), "Mean = 5");
  let session = (await f.service.request({ action: "read", sessionId: f.session.id, path: "notes.txt" })).session;
  const read = await source(f.service, session); session = await save(f.service, session, [quote(read, "Mean = 5")]);
  session = (await f.service.request({ action: "document", sessionId: session.id, documentId: session.documents[0].id, expectedRevision: 1, name: "notes.txt", content: "Mean = 6" })).session;
  assert.equal(session.documents[0].sourceSha256, sha("Mean = 5")); assert.equal(session.claims[0].freshness.status, "stale");
  await assert.rejects(save(f.service, session, [quote(read, "Mean = 5")]), /changed after preview/);
  const current = await source(f.service, session); assert.equal(current.documentSha256, sha("Mean = 6"));
  session = await save(f.service, session, [quote(current, "Mean = 6")], { claimId: session.claims[0].id });
  assert.equal(session.claims[0].evidence[0].source.originalSourceSha256, sha("Mean = 5")); assert.equal(session.claims[0].freshness.status, "current");
});

test("same-volume hard links and paths escaping the workspace are rejected by the existing document guard", async t => {
  const f = await fixture(t); await writeFile(join(f.root, "notes.txt"), "Mean = 5");
  let session = (await f.service.request({ action: "read", sessionId: f.session.id, path: "notes.txt" })).session;
  await link(join(f.root, "notes.txt"), join(f.root, "alias.txt"));
  await assert.rejects(source(f.service, session), /linked|regular|link/);
  session.documents[0].source = "../outside.txt";
  await assert.rejects(new ResearchClaimsService(f.root).readSource(session, { documentId: session.documents[0].id }), /inside/);
});

test("stored malformed claim records stay isolated without changing their original raw SQLite payload", async t => {
  const f = await fixture(t); let session = await textDocument(f.service, f.session);
  session = await save(f.service, session, [quote(await source(f.service, session), "mean = 5")]); await f.service.close();
  for (const mutate of [
    claim => { claim.review.state = ["reviewed"]; },
    claim => { claim.evidence[0].relation = ["supports"]; },
    claim => { claim.evidence[0].source.readingScope.fullDocument = true; },
    claim => { claim.evidence[0].source.quoteEnd += 1; },
  ]) {
    const stored = JSON.parse(f.raw()); mutate(stored.claims[0]); const raw = JSON.stringify(stored, null, 2); f.replace(raw);
    const reopened = f.open(); const listing = await reopened.request({ action: "list" });
    assert.equal(listing.sessions.length, 0); assert.equal(listing.recoveryIssues[0].code, "INVALID_SESSION"); assert.equal(f.raw(), raw);
    await reopened.close(); f.replace(JSON.stringify(session));
  }
});

test("old serialized projections are ignored in current claims and history; invalid Unicode ranges cannot become reviewed", async t => {
  const f = await fixture(t); let session = await textDocument(f.service, f.session);
  session = await save(f.service, session, [quote(await source(f.service, session), "📊")]); session = await review(f.service, session);
  const forged = { status: "current", checkedAt: "2099-01-01T00:00:00Z", code: "FORGED_HISTORY", message: "forged" };
  session.claims[0].history[0].evidence[0].freshness = forged; session.claims[0].history[0].review.needsReconfirmation = false;
  const helper = new ResearchClaimsService(f.root); const projected = await helper.project(JSON.parse(JSON.stringify(session)));
  assert.equal(projected.claims[0].history[0].evidence[0].freshness, undefined); assert.equal(projected.claims[0].history[0].review.needsReconfirmation, undefined);
  const savedSource = session.claims[0].evidence[0].source; savedSource.quoteStart = 1; savedSource.excerpt = "📊".slice(1, 2);
  assertResearchClaims(session.claims); // Shape is insufficient: the reopened text determines valid Unicode boundaries.
  const invalid = await helper.project(JSON.parse(JSON.stringify(session)));
  assert.equal(invalid.claims[0].freshness.code, "SOURCE_RANGE_INVALID");
  await assert.rejects(helper.reviewClaim(session, { claimId: session.claims[0].id, state: "reviewed" }), /replace stale evidence/);
});

test("later claims beyond the snapshot budget can be reviewed and bounded polls rotate their checks without latching pending", async t => {
  const f = await fixture(t); let session = f.session;
  for (let index = 0; index < 9; index++) {
    session = await textDocument(f.service, session, `Evidence ${index}`);
    const read = await source(f.service, session, session.documents.at(-1).id);
    session = await save(f.service, session, [quote(read, `Evidence ${index}`)], { text: `Claim ${index}` });
  }
  const target = session.claims.at(-1).id;
  session = await review(f.service, session, target);
  assert.equal(session.claims.at(-1).review.state, "reviewed"); assert.equal(session.claims.at(-1).freshness.status, "current");
  const checked = new Set();
  for (let index = 0; index < 9; index++) {
    session = await get(f.service, session.id);
    for (const claim of session.claims) {
      if (claim.freshness.status === "current") checked.add(claim.id);
      else assert.equal(claim.freshness.code, "VERIFICATION_BUDGET");
      assert.equal(claim.evidence[0].invalidated, undefined);
    }
  }
  assert.equal(checked.size, 9);
});

test("stale expected revisions and two-instance CAS never persist a dirty claim; no claim mutation is a model tool", async t => {
  const f = await fixture(t); const first = f.service; let session = await textDocument(first, f.session); const second = f.open();
  const read = await source(first, session); session = await save(first, session, [quote(read, "mean = 5")]);
  const winner = f.raw();
  await assert.rejects(save(first, { ...session, revision: session.revision - 1 }, [], { text: "stale" }), error => error.code === "REVISION_CONFLICT");
  await assert.rejects(save(second, { ...session, revision: session.revision - 1 }, [], { text: "loser" }), error => error.code === "REVISION_CONFLICT");
  assert.equal(f.raw(), winner); assert.deepEqual(durableClaims((await get(second, session.id)).claims), durableClaims((await get(first, session.id)).claims));
  assert.equal(RESEARCH_TOOLS.some(tool => /^claim_/.test(tool.function.name)), false);
});

test("generation keeps get/list responsive with explicit pending sources and rejects idle-only review/save", async t => {
  let begun, release; const started = new Promise(resolve => { begun = resolve; }); const finish = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { chat: async (_id, _payload, chunk, signal) => {
    chunk({ choices: [{ delta: { content: "Live text" } }] }); begun();
    await Promise.race([finish, new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }))]);
  } });
  let session = await textDocument(f.service, f.session); session = await save(f.service, session, [quote(await source(f.service, session), "mean = 5")]);
  await f.service.request({ action: "send", sessionId: session.id, modelId: "fixture", content: "Continue", documentIds: [] }); await started;
  session = await get(f.service, session.id);
  assert.equal(session.status, "generating"); assert.equal(session.messages.at(-1).content, "Live text");
  assert.equal(session.claims[0].freshness.code, "VERIFICATION_BUDGET"); assert.match(session.claims[0].freshness.message, /generating/);
  assert.equal((await f.service.request({ action: "list" })).sessions[0].claimReviewSummary.sourceChecks,"pending");
  await assert.rejects(review(f.service, session), /idle/); await assert.rejects(save(f.service, session, []), /idle/);
  release(); await f.service.request({ action: "cancel", sessionId: session.id });
  session = await get(f.service, session.id); assert.equal(session.claims[0].freshness.status, "current");
});

test("an in-flight source check returns the latest conversation with pending evidence when a send starts", async t => {
  let releaseModel; const finish = new Promise(resolve => { releaseModel = resolve; });
  const f = await fixture(t, { chat: async (_id, _payload, chunk, signal) => { chunk({ choices: [{ delta: { content: "New streaming turn" } }] }); await Promise.race([finish, new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }))]); } });
  let session = await textDocument(f.service, f.session); session = await save(f.service, session, [quote(await source(f.service, session), "mean = 5")]);
  const actualProject = f.service.claims.project.bind(f.service.claims);
  let ready, release; const began = new Promise(resolve => { ready = resolve; }); const gate = new Promise(resolve => { release = resolve; }); let once = true;
  f.service.claims.project = async (...args) => { const result = await actualProject(...args); if (once) { once = false; ready(); await gate; } return result; };
  const pending = get(f.service, session.id); await began;
  await f.service.request({ action: "send", sessionId: session.id, modelId: "fixture", content: "Continue", documentIds: [] });
  release(); const snapshot = await pending;
  assert.equal(snapshot.status, "generating"); assert.equal(snapshot.messages.at(-2).content, "Continue"); assert.equal(snapshot.claims[0].freshness.code, "VERIFICATION_BUDGET");
  assert.equal(JSON.parse(f.raw()).messages.at(-2).content, "Continue");
  releaseModel(); await f.service.request({ action: "cancel", sessionId: session.id });
});

test("preserved claim history rejects edits at its bound instead of deleting old versions", async t => {
  const f = await fixture(t); let session = await save(f.service, f.session, []);
  for (let index = 0; index < RESEARCH_CLAIM_LIMITS.history; index++) session = await save(f.service, session, [], { claimId: session.claims[0].id, text: `Revision ${index}` });
  assert.equal(session.claims[0].history.length, 10); const original = f.raw();
  await assert.rejects(save(f.service, session, [], { claimId: session.claims[0].id }), /history limit/);
  assert.equal(f.raw(), original); assert.equal(decodeResearchSession(f.raw()).ok, true);
});

test("a first observed invalidation merges by evidence identity after another writer wins CAS, preserving its title and review history", async t => {
  const f = await fixture(t); await writeFile(join(f.root, "notes.txt"), "Mean = 5");
  let session = (await f.service.request({ action: "read", sessionId: f.session.id, path: "notes.txt" })).session;
  session = await save(f.service, session, [quote(await source(f.service, session), "Mean = 5")]); session = await review(f.service, session);
  const originalDecision = structuredClone(session.claims[0].review);
  await writeFile(join(f.root, "notes.txt"), "Mean = 6");
  const actualProject = f.service.claims.project.bind(f.service.claims);
  let ready, release; const started = new Promise(resolve => { ready = resolve; }); const gate = new Promise(resolve => { release = resolve; }); let once = true;
  f.service.claims.project = async (...args) => { const result = await actualProject(...args); if (once) { once = false; ready(); await gate; } return result; };
  const pending = get(f.service, session.id); await started;
  const winner = JSON.parse(f.raw()); winner.title = "Other instance winner"; winner.revision++;
  f.replace(JSON.stringify(winner)); await writeFile(join(f.root, "notes.txt"), "Mean = 5"); release();
  const snapshot = await pending; const saved = JSON.parse(f.raw());
  assert.equal(snapshot.title, "Other instance winner"); assert.equal(saved.title, "Other instance winner");
  assert.equal(saved.revision, winner.revision + 1); assert.equal(saved.claims[0].evidence[0].invalidated.code, "ORIGINAL_SOURCE_CHANGED");
  assert.equal(saved.claims[0].review.decidedAt, originalDecision.decidedAt); assert.equal(saved.claims[0].review.state, "reviewed");
  assert.equal((await get(f.service, session.id)).claims[0].freshness.code, "PREVIOUSLY_INVALIDATED");
});

test("source preview tokens cannot survive restart and deliberately malformed UTF-16 cannot be quoted", async t => {
  const f = await fixture(t); let session = await textDocument(f.service, f.session, "valid \uDC00 end");
  const read = await source(f.service, session);
  await assert.rejects(save(f.service, session, [quote(read, "\uDC00")]), /surrogate/);
  const old = await source(f.service, session); await f.service.close(); const reopened = f.open(); session = await get(reopened, session.id);
  const original = f.raw(); await assert.rejects(save(reopened, session, [quote(old, "valid")]), /expired/); assert.equal(f.raw(), original);
});
