import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentRunEvent,
  AgentThread,
  ChatMessage,
  FileCheckpoint,
  ModelDescriptor,
  PatchOperation,
  PatchOperationState,
  PatchProposal,
  ReviewComment,
  ReviewPacketView,
  RunCheckpoint,
  RunDetail,
  RunEventHistoryRevision,
  RunFork,
  RunForkResult,
  RunHistoryHead,
  RunSummary,
  StartupRecoveryReport,
  ToolApproval,
  ValidationJournalSnapshot,
  ValidationJournalStep,
  ValidationStepKey,
  ValidationStepPlan,
} from "../../shared/contracts.ts";
import type { ModuleIntegrityReport } from "../../shared/modules.ts";
import {
  emptyReview,
  lifecycleEventStatus,
  projectRunLifecycle,
  runAllowedActions,
  runDetailRevision,
} from "../../shared/run-lifecycle.ts";
import {
  validationJournalNextStep,
  validationJournalState,
  validationPlanSha256,
} from "./validation-journal.ts";
import { bindReviewToValidation, reviewBindingMatches } from "./review-binding.ts";
import {
  validationStepEvidenceSha256,
  validationToolOutputBindingMatches,
} from "./validation-evidence.ts";
import {
  appendRunEventUnsafe,
  installRunHistorySchema,
  listRunEventHistory,
  readRunHistoryHead,
  validateRunEventProjection,
} from "./run-history.ts";
import {
  createRunCheckpoint as createTaskCheckpoint,
  forkRunCheckpoint as forkTaskCheckpoint,
  getRunCheckpoint as readTaskCheckpoint,
  installRunCheckpointSchema,
  listRunCheckpoints as listTaskCheckpoints,
  listRunForks as listTaskForks,
  workspaceBindingIdentity,
  type CreateRunCheckpointInput,
  type ForkRunCheckpointInput,
  type ListRunForksInput,
} from "./run-checkpoints.ts";

type DbRunEventRow = {
  id: string;
  run_id: string;
  stage: string;
  status: string;
  payload: string;
  created_at: string;
};

type DbApprovalRow = {
  id: string;
  run_id: string;
  status: string;
  payload: string;
  created_at: string;
  expires_at: string | null;
  revision: number;
  decided_at: string | null;
  decision_key: string | null;
};

type DbPatchRow = {
  id: string;
  run_id: string;
  status: string;
  payload: string;
  created_at: string;
  target_path: string | null;
  revision: number;
};

type DbPatchOperationRow = {
  id: string;
  patch_id: string;
  run_id: string;
  target_path: string;
  state: string;
  active: number;
  revision: number;
  payload: string;
  created_at: string;
  updated_at: string;
};

type DbCheckpointRow = {
  id: string;
  operation_id: string;
  patch_id: string;
  run_id: string;
  status: string;
  revision: number;
  payload: string;
  created_at: string;
  updated_at: string;
};

type DbValidationJournalRow = {
  operation_id: string;
  patch_id: string;
  run_id: string;
  state: string;
  revision: number;
  payload: string;
  created_at: string;
  updated_at: string;
};

type ValidationJournalRecord = Omit<ValidationJournalSnapshot, "snapshotAt" | "nextStepKey" | "resumable">;

type CheckpointRecord = FileCheckpoint & { content: string };

