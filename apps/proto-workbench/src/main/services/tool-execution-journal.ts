import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PolicyDecision } from "../../shared/tool-policy.ts";
import { resolveToolContract } from "../../shared/tool-contracts.ts";
import { RuntimeFailure } from "./runtime-control.ts";
import type { ToolEffect } from "./tool-effects.ts";
import { validateExecutionScope, type ExecutionScope } from "./execution-scope.ts";
import { applySchemaMigrations, type SchemaMigrationReport } from "./schema-migrations.ts";

const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export interface ToolExecutionIdentity {
  operationId: string;
  scope?: ExecutionScope;
  /** Read compatibility for v1 fixtures and migration, never used by production callers. */
  runId?: string;
  tool: string;
  arguments: Record<string, unknown>;
  effect: ToolEffect;
  decisionId?: string;
  decision?: PolicyDecision;
}
export type ToolExecutionOutcome = "ok" | "tool-error";
export type ToolExecutionState = "intent" | "dispatched" | "no-effect" | "effect-unknown" | "completed" | "reconciled-applied" | "reconciled-not-applied";
export interface ToolExecutionRecord {
  operationId: string;
  /** Legacy read alias for scope.scopeId. */
  runId: string;
  scope: ExecutionScope;
  tool: string;
  capabilityId?: string;
  effect: ToolEffect;
  argumentsSha256: string;
  state: ToolExecutionState;
  outcome?: ToolExecutionOutcome;
  decisionId?: string;
  decision?: PolicyDecision;
  createdAt: string;
  updatedAt: string;
  receipt?: Record<string, unknown>;
  recoveredReceipt?: Record<string, unknown>;
}
export interface ToolReconciliation {
  id: string;
  operationId: string;
  verdict: "applied" | "not-applied";
  actor: string;
  evidenceRef: string;
  reconciledAt: string;
}
type JournalRow = {
  operation_id: string; run_id: string; scope_surface: ExecutionScope["surface"]; parent_operation_id: string | null;
  tool: string; capability_id: string | null; effect: ToolEffect; arguments_sha256: string; state: ToolExecutionState;
  recovered_receipt_json: string | null; recovered_receipt_sha256: string | null; recovered_receipt_bytes: number | null;
  outcome: ToolExecutionOutcome | null; decision_id: string | null; policy_decision_json: string | null; policy_decision_sha256: string | null;
  receipt_json: string | null; receipt_sha256: string | null; receipt_bytes: number | null; created_at: string; updated_at: string;
};
export type ToolExecutionStart = { kind: "start"; leaseId: string } | { kind: "receipt"; receipt: Record<string, unknown> };

const V1_SCHEMA = `CREATE TABLE IF NOT EXISTS tool_execution_journal (
  operation_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,tool TEXT NOT NULL,
  effect TEXT NOT NULL CHECK(effect IN ('read','write')),arguments_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('intent','dispatched','no-effect','effect-unknown','completed')),
  receipt_json TEXT,receipt_sha256 TEXT,receipt_bytes INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);`;
// Rebuild is necessary because SQLite cannot widen the v1 CHECK constraint.
// Receipt bytes and hashes are copied verbatim; legacy outcome is deliberately
// unknown because v1 discarded the MCP isError envelope.
const V2_SCHEMA = `CREATE TABLE tool_execution_journal_v2 (
  operation_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,scope_surface TEXT NOT NULL,parent_operation_id TEXT,
  tool TEXT NOT NULL,effect TEXT NOT NULL CHECK(effect IN ('read','write')),arguments_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('intent','dispatched','no-effect','effect-unknown','completed','reconciled-applied','reconciled-not-applied')),
  outcome TEXT CHECK(outcome IN ('ok','tool-error')),decision_id TEXT,policy_decision_json TEXT,policy_decision_sha256 TEXT,
  receipt_json TEXT,receipt_sha256 TEXT,receipt_bytes INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
INSERT INTO tool_execution_journal_v2(operation_id,run_id,scope_surface,tool,effect,arguments_sha256,state,receipt_json,receipt_sha256,receipt_bytes,created_at,updated_at)
  SELECT operation_id,run_id,'legacy',tool,effect,arguments_sha256,state,receipt_json,receipt_sha256,receipt_bytes,created_at,updated_at FROM tool_execution_journal;
DROP TABLE tool_execution_journal;
ALTER TABLE tool_execution_journal_v2 RENAME TO tool_execution_journal;
CREATE INDEX tool_execution_journal_scope_updated ON tool_execution_journal(scope_surface,run_id,updated_at);
CREATE TABLE tool_execution_reconciliations(
  id TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES tool_execution_journal(operation_id),
  verdict TEXT NOT NULL CHECK(verdict IN ('applied','not-applied')),actor TEXT NOT NULL,evidence_ref TEXT NOT NULL,reconciled_at TEXT NOT NULL
);
CREATE INDEX tool_execution_reconciliations_operation ON tool_execution_reconciliations(operation_id,reconciled_at);
CREATE TRIGGER tool_execution_reconciliations_no_update BEFORE UPDATE ON tool_execution_reconciliations BEGIN SELECT RAISE(ABORT,'Reconciliation history is append-only'); END;
CREATE TRIGGER tool_execution_reconciliations_no_delete BEFORE DELETE ON tool_execution_reconciliations BEGIN SELECT RAISE(ABORT,'Reconciliation history is append-only'); END;`;

