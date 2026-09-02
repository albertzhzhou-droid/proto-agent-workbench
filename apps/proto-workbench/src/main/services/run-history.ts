import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AgentRunEvent,
  RunEventHistoryRevision,
  RunHistoryHead,
} from "../../shared/contracts.ts";

const EMPTY_HISTORY_HASH = "0".repeat(64);
const RUN_STAGES = new Set(["goal", "plan", "design", "validate", "review"]);
const RUN_STATUSES = new Set([
  "pending",
  "running",
  "completed",
  "failed",
  "approval-required",
  "approved",
  "rejected",
  "cancelled",
  "interrupted",
  "effect-unknown",
]);

type ProjectionRow = {
  id: string;
  run_id: string;
  stage: string;
  status: string;
  payload: string;
  created_at: string;
  history_sequence: number | null;
};

type HistoryRow = {
  history_id: string;
  run_id: string;
  event_id: string;
  sequence: number;
  event_revision: number;
  stage: string;
  status: string;
  payload: string;
  created_at: string;
  recorded_at: string;
  snapshot_sha256: string;
  previous_sha256: string;
  entry_sha256: string;
};

export interface AppendRunEventResult extends RunHistoryHead {
  appended: boolean;
  snapshotSha256: string;
}

/** Install the additive history schema and import pre-history projections verbatim. */
export function installRunHistorySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_event_history (
      history_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_revision INTEGER NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      snapshot_sha256 TEXT NOT NULL,
      previous_sha256 TEXT NOT NULL,
      entry_sha256 TEXT NOT NULL,
      UNIQUE(run_id, sequence),
      UNIQUE(run_id, event_id, event_revision)
    );
    CREATE INDEX IF NOT EXISTS idx_run_event_history_event
      ON run_event_history(run_id, event_id, event_revision);
  `);
  const columns = db.prepare("PRAGMA table_info(run_events)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "history_sequence")) {
    db.exec("ALTER TABLE run_events ADD COLUMN history_sequence INTEGER");
  }

  const migrate = (): void => {
    const projections = db
      .prepare(
        "SELECT id, run_id, stage, status, payload, created_at, history_sequence " +
          "FROM run_events ORDER BY run_id ASC, created_at ASC, id ASC",
      )
      .all() as ProjectionRow[];
    const projectionsByRun = new Map<string, ProjectionRow[]>();
    for (const projection of projections) {
      const group = projectionsByRun.get(projection.run_id) ?? [];
      group.push(projection);
      projectionsByRun.set(projection.run_id, group);
    }
    const historyRunRows = db.prepare(
      "SELECT DISTINCT run_id FROM run_event_history ORDER BY run_id ASC",
    ).all() as Array<{ run_id: string }>;
    const runIds = new Set([...projectionsByRun.keys(), ...historyRunRows.map((row) => row.run_id)]);
    for (const runId of [...runIds].sort()) {
      const history = validateRunHistory(db, runId);
      const runProjections = projectionsByRun.get(runId) ?? [];
      if (history.length === 0) {
        for (const projection of runProjections) backfillLegacyProjection(db, projection);
        const migrated = validateRunHistory(db, runId);
        assertProjectionMatchesHistory(db, runId, migrated);
      } else {
        rebuildProjectionFromTrustedHistory(db, runId, runProjections, history);
      }
    }
  };
  if (db.isTransaction) migrate();
  else immediateTransaction(db, migrate);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS run_event_history_no_update
    BEFORE UPDATE ON run_event_history
    BEGIN
      SELECT RAISE(ABORT, 'run_event_history is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS run_event_history_no_delete
    BEFORE DELETE ON run_event_history
    BEGIN
      SELECT RAISE(ABORT, 'run_event_history is append-only');
    END;
  `);
}

