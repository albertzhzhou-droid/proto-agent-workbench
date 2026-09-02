import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AppDatabase } from "../src/main/services/database.ts";
import { installRunHistorySchema } from "../src/main/services/run-history.ts";

const timestamp = "2026-08-30T20:00:00.000Z";
const event = (overrides = {}) => ({
  id: overrides.id ?? "event-1",
  runId: overrides.runId ?? "run-1",
  stage: overrides.stage ?? "plan",
  actor: overrides.actor ?? "assistant",
  title: overrides.title ?? "Plan",
  summary: overrides.summary ?? "Snapshot",
  inputProvenance: [],
  outputArtifacts: [],
  evidenceIds: [],
  status: overrides.status ?? "running",
  createdAt: overrides.createdAt ?? timestamp,
  payload: overrides.payload,
});

test("run event revisions dedupe identical snapshots and chain status or payload changes", () => {
  const database = new AppDatabase(":memory:");
  const first = event();
  database.appendEvent(first);
  database.appendEvent({ ...first });
  assert.equal(database.getRunEventHistory("run-1").length, 1);

  database.appendEvent(event({ status: "completed", summary: "Done", payload: { result: "ok" } }));
  const history = database.getRunEventHistory("run-1");
  assert.deepEqual(history.map((revision) => revision.sequence), [1, 2]);
  assert.deepEqual(history.map((revision) => revision.eventRevision), [1, 2]);
  assert.equal(history[1].previousSha256, history[0].entrySha256);
  assert.notEqual(history[1].snapshotSha256, history[0].snapshotSha256);
  assert.equal(database.getRunEvent("event-1").status, "completed");
  assert.equal(database.getRunEvent("event-1").payload.result, "ok");

  assert.throws(
    () => database.db.prepare("UPDATE run_event_history SET status = 'failed'").run(),
    /append-only/,
  );
  assert.throws(
    () => database.db.prepare("DELETE FROM run_event_history").run(),
    /append-only/,
  );
  database.close();
});

test("equal event timestamps use the durable per-run sequence as their stable tie-break", () => {
  const database = new AppDatabase(":memory:");
  database.appendEvent(event({ id: "z-event", title: "Inserted first" }));
  database.appendEvent(event({ id: "a-event", title: "Inserted second" }));
  assert.deepEqual(database.getRunEvents("run-1").map((item) => item.id), ["z-event", "a-event"]);
  assert.deepEqual(
    database.getRunEventHistory("run-1").map((revision) => [revision.eventId, revision.sequence]),
    [["z-event", 1], ["a-event", 2]],
  );
  database.appendEvent(event({ id: "z-event", title: "Inserted first", status: "completed" }));
  assert.deepEqual(database.getRunEvents("run-1").map((item) => item.id), ["z-event", "a-event"]);
  database.close();
});

test("legacy projections backfill exact raw payload once across repeated opens", async () => {
  const path = resolve("tests", `.tmp-run-history-${process.pid}.sqlite`);
  await rm(path, { force: true });
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const rawPayload = '{  "id":"legacy-event", "runId":"legacy-run", "stage":"goal", "actor":"user", "title":"Legacy", "summary":"Raw payload", "inputProvenance":[], "outputArtifacts":[], "evidenceIds":[], "status":"completed", "createdAt":"2026-08-30T20:00:00.000Z" }';
  legacy.prepare(
    "INSERT INTO run_events(id, run_id, stage, status, payload, created_at) VALUES(?, ?, ?, ?, ?, ?)",
  ).run("legacy-event", "legacy-run", "goal", "completed", rawPayload, timestamp);
  legacy.close();

  const firstOpen = new AppDatabase(path);
  assert.equal(firstOpen.getRunEventHistory("legacy-run")[0].rawPayload, rawPayload);
  assert.equal(firstOpen.getRunEvents("legacy-run")[0].title, "Legacy");
  firstOpen.close();
  const secondOpen = new AppDatabase(path);
  assert.equal(secondOpen.getRunEventHistory("legacy-run").length, 1);
  secondOpen.close();
  await rm(path, { force: true });
});

test("reopen rebuilds a mismatched projection from trusted history without legitimizing it", async () => {
  const path = resolve("tests", `.tmp-run-projection-${process.pid}.sqlite`);
  await rm(path, { force: true });
  const database = new AppDatabase(path);
  database.appendEvent(event({ status: "completed", summary: "Trusted" }));
  const trustedRawPayload = database.getRunEventHistory("run-1")[0].rawPayload;
  database.close();

  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE run_events SET status = 'failed', payload = ? WHERE id = ?")
    .run('{"forged":true}', "event-1");
  raw.close();

  const reopened = new AppDatabase(path);
  assert.equal(reopened.getRunEventHistory("run-1").length, 1);
  assert.equal(reopened.getRunEventHistory("run-1")[0].rawPayload, trustedRawPayload);
  assert.equal(reopened.getRunEvent("event-1").status, "completed");
  assert.equal(reopened.getRunEvent("event-1").summary, "Trusted");
  reopened.close();
  await rm(path, { force: true });
});