/** Host-owned durable execution evidence shared by MCP and other backends. */
export class ToolExecutionJournal {
  private readonly db: DatabaseSync;
  private readonly active = new Map<string, string>();
  readonly migrationReport: SchemaMigrationReport;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.migrationReport = applySchemaMigrations(db, "tool-execution-journal", [
      { version: 1, sql: V1_SCHEMA }, { version: 2, sql: V2_SCHEMA },
      { version: 3, sql: `ALTER TABLE tool_execution_journal ADD COLUMN capability_id TEXT;
        ALTER TABLE tool_execution_journal ADD COLUMN recovered_receipt_json TEXT;
        ALTER TABLE tool_execution_journal ADD COLUMN recovered_receipt_sha256 TEXT;
        ALTER TABLE tool_execution_journal ADD COLUMN recovered_receipt_bytes INTEGER;` },
    ]);
    for (const row of db.prepare("SELECT DISTINCT tool FROM tool_execution_journal WHERE capability_id IS NULL").all() as Array<{tool:string}>) {
      const capabilityId = resolveToolContract(row.tool)?.capabilityId;
      if (capabilityId) db.prepare("UPDATE tool_execution_journal SET capability_id=? WHERE tool=? AND capability_id IS NULL").run(capabilityId,row.tool);
    }
  }

  begin(identity: ToolExecutionIdentity): ToolExecutionStart {
    const scope = this.validateIdentity(identity), argumentsSha256 = digest(stableJson(identity.arguments));
    const current = this.row(identity.operationId);
    if (!current) {
      const at = new Date().toISOString(), decision = identity.decision ? serializeReceipt(identity.decision as unknown as Record<string, unknown>) : null;
      this.db.prepare(`INSERT INTO tool_execution_journal
        (operation_id,run_id,scope_surface,parent_operation_id,tool,capability_id,effect,arguments_sha256,state,decision_id,policy_decision_json,policy_decision_sha256,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'intent',?,?,?,?,?)`).run(identity.operationId, scope.scopeId, scope.surface, scope.parentOperationId ?? null,
          identity.tool, resolveToolContract(identity.tool)?.capabilityId ?? null, identity.effect, argumentsSha256, identity.decisionId ?? identity.decision?.decisionId ?? null, decision, decision ? digest(decision) : null, at, at);
      return this.acquire(identity.operationId);
    }
    if (current.run_id !== scope.scopeId || current.scope_surface !== scope.surface || (current.parent_operation_id ?? undefined) !== scope.parentOperationId
      || current.tool !== identity.tool || current.effect !== identity.effect || current.arguments_sha256 !== argumentsSha256) {
      throw new RuntimeFailure("TOOL_OPERATION_CONFLICT", "tool-execution-journal", "The operation ID is already bound to a different scope, tool, effect, or arguments.");
    }
    if (current.state === "completed" || (current.state === "no-effect" && current.receipt_json)) return { kind: "receipt", receipt: this.receipt(current) };
    if (current.state === "effect-unknown") throw unknownEffect(identity.operationId, current.tool);
    if (current.state.startsWith("reconciled-")) throw Object.assign(new Error("A reconciled operation is final. Start an explicit new operation if a retry is needed."), { code: "TOOL_OPERATION_RECONCILED", effectState: current.state === "reconciled-not-applied" ? "none" : "unknown" });
    if (this.active.has(identity.operationId)) throw inProgress(identity.operationId, current.tool);
    if (current.state === "dispatched" && current.effect === "write") {
      this.setUnknown(current);
      throw unknownEffect(identity.operationId, current.tool);
    }
    this.db.prepare(`UPDATE tool_execution_journal SET state='intent',outcome=NULL,receipt_json=NULL,receipt_sha256=NULL,receipt_bytes=NULL,updated_at=?
      WHERE operation_id=? AND state IN ('intent','dispatched','no-effect')`).run(new Date().toISOString(), identity.operationId);
    return this.acquire(identity.operationId);
  }

  markDispatched(identity: ToolExecutionIdentity, leaseId: string): void {
    this.assertLease(identity, leaseId);
    const changed = this.db.prepare(`UPDATE tool_execution_journal SET state='dispatched',updated_at=? WHERE operation_id=? AND state='intent'`)
      .run(new Date().toISOString(), identity.operationId);
    if (Number(changed.changes) !== 1) throw new Error("TOOL_EXECUTION_JOURNAL_CONFLICT");
  }

  complete(identity: ToolExecutionIdentity, leaseId: string, receipt: Record<string, unknown>): void {
    this.assertLease(identity, leaseId);
    const effectState = receiptEffectState(receipt), outcome = receiptOutcome(receipt);
    if (effectState === "unknown" && identity.effect === "write") {
      this.setUnknown(this.requiredRow(identity.operationId), receipt, outcome);
      this.active.delete(identity.operationId);
      return;
    }
    this.finish(identity, leaseId, effectState === "none" ? "no-effect" : "completed", receipt, outcome);
  }

  /** Explicit server no-effect acknowledgement may settle a dispatched write. */
  markNoEffect(identity: ToolExecutionIdentity, leaseId: string, confirmed = false, receipt?: Record<string, unknown>): void {
    this.assertLease(identity, leaseId);
    const current = this.requiredRow(identity.operationId);
    if (current.state === "dispatched" && current.effect === "write" && !confirmed) throw new Error("TOOL_NO_EFFECT_NOT_CONFIRMED");
    this.finish(identity, leaseId, "no-effect", receipt, receipt ? receiptOutcome(receipt) : undefined);
  }

  markUnknown(identity: ToolExecutionIdentity, leaseId: string, observedReceipt?: Record<string, unknown>): void {
    this.assertLease(identity, leaseId);
    this.setUnknown(this.requiredRow(identity.operationId), observedReceipt, observedReceipt ? receiptOutcome(observedReceipt) : undefined);
    this.active.delete(identity.operationId);
  }

  get(operationId: string): ToolExecutionRecord | undefined {
    let row = this.row(operationId);
    if (!row) return undefined;
    if (row.state === "dispatched" && !this.active.has(operationId)) {
      if (row.effect === "write") this.setUnknown(row);
      else this.db.prepare("UPDATE tool_execution_journal SET state='no-effect',updated_at=? WHERE operation_id=? AND state='dispatched'").run(new Date().toISOString(), operationId);
      row = this.requiredRow(operationId);
    }
    return this.record(row);
  }

  list(scope: ExecutionScope): ToolExecutionRecord[] {
    validateExecutionScope(scope);
    const rows = this.db.prepare("SELECT operation_id FROM tool_execution_journal WHERE scope_surface=? AND run_id=? ORDER BY created_at,operation_id").all(scope.surface, scope.scopeId) as Array<{ operation_id: string }>;
    return rows.map(row => this.get(row.operation_id)!);
  }

  listPage(filter: {surface?: ExecutionScope["surface"];scopeId?: string;state?: ToolExecutionState;limit?: number;offset?: number} = {}): {records:ToolExecutionRecord[];total:number;unknownEffects:number} {
    const limit=filter.limit??100,offset=filter.offset??0;
    if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(offset)||offset<0) throw new Error("TOOL_JOURNAL_PAGE_INVALID");
    this.recoverOrphanedDispatches();
    const where:string[]=[],values:string[]=[];
    if(filter.surface){validateExecutionScope({surface:filter.surface,scopeId:filter.scopeId??"query"});where.push("scope_surface=?");values.push(filter.surface);}
    if(filter.scopeId){if(!IDENTIFIER.test(filter.scopeId))throw new Error("TOOL_EXECUTION_SCOPE_INVALID");where.push("run_id=?");values.push(filter.scopeId);}
    if(filter.state){if(!["intent","dispatched","no-effect","effect-unknown","completed","reconciled-applied","reconciled-not-applied"].includes(filter.state))throw new Error("TOOL_JOURNAL_STATE_INVALID");where.push("state=?");values.push(filter.state);}
    const predicate=where.length?` WHERE ${where.join(" AND ")}`:"";
    const total=Number((this.db.prepare(`SELECT COUNT(*) AS count FROM tool_execution_journal${predicate}`).get(...values) as {count:number}).count);
    const rows=this.db.prepare(`SELECT operation_id,run_id,scope_surface,parent_operation_id,tool,capability_id,effect,arguments_sha256,state,outcome,decision_id,created_at,updated_at FROM tool_execution_journal${predicate} ORDER BY updated_at DESC,operation_id LIMIT ? OFFSET ?`).all(...values,limit,offset) as JournalRow[];
    return {records:rows.map(row=>this.record(row,false)),total,unknownEffects:this.recoverySummary().unknownEffects};
  }

  recoverySummary(): {unknownEffects:number;total:number} {
    this.recoverOrphanedDispatches();
    const counts=this.db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN state='effect-unknown' THEN 1 ELSE 0 END) AS unknownEffects FROM tool_execution_journal").get() as {total:number;unknownEffects:number|null};
    return {total:Number(counts.total),unknownEffects:Number(counts.unknownEffects??0)};
  }

  private recoverOrphanedDispatches():void {
    const rows=this.db.prepare("SELECT operation_id,effect FROM tool_execution_journal WHERE state='dispatched'").all() as Array<{operation_id:string;effect:ToolEffect}>;
    for(const row of rows) if(!this.active.has(row.operation_id)) this.db.prepare("UPDATE tool_execution_journal SET state=?,updated_at=? WHERE operation_id=? AND state='dispatched'").run(row.effect==="write"?"effect-unknown":"no-effect",new Date().toISOString(),row.operation_id);
  }

  /** A verified recovery receipt supplements rather than overwrites the original observation. */
  recordReconciledReceipt(operationId:string,receipt:Record<string,unknown>):ToolExecutionRecord {
    const row=this.requiredRow(operationId),payload=serializeReceipt(receipt);
    if(row.state!=="reconciled-applied"||this.active.has(operationId))throw new Error("TOOL_RECOVERY_RECEIPT_REQUIRES_RECONCILIATION");
    if(receiptEffectState(receipt)!==undefined)throw new Error("TOOL_RECOVERY_RECEIPT_EFFECT_CONFLICT");
    if(row.recovered_receipt_json&&row.recovered_receipt_json!==payload)throw new Error("TOOL_RECOVERY_RECEIPT_CONFLICT");
    this.db.prepare("UPDATE tool_execution_journal SET recovered_receipt_json=?,recovered_receipt_sha256=?,recovered_receipt_bytes=?,outcome=?,updated_at=? WHERE operation_id=? AND state='reconciled-applied'")
      .run(payload,digest(payload),Buffer.byteLength(payload),receiptOutcome(receipt),new Date().toISOString(),operationId);
    return this.get(operationId)!;
  }

  reconcile(operationId: string, verdict: "applied" | "not-applied", actor: string, evidenceRef: string): ToolExecutionRecord {
    if (!IDENTIFIER.test(operationId) || !["applied", "not-applied"].includes(verdict)
      || typeof actor !== "string" || !actor.trim() || actor.length > 256
      || typeof evidenceRef !== "string" || !evidenceRef.trim() || evidenceRef.length > 4096) throw new Error("TOOL_RECONCILIATION_INVALID");
    if (this.active.has(operationId)) throw inProgress(operationId, this.requiredRow(operationId).tool);
    this.get(operationId); // Recover an orphaned dispatch before applying the verdict.
    this.db.exec("SAVEPOINT tool_reconcile");
    try {
      const at = new Date().toISOString();
      const changed = this.db.prepare("UPDATE tool_execution_journal SET state=?,updated_at=? WHERE operation_id=? AND state='effect-unknown'")
        .run(`reconciled-${verdict}`, at, operationId);
      if (Number(changed.changes) !== 1) throw new Error("TOOL_RECONCILIATION_REQUIRES_UNKNOWN_EFFECT");
      this.db.prepare("INSERT INTO tool_execution_reconciliations(id,operation_id,verdict,actor,evidence_ref,reconciled_at) VALUES(?,?,?,?,?,?)")
        .run(randomUUID(), operationId, verdict, actor.trim(), evidenceRef.trim(), at);
      this.db.exec("RELEASE tool_reconcile");
    } catch (error) { this.db.exec("ROLLBACK TO tool_reconcile; RELEASE tool_reconcile"); throw error; }
    return this.get(operationId)!;
  }

  reconciliationHistory(operationId: string): ToolReconciliation[] {
    return this.db.prepare(`SELECT id,operation_id AS operationId,verdict,actor,evidence_ref AS evidenceRef,reconciled_at AS reconciledAt
      FROM tool_execution_reconciliations WHERE operation_id=? ORDER BY reconciled_at,id`).all(operationId) as unknown as ToolReconciliation[];
  }

  private finish(identity: ToolExecutionIdentity, leaseId: string, state: "completed" | "no-effect", receipt?: Record<string, unknown>, outcome?: ToolExecutionOutcome): void {
    this.assertLease(identity, leaseId);
    const payload = receipt ? serializeReceipt(receipt) : null;
    const changed = this.db.prepare(`UPDATE tool_execution_journal SET state=?,outcome=?,receipt_json=?,receipt_sha256=?,receipt_bytes=?,updated_at=?
      WHERE operation_id=? AND state IN ('intent','dispatched')`).run(state, outcome ?? null, payload, payload ? digest(payload) : null,
        payload ? Buffer.byteLength(payload) : null, new Date().toISOString(), identity.operationId);
    if (Number(changed.changes) !== 1) throw new Error("TOOL_EXECUTION_JOURNAL_CONFLICT");
    this.active.delete(identity.operationId);
  }

  private record(row: JournalRow,includeReceipt=true): ToolExecutionRecord {
    if (row.policy_decision_json && digest(row.policy_decision_json) !== row.policy_decision_sha256) throw new Error("TOOL_POLICY_DECISION_DIGEST_MISMATCH");
    return {
      operationId: row.operation_id, runId: row.run_id,
      scope: { surface: row.scope_surface, scopeId: row.run_id, ...(row.parent_operation_id ? { parentOperationId: row.parent_operation_id } : {}) },
      tool: row.tool, effect: row.effect, argumentsSha256: row.arguments_sha256, state: row.state,
      ...(row.capability_id??resolveToolContract(row.tool)?.capabilityId ? {capabilityId:row.capability_id??resolveToolContract(row.tool)!.capabilityId}:{}),
      createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.outcome ? { outcome: row.outcome } : {}), ...(row.decision_id ? { decisionId: row.decision_id } : {}),
      ...(row.policy_decision_json ? { decision: JSON.parse(row.policy_decision_json) as PolicyDecision } : {}),
      ...(includeReceipt&&row.receipt_json ? { receipt: this.receipt(row) } : {}),
      ...(includeReceipt&&row.recovered_receipt_json ? {recoveredReceipt:this.receipt({...row,receipt_json:row.recovered_receipt_json,receipt_sha256:row.recovered_receipt_sha256,receipt_bytes:row.recovered_receipt_bytes})}:{}),
    };
  }
  private acquire(operationId: string): ToolExecutionStart {
    const leaseId = randomUUID(); this.active.set(operationId, leaseId); return { kind: "start", leaseId };
  }
  private assertLease(identity: ToolExecutionIdentity, leaseId: string): void {
    if (this.active.get(identity.operationId) !== leaseId) throw new Error("TOOL_EXECUTION_JOURNAL_LEASE_LOST");
  }
  private row(operationId: string): JournalRow | undefined {
    return this.db.prepare("SELECT * FROM tool_execution_journal WHERE operation_id=?").get(operationId) as JournalRow | undefined;
  }
  private requiredRow(operationId: string): JournalRow {
    const row = this.row(operationId); if (!row) throw new Error("TOOL_EXECUTION_JOURNAL_ENTRY_MISSING"); return row;
  }
  private receipt(row: JournalRow): Record<string, unknown> {
    if (!row.receipt_json || !row.receipt_sha256 || row.receipt_bytes === null || Buffer.byteLength(row.receipt_json) !== row.receipt_bytes
      || digest(row.receipt_json) !== row.receipt_sha256) throw new Error("TOOL_EXECUTION_RECEIPT_DIGEST_MISMATCH");
    const value: unknown = JSON.parse(row.receipt_json);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("TOOL_EXECUTION_RECEIPT_INVALID");
    return value as Record<string, unknown>;
  }
  private setUnknown(row: JournalRow, receipt?: Record<string, unknown>, outcome?: ToolExecutionOutcome): void {
    const payload = receipt ? serializeReceipt(receipt) : null;
    this.db.prepare(`UPDATE tool_execution_journal SET state='effect-unknown',outcome=?,receipt_json=?,receipt_sha256=?,receipt_bytes=?,updated_at=?
      WHERE operation_id=? AND state IN ('intent','dispatched','effect-unknown')`).run(outcome ?? null, payload, payload ? digest(payload) : null,
        payload ? Buffer.byteLength(payload) : null, new Date().toISOString(), row.operation_id);
  }
  private validateIdentity(identity: ToolExecutionIdentity): ExecutionScope {
    const scope: ExecutionScope = identity.scope ?? { surface: "legacy", scopeId: identity.runId ?? "" };
    validateExecutionScope(scope);
    if (!IDENTIFIER.test(identity.operationId) || !/^[a-z][a-z0-9_.]{0,127}$/.test(identity.tool)
      || !["read", "write"].includes(identity.effect) || !identity.arguments || typeof identity.arguments !== "object" || Array.isArray(identity.arguments)
      || (identity.decisionId !== undefined && !IDENTIFIER.test(identity.decisionId))) throw new Error("TOOL_EXECUTION_IDENTITY_INVALID");
    return scope;
  }
}