/** Caller must already own the surrounding write transaction. */
export function appendRunEventUnsafe(db: DatabaseSync, event: AgentRunEvent): AppendRunEventResult {
  if (!db.isTransaction) throw new Error("appendRunEventUnsafe requires an active database transaction.");
  const history = validateRunHistory(db, event.runId);
  assertProjectionMatchesHistory(db, event.runId, history);
  const rawPayload = JSON.stringify(event);
  const current = db
    .prepare(
      "SELECT id, run_id, stage, status, payload, created_at, history_sequence FROM run_events WHERE id = ?",
    )
    .get(event.id) as ProjectionRow | undefined;
  const eventHistory = history.filter((revision) => revision.event_id === event.id);
  const trustedLatest = eventHistory.at(-1);
  const trustedFirstSequence = eventHistory[0]?.sequence;
  if (current && (!trustedLatest
    || current.run_id !== trustedLatest.run_id
    || current.stage !== trustedLatest.stage
    || current.status !== trustedLatest.status
    || current.payload !== trustedLatest.payload
    || current.created_at !== trustedLatest.created_at
    || current.history_sequence !== trustedFirstSequence)) {
    throw new Error("The current run event projection does not match its validated history.");
  }
  if (!current && trustedLatest) {
    throw new Error("The current run event projection is missing from its validated history.");
  }
  if (current && (current.run_id !== event.runId || current.stage !== event.stage || current.created_at !== event.createdAt)) {
    throw new Error("Run event identity fields are immutable once recorded.");
  }

  const snapshotSha256 = eventSnapshotSha256({
    eventId: event.id,
    runId: event.runId,
    stage: event.stage,
    status: event.status,
    rawPayload,
    createdAt: event.createdAt,
  });
  const latest = db
    .prepare(
      "SELECT sequence, snapshot_sha256, entry_sha256 FROM run_event_history " +
        "WHERE run_id = ? AND event_id = ? ORDER BY event_revision DESC LIMIT 1",
    )
    .get(event.runId, event.id) as
      | { sequence: number; snapshot_sha256: string; entry_sha256: string }
      | undefined;
  if (latest?.snapshot_sha256 === snapshotSha256) {
    return {
      appended: false,
      sequence: latest.sequence,
      snapshotSha256,
      entrySha256: latest.entry_sha256,
    };
  }

  const revision = appendRawHistoryUnsafe(db, {
    eventId: event.id,
    runId: event.runId,
    stage: event.stage,
    status: event.status,
    rawPayload,
    createdAt: event.createdAt,
    snapshotSha256,
    recordedAt: new Date().toISOString(),
  });
  db.prepare(
    "INSERT INTO run_events(id, run_id, stage, status, payload, created_at, history_sequence) " +
      "VALUES(?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload",
  ).run(
    event.id,
    event.runId,
    event.stage,
    event.status,
    rawPayload,
    event.createdAt,
    revision.sequence,
  );
  return {
    appended: true,
    sequence: revision.sequence,
    snapshotSha256,
    entrySha256: revision.entrySha256,
  };
}

export function listRunEventHistory(db: DatabaseSync, runId: string): RunEventHistoryRevision[] {
  return validateRunHistory(db, runId).map(historyRowToRevision);
}

export function readRunHistoryHead(db: DatabaseSync, runId: string): RunHistoryHead {
  const rows = validateRunHistory(db, runId);
  const row = rows.at(-1);
  return row ? { sequence: row.sequence, entrySha256: row.entry_sha256 } : {
    sequence: 0,
    entrySha256: EMPTY_HISTORY_HASH,
  };
}

export function validateRunEventProjection(db: DatabaseSync, runId: string): void {
  const history = validateRunHistory(db, runId);
  assertProjectionMatchesHistory(db, runId, history);
}

function backfillLegacyProjection(db: DatabaseSync, projection: ProjectionRow): void {
  const snapshotSha256 = eventSnapshotSha256({
    eventId: projection.id,
    runId: projection.run_id,
    stage: projection.stage,
    status: projection.status,
    rawPayload: projection.payload,
    createdAt: projection.created_at,
  });
  const revision = appendRawHistoryUnsafe(db, {
    eventId: projection.id,
    runId: projection.run_id,
    stage: projection.stage,
    status: projection.status,
    rawPayload: projection.payload,
    createdAt: projection.created_at,
    snapshotSha256,
    recordedAt: projection.created_at,
  });
  db.prepare("UPDATE run_events SET history_sequence = ? WHERE id = ?").run(revision.sequence, projection.id);
}

