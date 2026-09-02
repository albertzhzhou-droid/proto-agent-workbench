import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  AgentThread,
  ChatMessage,
  MissionRecipe,
  RunCheckpoint,
  RunCheckpointMessage,
  RunFork,
  RunForkResult,
} from "../../shared/contracts.ts";
import { listRunEventHistory, readRunHistoryHead } from "./run-history.ts";
import { assertMissionRecipe } from "./resume-contract.ts";

const MAX_CHECKPOINT_MESSAGES = 256;
const MAX_ARTIFACT_REFS = 128;
const MAX_ARTIFACT_REF_LENGTH = 2_048;
const MESSAGE_ROLES = new Set<ChatMessage["role"]>(["user", "assistant", "tool", "system"]);

export interface CreateRunCheckpointInput {
  id?: string;
  runId: string;
  messagePrefixLength?: number;
  artifactRefs?: string[];
  missionRecipe?: MissionRecipe;
  createdAt?: string;
}

export interface ForkRunCheckpointInput {
  checkpointId: string;
  idempotencyKey: string;
  expectedSnapshotDigest: string;
  expectedResumeContractDigest: string;
  /** Canonical, authorized workspace path supplied by the main workspace service. */
  expectedWorkspacePath: string;
  title?: string;
  createdAt?: string;
}

export type ListRunForksInput = { runId: string } | { checkpointIds: string[] };

type ThreadRow = {
  id: string;
  workspace_path: string;
  title: string;
  mode: AgentThread["mode"];
  model_id: string | null;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  role: string;
  content: string;
  payload: string;
  created_at: string;
};

type CheckpointRow = {
  id: string;
  run_id: string;
  source_thread_id: string;
  workspace_path: string;
  workspace_identity: string;
  message_count: number;
  artifact_refs: string;
  history_sequence: number;
  history_head_sha256: string;
  snapshot_digest: string;
  payload: string;
  created_at: string;
};

type ForkRow = {
  id: string;
  checkpoint_id: string;
  idempotency_key: string;
  source_thread_id: string;
  fork_thread_id: string;
  workspace_identity: string;
  snapshot_digest: string;
  resume_contract_digest: string | null;
  request_sha256: string | null;
  payload: string;
  created_at: string;
};