test("malformed sequence/hash chains fail closed on install, read, and append", () => {
  const database = new AppDatabase(":memory:");
  database.appendEvent(event());
  database.db.exec("DROP TRIGGER run_event_history_no_update");
  database.db.prepare("UPDATE run_event_history SET previous_sha256 = ? WHERE sequence = 1")
    .run("f".repeat(64));
  assert.throws(() => database.getRunEventHistory("run-1"), /integrity check failed/);
  assert.throws(() => database.appendEvent(event({ id: "event-2" })), /integrity check failed/);
  assert.throws(() => installRunHistorySchema(database.db), /integrity check failed/);
  assert.equal(Number(database.db.prepare("SELECT COUNT(*) AS count FROM run_event_history").get().count), 1);
  database.close();
});

test("recorded audit time and live projection tampering are rejected before reads", () => {
  const historyDatabase = new AppDatabase(":memory:");
  historyDatabase.appendEvent(event({ status: "completed" }));
  historyDatabase.db.exec("DROP TRIGGER run_event_history_no_update");
  historyDatabase.db.prepare("UPDATE run_event_history SET recorded_at = ? WHERE sequence = 1")
    .run("2099-01-01T00:00:00.000Z");
  assert.throws(() => historyDatabase.getRunEventHistory("run-1"), /integrity check failed/);
  historyDatabase.close();

  const projectionDatabase = new AppDatabase(":memory:");
  projectionDatabase.appendEvent(event({ status: "completed" }));
  projectionDatabase.db.prepare("UPDATE run_events SET status = 'failed' WHERE id = 'event-1'").run();
  assert.throws(() => projectionDatabase.getRunEvents("run-1"), /projection integrity check failed/);
  assert.throws(() => projectionDatabase.getRunEvent("event-1"), /projection integrity check failed/);
  assert.throws(() => projectionDatabase.listRuns(), /projection integrity check failed/);
  projectionDatabase.close();
});

test("legacy bogus stage or status fails semantic backfill without history divergence", () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    CREATE TABLE run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO run_events(id, run_id, stage, status, payload, created_at)
    VALUES('event-1', 'run-1', 'bogus-stage', 'bogus-status', '{}', '2026-08-30T20:00:00.000Z');
  `);
  assert.throws(() => installRunHistorySchema(raw), /semantic validation failed/);
  assert.equal(Number(raw.prepare("SELECT COUNT(*) AS count FROM run_event_history").get().count), 0);
  assert.equal(Number(raw.prepare("SELECT COUNT(*) AS count FROM run_events").get().count), 1);
  raw.close();
});

test("snapshot hash binds raw JSON bytes across unsafe-integer collisions and whitespace tampering", () => {
  const first = legacySnapshotHash('{"value":9007199254740992}');
  const second = legacySnapshotHash('{"value":9007199254740993}');
  assert.equal(JSON.parse('{"value":9007199254740992}').value, JSON.parse('{"value":9007199254740993}').value);
  assert.notEqual(first, second);

  const database = new AppDatabase(":memory:");
  database.appendEvent(event({ status: "completed", payload: { value: 1 } }));
  const stored = database.db.prepare("SELECT payload FROM run_event_history WHERE sequence = 1").get().payload;
  database.db.exec("DROP TRIGGER run_event_history_no_update");
  database.db.prepare("UPDATE run_event_history SET payload = ? WHERE sequence = 1")
    .run(`  ${stored}\n`);
  assert.deepEqual(JSON.parse(stored), JSON.parse(`  ${stored}\n`));
  assert.throws(() => database.getRunEventHistory("run-1"), /integrity check failed/);
  database.close();
});

function legacySnapshotHash(rawPayload) {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    CREATE TABLE run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  raw.prepare(
    "INSERT INTO run_events(id, run_id, stage, status, payload, created_at) VALUES(?, ?, ?, ?, ?, ?)",
  ).run("event-1", "run-1", "goal", "completed", rawPayload, timestamp);
  installRunHistorySchema(raw);
  const hash = raw.prepare("SELECT snapshot_sha256 FROM run_event_history WHERE sequence = 1").get().snapshot_sha256;
  raw.close();
  return hash;
}