const AGENT_STAGES = new Set<AgentRunEvent["stage"]>(["goal", "plan", "design", "validate", "review"]);
const AGENT_ACTORS = new Set<AgentRunEvent["actor"]>(["user", "assistant", "tool", "system"]);
const EVENT_STATUSES = new Set<AgentRunEvent["status"]>([
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
const APPROVAL_STATUSES = new Set<ToolApproval["status"]>(["pending", "approved", "rejected", "expired", "cancelled", "stale"]);
const APPROVAL_RISKS = new Set<ToolApproval["risk"]>(["write", "network", "code-execution"]);
const PATCH_STATUSES = new Set<PatchProposal["status"]>(["pending", "approved", "rejected", "stale", "rolled-back"]);
const PATCH_OPERATION_STATES = new Set<PatchOperationState>([
  "prepared",
  "applying",
  "applied",
  "validating",
  "verified",
  "validation-failed",
  "effect-unknown",
  "conflict",
  "rolled-back",
]);
const CHECKPOINT_STATES = new Set<FileCheckpoint["restoreState"]>(["available", "restore-proposed", "restored", "conflict"]);
const VALIDATION_STEP_KEYS = new Set<ValidationStepKey>([
  "design-approval",
  "artifact-boundary",
  "proto-check",
  "proto-workflow",
  "review-packet",
]);
const VALIDATION_STEP_STATES = new Set<ValidationJournalStep["state"]>([
  "pending",
  "running",
  "completed",
  "failed",
  "interrupted",
  "effect-unknown",
]);
const VALIDATION_STEP_EFFECTS = new Set<ValidationJournalStep["effect"]>(["none", "workspace-read", "artifact-write"]);
const MESSAGE_ROLES = new Set<ChatMessage["role"]>(["user", "assistant", "tool", "system"]);
const REVIEW_GATES = new Set<ReviewPacketView["gate"]>(["ready", "blocked", "review-required", "approved"]);
const CLAIM_STATUSES = new Set<ReviewPacketView["claims"][number]["status"]>([
  "supported",
  "failed",
  "needs-review",
  "not-applicable",
]);
const CHECKLIST_STATUSES = new Set<ReviewPacketView["checklist"][number]["status"]>(["done", "pending", "blocked"]);

export class AppDatabase {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO settings(key, value) VALUES(?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, JSON.stringify(value));
  }

  appendModuleAudit(report: ModuleIntegrityReport): ModuleIntegrityReport {
    const audited = { ...report, auditId: report.auditId ?? randomUUID() };
    this.db
      .prepare(
        "INSERT INTO module_audits(id, checked_at, ok, manifest_sha256, payload) VALUES(?, ?, ?, ?, ?)",
      )
      .run(
        audited.auditId,
        audited.checkedAt,
        audited.ok ? 1 : 0,
        audited.manifestSha256 ?? null,
        JSON.stringify(audited),
      );
    return audited;
  }

  listModuleAudits(limit = 20): ModuleIntegrityReport[] {
    const rows = this.db
      .prepare("SELECT payload FROM module_audits ORDER BY checked_at DESC LIMIT ?")
      .all(Math.max(1, Math.min(200, Math.floor(limit)))) as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as ModuleIntegrityReport);
  }

  saveModels(models: ModelDescriptor[]): void {
    const statement = this.db.prepare(
      "INSERT INTO models(id, descriptor, scanned_at) VALUES(?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET descriptor = excluded.descriptor, scanned_at = excluded.scanned_at",
    );
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      for (const model of models) statement.run(model.id, JSON.stringify(model), now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listModels(): ModelDescriptor[] {
    const rows = this.db.prepare("SELECT descriptor FROM models ORDER BY scanned_at DESC").all() as Array<{
      descriptor: string;
    }>;
    return rows.map((row) => JSON.parse(row.descriptor) as ModelDescriptor);
  }

  createThread(thread: AgentThread): void {
    this.db
      .prepare(
        "INSERT INTO threads(id, workspace_path, title, mode, model_id, created_at, updated_at) " +
          "VALUES(?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        thread.id,
        thread.workspacePath,
        thread.title,
        thread.mode,
        thread.modelId ?? null,
        thread.createdAt,
        thread.updatedAt,
      );
  }

  listThreads(): AgentThread[] {
    const rows = this.db.prepare("SELECT * FROM threads ORDER BY updated_at DESC").all();
    return (rows as unknown as DbThread[]).map(rowToThread);
  }

  getThread(id: string): AgentThread | undefined {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as DbThread | undefined;
    return row ? rowToThread(row) : undefined;
  }

  touchThread(id: string, modelId?: string): void {
    this.db
      .prepare("UPDATE threads SET updated_at = ?, model_id = COALESCE(?, model_id) WHERE id = ?")
      .run(new Date().toISOString(), modelId ?? null, id);
  }

  updateThread(id: string, patch: Partial<Pick<AgentThread, "title" | "mode" | "modelId">>): AgentThread {
    const current = this.getThread(id);
    if (!current) throw new Error("Thread was not found.");
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.db
      .prepare("UPDATE threads SET title = ?, mode = ?, model_id = ?, updated_at = ? WHERE id = ?")
      .run(next.title, next.mode, next.modelId ?? null, next.updatedAt, id);
    return next;
  }

  addMessage(threadId: string, message: ChatMessage): void {
    this.db
      .prepare(
        "INSERT INTO messages(id, thread_id, role, content, payload, created_at) VALUES(?, ?, ?, ?, ?, ?)",
      )
      .run(message.id, threadId, message.role, message.content, JSON.stringify(message), message.createdAt);
    this.touchThread(threadId);
  }

  commitMessageWithRunCheckpoint(
    runId: string,
    threadId: string,
    message: ChatMessage,
    artifactRefs: string[] = [],
  ): RunCheckpoint {
    return this.immediateTransaction(() => {
      const context = this.getRunContext(runId);
      if (context?.threadId !== threadId) {
        throw new Error("The message thread does not match the run checkpoint context.");
      }
      this.addMessage(threadId, message);
      return createTaskCheckpoint(this.db, {
        runId,
        artifactRefs,
        createdAt: message.createdAt,
      });
    });
  }

  getMessages(threadId: string): ChatMessage[] {
    const rows = this.db
      .prepare("SELECT payload FROM messages WHERE thread_id = ? ORDER BY created_at ASC")
      .all(threadId) as Array<{ payload: string }>;
    return rows
      .map((row) => normalizeMessagePayload(row.payload))
      .filter((message): message is ChatMessage => Boolean(message));
  }

  appendEvent(event: AgentRunEvent): void {
    const append = (): void => {
      const result = appendRunEventUnsafe(this.db, event);
      if (result.appended) this.touchRunRevision(event.runId);
    };
    if (this.db.isTransaction) append();
    else this.immediateTransaction(append);
  }

  recordRunStart(event: AgentRunEvent, threadId: string, workspacePath: string): void {
    this.immediateTransaction(() => {
      const thread = this.db.prepare("SELECT workspace_path FROM threads WHERE id = ?").get(threadId) as
        | { workspace_path: string }
        | undefined;
      if (!thread || workspaceBindingIdentity(thread.workspace_path) !== workspaceBindingIdentity(workspacePath)) {
        throw new Error("The run start does not match the trusted thread workspace binding.");
      }
      const existing = this.db.prepare(
        "SELECT thread_id, workspace_path FROM run_state WHERE run_id = ?",
      ).get(event.runId) as { thread_id: string | null; workspace_path: string | null } | undefined;
      if (existing?.thread_id && existing.thread_id !== threadId) {
        throw new Error("The run is already bound to a different task thread.");
      }
      if (existing?.workspace_path
        && workspaceBindingIdentity(existing.workspace_path) !== workspaceBindingIdentity(workspacePath)) {
        throw new Error("The run is already bound to a different workspace identity.");
      }
      this.db
        .prepare(
          "INSERT INTO run_state(run_id, archived, thread_id, workspace_path, created_at, updated_at, revision) " +
            "VALUES(?, 0, ?, ?, ?, ?, 1) " +
            "ON CONFLICT(run_id) DO UPDATE SET " +
            "thread_id = COALESCE(run_state.thread_id, excluded.thread_id), " +
            "workspace_path = COALESCE(run_state.workspace_path, excluded.workspace_path), " +
            "created_at = COALESCE(run_state.created_at, excluded.created_at), " +
            "updated_at = excluded.updated_at, revision = run_state.revision + 1",
        )
        .run(event.runId, threadId, workspacePath, event.createdAt, event.createdAt);
      this.appendEvent(event);
    });
  }

  getRunContext(runId: string): { threadId?: string; workspacePath?: string } | undefined {
    const row = this.db
      .prepare("SELECT thread_id, workspace_path FROM run_state WHERE run_id = ?")
      .get(runId) as { thread_id: string | null; workspace_path: string | null } | undefined;
    if (!row) return undefined;
    return {
      threadId: row.thread_id ?? undefined,
      workspacePath: row.workspace_path ?? undefined,
    };
  }

  getRunEvents(runId: string): AgentRunEvent[] {
    validateRunEventProjection(this.db, runId);
    const rows = this.db
      .prepare(
        "SELECT id, run_id, stage, status, payload, created_at FROM run_events WHERE run_id = ? " +
          "ORDER BY created_at ASC, history_sequence ASC, id ASC",
      )
      .all(runId) as DbRunEventRow[];
    return rows.map(normalizeRunEventRow);
  }

  getRunEventHistory(runId: string): RunEventHistoryRevision[] {
    return listRunEventHistory(this.db, runId);
  }

  getRunHistoryHead(runId: string): RunHistoryHead {
    return readRunHistoryHead(this.db, runId);
  }

  createRunCheckpoint(input: CreateRunCheckpointInput): RunCheckpoint {
    return createTaskCheckpoint(this.db, input);
  }

  getRunCheckpoint(id: string): RunCheckpoint | undefined {
    return readTaskCheckpoint(this.db, id);
  }

  listRunCheckpoints(runId: string): RunCheckpoint[] {
    return listTaskCheckpoints(this.db, runId);
  }

  listRunForks(input: ListRunForksInput): RunFork[] {
    return listTaskForks(this.db, input);
  }

  forkRunCheckpoint(input: ForkRunCheckpointInput): RunForkResult {
    return forkTaskCheckpoint(this.db, input);
  }

  getRunEvent(eventId: string): AgentRunEvent | undefined {
    const row = this.db
      .prepare("SELECT id, run_id, stage, status, payload, created_at FROM run_events WHERE id = ?")
      .get(eventId) as DbRunEventRow | undefined;
    if (row) validateRunEventProjection(this.db, row.run_id);
    return row ? normalizeRunEventRow(row) : undefined;
  }

  getRunDetail(runId: string): RunDetail {
    this.expirePendingApprovals();
    return this.readTransaction(() => {
      const snapshotAt = new Date().toISOString();
      const events = this.getRunEvents(runId);
      if (events.length === 0) throw new Error("Run was not found.");
      const eventHistory = this.getRunEventHistory(runId);
      const historyHead = this.getRunHistoryHead(runId);
      const taskCheckpoints = this.listRunCheckpoints(runId);
      const runForks = this.listRunForks({ runId });
      const patches = this.listPatches(runId);
      const approvals = this.listApprovalsUnsafe(runId);
      const patchOperations = this.listPatchOperations(runId);
      const validationJournals = this.listValidationJournals(runId);
      const checkpoints = this.listFileCheckpoints(runId);
      const review = this.getReview(runId) ?? emptyReview(runId);
      const comments = this.listReviewComments(runId);
      const runState = this.db
        .prepare("SELECT archived, thread_id, workspace_path, created_at, revision FROM run_state WHERE run_id = ?")
        .get(runId) as
        | { archived: number; thread_id: string | null; workspace_path: string | null; created_at: string | null; revision: number }
        | undefined;
      const archived = Boolean(runState?.archived);
      const lifecycle = projectRunLifecycle({ events, patches, approvals, patchOperations, validationJournals, checkpoints, review });
      const goal = events.find((event) => event.stage === "goal");
      const legacyThreadId = typeof goal?.payload?.threadId === "string" ? goal.payload.threadId : undefined;
      const legacyWorkspacePath = typeof goal?.payload?.workspacePath === "string" ? goal.payload.workspacePath : undefined;
      const threadId = runState?.thread_id ?? legacyThreadId;
      const workspacePath = runState?.workspace_path ?? legacyWorkspacePath;
      const storedThread = threadId ? this.getThread(threadId) : undefined;
      const thread = storedThread && (!workspacePath || storedThread.workspacePath === workspacePath)
        ? storedThread
        : undefined;
      const summary: RunSummary = {
        runId,
        title: runTitle(goal?.summary) ?? goal?.title ?? runId,
        createdAt: runState?.created_at ?? events[0]?.createdAt ?? new Date(0).toISOString(),
        status: lifecycleEventStatus(lifecycle),
        archived,
        lifecycle,
      };
      const activePatch = patches.find((patch) => patch.status === "pending");
      const uncertainArtifactOperation = patchOperations.find((operation) =>
        !["verified", "rolled-back"].includes(operation.state)
        && validationJournals.some((journal) => journal.operationId === operation.id && journal.steps.some(
          (step) => step.effect === "artifact-write" && step.state === "effect-unknown",
        )));
      const activePatchOperation = (activePatch
        ? patchOperations.find((operation) => operation.patchId === activePatch.id)
        : undefined)
        ?? uncertainArtifactOperation
        ?? patchOperations.find((operation) => !["verified", "rolled-back"].includes(operation.state))
        ?? patchOperations[0];
      return {
        revision: `${runState?.revision ?? 0}|${runDetailRevision({ events, patches, approvals, patchOperations, validationJournals, checkpoints, review, comments })}`
          + `|history:${historyHead.sequence}:${historyHead.entrySha256}`
          + `|task-checkpoints:${taskCheckpoints.length}:${taskCheckpoints.at(-1)?.snapshotDigest ?? "none"}`
          + `|run-forks:${runForks.length}:${runForks.at(-1)?.id ?? "none"}`,
        snapshotAt,
        summary,
        events,
        eventHistory,
        historyHead,
        taskCheckpoints,
        runForks,
        patches,
        activePatch,
        patchOperations,
        activePatchOperation,
        validationJournals,
        checkpoints,
        approvals,
        review,
        comments,
        threadId,
        workspacePath,
        thread,
        messages: thread ? this.getMessages(thread.id) : [],
        contextWarning: threadId && !thread
          ? "The run's original conversation is unavailable or no longer belongs to this workspace."
          : !runState?.thread_id && legacyThreadId
            ? "This legacy run recovered its conversation link from the original goal event."
            : undefined,
        allowedActions: runAllowedActions({ events, patches, approvals, patchOperations, validationJournals, checkpoints, review }),
      };
    });
  }

  listRuns(includeArchived = false): RunSummary[] {
    this.expirePendingApprovals();
    const rows = this.db
      .prepare(
        "SELECT id, run_id, stage, status, payload, created_at FROM run_events " +
          "ORDER BY created_at ASC, run_id ASC, history_sequence ASC, id ASC",
      )
      .all() as DbRunEventRow[];
    for (const runId of new Set(rows.map((row) => row.run_id))) validateRunEventProjection(this.db, runId);
    const archivedRows = this.db.prepare("SELECT run_id FROM run_state WHERE archived = 1").all() as Array<{ run_id: string }>;
    const archivedIds = new Set(archivedRows.map((row) => row.run_id));
    const grouped = new Map<string, { createdAt: string; events: AgentRunEvent[] }>();
    for (const row of rows) {
      const group = grouped.get(row.run_id) ?? { createdAt: row.created_at, events: [] };
      group.events.push(normalizeRunEventRow(row));
      grouped.set(row.run_id, group);
    }
    return [...grouped.entries()].map(([runId, group]) => {
      const goal = group.events.find((event) => event.stage === "goal");
      const patches = this.listPatches(runId);
      const approvals = this.listApprovalsUnsafe(runId);
      const patchOperations = this.listPatchOperations(runId);
      const validationJournals = this.listValidationJournals(runId);
      const checkpoints = this.listFileCheckpoints(runId);
      const review = this.getReview(runId);
      const lifecycle = projectRunLifecycle({ events: group.events, patches, approvals, patchOperations, validationJournals, checkpoints, review });
      return {
        runId,
        title: runTitle(goal?.summary) ?? goal?.title ?? runId,
        createdAt: group.createdAt,
        status: lifecycleEventStatus(lifecycle),
        archived: archivedIds.has(runId),
        lifecycle,
      };
    }).sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .filter((run) => includeArchived || !run.archived);
  }

  setRunArchived(runId: string, archived: boolean): void {
    this.db
      .prepare(
        "INSERT INTO run_state(run_id, archived) VALUES(?, ?) " +
          "ON CONFLICT(run_id) DO UPDATE SET archived = excluded.archived",
      )
      .run(runId, archived ? 1 : 0);
    this.touchRunRevision(runId);
  }

  savePatch(patch: PatchProposal): PatchProposal {
    const current = this.db.prepare("SELECT revision FROM patches WHERE id = ?").get(patch.id) as { revision: number } | undefined;
    if (!current && patch.status === "pending") {
      const competing = this.db
        .prepare("SELECT id FROM patches WHERE target_path = ? COLLATE NOCASE AND status = 'pending' AND id <> ? LIMIT 1")
        .get(patch.targetPath, patch.id) as { id: string } | undefined;
      if (competing) throw new Error("Another reviewed patch is already pending for this target.");
    }
    const saved = { ...patch, revision: current ? current.revision + 1 : Math.max(0, patch.revision ?? 0) };
    this.db
      .prepare(
        "INSERT INTO patches(id, run_id, target_path, status, revision, payload, created_at) VALUES(?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET target_path = excluded.target_path, status = excluded.status, revision = excluded.revision, payload = excluded.payload",
      )
      .run(saved.id, saved.runId, saved.targetPath, saved.status, saved.revision, JSON.stringify(saved), saved.createdAt);
    Object.assign(patch, saved);
    this.touchRunRevision(patch.runId);
    return saved;
  }

  getPatch(id: string): PatchProposal | undefined {
    const row = this.db
      .prepare("SELECT id, run_id, target_path, status, revision, payload, created_at FROM patches WHERE id = ?")
      .get(id) as DbPatchRow | undefined;
    return row ? normalizePatchRow(row) : undefined;
  }

  listPatches(runId: string): PatchProposal[] {
    const rows = this.db
      .prepare("SELECT id, run_id, target_path, status, revision, payload, created_at FROM patches WHERE run_id = ? ORDER BY created_at DESC, id DESC")
      .all(runId) as DbPatchRow[];
    return rows.map(normalizePatchRow);
  }

  getPatchOperation(id: string): PatchOperation | undefined {
    const row = this.db
      .prepare("SELECT id, patch_id, run_id, target_path, state, active, revision, payload, created_at, updated_at FROM patch_operations WHERE id = ?")
      .get(id) as DbPatchOperationRow | undefined;
    return row ? normalizePatchOperationRow(row) : undefined;
  }

  getPatchOperationForPatch(patchId: string): PatchOperation | undefined {
    const row = this.db
      .prepare("SELECT id, patch_id, run_id, target_path, state, active, revision, payload, created_at, updated_at FROM patch_operations WHERE patch_id = ?")
      .get(patchId) as DbPatchOperationRow | undefined;
    return row ? normalizePatchOperationRow(row) : undefined;
  }

  listPatchOperations(runId: string): PatchOperation[] {
    const rows = this.db
      .prepare(
        "SELECT id, patch_id, run_id, target_path, state, active, revision, payload, created_at, updated_at " +
          "FROM patch_operations WHERE run_id = ? ORDER BY updated_at DESC, id DESC",
      )
      .all(runId) as DbPatchOperationRow[];
    return rows.map(normalizePatchOperationRow);
  }

  listRecoverablePatchOperations(): PatchOperation[] {
    const rows = this.db
      .prepare(
        "SELECT id, patch_id, run_id, target_path, state, active, revision, payload, created_at, updated_at " +
          "FROM patch_operations WHERE state IN ('prepared', 'applying', 'applied', 'validating', 'validation-failed', 'effect-unknown', 'conflict') " +
          "ORDER BY updated_at ASC",
      )
      .all() as DbPatchOperationRow[];
    return rows.map(normalizePatchOperationRow);
  }

  getValidationJournal(operationId: string): ValidationJournalSnapshot | undefined {
    const row = this.db
      .prepare(
        "SELECT operation_id, patch_id, run_id, state, revision, payload, created_at, updated_at " +
          "FROM validation_journals WHERE operation_id = ?",
      )
      .get(operationId) as DbValidationJournalRow | undefined;
    return row ? validationJournalView(normalizeValidationJournalRow(row)) : undefined;
  }

  listValidationJournals(runId: string): ValidationJournalSnapshot[] {
    const rows = this.db
      .prepare(
        "SELECT operation_id, patch_id, run_id, state, revision, payload, created_at, updated_at " +
          "FROM validation_journals WHERE run_id = ? ORDER BY updated_at DESC, operation_id DESC",
      )
      .all(runId) as DbValidationJournalRow[];
    return rows.map((row) => validationJournalView(normalizeValidationJournalRow(row)));
  }

  prepareValidationJournal(operationId: string, plan: ValidationStepPlan[]): ValidationJournalSnapshot {
    return this.immediateTransaction(() => {
      const operation = this.getPatchOperation(operationId);
      if (!operation) throw new Error("Patch operation was not found.");
      const normalizedPlan = normalizeValidationPlan(plan);
      const planSha256 = validationPlanSha256(normalizedPlan);
      const existing = this.getValidationJournal(operationId);
      if (existing) {
        if (existing.patchId !== operation.patchId
          || existing.runId !== operation.runId
          || existing.planSha256 !== planSha256) {
          throw new Error("The validation journal plan no longer matches the reviewed patch operation.");
        }
        return existing;
      }
      const now = new Date().toISOString();
      const record: ValidationJournalRecord = {
        schema: "proto-workbench.validation-journal.v1",
        operationId: operation.id,
        patchId: operation.patchId,
        runId: operation.runId,
        planSha256,
        state: "pending",
        revision: 0,
        steps: normalizedPlan.map((step) => ({
          ...step,
          state: "pending",
          attempt: 0,
          eventIds: [],
          outputArtifacts: [],
          evidenceIds: [],
          updatedAt: now,
        })),
        createdAt: now,
        updatedAt: now,
      };
      this.writeValidationJournalUnsafe(record, false);
      this.touchRunRevision(record.runId);
      return validationJournalView(record);
    });
  }

  beginValidationJournalStep(
    operationId: string,
    expectedRevision: number,
    stepKey: ValidationStepKey,
    event: AgentRunEvent,
  ): ValidationJournalSnapshot {
    return this.immediateTransaction(() => {
      const record = this.getValidationJournalRecordUnsafe(operationId);
      if (!record) throw new Error("Validation journal was not found.");
      if (record.revision !== expectedRevision) {
        throw new Error("The validation journal changed. Refresh before replaying a step.");
      }
      const operation = this.getPatchOperation(operationId);
      if (!operation || operation.state !== "validating") {
        throw new Error("The patch operation is not in a validating state.");
      }
      const steps = [...record.steps].sort((left, right) => left.sequence - right.sequence);
      const index = steps.findIndex((step) => step.key === stepKey);
      if (index < 0) throw new Error(`Validation step ${stepKey} is not in the durable plan.`);
      const uncertainArtifact = steps.find(
        (step) => step.effect === "artifact-write" && step.state === "effect-unknown",
      );
      if (uncertainArtifact) {
        throw new Error(
          `Validation step ${uncertainArtifact.key} has an unknown artifact effect. Reconcile its artifacts explicitly or prepare a checkpoint restore before continuing.`,
        );
      }
      const executedArtifactTail = steps.slice(index + 1).find(isExecutedValidationArtifactStep);
      if (executedArtifactTail) {
        throw new Error(
          `Validation step ${executedArtifactTail.key} already attempted an artifact write after the requested replay point. Reconcile the durable journal before continuing.`,
        );
      }
      if (steps.slice(0, index).some((step) => step.state !== "completed")) {
        throw new Error("A validation step cannot start before its durable prerequisites complete.");
      }
      const current = steps[index]!;
      if (current.state === "completed" || current.state === "running") {
        throw new Error(`Validation step ${stepKey} is already ${current.state}.`);
      }
      if (current.state === "effect-unknown") {
        throw new Error(
          `Validation step ${stepKey} has an unknown effect. Reconcile its artifacts explicitly or prepare a checkpoint restore before continuing.`,
        );
      }
      const now = new Date().toISOString();
      const attempt = current.attempt + 1;
      const nextRevision = record.revision + 1;
      const nextSteps = steps.map((step, stepIndex): ValidationJournalStep => {
        if (stepIndex === index) {
          return {
            ...step,
            state: "running",
            attempt,
            eventId: event.id,
            eventIds: [...step.eventIds, event.id],
            outputSha256: undefined,
            outputArtifacts: [],
            evidenceIds: [],
            startedAt: now,
            completedAt: undefined,
            updatedAt: now,
            error: undefined,
            invalidatedBy: undefined,
          };
        }
        if (stepIndex > index && step.state !== "pending") {
          if (isExecutedValidationArtifactStep(step)) {
            return {
              ...step,
              state: "effect-unknown",
              completedAt: now,
              updatedAt: now,
              error: "A prerequisite replay would invalidate an artifact-writing result whose effect may already exist.",
              invalidatedBy: stepKey,
            };
          }
          return {
            ...step,
            state: "pending",
            eventId: undefined,
            outputSha256: undefined,
            outputArtifacts: [],
            evidenceIds: [],
            completedAt: undefined,
            updatedAt: now,
            error: undefined,
            invalidatedBy: stepKey,
          };
        }
        return step;
      });
      event.payload = {
        ...(event.payload ?? {}),
        validationJournal: {
          schema: record.schema,
          operationId,
          stepKey,
          attempt,
          journalRevision: nextRevision,
          operationRevision: operation.revision,
        },
      };
      const next: ValidationJournalRecord = {
        ...record,
        state: "running",
        revision: nextRevision,
        steps: nextSteps,
        updatedAt: now,
        reconciliation: undefined,
      };
      this.writeValidationJournalUnsafe(next, true);
      this.appendEvent(event);
      return validationJournalView(next);
    });
  }

  finishValidationJournalStep(
    operationId: string,
    expectedRevision: number,
    stepKey: ValidationStepKey,
    event: AgentRunEvent,
    review?: ReviewPacketView,
  ): ValidationJournalSnapshot {
    return this.immediateTransaction(() => {
      const record = this.getValidationJournalRecordUnsafe(operationId);
      if (!record) throw new Error("Validation journal was not found.");
      if (record.revision !== expectedRevision) {
        throw new Error("The validation journal changed before the step result was recorded.");
      }
      const index = record.steps.findIndex((step) => step.key === stepKey);
      if (index < 0) throw new Error(`Validation step ${stepKey} is not in the durable plan.`);
      const current = record.steps[index]!;
      if (current.state !== "running" || current.eventId !== event.id) {
        throw new Error("The validation result is not bound to the active journal attempt.");
      }
      const startedEvent = this.getRunEvent(event.id);
      if (!startedEvent || !validationEventBindingMatches(startedEvent, record, current)) {
        throw new Error("The validation result lost its durable journal-attempt binding.");
      }
      const startedBinding = startedEvent.payload?.validationJournal;
      const operationRevision = isJsonRecord(startedBinding)
        && typeof startedBinding.operationRevision === "number"
        && Number.isSafeInteger(startedBinding.operationRevision)
        && startedBinding.operationRevision >= 0
        ? startedBinding.operationRevision
        : undefined;
      const operation = this.getPatchOperation(operationId);
      if (operationRevision === undefined
        || !operation
        || operation.state !== "validating"
        || operation.revision !== operationRevision) {
        if (current.effect === "artifact-write") {
          const now = event.completedAt ?? new Date().toISOString();
          const originalSummary = event.summary.trim();
          event.status = "effect-unknown";
          event.completedAt = now;
          event.summary = "The artifact-writing step returned after its patch operation changed; its result was not accepted and its filesystem effect must be reconciled explicitly."
            + (originalSummary ? ` Tool result: ${originalSummary}` : "");
          const nextJournalRevision = record.revision + 1;
          const outputSha256 = validationStepEvidenceSha256(event);
          event.payload = {
            ...(event.payload ?? {}),
            validationJournal: {
              schema: record.schema,
              operationId,
              stepKey,
              attempt: current.attempt,
              journalRevision: nextJournalRevision,
              operationRevision,
              outputSha256,
              effectUnknownReason: "patch-operation-cas-changed",
            },
          };
          const nextSteps = record.steps.map((step, stepIndex): ValidationJournalStep => stepIndex === index
            ? {
              ...step,
              state: "effect-unknown",
              outputSha256,
              outputArtifacts: [...event.outputArtifacts],
              evidenceIds: [...event.evidenceIds],
              completedAt: now,
              updatedAt: now,
              error: event.summary,
            }
            : step);
          const next: ValidationJournalRecord = {
            ...record,
            state: validationJournalState(nextSteps),
            revision: nextJournalRevision,
            steps: nextSteps,
            updatedAt: now,
          };
          this.writeValidationJournalUnsafe(next, true);
          this.appendEvent(event);
          return validationJournalView(next);
        }
        throw new Error("The patch operation changed before the validation result was recorded.");
      }
      if (current.effect === "artifact-write"
        && event.status !== "completed"
        && event.status !== "approved") {
        event.status = "effect-unknown";
      }
      const now = event.completedAt ?? new Date().toISOString();
      const state: ValidationJournalStep["state"] = event.status === "completed" || event.status === "approved"
        ? "completed"
        : current.effect === "artifact-write" || event.status === "effect-unknown"
          ? "effect-unknown"
          : event.status === "interrupted" || event.status === "cancelled"
            ? "interrupted"
            : "failed";
      const nextJournalRevision = record.revision + 1;
      const boundReview = review && stepKey === "review-packet" && state === "completed"
        ? bindReviewToValidation(review, operationId, record.planSha256, nextJournalRevision)
        : undefined;
      const outputSha256 = validationStepEvidenceSha256(event);
      event.payload = {
        ...(event.payload ?? {}),
        validationJournal: {
          schema: record.schema,
          operationId,
          stepKey,
          attempt: current.attempt,
          journalRevision: nextJournalRevision,
          operationRevision,
          outputSha256,
          reviewPacketSha256: boundReview?.packetSha256,
        },
      };
      const nextSteps = record.steps.map((step, stepIndex): ValidationJournalStep => stepIndex === index
        ? {
          ...step,
          state,
          outputSha256,
          outputArtifacts: [...event.outputArtifacts],
          evidenceIds: [...event.evidenceIds],
          completedAt: now,
          updatedAt: now,
          error: state === "completed" ? undefined : event.summary || "Validation step did not complete successfully.",
        }
        : step);
      const next: ValidationJournalRecord = {
        ...record,
        state: validationJournalState(nextSteps),
        revision: nextJournalRevision,
        steps: nextSteps,
        updatedAt: now,
      };
      this.writeValidationJournalUnsafe(next, true);
      this.appendEvent(event);
      if (review) this.saveReview(boundReview ?? review);
      if (boundReview) this.saveValidationReviewSnapshotUnsafe(operationId, boundReview);
      return validationJournalView(next);
    });
  }

  reconcileValidationJournals(reason: string): {
    reconciled: number;
    stepsNeedingReplay: number;
    runIds: string[];
  } {
    return this.immediateTransaction(() => this.reconcileValidationJournalsUnsafe(reason));
  }

  getFileCheckpoint(id: string): FileCheckpoint | undefined {
    const row = this.db
      .prepare("SELECT id, operation_id, patch_id, run_id, status, revision, payload, created_at, updated_at FROM file_checkpoints WHERE id = ?")
      .get(id) as DbCheckpointRow | undefined;
    return row ? checkpointView(normalizeCheckpointRow(row)) : undefined;
  }

  getCheckpointSnapshot(id: string): { checkpoint: FileCheckpoint; content: string } | undefined {
    const row = this.db
      .prepare("SELECT id, operation_id, patch_id, run_id, status, revision, payload, created_at, updated_at FROM file_checkpoints WHERE id = ?")
      .get(id) as DbCheckpointRow | undefined;
    if (!row) return undefined;
    const record = normalizeCheckpointRow(row);
    return { checkpoint: checkpointView(record), content: record.content };
  }

  listFileCheckpoints(runId: string): FileCheckpoint[] {
    const rows = this.db
      .prepare(
        "SELECT id, operation_id, patch_id, run_id, status, revision, payload, created_at, updated_at " +
          "FROM file_checkpoints WHERE run_id = ? ORDER BY updated_at DESC, id DESC",
      )
      .all(runId) as DbCheckpointRow[];
    return rows.map((row) => checkpointView(normalizeCheckpointRow(row)));
  }

  preparePatchOperation(
    patchId: string,
    expectedPatchRevision: number,
    snapshot: {
      targetPath: string;
      existed: boolean;
      content: string;
      sha256: string;
      resultSha256: string;
      resultExists: boolean;
    },
  ): { operation: PatchOperation; checkpoint: FileCheckpoint } {
    return this.immediateTransaction(() => {
      const patch = this.getPatch(patchId);
      if (!patch) throw new Error("Patch proposal was not found.");
      if (patch.status !== "pending") throw new Error(`Patch is already ${patch.status}.`);
      if (patch.revision !== expectedPatchRevision) throw new Error("The patch changed after it was reviewed. Refresh before deciding.");
      if (patch.targetPath !== snapshot.targetPath
        || patch.baseExists !== snapshot.existed
        || patch.baseSha256 !== snapshot.sha256
        || sha256Text(patch.after) !== snapshot.resultSha256
        || patch.afterExists !== snapshot.resultExists) {
        throw new Error("The patch snapshot no longer matches the reviewed proposal.");
      }
      const existing = this.getPatchOperationForPatch(patchId);
      if (existing) {
        const checkpoint = this.getFileCheckpoint(existing.checkpointId);
        if (!checkpoint) throw new Error("The patch operation checkpoint is unavailable.");
        return { operation: existing, checkpoint };
      }
      const now = new Date().toISOString();
      const operationId = randomUUID();
      const checkpointId = randomUUID();
      const operation: PatchOperation = {
        id: operationId,
        idempotencyKey: `patch:${patch.id}:${snapshot.resultSha256}`,
        patchId: patch.id,
        runId: patch.runId,
        targetPath: patch.targetPath,
        state: "prepared",
        baseSha256: patch.baseSha256,
        baseExists: patch.baseExists,
        resultSha256: snapshot.resultSha256,
        resultExists: snapshot.resultExists,
        checkpointId,
        revision: 0,
        createdAt: now,
        updatedAt: now,
      };
      const checkpoint: FileCheckpoint = {
        id: checkpointId,
        operationId,
        patchId: patch.id,
        runId: patch.runId,
        targetPath: patch.targetPath,
        existed: snapshot.existed,
        sha256: snapshot.sha256,
        resultSha256: snapshot.resultSha256,
        sizeBytes: Buffer.byteLength(snapshot.content, "utf8"),
        restoreState: "available",
        revision: 0,
        createdAt: now,
        updatedAt: now,
      };
      try {
        this.db
          .prepare(
            "INSERT INTO patch_operations(id, patch_id, run_id, target_path, state, active, revision, payload, created_at, updated_at) " +
              "VALUES(?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
          )
          .run(operation.id, operation.patchId, operation.runId, operation.targetPath, operation.state, operation.revision, JSON.stringify(operation), now, now);
      } catch (error) {
        throw new Error(`Another patch operation already owns this target: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.db
        .prepare(
          "INSERT INTO file_checkpoints(id, operation_id, patch_id, run_id, status, revision, payload, created_at, updated_at) " +
            "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          checkpoint.id,
          checkpoint.operationId,
          checkpoint.patchId,
          checkpoint.runId,
          checkpoint.restoreState,
          checkpoint.revision,
          JSON.stringify({ ...checkpoint, content: snapshot.content } satisfies CheckpointRecord),
          now,
          now,
        );
      this.touchRunRevision(patch.runId);
      return { operation, checkpoint };
    });
  }

  markPatchOperationApplying(operationId: string, expectedRevision: number): PatchOperation {
    return this.transitionPatchOperation(operationId, expectedRevision, ["prepared"], "applying");
  }

  markPatchOperationApplied(operationId: string, expectedRevision: number, observedSha256: string): { operation: PatchOperation; patch: PatchProposal } {
    return this.immediateTransaction(() => {
      const operation = this.updatePatchOperationUnsafe(operationId, expectedRevision, ["applying"], "applied", {
        observedSha256,
        appliedAt: new Date().toISOString(),
        error: undefined,
      }, true);
      const patch = this.getPatch(operation.patchId);
      if (!patch) throw new Error("Patch proposal was not found.");
      if (patch.status !== "pending") throw new Error(`Patch decision was already recorded as ${patch.status}.`);
      const nextPatch = this.updatePatchStatusUnsafe(patch, "pending", "approved");
      if (nextPatch.restoresCheckpointId) this.markCheckpointRestoredUnsafe(nextPatch.restoresCheckpointId, nextPatch.id);
      this.touchRunRevision(operation.runId);
      return { operation, patch: nextPatch };
    });
  }

  beginPatchValidation(operationId: string, expectedRevision: number): PatchOperation {
    return this.transitionPatchOperation(operationId, expectedRevision, ["applied", "validation-failed"], "validating", {
      validationStartedAt: new Date().toISOString(),
      error: undefined,
    });
  }

  finishPatchValidation(operationId: string, expectedRevision: number, ok: boolean, error?: string): PatchOperation {
    return this.transitionPatchOperation(
      operationId,
      expectedRevision,
      ["validating"],
      ok ? "verified" : "validation-failed",
      {
        completedAt: ok ? new Date().toISOString() : undefined,
        error: ok ? undefined : error || "Deterministic validation did not complete successfully.",
      },
      !ok,
    );
  }

  markPatchOperationEffectUnknown(operationId: string, expectedRevision: number, error: string): PatchOperation {
    return this.transitionPatchOperation(operationId, expectedRevision, ["applying"], "effect-unknown", { error }, true);
  }

  reconcilePatchOperation(
    operationId: string,
    expectedRevision: number,
    observation: { exists: boolean; sha256: string },
  ): PatchOperation {
    return this.immediateTransaction(() => {
      const operation = this.getPatchOperation(operationId);
      if (!operation) throw new Error("Patch operation was not found.");
      if (operation.revision !== expectedRevision) throw new Error("The patch operation changed. Refresh before reconciling it again.");
      const now = new Date().toISOString();
      const matchesResult = observation.exists === operation.resultExists && observation.sha256 === operation.resultSha256;
      const matchesBase = observation.exists === operation.baseExists && observation.sha256 === operation.baseSha256;
      if (operation.state === "rolled-back") return operation;
      if (matchesResult) {
        if (["applied", "validation-failed", "verified"].includes(operation.state)) {
          if (this.finalizeReconciledPatchEffectUnsafe(operation)) this.touchRunRevision(operation.runId);
          return operation;
        }
        const nextState: PatchOperationState = operation.state === "validating" ? "validation-failed" : "applied";
        const next = this.updatePatchOperationUnsafe(operation.id, operation.revision, [operation.state], nextState, {
          observedSha256: observation.sha256,
          recoveredAt: now,
          error: nextState === "validation-failed" ? "The app restarted during validation. The applied file was confirmed and validation can resume." : undefined,
        }, true);
        this.finalizeReconciledPatchEffectUnsafe(next);
        this.touchRunRevision(operation.runId);
        return next;
      }
      if (matchesBase && operation.state !== "validating") {
        if (operation.state === "prepared") return operation;
        const next = this.updatePatchOperationUnsafe(operation.id, operation.revision, [operation.state], "prepared", {
          observedSha256: observation.sha256,
          recoveredAt: now,
          error: "No file effect was observed. The same reviewed operation can be retried.",
        }, true);
        const patch = this.getPatch(operation.patchId);
        if (patch?.status === "stale") this.updatePatchStatusUnsafe(patch, "stale", "pending");
        this.touchRunRevision(operation.runId);
        return next;
      }
      if (operation.state === "conflict" && operation.observedSha256 === observation.sha256) return operation;
      const next = this.updatePatchOperationUnsafe(operation.id, operation.revision, [operation.state], "conflict", {
        observedSha256: observation.sha256,
        recoveredAt: now,
        error: "The current file matches neither the reviewed base nor the intended result.",
      }, false);
      this.touchRunRevision(operation.runId);
      return next;
    });
  }

  rejectPendingPatch(patchId: string, expectedRevision: number): PatchProposal {
    return this.immediateTransaction(() => {
      const patch = this.getPatch(patchId);
      if (!patch) throw new Error("Patch proposal was not found.");
      if (patch.status !== "pending") return patch;
      if (patch.revision !== expectedRevision) throw new Error("The patch changed after it was reviewed. Refresh before deciding.");
      const operation = this.getPatchOperationForPatch(patch.id);
      if (operation) throw new Error("This patch already has a durable apply operation and cannot be rejected as untouched.");
      const next = this.updatePatchStatusUnsafe(patch, "pending", "rejected");
      if (patch.restoresCheckpointId) this.releaseCheckpointRestoreProposalUnsafe(patch);
      this.touchRunRevision(next.runId);
      return next;
    });
  }

  markPendingPatchStale(patchId: string, expectedRevision: number): PatchProposal {
    return this.immediateTransaction(() => {
      const patch = this.getPatch(patchId);
      if (!patch) throw new Error("Patch proposal was not found.");
      if (patch.status !== "pending") return patch;
      if (patch.revision !== expectedRevision) throw new Error("The patch changed after it was reviewed. Refresh before deciding.");
      const next = this.updatePatchStatusUnsafe(patch, "pending", "stale");
      if (patch.restoresCheckpointId && !this.getPatchOperationForPatch(patch.id)) {
        this.releaseCheckpointRestoreProposalUnsafe(patch);
      }
      this.touchRunRevision(next.runId);
      return next;
    });
  }

  createCheckpointRestorePatch(
    checkpointId: string,
    expectedCheckpointRevision: number,
    patch: PatchProposal,
  ): PatchProposal {
    return this.immediateTransaction(() => {
      const snapshot = this.getCheckpointSnapshot(checkpointId);
      if (!snapshot) throw new Error("File checkpoint was not found.");
      const checkpoint = snapshot.checkpoint;
      if (checkpoint.revision !== expectedCheckpointRevision || checkpoint.restoreState !== "available") {
        throw new Error("The checkpoint changed after it was reviewed. Refresh before preparing a restore.");
      }
      if (patch.restoresCheckpointId !== checkpoint.id
        || patch.runId !== checkpoint.runId
        || patch.targetPath !== checkpoint.targetPath
        || patch.baseSha256 !== checkpoint.resultSha256
        || patch.after !== snapshot.content
        || patch.afterExists !== checkpoint.existed) {
        throw new Error("The restore proposal does not match the durable checkpoint.");
      }
      const original = this.getPatchOperation(checkpoint.operationId);
      if (!original || !["applied", "validation-failed", "verified"].includes(original.state)) {
        throw new Error("The checkpoint source operation is not in a restorable state.");
      }
      const savedPatch = this.savePatch(patch);
      const record = this.getCheckpointRecordUnsafe(checkpoint.id);
      const nextRecord: CheckpointRecord = {
        ...record,
        restoreState: "restore-proposed",
        restorePatchId: savedPatch.id,
        revision: record.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      this.writeCheckpointUnsafe(nextRecord);
      if (["applied", "validation-failed"].includes(original.state)) {
        this.updatePatchOperationUnsafe(original.id, original.revision, [original.state], original.state, {}, false);
      }
      this.touchRunRevision(checkpoint.runId);
      return savedPatch;
    });
  }

  markCheckpointConflict(checkpointId: string, expectedRevision: number, reason: string): FileCheckpoint {
    return this.immediateTransaction(() => {
      const record = this.getCheckpointRecordUnsafe(checkpointId);
      if (record.revision !== expectedRevision) throw new Error("The checkpoint changed. Refresh before reconciling it again.");
      const next: CheckpointRecord = {
        ...record,
        restoreState: "conflict",
        conflictReason: reason,
        revision: record.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      this.writeCheckpointUnsafe(next);
      this.touchRunRevision(next.runId);
      return checkpointView(next);
    });
  }

  private transitionPatchOperation(
    operationId: string,
    expectedRevision: number,
    expectedStates: PatchOperationState[],
    state: PatchOperationState,
    patch: Partial<PatchOperation> = {},
    active = !["verified", "conflict", "rolled-back"].includes(state),
  ): PatchOperation {
    return this.immediateTransaction(() => {
      const next = this.updatePatchOperationUnsafe(operationId, expectedRevision, expectedStates, state, patch, active);
      this.touchRunRevision(next.runId);
      return next;
    });
  }

  private updatePatchOperationUnsafe(
    operationId: string,
    expectedRevision: number,
    expectedStates: PatchOperationState[],
    state: PatchOperationState,
    patch: Partial<PatchOperation>,
    active: boolean,
  ): PatchOperation {
    const current = this.getPatchOperation(operationId);
    if (!current) throw new Error("Patch operation was not found.");
    if (current.revision !== expectedRevision || !expectedStates.includes(current.state)) {
      throw new Error("The patch operation changed before this transition could be recorded.");
    }
    const updatedAt = new Date().toISOString();
    const next: PatchOperation = {
      ...current,
      ...patch,
      id: current.id,
      patchId: current.patchId,
      runId: current.runId,
      checkpointId: current.checkpointId,
      state,
      revision: current.revision + 1,
      updatedAt,
    };
    const result = this.db
      .prepare(
        `UPDATE patch_operations SET state = ?, active = ?, revision = ?, payload = ?, updated_at = ? WHERE id = ? AND revision = ? AND state IN (${expectedStates.map(() => "?").join(",")})`,
      )
      .run(state, active ? 1 : 0, next.revision, JSON.stringify(next), updatedAt, operationId, expectedRevision, ...expectedStates);
    if (Number(result.changes) !== 1) throw new Error("The patch operation changed before this transition could be recorded.");
    return next;
  }

  private updatePatchStatusUnsafe(
    patch: PatchProposal,
    expectedStatus: PatchProposal["status"],
    status: PatchProposal["status"],
  ): PatchProposal {
    const next = { ...patch, status, revision: patch.revision + 1 };
    const result = this.db
      .prepare("UPDATE patches SET status = ?, revision = ?, payload = ? WHERE id = ? AND status = ? AND revision = ?")
      .run(status, next.revision, JSON.stringify(next), patch.id, expectedStatus, patch.revision);
    if (Number(result.changes) !== 1) throw new Error("The patch decision lost its compare-and-swap race.");
    return next;
  }

  private getCheckpointRecordUnsafe(id: string): CheckpointRecord {
    const row = this.db
      .prepare("SELECT id, operation_id, patch_id, run_id, status, revision, payload, created_at, updated_at FROM file_checkpoints WHERE id = ?")
      .get(id) as DbCheckpointRow | undefined;
    if (!row) throw new Error("File checkpoint was not found.");
    return normalizeCheckpointRow(row);
  }

  private writeCheckpointUnsafe(record: CheckpointRecord): void {
    this.db
      .prepare("UPDATE file_checkpoints SET status = ?, revision = ?, payload = ?, updated_at = ? WHERE id = ?")
      .run(record.restoreState, record.revision, JSON.stringify(record), record.updatedAt, record.id);
  }

  private markCheckpointRestoredUnsafe(checkpointId: string, restorePatchId: string): void {
    const record = this.getCheckpointRecordUnsafe(checkpointId);
    const restoredAt = new Date().toISOString();
    this.writeCheckpointUnsafe({
      ...record,
      restoreState: "restored",
      restorePatchId,
      revision: record.revision + 1,
      updatedAt: restoredAt,
      restoredAt,
    });
    const original = this.getPatchOperation(record.operationId);
    if (original && original.state !== "rolled-back") {
      this.updatePatchOperationUnsafe(original.id, original.revision, [original.state], "rolled-back", { completedAt: restoredAt }, false);
      const originalPatch = this.getPatch(original.patchId);
      if (originalPatch?.status === "approved") this.updatePatchStatusUnsafe(originalPatch, "approved", "rolled-back");
    }
  }

  private finalizeReconciledPatchEffectUnsafe(operation: PatchOperation): boolean {
    let patch = this.getPatch(operation.patchId);
    if (!patch) throw new Error("Patch proposal was not found.");
    let changed = false;
    if (patch.status === "pending" || patch.status === "stale") {
      patch = this.updatePatchStatusUnsafe(patch, patch.status, "approved");
      changed = true;
    }
    if (patch.restoresCheckpointId) {
      const checkpoint = this.getCheckpointRecordUnsafe(patch.restoresCheckpointId);
      if (checkpoint.restoreState === "restore-proposed" && checkpoint.restorePatchId === patch.id) {
        this.markCheckpointRestoredUnsafe(checkpoint.id, patch.id);
        changed = true;
      } else if (checkpoint.restoreState !== "restored") {
        throw new Error("The restored file effect does not match its checkpoint reservation.");
      }
    }
    return changed;
  }

  private releaseCheckpointRestoreProposalUnsafe(patch: PatchProposal): void {
    if (!patch.restoresCheckpointId) return;
    const record = this.getCheckpointRecordUnsafe(patch.restoresCheckpointId);
    if (record.restoreState !== "restore-proposed" || record.restorePatchId !== patch.id) {
      throw new Error("The checkpoint restore reservation no longer matches this patch.");
    }
    const updatedAt = new Date().toISOString();
    const { restorePatchId: _restorePatchId, ...withoutRestorePatch } = record;
    this.writeCheckpointUnsafe({
      ...withoutRestorePatch,
      restoreState: "available",
      revision: record.revision + 1,
      updatedAt,
    });
    const original = this.getPatchOperation(record.operationId);
    if (original && ["applied", "validation-failed"].includes(original.state)) {
      this.updatePatchOperationUnsafe(original.id, original.revision, [original.state], original.state, {}, true);
    }
  }

  saveApproval(approval: ToolApproval): ToolApproval {
    const current = this.db.prepare("SELECT revision FROM approvals WHERE id = ?").get(approval.id) as { revision: number } | undefined;
    const saved = { ...approval, revision: current ? current.revision + 1 : Math.max(0, approval.revision ?? 0) };
    this.db
      .prepare(
        "INSERT INTO approvals(id, run_id, status, expires_at, revision, decided_at, decision_key, payload, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET status = excluded.status, expires_at = excluded.expires_at, revision = excluded.revision, decided_at = excluded.decided_at, decision_key = excluded.decision_key, payload = excluded.payload",
      )
      .run(
        saved.id,
        saved.runId,
        saved.status,
        saved.expiresAt,
        saved.revision,
        saved.decidedAt ?? null,
        saved.decisionKey ?? null,
        JSON.stringify(saved),
        saved.createdAt,
      );
    Object.assign(approval, saved);
    this.touchRunRevision(approval.runId);
    return saved;
  }

  getApproval(id: string): ToolApproval | undefined {
    const row = this.db
      .prepare("SELECT id, run_id, status, expires_at, revision, decided_at, decision_key, payload, created_at FROM approvals WHERE id = ?")
      .get(id) as DbApprovalRow | undefined;
    return row ? normalizeApprovalRow(row) : undefined;
  }

  listApprovals(runId?: string): ToolApproval[] {
    this.expirePendingApprovals();
    return this.listApprovalsUnsafe(runId);
  }

  private listApprovalsUnsafe(runId?: string): ToolApproval[] {
    const rows = (runId
      ? this.db.prepare("SELECT id, run_id, status, expires_at, revision, decided_at, decision_key, payload, created_at FROM approvals WHERE run_id = ? ORDER BY created_at DESC").all(runId)
      : this.db.prepare("SELECT id, run_id, status, expires_at, revision, decided_at, decision_key, payload, created_at FROM approvals ORDER BY created_at DESC").all()) as DbApprovalRow[];
    return rows.map(normalizeApprovalRow);
  }

  resolvePendingApproval(
    approvalId: string,
    decision: "approved" | "rejected",
    expectedRevision: number,
    decidedAt = new Date().toISOString(),
  ): ToolApproval {
    return this.immediateTransaction(() => {
      const row = this.db
        .prepare("SELECT id, run_id, status, expires_at, revision, decided_at, decision_key, payload, created_at FROM approvals WHERE id = ?")
        .get(approvalId) as DbApprovalRow | undefined;
      if (!row) throw new Error("Approval request was not found.");
      const current = normalizeApprovalRow(row);
      if (current.status !== "pending") return current;
      const expiresAt = Date.parse(current.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(decidedAt)) {
        return this.expirePendingApprovalUnsafe(current, decidedAt);
      }
      const next: ToolApproval = {
        ...current,
        status: decision,
        revision: current.revision + 1,
        decidedAt,
        decisionKey: `${approvalId}:${decision}`,
      };
      const result = this.db
        .prepare(
          "UPDATE approvals SET status = ?, revision = ?, decided_at = ?, decision_key = ?, payload = ? " +
            "WHERE id = ? AND status = 'pending' AND revision = ? AND expires_at > ?",
        )
        .run(next.status, next.revision, decidedAt, `${approvalId}:${decision}`, JSON.stringify(next), approvalId, expectedRevision, decidedAt);
      if (Number(result.changes) !== 1) {
        const winner = this.getApproval(approvalId);
        if (!winner) throw new Error("Approval request was not found.");
        return winner;
      }
      this.touchRunRevision(next.runId);
      return next;
    });
  }

  expirePendingApprovals(now = new Date().toISOString()): number {
    return this.immediateTransaction(() => {
      const candidates = this.db
        .prepare(
          "SELECT id, run_id, status, expires_at, revision, decided_at, decision_key, payload, created_at " +
            "FROM approvals WHERE status = 'pending'",
        )
        .all() as DbApprovalRow[];
      const nowMs = Date.parse(now);
      const rows = candidates.filter((row) => {
        const expiry = Date.parse(normalizeApprovalRow(row).expiresAt);
        return !Number.isFinite(expiry) || expiry <= nowMs;
      });
      for (const row of rows) this.expirePendingApprovalUnsafe(normalizeApprovalRow(row), now);
      return rows.length;
    });
  }

  expirePendingApproval(approvalId: string, now = new Date().toISOString()): ToolApproval | undefined {
    return this.immediateTransaction(() => {
      const row = this.db
        .prepare("SELECT id, run_id, status, expires_at, revision, decided_at, decision_key, payload, created_at FROM approvals WHERE id = ?")
        .get(approvalId) as DbApprovalRow | undefined;
      if (!row) return undefined;
      const approval = normalizeApprovalRow(row);
      const expiry = Date.parse(approval.expiresAt);
      if (approval.status !== "pending" || (Number.isFinite(expiry) && expiry > Date.parse(now))) return approval;
      return this.expirePendingApprovalUnsafe(approval, now);
    });
  }

  markApprovalConsumed(approvalId: string, executionEventId: string): ToolApproval {
    return this.immediateTransaction(() => {
      const approval = this.getApproval(approvalId);
      if (!approval) throw new Error("Approval request was not found.");
      if (approval.consumedAt) return approval;
      if (approval.status !== "approved") throw new Error(`Approval is ${approval.status} and cannot authorize execution.`);
      const next: ToolApproval = {
        ...approval,
        revision: approval.revision + 1,
        consumedAt: new Date().toISOString(),
        executionEventId,
      };
      const result = this.db
        .prepare("UPDATE approvals SET revision = ?, payload = ? WHERE id = ? AND status = 'approved' AND revision = ?")
        .run(next.revision, JSON.stringify(next), approval.id, approval.revision);
      if (Number(result.changes) !== 1) throw new Error("Approval consumption lost its compare-and-swap race.");
      this.touchRunRevision(next.runId);
      return next;
    });
  }

  private expirePendingApprovalUnsafe(approval: ToolApproval, expiredAt: string): ToolApproval {
    const next: ToolApproval = {
      ...approval,
      status: "expired",
      revision: approval.revision + 1,
      decidedAt: expiredAt,
      decisionKey: `${approval.id}:expired`,
      invalidatedAt: expiredAt,
      invalidationReason: "The approval expired before it was resolved; no action was executed.",
    };
    const result = this.db
      .prepare(
        "UPDATE approvals SET status = 'expired', revision = ?, decided_at = ?, decision_key = ?, payload = ? " +
          "WHERE id = ? AND status = 'pending' AND revision = ?",
      )
      .run(next.revision, expiredAt, `${approval.id}:expired`, JSON.stringify(next), next.id, approval.revision);
    if (Number(result.changes) === 1) this.touchRunRevision(next.runId);
    return Number(result.changes) === 1 ? next : this.getApproval(next.id) ?? next;
  }

  invalidatePendingApprovals(reason: string): number {
    return this.immediateTransaction(() => this.invalidatePendingApprovalsUnsafe(reason));
  }

  reconcileStartupState(runReason: string, approvalReason: string): StartupRecoveryReport {
    return this.immediateTransaction(() => {
      const invalidatedApprovals = this.invalidatePendingApprovalsUnsafe(approvalReason);
      const runs = this.reconcileInterruptedRunsUnsafe(runReason, invalidatedApprovals);
      const journals = this.reconcileValidationJournalsUnsafe(runReason);
      return {
        ...runs,
        runIds: [...new Set([...runs.runIds, ...journals.runIds])],
        ...(journals.reconciled > 0 || journals.stepsNeedingReplay > 0
          ? {
            reconciledValidationJournals: journals.reconciled,
            validationStepsNeedingReplay: journals.stepsNeedingReplay,
          }
          : {}),
      };
    });
  }

  private invalidatePendingApprovalsUnsafe(reason: string): number {
    const candidates = this.db
      .prepare("SELECT id, run_id, status, expires_at, revision, decided_at, decision_key, payload, created_at FROM approvals WHERE status IN ('pending', 'approved')")
      .all() as DbApprovalRow[];
    const invalidatedAt = new Date().toISOString();
    const pending = candidates.filter((row) => {
      const approval = normalizeApprovalRow(row);
      return approval.status === "pending" || (approval.status === "approved" && !approval.consumedAt);
    });
    for (const row of pending) {
      const approval = normalizeApprovalRow(row);
      const previousStatus = approval.status;
      approval.status = "stale";
      approval.invalidatedAt = invalidatedAt;
      approval.invalidationReason = isJsonRecord(parseJson(row.payload))
        ? previousStatus === "approved"
          ? `${reason} The approval decision was recorded but had not been consumed by a durable execution event.`
          : reason
        : `${reason} The legacy approval payload was malformed and quarantined.`;
      this.saveApproval(approval);
    }
    return pending.length;
  }

  reconcileInterruptedRuns(reason: string, invalidatedApprovals = 0): StartupRecoveryReport {
    return this.immediateTransaction(() => this.reconcileInterruptedRunsUnsafe(reason, invalidatedApprovals));
  }

  private reconcileInterruptedRunsUnsafe(reason: string, invalidatedApprovals = 0): StartupRecoveryReport {
    const checkedAt = new Date().toISOString();
    const rows = this.db
      .prepare(
        "SELECT id, run_id, stage, status, payload, created_at FROM run_events " +
          "WHERE status IN ('running', 'approval-required') " +
          "ORDER BY created_at ASC, run_id ASC, history_sequence ASC, id ASC",
      )
      .all() as DbRunEventRow[];
    const activeByRun = new Map<string, AgentRunEvent[]>();
    for (const row of rows) {
      const event = normalizeRunEventRow(row);
      const events = activeByRun.get(row.run_id) ?? [];
      events.push(event);
      activeByRun.set(row.run_id, events);
    }
    const runIds = [...activeByRun.keys()];
    if (runIds.length === 0) {
      return {
        checkedAt,
        recoveredRuns: 0,
        recoveredEvents: 0,
        invalidatedApprovals,
        reconciledPatchOperations: 0,
        conflictedPatchOperations: 0,
        runIds: [],
      };
    }

    for (const [runId, events] of activeByRun) {
      const recovered = events.map((event) => {
        const status: AgentRunEvent["status"] = event.status === "running" && (event.actor === "tool" || Boolean(event.tool))
          ? "effect-unknown"
          : "interrupted";
        this.appendEvent({
          ...event,
          status,
          completedAt: checkedAt,
          payload: {
            ...(event.payload ?? {}),
            startupRecovery: {
              checkedAt,
              reason,
              previousStatus: event.status,
              effectClass: status === "effect-unknown" ? "side-effect-may-have-occurred" : "not-started-or-no-effect-observed",
            },
          },
        });
        return { id: event.id, status };
      });
      const latest = events.at(-1)!;
      const runStatus: AgentRunEvent["status"] = recovered.some((event) => event.status === "effect-unknown")
        ? "effect-unknown"
        : "interrupted";
      this.appendEvent({
        id: randomUUID(),
        runId,
        stage: latest.stage,
        actor: "system",
        title: "Run interrupted during startup recovery",
        summary:
          `${events.length} unfinished event${events.length === 1 ? " was" : "s were"} marked interrupted without replaying side effects.`,
        inputProvenance: [],
        outputArtifacts: [],
        evidenceIds: [],
        status: runStatus,
        createdAt: checkedAt,
        completedAt: checkedAt,
        payload: {
          reason,
          recoveredEvents: recovered,
        },
      });
    }
    return {
      checkedAt,
      recoveredRuns: runIds.length,
      recoveredEvents: rows.length,
      invalidatedApprovals,
      reconciledPatchOperations: 0,
      conflictedPatchOperations: 0,
      runIds,
    };
  }

  private reconcileValidationJournalsUnsafe(reason: string): {
    reconciled: number;
    stepsNeedingReplay: number;
    runIds: string[];
  } {
    const rows = this.db
      .prepare(
        "SELECT operation_id, patch_id, run_id, state, revision, payload, created_at, updated_at " +
          "FROM validation_journals ORDER BY updated_at ASC, operation_id ASC",
      )
      .all() as DbValidationJournalRow[];
    const checkedAt = new Date().toISOString();
    let reconciled = 0;
    let stepsNeedingReplay = 0;
    const runIds = new Set<string>();
    for (const row of rows) {
      const record = normalizeValidationJournalRow(row);
      const review = this.getValidationReviewSnapshot(record.operationId);
      const repairedSteps: ValidationStepKey[] = [];
      let brokenBy: ValidationStepKey | undefined;
      const steps = [...record.steps]
        .sort((left, right) => left.sequence - right.sequence)
        .map((step): ValidationJournalStep => {
          if (brokenBy) {
            if (isExecutedValidationArtifactStep(step)) {
              if (step.state === "effect-unknown" && step.invalidatedBy === brokenBy) return step;
              repairedSteps.push(step.key);
              stepsNeedingReplay += 1;
              return {
                ...step,
                state: "effect-unknown",
                completedAt: checkedAt,
                updatedAt: checkedAt,
                error: "A prerequisite lost durable evidence after this artifact-writing step had already been attempted; its effect requires explicit reconciliation.",
                invalidatedBy: brokenBy,
              };
            }
            if (step.state === "pending" && !step.eventId) return step;
            repairedSteps.push(step.key);
            stepsNeedingReplay += 1;
            return {
              ...step,
              state: "pending",
              eventId: undefined,
              outputSha256: undefined,
              outputArtifacts: [],
              evidenceIds: [],
              completedAt: undefined,
              updatedAt: checkedAt,
              error: undefined,
              invalidatedBy: brokenBy,
            };
          }
          const event = step.eventId ? this.getRunEvent(step.eventId) : undefined;
          const bindingMatches = Boolean(event && validationEventBindingMatches(event, record, step));
          let next = step;
          if (step.state === "running") {
            const state = bindingMatches && event
              ? journalStepStateFromRecoveredEvent(event, step.effect)
              : step.effect === "artifact-write" ? "effect-unknown" : "interrupted";
            next = {
              ...step,
              state,
              completedAt: event?.completedAt ?? checkedAt,
              updatedAt: checkedAt,
              error: state === "completed"
                ? undefined
                : event?.summary || "Startup reconciliation could not prove this validation attempt completed.",
            };
            repairedSteps.push(step.key);
            if (state !== "completed") stepsNeedingReplay += 1;
          } else if (step.state === "completed") {
            const validationBinding = isJsonRecord(event?.payload?.validationJournal)
              ? event.payload.validationJournal
              : undefined;
            const journalRevision = validationBinding
              && typeof validationBinding.journalRevision === "number"
              && Number.isSafeInteger(validationBinding.journalRevision)
              && validationBinding.journalRevision >= 0
              ? validationBinding.journalRevision
              : undefined;
            const outputBinding = Boolean(event
              && validationBinding?.outputSha256 === step.outputSha256
              && validationStepEvidenceSha256(event) === step.outputSha256
              && validationToolOutputBindingMatches(event));
            const reviewInvalid = step.key === "review-packet"
              && (journalRevision === undefined
                || !reviewBindingMatches(review, record.operationId, record.planSha256, journalRevision)
                || validationBinding?.reviewPacketSha256 !== review?.packetSha256);
            if (!bindingMatches
              || !event
              || !["completed", "approved"].includes(event.status)
              || !outputBinding
              || reviewInvalid) {
              const state = step.effect === "artifact-write" ? "effect-unknown" : "interrupted";
              next = {
                ...step,
                state,
                completedAt: checkedAt,
                updatedAt: checkedAt,
                error: reviewInvalid
                  ? "The review snapshot is missing or is not bound to this operation and validation plan."
                  : "The completed validation step no longer has matching durable event evidence.",
              };
              repairedSteps.push(step.key);
              stepsNeedingReplay += 1;
            }
          }
          if (next.state !== "completed") brokenBy = next.key;
          return next;
        });
      const state = validationJournalState(steps);
      if (repairedSteps.length === 0 && state === record.state) continue;
      const next: ValidationJournalRecord = {
        ...record,
        state,
        revision: record.revision + 1,
        steps,
        updatedAt: checkedAt,
        reconciliation: {
          checkedAt,
          reason,
          repairedSteps,
        },
      };
      this.writeValidationJournalUnsafe(next, true);
      this.appendEvent({
        id: randomUUID(),
        runId: record.runId,
        stage: "validate",
        actor: "system",
        title: "Validation journal reconciled",
        summary: repairedSteps.length
          ? `${repairedSteps.length} validation step${repairedSteps.length === 1 ? "" : "s"} require an explicit replay decision.`
          : "Validation journal state was reconciled with its durable step evidence.",
        inputProvenance: [],
        outputArtifacts: [],
        evidenceIds: [],
        status: "completed",
        createdAt: checkedAt,
        completedAt: checkedAt,
        payload: {
          operationId: record.operationId,
          previousState: record.state,
          state,
          repairedSteps,
          automaticReplay: false,
          reason,
        },
      });
      reconciled += 1;
      runIds.add(record.runId);
    }
    return { reconciled, stepsNeedingReplay, runIds: [...runIds] };
  }

  private getValidationJournalRecordUnsafe(operationId: string): ValidationJournalRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT operation_id, patch_id, run_id, state, revision, payload, created_at, updated_at " +
          "FROM validation_journals WHERE operation_id = ?",
      )
      .get(operationId) as DbValidationJournalRow | undefined;
    return row ? normalizeValidationJournalRow(row) : undefined;
  }

  private writeValidationJournalUnsafe(record: ValidationJournalRecord, requireExisting: boolean): void {
    if (!requireExisting) {
      this.db
        .prepare(
          "INSERT INTO validation_journals(operation_id, patch_id, run_id, state, revision, payload, created_at, updated_at) " +
            "VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          record.operationId,
          record.patchId,
          record.runId,
          record.state,
          record.revision,
          JSON.stringify(record),
          record.createdAt,
          record.updatedAt,
        );
      return;
    }
    const result = this.db
      .prepare(
        "UPDATE validation_journals SET state = ?, revision = ?, payload = ?, updated_at = ? " +
          "WHERE operation_id = ? AND revision = ?",
      )
      .run(
        record.state,
        record.revision,
        JSON.stringify(record),
        record.updatedAt,
        record.operationId,
        record.revision - 1,
      );
    if (Number(result.changes) !== 1) throw new Error("The validation journal changed during reconciliation.");
  }

  private immediateTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private readTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveReview(review: ReviewPacketView): void {
    this.db
      .prepare(
        "INSERT INTO reviews(run_id, payload, updated_at) VALUES(?, ?, ?) " +
          "ON CONFLICT(run_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
      )
      .run(review.runId, JSON.stringify(review), new Date().toISOString());
    this.touchRunRevision(review.runId);
  }

  getReview(runId: string): ReviewPacketView | undefined {
    const row = this.db.prepare("SELECT payload FROM reviews WHERE run_id = ?").get(runId) as
      | { payload: string }
      | undefined;
    return row ? normalizeReviewPayload(runId, row.payload) : undefined;
  }

  getValidationReviewSnapshot(operationId: string): ReviewPacketView | undefined {
    const row = this.db
      .prepare("SELECT run_id, payload FROM validation_review_snapshots WHERE operation_id = ?")
      .get(operationId) as { run_id: string; payload: string } | undefined;
    return row ? normalizeReviewPayload(row.run_id, row.payload) : undefined;
  }

  private saveValidationReviewSnapshotUnsafe(operationId: string, review: ReviewPacketView): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO validation_review_snapshots(operation_id, run_id, payload, created_at) " +
          "VALUES(?, ?, ?, ?)",
      )
      .run(operationId, review.runId, JSON.stringify(review), new Date().toISOString());
    const stored = this.getValidationReviewSnapshot(operationId);
    if (!stored
      || stored.runId !== review.runId
      || stored.packetSha256 !== review.packetSha256
      || !reviewBindingMatches(
        stored,
        operationId,
        review.validationPlanSha256 ?? "",
        review.validationJournalRevision ?? -1,
      )) {
      throw new Error("The immutable validation review snapshot conflicts with this operation result.");
    }
  }

  addReviewComment(runId: string, comment: string): ReviewComment {
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare("INSERT INTO review_comments(run_id, comment, created_at) VALUES(?, ?, ?)")
      .run(runId, comment, createdAt);
    this.touchRunRevision(runId);
    return { id: Number(result.lastInsertRowid), runId, comment, createdAt };
  }

  listReviewComments(runId: string): ReviewComment[] {
    const rows = this.db
      .prepare("SELECT id, run_id, comment, created_at FROM review_comments WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId) as Array<{ id: number; run_id: string; comment: string; created_at: string }>;
    return rows.map((row) => ({ id: row.id, runId: row.run_id, comment: row.comment, createdAt: row.created_at }));
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS module_audits (
        id TEXT PRIMARY KEY,
        checked_at TEXT NOT NULL,
        ok INTEGER NOT NULL,
        manifest_sha256 TEXT,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_module_audits_checked ON module_audits(checked_at DESC);
      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        descriptor TEXT NOT NULL,
        scanned_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        title TEXT NOT NULL,
        mode TEXT NOT NULL,
        model_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, created_at);
      CREATE TABLE IF NOT EXISTS run_state (
        run_id TEXT PRIMARY KEY,
        archived INTEGER NOT NULL DEFAULT 0,
        thread_id TEXT,
        workspace_path TEXT,
        created_at TEXT,
        updated_at TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        recovery_state TEXT
      );
      CREATE TABLE IF NOT EXISTS patches (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        target_path TEXT,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_patches_run ON patches(run_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        decided_at TEXT,
        decision_key TEXT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS patch_operations (
        id TEXT PRIMARY KEY,
        patch_id TEXT NOT NULL UNIQUE REFERENCES patches(id),
        run_id TEXT NOT NULL,
        target_path TEXT NOT NULL,
        state TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_patch_operations_run ON patch_operations(run_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_patch_operations_active_target ON patch_operations(target_path COLLATE NOCASE) WHERE active = 1;
      CREATE TABLE IF NOT EXISTS validation_journals (
        operation_id TEXT PRIMARY KEY REFERENCES patch_operations(id),
        patch_id TEXT NOT NULL REFERENCES patches(id),
        run_id TEXT NOT NULL,
        state TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_validation_journals_run ON validation_journals(run_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS validation_review_snapshots (
        operation_id TEXT PRIMARY KEY REFERENCES patch_operations(id),
        run_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_validation_review_snapshots_run ON validation_review_snapshots(run_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS file_checkpoints (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE REFERENCES patch_operations(id),
        patch_id TEXT NOT NULL REFERENCES patches(id),
        run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_file_checkpoints_run ON file_checkpoints(run_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS reviews (
        run_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        comment TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.ensureColumn("run_state", "thread_id", "TEXT");
    this.ensureColumn("run_state", "workspace_path", "TEXT");
    this.ensureColumn("run_state", "created_at", "TEXT");
    this.ensureColumn("run_state", "updated_at", "TEXT");
    this.ensureColumn("run_state", "revision", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("run_state", "recovery_state", "TEXT");
    this.ensureColumn("patches", "target_path", "TEXT");
    this.ensureColumn("patches", "revision", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("approvals", "expires_at", "TEXT");
    this.ensureColumn("approvals", "revision", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("approvals", "decided_at", "TEXT");
    this.ensureColumn("approvals", "decision_key", "TEXT");
    installRunHistorySchema(this.db);
    installRunCheckpointSchema(this.db);
  }

  private ensureColumn(table: "run_state" | "patches" | "approvals", column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((candidate) => candidate.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private touchRunRevision(runId: string): void {
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO run_state(run_id, archived, updated_at, revision) VALUES(?, 0, ?, 1) " +
          "ON CONFLICT(run_id) DO UPDATE SET updated_at = excluded.updated_at, revision = run_state.revision + 1",
      )
      .run(runId, updatedAt);
  }
}

function normalizeRunEventRow(row: DbRunEventRow): AgentRunEvent {
  const parsed = parseJson(row.payload);
  const payload = isJsonRecord(parsed) ? parsed : undefined;
  const stage = AGENT_STAGES.has(row.stage as AgentRunEvent["stage"])
    ? row.stage as AgentRunEvent["stage"]
    : "plan";
  const status = EVENT_STATUSES.has(row.status as AgentRunEvent["status"])
    ? row.status as AgentRunEvent["status"]
    : "failed";
  const actor = payload && AGENT_ACTORS.has(payload.actor as AgentRunEvent["actor"])
    ? payload.actor as AgentRunEvent["actor"]
    : "system";
  return {
    id: row.id,
    runId: row.run_id,
    stage,
    actor,
    title: payload && typeof payload.title === "string" ? payload.title : "Recovered malformed legacy event",
    summary: payload && typeof payload.summary === "string"
      ? payload.summary
      : "The indexed event payload was incomplete or malformed and was quarantined.",
    tool: payload && typeof payload.tool === "string" ? payload.tool : undefined,
    inputProvenance: stringArray(payload?.inputProvenance),
    outputArtifacts: stringArray(payload?.outputArtifacts),
    evidenceIds: stringArray(payload?.evidenceIds),
    status,
    createdAt: row.created_at,
    completedAt: payload && typeof payload.completedAt === "string" ? payload.completedAt : undefined,
    payload: payload && isJsonRecord(payload.payload) ? payload.payload : undefined,
  };
}

function normalizePatchRow(row: DbPatchRow): PatchProposal {
  const parsed = parseJson(row.payload);
  const payload = isJsonRecord(parsed) ? parsed : undefined;
  const validPayload = Boolean(
    payload
    && typeof payload.targetPath === "string"
    && payload.targetPath.trim()
    && typeof payload.baseSha256 === "string"
    && payload.baseSha256.trim()
    && typeof payload.before === "string"
    && typeof payload.after === "string"
    && typeof payload.unifiedDiff === "string"
    && typeof payload.rationale === "string",
  );
  const hasExistenceCas = Boolean(payload && typeof payload.baseExists === "boolean" && typeof payload.afterExists === "boolean");
  const status = validPayload && hasExistenceCas && PATCH_STATUSES.has(row.status as PatchProposal["status"])
    ? row.status as PatchProposal["status"]
    : "stale";
  return {
    id: row.id,
    runId: row.run_id,
    targetPath: payload && typeof payload.targetPath === "string" ? payload.targetPath : "",
    baseSha256: payload && typeof payload.baseSha256 === "string" ? payload.baseSha256 : "",
    baseExists: payload && typeof payload.baseExists === "boolean" ? payload.baseExists : false,
    before: payload && typeof payload.before === "string" ? payload.before : "",
    after: payload && typeof payload.after === "string" ? payload.after : "",
    afterExists: payload && typeof payload.afterExists === "boolean" ? payload.afterExists : true,
    unifiedDiff: payload && typeof payload.unifiedDiff === "string" ? payload.unifiedDiff : "",
    rationale: payload && typeof payload.rationale === "string"
      ? payload.rationale
      : "Malformed legacy patch payload was quarantined.",
    status,
    revision: Number.isSafeInteger(row.revision) && row.revision >= 0 ? row.revision : 0,
    restoresCheckpointId: payload && typeof payload.restoresCheckpointId === "string" ? payload.restoresCheckpointId : undefined,
    materialBinding: payload?.materialBinding && typeof payload.materialBinding === "object" ? payload.materialBinding as PatchProposal["materialBinding"] : undefined,
    createdAt: row.created_at,
  };
}

function normalizePatchOperationRow(row: DbPatchOperationRow): PatchOperation {
  const parsed = parseJson(row.payload);
  const payload = isJsonRecord(parsed) ? parsed : undefined;
  const state = PATCH_OPERATION_STATES.has(row.state as PatchOperationState)
    ? row.state as PatchOperationState
    : "effect-unknown";
  return {
    id: row.id,
    idempotencyKey: payload && typeof payload.idempotencyKey === "string" ? payload.idempotencyKey : `recovered:${row.id}`,
    patchId: row.patch_id,
    runId: row.run_id,
    targetPath: row.target_path,
    state,
    baseSha256: payload && typeof payload.baseSha256 === "string" ? payload.baseSha256 : "",
    baseExists: Boolean(payload?.baseExists),
    resultSha256: payload && typeof payload.resultSha256 === "string" ? payload.resultSha256 : "",
    resultExists: payload?.resultExists !== false,
    observedSha256: payload && typeof payload.observedSha256 === "string" ? payload.observedSha256 : undefined,
    checkpointId: payload && typeof payload.checkpointId === "string" ? payload.checkpointId : "",
    revision: Number.isSafeInteger(row.revision) && row.revision >= 0 ? row.revision : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: payload && typeof payload.appliedAt === "string" ? payload.appliedAt : undefined,
    validationStartedAt: payload && typeof payload.validationStartedAt === "string" ? payload.validationStartedAt : undefined,
    completedAt: payload && typeof payload.completedAt === "string" ? payload.completedAt : undefined,
    recoveredAt: payload && typeof payload.recoveredAt === "string" ? payload.recoveredAt : undefined,
    error: payload && typeof payload.error === "string"
      ? payload.error
      : payload
        ? undefined
        : "Malformed patch operation payload was quarantined.",
  };
}

function normalizeValidationJournalRow(row: DbValidationJournalRow): ValidationJournalRecord {
  const parsed = parseJson(row.payload);
  const payload = isJsonRecord(parsed) ? parsed : undefined;
  const rawSteps = Array.isArray(payload?.steps) ? payload.steps : [];
  const seen = new Set<ValidationStepKey>();
  const steps = rawSteps
    .filter(isJsonRecord)
    .map((step): ValidationJournalStep | undefined => {
      const key = VALIDATION_STEP_KEYS.has(step.key as ValidationStepKey)
        ? step.key as ValidationStepKey
        : undefined;
      if (!key || seen.has(key)) return undefined;
      seen.add(key);
      const effect = VALIDATION_STEP_EFFECTS.has(step.effect as ValidationJournalStep["effect"])
        ? step.effect as ValidationJournalStep["effect"]
        : "artifact-write";
      const recordedState = VALIDATION_STEP_STATES.has(step.state as ValidationJournalStep["state"])
        ? step.state as ValidationJournalStep["state"]
        : "effect-unknown";
      const state = effect === "artifact-write" && (recordedState === "failed" || recordedState === "interrupted")
        ? "effect-unknown"
        : recordedState;
      const sequence = typeof step.sequence === "number" && Number.isSafeInteger(step.sequence) && step.sequence >= 0
        ? step.sequence
        : Number.MAX_SAFE_INTEGER;
      const updatedAt = typeof step.updatedAt === "string" ? step.updatedAt : row.updated_at;
      return {
        key,
        title: typeof step.title === "string" && step.title ? step.title : key,
        sequence,
        effect,
        inputSha256: typeof step.inputSha256 === "string" ? step.inputSha256 : "",
        state,
        attempt: typeof step.attempt === "number" && Number.isSafeInteger(step.attempt) && step.attempt >= 0
          ? step.attempt
          : 0,
        eventId: typeof step.eventId === "string" ? step.eventId : undefined,
        eventIds: stringArray(step.eventIds),
        outputSha256: typeof step.outputSha256 === "string" ? step.outputSha256 : undefined,
        outputArtifacts: stringArray(step.outputArtifacts),
        evidenceIds: stringArray(step.evidenceIds),
        startedAt: typeof step.startedAt === "string" ? step.startedAt : undefined,
        completedAt: typeof step.completedAt === "string" ? step.completedAt : undefined,
        updatedAt,
        error: typeof step.error === "string" ? step.error : undefined,
        invalidatedBy: VALIDATION_STEP_KEYS.has(step.invalidatedBy as ValidationStepKey)
          ? step.invalidatedBy as ValidationStepKey
          : undefined,
      };
    })
    .filter((step): step is ValidationJournalStep => Boolean(step))
    .sort((left, right) => left.sequence - right.sequence);
  const reconciliation = isJsonRecord(payload?.reconciliation)
    ? {
      checkedAt: typeof payload.reconciliation.checkedAt === "string"
        ? payload.reconciliation.checkedAt
        : row.updated_at,
      reason: typeof payload.reconciliation.reason === "string"
        ? payload.reconciliation.reason
        : "Recovered malformed reconciliation metadata.",
      repairedSteps: stringArray(payload.reconciliation.repairedSteps)
        .filter((key): key is ValidationStepKey => VALIDATION_STEP_KEYS.has(key as ValidationStepKey)),
    }
    : undefined;
  const plan = steps.map(({ key, title, sequence, effect, inputSha256 }) => ({ key, title, sequence, effect, inputSha256 }));
  return {
    schema: "proto-workbench.validation-journal.v1",
    operationId: row.operation_id,
    patchId: row.patch_id,
    runId: row.run_id,
    planSha256: payload && typeof payload.planSha256 === "string"
      ? payload.planSha256
      : validationPlanSha256(plan),
    state: validationJournalState(steps),
    revision: Number.isSafeInteger(row.revision) && row.revision >= 0 ? row.revision : 0,
    steps,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reconciliation,
  };
}

function validationJournalView(record: ValidationJournalRecord): ValidationJournalSnapshot {
  const next = validationJournalNextStep(record.steps);
  const hasUnknownArtifactEffect = record.steps.some(
    (step) => step.effect === "artifact-write" && step.state === "effect-unknown",
  );
  return {
    ...structuredClone(record),
    nextStepKey: next?.key,
    resumable: Boolean(
      next
      && !hasUnknownArtifactEffect
      && next.state !== "effect-unknown"
      && record.state !== "running",
    ),
    snapshotAt: new Date().toISOString(),
  };
}

function isExecutedValidationArtifactStep(step: ValidationJournalStep): boolean {
  return step.effect === "artifact-write" && (
    step.state !== "pending"
    || step.attempt > 0
    || Boolean(step.eventId)
    || step.eventIds.length > 0
  );
}

function normalizeValidationPlan(plan: ValidationStepPlan[]): ValidationStepPlan[] {
  if (!Array.isArray(plan) || plan.length === 0) throw new Error("Validation journal requires at least one step.");
  const keys = new Set<ValidationStepKey>();
  const normalized = [...plan].sort((left, right) => left.sequence - right.sequence);
  normalized.forEach((step, index) => {
    if (!VALIDATION_STEP_KEYS.has(step.key) || keys.has(step.key)) {
      throw new Error("Validation journal step keys must be known and unique.");
    }
    keys.add(step.key);
    if (step.sequence !== index) throw new Error("Validation journal steps must use a contiguous sequence.");
    if (!step.title.trim()) throw new Error("Validation journal steps require a title.");
    if (!VALIDATION_STEP_EFFECTS.has(step.effect)) throw new Error("Validation journal step effect is invalid.");
    if (!/^[a-f0-9]{64}$/.test(step.inputSha256)) throw new Error("Validation journal step input hash is invalid.");
  });
  return normalized.map((step) => ({ ...step }));
}

function validationEventBindingMatches(
  event: AgentRunEvent,
  journal: ValidationJournalRecord,
  step: ValidationJournalStep,
): boolean {
  const binding = event.payload?.validationJournal;
  if (!isJsonRecord(binding)) return false;
  return binding.schema === journal.schema
    && binding.operationId === journal.operationId
    && binding.stepKey === step.key
    && binding.attempt === step.attempt;
}

function journalStepStateFromRecoveredEvent(
  event: AgentRunEvent,
  effect: ValidationJournalStep["effect"],
): ValidationJournalStep["state"] {
  // A terminal event with a still-running journal cannot be accepted as committed:
  // normal completion updates the event and journal in one SQLite transaction.
  if (event.status === "completed" || event.status === "approved") {
    return effect === "artifact-write" ? "effect-unknown" : "interrupted";
  }
  if (effect === "artifact-write") return "effect-unknown";
  if (event.status === "failed" || event.status === "rejected") return "failed";
  if (event.status === "effect-unknown") return "interrupted";
  if (event.status === "interrupted" || event.status === "cancelled") return "interrupted";
  return "interrupted";
}

function normalizeCheckpointRow(row: DbCheckpointRow): CheckpointRecord {
  const parsed = parseJson(row.payload);
  const payload = isJsonRecord(parsed) ? parsed : undefined;
  const restoreState = CHECKPOINT_STATES.has(row.status as FileCheckpoint["restoreState"])
    ? row.status as FileCheckpoint["restoreState"]
    : "conflict";
  return {
    id: row.id,
    operationId: row.operation_id,
    patchId: row.patch_id,
    runId: row.run_id,
    targetPath: payload && typeof payload.targetPath === "string" ? payload.targetPath : "",
    existed: Boolean(payload?.existed),
    sha256: payload && typeof payload.sha256 === "string" ? payload.sha256 : "",
    resultSha256: payload && typeof payload.resultSha256 === "string" ? payload.resultSha256 : "",
    sizeBytes: payload && typeof payload.sizeBytes === "number" && Number.isSafeInteger(payload.sizeBytes) ? payload.sizeBytes : 0,
    restoreState,
    restorePatchId: payload && typeof payload.restorePatchId === "string" ? payload.restorePatchId : undefined,
    revision: Number.isSafeInteger(row.revision) && row.revision >= 0 ? row.revision : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    restoredAt: payload && typeof payload.restoredAt === "string" ? payload.restoredAt : undefined,
    conflictReason: payload && typeof payload.conflictReason === "string"
      ? payload.conflictReason
      : payload
        ? undefined
        : "Malformed checkpoint payload was quarantined.",
    content: payload && typeof payload.content === "string" ? payload.content : "",
  };
}

function checkpointView(record: CheckpointRecord): FileCheckpoint {
  const { content: _content, ...checkpoint } = record;
  return checkpoint;
}

function normalizeApprovalRow(row: DbApprovalRow): ToolApproval {
  const parsed = parseJson(row.payload);
  const payload = isJsonRecord(parsed) ? parsed : undefined;
  const status = APPROVAL_STATUSES.has(row.status as ToolApproval["status"])
    ? row.status as ToolApproval["status"]
    : "stale";
  const risk = payload && APPROVAL_RISKS.has(payload.risk as ToolApproval["risk"])
    ? payload.risk as ToolApproval["risk"]
    : "code-execution";
  return {
    id: row.id,
    runId: row.run_id,
    threadId: payload && typeof payload.threadId === "string" ? payload.threadId : "",
    workspacePath: payload && typeof payload.workspacePath === "string" ? payload.workspacePath : "",
    serviceSessionId: payload && typeof payload.serviceSessionId === "string" ? payload.serviceSessionId : "",
    tool: payload && typeof payload.tool === "string" ? payload.tool : "invalid-legacy-approval",
    arguments: payload && isJsonRecord(payload.arguments) ? payload.arguments : {},
    argumentsSha256: payload && typeof payload.argumentsSha256 === "string" ? payload.argumentsSha256 : "",
    risk,
    status,
    revision: Number.isSafeInteger(row.revision) && row.revision >= 0 ? row.revision : 0,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? (payload && typeof payload.expiresAt === "string" ? payload.expiresAt : row.created_at),
    decidedAt: row.decided_at ?? (payload && typeof payload.decidedAt === "string" ? payload.decidedAt : undefined),
    decisionKey: row.decision_key ?? (payload && typeof payload.decisionKey === "string" ? payload.decisionKey : undefined),
    consumedAt: payload && typeof payload.consumedAt === "string" ? payload.consumedAt : undefined,
    executionEventId: payload && typeof payload.executionEventId === "string" ? payload.executionEventId : undefined,
    invalidatedAt: payload && typeof payload.invalidatedAt === "string" ? payload.invalidatedAt : undefined,
    invalidationReason: payload && typeof payload.invalidationReason === "string"
      ? payload.invalidationReason
      : payload
        ? undefined
        : "Malformed legacy approval payload was quarantined.",
  };
}

function normalizeMessagePayload(payloadJson: string): ChatMessage | undefined {
  const payload = parseJson(payloadJson);
  if (!isJsonRecord(payload)
    || typeof payload.id !== "string"
    || !MESSAGE_ROLES.has(payload.role as ChatMessage["role"])
    || typeof payload.content !== "string"
    || typeof payload.createdAt !== "string") {
    return undefined;
  }
  const attachments = Array.isArray(payload.attachments)
    ? payload.attachments.flatMap((item) => {
      if (!isJsonRecord(item)
        || typeof item.path !== "string"
        || typeof item.name !== "string"
        || typeof item.mediaType !== "string"
        || typeof item.sizeBytes !== "number") return [];
      return [{
        path: item.path,
        name: item.name,
        mediaType: item.mediaType,
        sizeBytes: item.sizeBytes,
      }];
    })
    : undefined;
  return {
    id: payload.id,
    role: payload.role as ChatMessage["role"],
    content: payload.content,
    createdAt: payload.createdAt,
    attachments,
    toolName: typeof payload.toolName === "string" ? payload.toolName : undefined,
  };
}

function normalizeReviewPayload(runId: string, payloadJson: string): ReviewPacketView | undefined {
  const payload = parseJson(payloadJson);
  if (!isJsonRecord(payload)) return undefined;
  const validGate = REVIEW_GATES.has(payload.gate as ReviewPacketView["gate"]);
  const claims = Array.isArray(payload.claims)
    ? payload.claims.flatMap((item) => {
      if (!isJsonRecord(item)
        || typeof item.id !== "string"
        || typeof item.claim !== "string"
        || !CLAIM_STATUSES.has(item.status as ReviewPacketView["claims"][number]["status"])) return [];
      return [{
        id: item.id,
        claim: item.claim,
        evidence: stringArray(item.evidence),
        status: item.status as ReviewPacketView["claims"][number]["status"],
      }];
    })
    : [];
  const checklist = Array.isArray(payload.checklist)
    ? payload.checklist.flatMap((item) => {
      if (!isJsonRecord(item)
        || typeof item.id !== "string"
        || typeof item.label !== "string"
        || !CHECKLIST_STATUSES.has(item.status as ReviewPacketView["checklist"][number]["status"])) return [];
      return [{
        id: item.id,
        label: item.label,
        status: item.status as ReviewPacketView["checklist"][number]["status"],
      }];
    })
    : [];
  return {
    runId,
    operationId: typeof payload.operationId === "string" ? payload.operationId : undefined,
    validationPlanSha256: typeof payload.validationPlanSha256 === "string" && /^[a-f0-9]{64}$/.test(payload.validationPlanSha256)
      ? payload.validationPlanSha256
      : undefined,
    validationJournalRevision: typeof payload.validationJournalRevision === "number"
      && Number.isSafeInteger(payload.validationJournalRevision)
      && payload.validationJournalRevision >= 0
      ? payload.validationJournalRevision
      : undefined,
    packetSha256: typeof payload.packetSha256 === "string" && /^[a-f0-9]{64}$/.test(payload.packetSha256)
      ? payload.packetSha256
      : undefined,
    packetPath: typeof payload.packetPath === "string" ? payload.packetPath : undefined,
    gate: validGate ? payload.gate as ReviewPacketView["gate"] : "blocked",
    approvedAt: typeof payload.approvedAt === "string" ? payload.approvedAt : undefined,
    summary: typeof payload.summary === "string"
      ? payload.summary
      : "Malformed legacy review payload was quarantined.",
    claims,
    checklist,
    unresolvedQuestions: stringArray(payload.unresolvedQuestions),
    safetyBoundary: typeof payload.safetyBoundary === "string"
      ? payload.safetyBoundary
      : "Software validation only; the stored review payload requires manual inspection.",
  };
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

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

interface DbThread {
  id: string;
  workspace_path: string;
  title: string;
  mode: AgentThread["mode"];
  model_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToThread(row: DbThread): AgentThread {
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

function runTitle(summary?: string): string | undefined {
  const normalized = summary?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > 72 ? `${normalized.slice(0, 69)}...` : normalized;
}