export function installRunCheckpointSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_checkpoints (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      workspace_identity TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      artifact_refs TEXT NOT NULL,
      history_sequence INTEGER NOT NULL,
      history_head_sha256 TEXT NOT NULL,
      snapshot_digest TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_run_checkpoints_run ON run_checkpoints(run_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS run_forks (
      id TEXT PRIMARY KEY,
      checkpoint_id TEXT NOT NULL REFERENCES run_checkpoints(id),
      idempotency_key TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      fork_thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id),
      workspace_identity TEXT NOT NULL,
      snapshot_digest TEXT NOT NULL,
      resume_contract_digest TEXT,
      request_sha256 TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(checkpoint_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_run_forks_checkpoint ON run_forks(checkpoint_id, created_at DESC);
    CREATE TRIGGER IF NOT EXISTS run_checkpoints_no_update
    BEFORE UPDATE ON run_checkpoints
    BEGIN
      SELECT RAISE(ABORT, 'run_checkpoints are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS run_checkpoints_no_delete
    BEFORE DELETE ON run_checkpoints
    BEGIN
      SELECT RAISE(ABORT, 'run_checkpoints are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS run_forks_no_update
    BEFORE UPDATE ON run_forks
    BEGIN
      SELECT RAISE(ABORT, 'run_forks are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS run_forks_no_delete
    BEFORE DELETE ON run_forks
    BEGIN
      SELECT RAISE(ABORT, 'run_forks are immutable');
    END;
  `);
  const forkColumns = db.prepare("PRAGMA table_info(run_forks)").all() as Array<{ name: string }>;
  if (!forkColumns.some((column) => column.name === "request_sha256")) {
    db.exec("ALTER TABLE run_forks ADD COLUMN request_sha256 TEXT");
  }
  if (!forkColumns.some((column) => column.name === "resume_contract_digest")) {
    db.exec("ALTER TABLE run_forks ADD COLUMN resume_contract_digest TEXT");
  }
}

export function createRunCheckpoint(db: DatabaseSync, input: CreateRunCheckpointInput): RunCheckpoint {
  return withImmediateTransaction(db, () => createRunCheckpointUnsafe(db, input));
}

export function getRunCheckpoint(db: DatabaseSync, id: string): RunCheckpoint | undefined {
  const row = db.prepare("SELECT * FROM run_checkpoints WHERE id = ?").get(id) as CheckpointRow | undefined;
  return row ? checkpointRowToCheckpoint(db, row) : undefined;
}

export function listRunCheckpoints(db: DatabaseSync, runId: string): RunCheckpoint[] {
  const rows = db.prepare(
    "SELECT * FROM run_checkpoints WHERE run_id = ? ORDER BY created_at ASC, id ASC",
  ).all(runId) as CheckpointRow[];
  return rows.map((row) => checkpointRowToCheckpoint(db, row));
}

export function listRunForks(db: DatabaseSync, input: ListRunForksInput): RunFork[] {
  if ("runId" in input) {
    const rows = db.prepare(
      "SELECT run_forks.* FROM run_forks " +
        "INNER JOIN run_checkpoints ON run_checkpoints.id = run_forks.checkpoint_id " +
        "WHERE run_checkpoints.run_id = ? ORDER BY run_forks.created_at ASC, run_forks.id ASC",
    ).all(input.runId) as ForkRow[];
    return rows.map((row) => validatedForkRow(db, row));
  }
  const checkpointIds = [...new Set(input.checkpointIds)];
  if (checkpointIds.length === 0) return [];
  if (checkpointIds.length > 256 || checkpointIds.some((id) => !id.trim())) {
    throw new Error("Fork lineage queries require at most 256 non-empty checkpoint IDs.");
  }
  const placeholders = checkpointIds.map(() => "?").join(", ");
  const rows = db.prepare(
    `SELECT * FROM run_forks WHERE checkpoint_id IN (${placeholders}) ORDER BY created_at ASC, id ASC`,
  ).all(...checkpointIds) as ForkRow[];
  return rows.map((row) => validatedForkRow(db, row));
}

export function forkRunCheckpoint(db: DatabaseSync, input: ForkRunCheckpointInput): RunForkResult {
  return withImmediateTransaction(db, () => forkRunCheckpointUnsafe(db, input));
}

function createRunCheckpointUnsafe(db: DatabaseSync, input: CreateRunCheckpointInput): RunCheckpoint {
  const id = input.id?.trim() || randomUUID();
  const context = db.prepare(
    "SELECT thread_id, workspace_path FROM run_state WHERE run_id = ?",
  ).get(input.runId) as { thread_id: string | null; workspace_path: string | null } | undefined;
  if (!context?.thread_id || !context.workspace_path) {
    throw new Error("A run checkpoint requires a run with bound thread and workspace context.");
  }
  const threadRow = db.prepare(
    "SELECT id, workspace_path, title, mode, model_id, created_at, updated_at FROM threads WHERE id = ?",
  ).get(context.thread_id) as ThreadRow | undefined;
  if (!threadRow || workspaceBindingIdentity(threadRow.workspace_path) !== workspaceBindingIdentity(context.workspace_path)) {
    throw new Error("The run's thread no longer belongs to its recorded workspace.");
  }

  const allMessageRows = db.prepare(
    "SELECT id, role, content, payload, created_at FROM messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC",
  ).all(threadRow.id) as MessageRow[];
  const prefixLength = input.messagePrefixLength ?? allMessageRows.length;
  if (!Number.isSafeInteger(prefixLength) || prefixLength < 0 || prefixLength > allMessageRows.length) {
    throw new Error("The checkpoint message prefix length is outside the available task history.");
  }
  if (prefixLength > MAX_CHECKPOINT_MESSAGES) {
    throw new Error(`Run checkpoints are limited to ${MAX_CHECKPOINT_MESSAGES} messages.`);
  }
  const messages = allMessageRows.slice(0, prefixLength).map(messageRowToCheckpointMessage);
  const artifactRefs = normalizeArtifactRefs(input.artifactRefs ?? []);
  const historyHead = readRunHistoryHead(db, input.runId);
  const sourceThread = threadRowToThread(threadRow);
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!validTimestamp(createdAt) || !isThread(sourceThread)) {
    throw new Error("The checkpoint source metadata contains an invalid timestamp.");
  }
  if (input.missionRecipe) {
    assertMissionRecipe(input.missionRecipe);
    const lastUserGoal = [...messages].reverse().find((message) => message.role === "user")?.content
      .normalize("NFKC").replace(/\r\n?/g, "\n").trim();
    if (input.missionRecipe.mode !== sourceThread.mode
      || input.missionRecipe.title !== sourceThread.title.normalize("NFKC").replace(/\r\n?/g, "\n").trim()
      || input.missionRecipe.goal !== lastUserGoal
      || input.missionRecipe.capabilities.workspaceIdentity !== workspaceBindingIdentity(sourceThread.workspacePath)
      || (input.missionRecipe.capabilities.model
        && input.missionRecipe.capabilities.model.id !== sourceThread.modelId)) {
      throw new Error("The Mission Recipe does not match the trusted checkpoint thread and message boundary.");
    }
  }
  const checkpointBase = {
    schema: "proto-workbench.run-checkpoint.v1",
    runId: input.runId,
    sourceThreadId: sourceThread.id,
    workspacePath: sourceThread.workspacePath,
    workspaceIdentity: workspaceBindingIdentity(sourceThread.workspacePath),
    sourceThread,
    messages,
    artifactRefs,
    historyHead,
    missionRecipe: input.missionRecipe,
  };
  const checkpoint: RunCheckpoint = {
    id,
    ...checkpointBase,
    snapshotDigest: sha256Text(stableJson(checkpointBase)),
    createdAt,
  };

  const existing = getRunCheckpoint(db, id);
  if (existing) {
    if (existing.snapshotDigest !== checkpoint.snapshotDigest) {
      throw new Error("The immutable run checkpoint ID already identifies a different snapshot.");
    }
    return existing;
  }
  db.prepare(
    "INSERT INTO run_checkpoints(id, run_id, source_thread_id, workspace_path, workspace_identity, " +
      "message_count, artifact_refs, history_sequence, history_head_sha256, snapshot_digest, payload, created_at) " +
      "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    checkpoint.id,
    checkpoint.runId,
    checkpoint.sourceThreadId,
    checkpoint.workspacePath,
    checkpoint.workspaceIdentity,
    checkpoint.messages.length,
    JSON.stringify(checkpoint.artifactRefs),
    checkpoint.historyHead.sequence,
    checkpoint.historyHead.entrySha256,
    checkpoint.snapshotDigest,
    JSON.stringify(checkpoint),
    checkpoint.createdAt,
  );
  return checkpoint;
}

function forkRunCheckpointUnsafe(db: DatabaseSync, input: ForkRunCheckpointInput): RunForkResult {
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 256) {
    throw new Error("A bounded idempotency key is required to fork a run checkpoint.");
  }
  if (!sha256String(input.expectedResumeContractDigest)) {
    throw new Error("A trusted resume contract digest is required to fork a run checkpoint.");
  }
  const checkpoint = getRunCheckpoint(db, input.checkpointId);
  if (!checkpoint) throw new Error("Run checkpoint was not found.");
  if (input.expectedSnapshotDigest !== checkpoint.snapshotDigest) {
    throw new Error("The checkpoint snapshot digest does not match the expected task snapshot.");
  }
  if (workspaceBindingIdentity(input.expectedWorkspacePath) !== checkpoint.workspaceIdentity) {
    throw new Error("The checkpoint belongs to a different workspace identity.");
  }
  const title = normalizedForkTitle(input.title, checkpoint.sourceThread.title);
  if (input.createdAt !== undefined && !validTimestamp(input.createdAt)) {
    throw new Error("The fork request timestamp is invalid.");
  }
  const requestSha256 = forkRequestSha256({
    checkpointId: checkpoint.id,
    idempotencyKey: input.idempotencyKey,
    expectedSnapshotDigest: input.expectedSnapshotDigest,
    expectedResumeContractDigest: input.expectedResumeContractDigest,
    expectedWorkspaceIdentity: workspaceBindingIdentity(input.expectedWorkspacePath),
    requestedCreatedAt: input.createdAt ?? null,
    title,
  });

  const existing = db.prepare(
    "SELECT * FROM run_forks WHERE checkpoint_id = ? AND idempotency_key = ?",
  ).get(checkpoint.id, input.idempotencyKey) as ForkRow | undefined;
  if (existing) {
    if (existing.request_sha256 !== requestSha256) {
      throw new Error("The idempotency key is already bound to a different fork request.");
    }
    return hydrateForkResult(db, existing);
  }

  const createdAt = input.createdAt ?? new Date().toISOString();
  const thread: AgentThread = {
    id: randomUUID(),
    workspacePath: checkpoint.workspacePath,
    title,
    mode: checkpoint.sourceThread.mode,
    modelId: checkpoint.sourceThread.modelId,
    createdAt,
    updatedAt: createdAt,
  };
  db.prepare(
    "INSERT INTO threads(id, workspace_path, title, mode, model_id, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
  ).run(
    thread.id,
    thread.workspacePath,
    thread.title,
    thread.mode,
    thread.modelId ?? null,
    thread.createdAt,
    thread.updatedAt,
  );

  const insertMessage = db.prepare(
    "INSERT INTO messages(id, thread_id, role, content, payload, created_at) VALUES(?, ?, ?, ?, ?, ?)",
  );
  const messages = checkpoint.messages.map((source): ChatMessage => {
    const message: ChatMessage = {
      id: randomUUID(),
      role: source.role,
      content: source.content,
      createdAt: source.createdAt,
      attachments: source.attachments,
      toolName: source.toolName,
    };
    insertMessage.run(
      message.id,
      thread.id,
      message.role,
      message.content,
      JSON.stringify(message),
      message.createdAt,
    );
    return message;
  });
  const fork: RunFork = {
    id: randomUUID(),
    checkpointId: checkpoint.id,
    idempotencyKey: input.idempotencyKey,
    sourceThreadId: checkpoint.sourceThreadId,
    forkThreadId: thread.id,
    workspaceIdentity: checkpoint.workspaceIdentity,
    snapshotDigest: checkpoint.snapshotDigest,
    resumeContractDigest: input.expectedResumeContractDigest,
    createdAt,
  };
  db.prepare(
    "INSERT INTO run_forks(id, checkpoint_id, idempotency_key, source_thread_id, fork_thread_id, " +
      "workspace_identity, snapshot_digest, resume_contract_digest, request_sha256, payload, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    fork.id,
    fork.checkpointId,
    fork.idempotencyKey,
    fork.sourceThreadId,
    fork.forkThreadId,
    fork.workspaceIdentity,
    fork.snapshotDigest,
    fork.resumeContractDigest ?? null,
    requestSha256,
    JSON.stringify({ ...fork, requestSha256 }),
    fork.createdAt,
  );
  return { fork, thread, messages };
}

function validateCheckpointDigest(checkpoint: RunCheckpoint): void {
  const checkpointBase = {
    schema: "proto-workbench.run-checkpoint.v1",
    runId: checkpoint.runId,
    sourceThreadId: checkpoint.sourceThreadId,
    workspacePath: checkpoint.workspacePath,
    workspaceIdentity: checkpoint.workspaceIdentity,
    sourceThread: checkpoint.sourceThread,
    messages: checkpoint.messages,
    artifactRefs: checkpoint.artifactRefs,
    historyHead: checkpoint.historyHead,
    missionRecipe: checkpoint.missionRecipe,
  };
  if (sha256Text(stableJson(checkpointBase)) !== checkpoint.snapshotDigest) {
    throw new Error("The immutable checkpoint payload does not match its snapshot digest.");
  }
}

function hydrateForkResult(db: DatabaseSync, forkRow: ForkRow): RunForkResult {
  const fork = validatedForkRow(db, forkRow);
  const row = db.prepare(
    "SELECT id, workspace_path, title, mode, model_id, created_at, updated_at FROM threads WHERE id = ?",
  ).get(forkRow.fork_thread_id) as ThreadRow | undefined;
  if (!row) throw new Error("The idempotent fork record references a missing task thread.");
  const messages = db.prepare(
    "SELECT id, role, content, payload, created_at FROM messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC",
  ).all(forkRow.fork_thread_id) as MessageRow[];
  return {
    fork,
    thread: threadRowToThread(row),
    messages: messages.map(messageRowToMessage),
  };
}

function checkpointRowToCheckpoint(db: DatabaseSync, row: CheckpointRow): RunCheckpoint {
  const checkpoint = parseRunCheckpoint(row.payload);
  const artifactRefs = parseStringArray(row.artifact_refs);
  if (checkpoint.id !== row.id
    || checkpoint.runId !== row.run_id
    || checkpoint.sourceThreadId !== row.source_thread_id
    || checkpoint.workspacePath !== row.workspace_path
    || checkpoint.workspaceIdentity !== row.workspace_identity
    || checkpoint.messages.length !== row.message_count
    || stableJson(checkpoint.artifactRefs) !== stableJson(artifactRefs)
    || checkpoint.historyHead.sequence !== row.history_sequence
    || checkpoint.historyHead.entrySha256 !== row.history_head_sha256
    || checkpoint.snapshotDigest !== row.snapshot_digest
    || checkpoint.createdAt !== row.created_at) {
    throw new Error("Stored run checkpoint columns conflict with the immutable payload.");
  }
  validateCheckpointDigest(checkpoint);
  const history = listRunEventHistory(db, checkpoint.runId);
  if (checkpoint.historyHead.sequence === 0) {
    if (checkpoint.historyHead.entrySha256 !== "0".repeat(64)) {
      throw new Error("Stored run checkpoint history binding is invalid.");
    }
  } else {
    const boundRevision = history[checkpoint.historyHead.sequence - 1];
    if (!boundRevision || boundRevision.entrySha256 !== checkpoint.historyHead.entrySha256) {
      throw new Error("Stored run checkpoint history binding is invalid.");
    }
  }
  return checkpoint;
}

function validatedForkRow(db: DatabaseSync, row: ForkRow): RunFork {
  const fork = forkRowToFork(row);
  const checkpoint = getRunCheckpoint(db, row.checkpoint_id);
  if (!checkpoint
    || fork.sourceThreadId !== checkpoint.sourceThreadId
    || fork.workspaceIdentity !== checkpoint.workspaceIdentity
    || fork.snapshotDigest !== checkpoint.snapshotDigest
    || (fork.resumeContractDigest ?? null) !== row.resume_contract_digest) {
    throw new Error("Stored run fork is not bound to its immutable checkpoint.");
  }
  return fork;
}

function forkRowToFork(row: ForkRow): RunFork {
  const { fork, requestSha256 } = parseRunFork(row.payload);
  if (fork.id !== row.id
    || fork.checkpointId !== row.checkpoint_id
    || fork.idempotencyKey !== row.idempotency_key
    || fork.sourceThreadId !== row.source_thread_id
    || fork.forkThreadId !== row.fork_thread_id
    || fork.workspaceIdentity !== row.workspace_identity
    || fork.snapshotDigest !== row.snapshot_digest
    || (fork.resumeContractDigest ?? null) !== row.resume_contract_digest
    || requestSha256 !== row.request_sha256
    || fork.createdAt !== row.created_at) {
    throw new Error("Stored run fork columns conflict with the immutable payload.");
  }
  return fork;
}

function parseRunCheckpoint(payload: string): RunCheckpoint {
  const parsed = parseJsonRecord(payload);
  if (!parsed
    || parsed.schema !== "proto-workbench.run-checkpoint.v1"
    || !nonEmptyString(parsed.id)
    || !nonEmptyString(parsed.runId)
    || !nonEmptyString(parsed.sourceThreadId)
    || !nonEmptyString(parsed.workspacePath)
    || !sha256String(parsed.workspaceIdentity)
    || !sha256String(parsed.snapshotDigest)
    || !validTimestamp(parsed.createdAt)
    || !isThread(parsed.sourceThread)
    || !Array.isArray(parsed.messages)
    || !Array.isArray(parsed.artifactRefs)
    || !isHistoryHead(parsed.historyHead)) {
    throw new Error("Stored run checkpoint payload is malformed.");
  }
  const messages = parsed.messages.map(parseCheckpointMessage);
  const sourceIds = new Set(messages.map((message) => message.sourceMessageId));
  if (messages.length > MAX_CHECKPOINT_MESSAGES || sourceIds.size !== messages.length) {
    throw new Error("Stored run checkpoint messages are malformed or exceed the bound.");
  }
  const artifactRefs = normalizeArtifactRefs(parsed.artifactRefs.map((value) => {
    if (typeof value !== "string") throw new Error("Stored run checkpoint artifact references are malformed.");
    return value;
  }));
  if (parsed.missionRecipe !== undefined) assertMissionRecipe(parsed.missionRecipe);
  if (stableJson(artifactRefs) !== stableJson(parsed.artifactRefs)
    || parsed.sourceThread.id !== parsed.sourceThreadId
    || parsed.sourceThread.workspacePath !== parsed.workspacePath
    || workspaceBindingIdentity(parsed.workspacePath) !== parsed.workspaceIdentity) {
    throw new Error("Stored run checkpoint identity bindings are malformed.");
  }
  return {
    id: parsed.id,
    runId: parsed.runId,
    sourceThreadId: parsed.sourceThreadId,
    workspacePath: parsed.workspacePath,
    workspaceIdentity: parsed.workspaceIdentity,
    sourceThread: parsed.sourceThread,
    messages,
    artifactRefs,
    historyHead: parsed.historyHead,
    missionRecipe: parsed.missionRecipe,
    snapshotDigest: parsed.snapshotDigest,
    createdAt: parsed.createdAt,
  };
}

function parseRunFork(payload: string): { fork: RunFork; requestSha256: string } {
  const parsed = parseJsonRecord(payload);
  if (!parsed
    || !nonEmptyString(parsed.id)
    || !nonEmptyString(parsed.checkpointId)
    || !nonEmptyString(parsed.idempotencyKey)
    || !nonEmptyString(parsed.sourceThreadId)
    || !nonEmptyString(parsed.forkThreadId)
    || !sha256String(parsed.workspaceIdentity)
    || !sha256String(parsed.snapshotDigest)
    || (parsed.resumeContractDigest !== undefined && !sha256String(parsed.resumeContractDigest))
    || !sha256String(parsed.requestSha256)
    || !validTimestamp(parsed.createdAt)) {
    throw new Error("Stored run fork payload is malformed.");
  }
  return {
    fork: {
      id: parsed.id,
      checkpointId: parsed.checkpointId,
      idempotencyKey: parsed.idempotencyKey,
      sourceThreadId: parsed.sourceThreadId,
      forkThreadId: parsed.forkThreadId,
      workspaceIdentity: parsed.workspaceIdentity,
      snapshotDigest: parsed.snapshotDigest,
      resumeContractDigest: typeof parsed.resumeContractDigest === "string" ? parsed.resumeContractDigest : undefined,
      createdAt: parsed.createdAt,
    },
    requestSha256: parsed.requestSha256,
  };
}

function messageRowToCheckpointMessage(row: MessageRow): RunCheckpointMessage {
  const message = messageRowToMessage(row);
  return { ...message, sourceMessageId: row.id };
}

function messageRowToMessage(row: MessageRow): ChatMessage {
  const parsed = parseJsonRecord(row.payload);
  if (!MESSAGE_ROLES.has(row.role as ChatMessage["role"])) {
    throw new Error("Stored task message role is malformed.");
  }
  const role = row.role as ChatMessage["role"];
  const attachments = Array.isArray(parsed?.attachments)
    ? parsed.attachments.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const attachment = item as Record<string, unknown>;
      if (typeof attachment.path !== "string" || typeof attachment.name !== "string"
        || typeof attachment.mediaType !== "string" || typeof attachment.sizeBytes !== "number") return [];
      return [{
        path: attachment.path,
        name: attachment.name,
        mediaType: attachment.mediaType,
        sizeBytes: attachment.sizeBytes,
      }];
    })
    : undefined;
  return {
    id: row.id,
    role,
    content: row.content,
    createdAt: row.created_at,
    attachments,
    toolName: typeof parsed?.toolName === "string" ? parsed.toolName : undefined,
  };
}

function threadRowToThread(row: ThreadRow): AgentThread {
  return {
    id: row.id,
    workspacePath: row.workspace_path,
    title: row.title,
    mode: row.mode,
    modelId: row.model_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeArtifactRefs(values: string[]): string[] {
  if (values.length > MAX_ARTIFACT_REFS) {
    throw new Error(`Run checkpoints are limited to ${MAX_ARTIFACT_REFS} artifact references.`);
  }
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (normalized.some((value) => value.length > MAX_ARTIFACT_REF_LENGTH)) {
    throw new Error("A checkpoint artifact reference exceeds the supported length.");
  }
  return normalized;
}

function normalizedForkTitle(requested: string | undefined, source: string): string {
  const title = requested?.replace(/\s+/g, " ").trim() || `${source} (fork)`;
  if (title.length > 200) throw new Error("The fork title is too long.");
  return title;
}

function forkRequestSha256(request: {
  checkpointId: string;
  idempotencyKey: string;
  expectedSnapshotDigest: string;
  expectedResumeContractDigest: string;
  expectedWorkspaceIdentity: string;
  requestedCreatedAt: string | null;
  title: string;
}): string {
  return sha256Text(stableJson(request));
}

/**
 * Compares a path already canonicalized and authorized by the main workspace service.
 * This lexical normalization is not a realpath or filesystem-containment check.
 */
export function workspaceBindingIdentity(workspacePath: string): string {
  const canonical = resolve(workspacePath).replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase("en-US");
  return sha256Text(canonical);
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("Stored string-array column is malformed.");
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message === "Stored string-array column is malformed.") throw error;
    throw new Error("Stored string-array column is malformed.");
  }
}

function parseCheckpointMessage(value: unknown): RunCheckpointMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored run checkpoint message is malformed.");
  }
  const message = value as Record<string, unknown>;
  if (!nonEmptyString(message.id)
    || !nonEmptyString(message.sourceMessageId)
    || !MESSAGE_ROLES.has(message.role as ChatMessage["role"])
    || typeof message.content !== "string"
    || !validTimestamp(message.createdAt)
    || (message.toolName !== undefined && typeof message.toolName !== "string")
    || (message.attachments !== undefined && !validAttachments(message.attachments))) {
    throw new Error("Stored run checkpoint message is malformed.");
  }
  return message as unknown as RunCheckpointMessage;
}

function isThread(value: unknown): value is AgentThread {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const thread = value as Record<string, unknown>;
  return nonEmptyString(thread.id)
    && nonEmptyString(thread.workspacePath)
    && nonEmptyString(thread.title)
    && (thread.mode === "plan" || thread.mode === "act")
    && (thread.modelId === undefined || typeof thread.modelId === "string")
    && validTimestamp(thread.createdAt)
    && validTimestamp(thread.updatedAt);
}

function isHistoryHead(value: unknown): value is RunCheckpoint["historyHead"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const head = value as Record<string, unknown>;
  return typeof head.sequence === "number"
    && Number.isSafeInteger(head.sequence)
    && head.sequence >= 0
    && sha256String(head.entrySha256);
}

function validAttachments(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const attachment = item as Record<string, unknown>;
    return nonEmptyString(attachment.path)
      && nonEmptyString(attachment.name)
      && nonEmptyString(attachment.mediaType)
      && typeof attachment.sizeBytes === "number"
      && Number.isSafeInteger(attachment.sizeBytes)
      && attachment.sizeBytes >= 0;
  });
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function sha256String(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function withImmediateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  if (db.isTransaction) return withSavepoint(db, operation);
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

let savepointSequence = 0;

function withSavepoint<T>(db: DatabaseSync, operation: () => T): T {
  const name = `run_checkpoint_scope_${++savepointSequence}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = operation();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    db.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}