export function receiptOutcome(receipt: Record<string, unknown>): ToolExecutionOutcome {
  const structured = object(receipt.structuredContent), data = object(receipt.data);
  return receipt.isError === true || receipt.ok === false || structured?.ok === false || data?.ok === false
    || ["failed", "error", "unverifiable", "incomplete"].includes(String(data?.status ?? structured?.status ?? receipt.status ?? "")) ? "tool-error" : "ok";
}
export function receiptEffectState(receipt: Record<string, unknown>): "none" | "unknown" | undefined {
  const value = receipt.effect_state ?? object(receipt.structuredContent)?.effect_state ?? object(receipt.data)?.effect_state;
  return value === "none" || value === "unknown" ? value : undefined;
}
/** Shared terminal category for Chat, Harness and other activity projections. */
export function executionActivityState(record: ToolExecutionRecord): "running" | "complete" | "error" | "effect-unknown" {
  if (record.state === "effect-unknown") return "effect-unknown";
  if (record.state === "intent" || record.state === "dispatched") return "running";
  if (record.state === "reconciled-not-applied") return "error";
  if (record.state === "reconciled-applied" && (!record.recoveredReceipt || receiptOutcome(record.recoveredReceipt) !== "ok" || receiptEffectState(record.recoveredReceipt) !== undefined)) return "error";
  return record.outcome === "ok" ? "complete" : "error";
}
function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function serializeReceipt(receipt: Record<string, unknown>): string {
  const payload = JSON.stringify(receipt);
  if (typeof payload !== "string" || Buffer.byteLength(payload) > MAX_RECEIPT_BYTES) throw new Error("TOOL_EXECUTION_RECEIPT_LIMIT");
  return payload;
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") { const obj = value as Record<string, unknown>; return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(",")}}`; }
  return JSON.stringify(value) ?? "null";
}
function unknownEffect(operationId: string, tool: string): RuntimeFailure {
  return new RuntimeFailure("TOOL_EFFECT_UNKNOWN", "tool-execution-recovery", `The prior ${tool} operation ${operationId} may have taken effect. Reconcile its durable record before starting a new operation.`, { effectState: "unknown" });
}
function inProgress(operationId: string, tool: string): RuntimeFailure {
  return new RuntimeFailure("TOOL_OPERATION_IN_PROGRESS", "tool-execution-journal", `The ${tool} operation ${operationId} already has an active owner.`);
}