function rebuildProjectionFromTrustedHistory(
  db: DatabaseSync,
  runId: string,
  projections: ProjectionRow[],
  history: HistoryRow[],
): void {
  const latestByEvent = new Map<string, HistoryRow>();
  const firstSequenceByEvent = new Map<string, number>();
  for (const revision of history) {
    latestByEvent.set(revision.event_id, revision);
    if (!firstSequenceByEvent.has(revision.event_id)) firstSequenceByEvent.set(revision.event_id, revision.sequence);
  }
  const projectionIds = new Set(projections.map((projection) => projection.id));
  for (const projection of projections) {
    const trusted = latestByEvent.get(projection.id);
    if (!trusted) {
      throw new Error(`Run history integrity check failed for ${runId}: projection event has no history.`);
    }
    const firstSequence = firstSequenceByEvent.get(trusted.event_id);
    if (firstSequence === undefined) {
      throw new Error(`Run history integrity check failed for ${runId}: event has no first sequence.`);
    }
    if (projection.run_id !== trusted.run_id
      || projection.stage !== trusted.stage
      || projection.status !== trusted.status
      || projection.payload !== trusted.payload
      || projection.created_at !== trusted.created_at
      || projection.history_sequence !== firstSequence) {
      db.prepare(
        "UPDATE run_events SET run_id = ?, stage = ?, status = ?, payload = ?, created_at = ?, history_sequence = ? " +
          "WHERE id = ?",
      ).run(
        trusted.run_id,
        trusted.stage,
        trusted.status,
        trusted.payload,
        trusted.created_at,
        firstSequence,
        trusted.event_id,
      );
    }
  }
  for (const trusted of latestByEvent.values()) {
    if (projectionIds.has(trusted.event_id)) continue;
    const firstSequence = firstSequenceByEvent.get(trusted.event_id);
    if (firstSequence === undefined) {
      throw new Error(`Run history integrity check failed for ${runId}: event has no first sequence.`);
    }
    db.prepare(
      "INSERT INTO run_events(id, run_id, stage, status, payload, created_at, history_sequence) " +
        "VALUES(?, ?, ?, ?, ?, ?, ?)",
    ).run(
      trusted.event_id,
      trusted.run_id,
      trusted.stage,
      trusted.status,
      trusted.payload,
      trusted.created_at,
      firstSequence,
    );
  }
}

function validateRunHistory(db: DatabaseSync, runId: string): HistoryRow[] {
  const rows = db.prepare(
    "SELECT history_id, run_id, event_id, sequence, event_revision, stage, status, payload, " +
      "created_at, recorded_at, snapshot_sha256, previous_sha256, entry_sha256 " +
      "FROM run_event_history WHERE run_id = ? ORDER BY sequence ASC",
  ).all(runId) as HistoryRow[];
  let previousSha256 = EMPTY_HISTORY_HASH;
  const revisionsByEvent = new Map<string, number>();
  for (const [index, row] of rows.entries()) {
    const expectedSequence = index + 1;
    const expectedEventRevision = (revisionsByEvent.get(row.event_id) ?? 0) + 1;
    validateHistorySnapshotSemantics({
      eventId: row.event_id,
      runId: row.run_id,
      stage: row.stage,
      status: row.status,
      createdAt: row.created_at,
      recordedAt: row.recorded_at,
    });
    const expectedSnapshotSha256 = eventSnapshotSha256({
      eventId: row.event_id,
      runId: row.run_id,
      stage: row.stage,
      status: row.status,
      rawPayload: row.payload,
      createdAt: row.created_at,
    });
    const expectedEntrySha256 = sha256Text(stableJson({
      eventRevision: expectedEventRevision,
      eventId: row.event_id,
      previousSha256,
      recordedAt: row.recorded_at,
      runId: row.run_id,
      sequence: expectedSequence,
      snapshotSha256: expectedSnapshotSha256,
    }));
    const expectedHistoryId = `${row.run_id}:${expectedSequence}:${expectedEntrySha256}`;
    if (row.run_id !== runId
      || row.sequence !== expectedSequence
      || row.event_revision !== expectedEventRevision
      || row.previous_sha256 !== previousSha256
      || row.snapshot_sha256 !== expectedSnapshotSha256
      || row.entry_sha256 !== expectedEntrySha256
      || row.history_id !== expectedHistoryId) {
      throw new Error(`Run history integrity check failed for ${runId} at sequence ${expectedSequence}.`);
    }
    revisionsByEvent.set(row.event_id, expectedEventRevision);
    previousSha256 = expectedEntrySha256;
  }
  return rows;
}

function assertProjectionMatchesHistory(db: DatabaseSync, runId: string, history: HistoryRow[]): void {
  const projections = db.prepare(
    "SELECT id, run_id, stage, status, payload, created_at, history_sequence " +
      "FROM run_events WHERE run_id = ? ORDER BY history_sequence ASC, id ASC",
  ).all(runId) as ProjectionRow[];
  const latestByEvent = new Map<string, HistoryRow>();
  const firstSequenceByEvent = new Map<string, number>();
  for (const revision of history) {
    latestByEvent.set(revision.event_id, revision);
    if (!firstSequenceByEvent.has(revision.event_id)) firstSequenceByEvent.set(revision.event_id, revision.sequence);
  }
  if (projections.length !== latestByEvent.size) {
    throw new Error(`Run event projection integrity check failed for ${runId}.`);
  }
  for (const projection of projections) {
    const trusted = latestByEvent.get(projection.id);
    if (!trusted
      || projection.run_id !== trusted.run_id
      || projection.stage !== trusted.stage
      || projection.status !== trusted.status
      || projection.payload !== trusted.payload
      || projection.created_at !== trusted.created_at
      || projection.history_sequence !== firstSequenceByEvent.get(projection.id)) {
      throw new Error(`Run event projection integrity check failed for ${runId}.`);
    }
  }
}

function appendRawHistoryUnsafe(
  db: DatabaseSync,
  snapshot: {
    eventId: string;
    runId: string;
    stage: string;
    status: string;
    rawPayload: string;
    createdAt: string;
    recordedAt: string;
    snapshotSha256: string;
  },
): { sequence: number; entrySha256: string } {
  validateHistorySnapshotSemantics(snapshot);
  const head = readRunHistoryHead(db, snapshot.runId);
  const eventRevisionRow = db.prepare(
    "SELECT COALESCE(MAX(event_revision), 0) AS revision FROM run_event_history WHERE run_id = ? AND event_id = ?",
  ).get(snapshot.runId, snapshot.eventId) as { revision: number };
  const sequence = head.sequence + 1;
  const eventRevision = eventRevisionRow.revision + 1;
  const entrySha256 = sha256Text(stableJson({
    eventRevision,
    eventId: snapshot.eventId,
    previousSha256: head.entrySha256,
    recordedAt: snapshot.recordedAt,
    runId: snapshot.runId,
    sequence,
    snapshotSha256: snapshot.snapshotSha256,
  }));
  const historyId = `${snapshot.runId}:${sequence}:${entrySha256}`;
  db.prepare(
    "INSERT INTO run_event_history(history_id, run_id, event_id, sequence, event_revision, stage, status, " +
      "payload, created_at, recorded_at, snapshot_sha256, previous_sha256, entry_sha256) " +
      "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    historyId,
    snapshot.runId,
    snapshot.eventId,
    sequence,
    eventRevision,
    snapshot.stage,
    snapshot.status,
    snapshot.rawPayload,
    snapshot.createdAt,
    snapshot.recordedAt,
    snapshot.snapshotSha256,
    head.entrySha256,
    entrySha256,
  );
  return { sequence, entrySha256 };
}

function validateHistorySnapshotSemantics(snapshot: {
  eventId: string;
  runId: string;
  stage: string;
  status: string;
  createdAt: string;
  recordedAt: string;
}): void {
  if (!snapshot.eventId.trim()
    || !snapshot.runId.trim()
    || !RUN_STAGES.has(snapshot.stage)
    || !RUN_STATUSES.has(snapshot.status)
    || !validTimestamp(snapshot.createdAt)
    || !validTimestamp(snapshot.recordedAt)) {
    throw new Error(`Run history semantic validation failed for ${snapshot.runId || "<empty-run>"}.`);
  }
}

function validTimestamp(value: string): boolean {
  return value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function eventSnapshotSha256(snapshot: {
  eventId: string;
  runId: string;
  stage: string;
  status: string;
  rawPayload: string;
  createdAt: string;
}): string {
  const parsed = parseJson(snapshot.rawPayload);
  return sha256Text(stableJson({
    createdAt: snapshot.createdAt,
    eventId: snapshot.eventId,
    payload: parsed === undefined ? snapshot.rawPayload : parsed,
    rawPayloadSha256: sha256Text(snapshot.rawPayload),
    runId: snapshot.runId,
    stage: snapshot.stage,
    status: snapshot.status,
  }));
}

function historyRowToRevision(row: HistoryRow): RunEventHistoryRevision {
  return {
    historyId: row.history_id,
    runId: row.run_id,
    eventId: row.event_id,
    sequence: row.sequence,
    eventRevision: row.event_revision,
    stage: row.stage as AgentRunEvent["stage"],
    status: row.status as AgentRunEvent["status"],
    rawPayload: row.payload,
    createdAt: row.created_at,
    recordedAt: row.recorded_at,
    snapshotSha256: row.snapshot_sha256,
    previousSha256: row.previous_sha256,
    entrySha256: row.entry_sha256,
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function immediateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
