import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { HarnessCheckpoint, HarnessProjection, ToolResultEnvelope } from "../../shared/harness.ts";

const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export interface HarnessSourceOperation {
  schema: "proto-workbench.harness-source-operation.v1";
  tool: "workspace_propose_patch" | "workspace_resume_validation";
  runId: string; callId: string; phase: "prewrite" | "prepared" | "applying" | "receipt";
  patchId?: string; operationId?: string; targetPath?: string;
  baseSha256?: string; resultSha256?: string;
  receipt?: Record<string, unknown>;
}

/** SQLite transactions bind the full execution state; projections never authorize effects. */
export class HarnessStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS harness_executions (run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, workspace_path TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, sha256 TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS harness_results (handle TEXT PRIMARY KEY, run_id TEXT NOT NULL, call_id TEXT NOT NULL, tool TEXT NOT NULL, payload TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, UNIQUE(run_id,call_id));
      CREATE TABLE IF NOT EXISTS harness_effects (run_id TEXT NOT NULL, call_id TEXT NOT NULL, tool TEXT NOT NULL, arguments_json TEXT NOT NULL, effect TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(run_id,call_id));
      CREATE TABLE IF NOT EXISTS harness_source_operations (run_id TEXT NOT NULL, call_id TEXT NOT NULL, payload TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(run_id,call_id));`);
  }
  save(checkpoint: HarnessCheckpoint): void {
    const previous = this.db.prepare("SELECT revision FROM harness_executions WHERE run_id=?").get(checkpoint.contract.runId) as { revision: number } | undefined;
    if (previous && previous.revision !== checkpoint.revision) throw new Error("HARNESS_CHECKPOINT_CONFLICT");
    const next = { ...checkpoint, revision: checkpoint.revision + 1, updatedAt: new Date().toISOString() };
    const payload = JSON.stringify(next);
    if (Buffer.byteLength(payload) > MAX_CHECKPOINT_BYTES) throw new Error("HARNESS_CHECKPOINT_LIMIT");
    const result = this.db.prepare(`INSERT INTO harness_executions VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,payload=excluded.payload,sha256=excluded.sha256,updated_at=excluded.updated_at WHERE harness_executions.revision=?`).run(next.contract.runId, next.contract.threadId, next.contract.workspacePath, next.revision, next.state, payload, digest(payload), next.updatedAt, checkpoint.revision);
    if (Number(result.changes) !== 1) throw new Error("HARNESS_CHECKPOINT_CONFLICT");
    Object.assign(checkpoint, next);
  }
  get(runId: string): HarnessCheckpoint | undefined {
    const row = this.db.prepare("SELECT payload,sha256 FROM harness_executions WHERE run_id=?").get(runId) as {payload:string;sha256:string} | undefined;
    if (!row) return undefined;
    if (digest(row.payload) !== row.sha256) throw new Error("HARNESS_CHECKPOINT_DIGEST_MISMATCH");
    return JSON.parse(row.payload) as HarnessCheckpoint;
  }
  latest(threadId: string): HarnessCheckpoint | undefined {
    const row = this.db.prepare("SELECT run_id FROM harness_executions WHERE thread_id=? ORDER BY updated_at DESC LIMIT 1").get(threadId) as {run_id:string} | undefined;
    return row ? this.get(row.run_id) : undefined;
  }
  list(workspacePath: string): HarnessProjection[] {
    return (this.db.prepare("SELECT run_id FROM harness_executions WHERE workspace_path=? ORDER BY updated_at DESC LIMIT 100").all(workspacePath) as {run_id:string}[]).map(row => this.project(this.get(row.run_id)!));
  }
  nonterminal(workspacePath: string): HarnessCheckpoint[] {
    return (this.db.prepare("SELECT run_id FROM harness_executions WHERE workspace_path=? AND state IN ('queued','preparing','generating','executing','checkpointing','validating','recovering') ORDER BY updated_at").all(workspacePath) as {run_id:string}[]).map(row => this.get(row.run_id)!);
  }
  project(c: HarnessCheckpoint): HarnessProjection {
    return {runId:c.contract.runId,threadId:c.contract.threadId,state:c.state,revision:c.revision,round:c.round,generatedTokens:c.generatedTokens,activeTimeMs:c.activeTimeMs,contextTokens:c.contract.contextTokens,resultCount:c.resultHandles.length,contextUsed:c.contextUsed,tokenCountMethod:c.tokenCountMethod,inFlightGenerationTokens:c.inFlightGenerationTokens,deliveredPaths:c.deliveredPaths,resumable:["paused","incomplete","blocked","failed","queued","preparing","validating","generating","executing","checkpointing","recovering","effect-unknown"].includes(c.state) && c.error?.code!=="OWNED_RESOURCE_CLEANUP_FAILED",error:c.error,hostRecovered:c.hostRecovered,recoveryCounters:c.recoveryCounters?{...c.recoveryCounters}:undefined,budgets:{...c.contract.budgets}};
  }
  intent(runId: string, callId: string, tool: string, args: Record<string, unknown>, effect: "read" | "write"): void {
    const payload=JSON.stringify(args);
    const existing=this.db.prepare("SELECT arguments_json,tool FROM harness_effects WHERE run_id=? AND call_id=?").get(runId,callId) as {arguments_json:string;tool:string}|undefined;
    if(existing && (existing.arguments_json!==payload || existing.tool!==tool)) throw new Error("HARNESS_CALL_ID_CONFLICT");
    this.db.prepare("INSERT OR IGNORE INTO harness_effects VALUES(?,?,?,?,?,?)").run(runId,callId,tool,payload,effect,"started");
  }
  uncertainEffect(runId: string, callId: string): boolean {
    return Boolean(this.db.prepare("SELECT call_id FROM harness_effects WHERE run_id=? AND call_id=? AND effect='write' AND state='started'").get(runId,callId));
  }
  beginSourceOperation(runId: string, callId: string, args: Record<string, unknown>, tool: HarnessSourceOperation["tool"] = "workspace_propose_patch"): void {
    this.intent(runId, callId, tool, args, "write");
    if (this.sourceOperation(runId, callId)) return;
    this.writeSourceOperation({ schema: "proto-workbench.harness-source-operation.v1", tool, runId, callId, phase: "prewrite" });
  }
  sourceOperation(runId: string, callId: string): HarnessSourceOperation | undefined {
    const row = this.db.prepare("SELECT payload,sha256 FROM harness_source_operations WHERE run_id=? AND call_id=?").get(runId, callId) as {payload: string; sha256: string} | undefined;
    if (!row) return undefined;
    if (digest(row.payload) !== row.sha256) throw new Error("HARNESS_SOURCE_OPERATION_DIGEST_MISMATCH");
    const value = JSON.parse(row.payload) as HarnessSourceOperation;
    if (value.runId !== runId || value.callId !== callId) throw new Error("HARNESS_SOURCE_OPERATION_BINDING_MISMATCH");
    return value;
  }
  bindSourceOperation(runId: string, callId: string, binding: Required<Pick<HarnessSourceOperation, "patchId" | "targetPath" | "baseSha256" | "resultSha256">>): void {
    const current = this.sourceOperation(runId, callId);
    if (!current || current.phase !== "prewrite") throw new Error("HARNESS_SOURCE_OPERATION_CONFLICT");
    this.writeSourceOperation({...current, ...binding, phase: "prepared"});
  }
  sourceMutationStarting(runId: string, callId: string): void {
    const current = this.sourceOperation(runId, callId);
    if (!current || current.phase !== "prepared") throw new Error("HARNESS_SOURCE_OPERATION_CONFLICT");
    this.writeSourceOperation({...current, phase: "applying"});
  }
  sourceOperationApplied(runId: string, callId: string, operationId: string): void {
    const current = this.sourceOperation(runId, callId);
    if (!current || current.phase !== "applying" || (current.operationId && current.operationId !== operationId)) throw new Error("HARNESS_SOURCE_OPERATION_CONFLICT");
    this.writeSourceOperation({...current, operationId});
  }
  stageSourceReceipt(runId: string, callId: string, receipt: Record<string, unknown>): void {
    const current = this.sourceOperation(runId, callId);
    if (!current || current.phase !== "applying") throw new Error("HARNESS_SOURCE_OPERATION_CONFLICT");
    this.writeSourceOperation({...current, phase: "receipt", receipt});
  }
  private writeSourceOperation(value: HarnessSourceOperation): void {
    const payload = JSON.stringify(value);
    if (Buffer.byteLength(payload) > MAX_RESULT_BYTES) throw new Error("HARNESS_SOURCE_OPERATION_LIMIT");
    this.db.prepare("INSERT INTO harness_source_operations VALUES(?,?,?,?) ON CONFLICT(run_id,call_id) DO UPDATE SET payload=excluded.payload,sha256=excluded.sha256").run(value.runId, value.callId, payload, digest(payload));
  }
  resultForCall(runId: string, callId: string): ToolResultEnvelope | undefined {
    const row=this.db.prepare("SELECT handle FROM harness_results WHERE run_id=? AND call_id=?").get(runId,callId) as {handle:string}|undefined;
    return row ? this.read(runId,row.handle) : undefined;
  }
  record(runId: string, callId: string, tool: string, data: Record<string, unknown>): ToolResultEnvelope {
    const previous=this.resultForCall(runId,callId); if(previous) return previous;
    const payload=JSON.stringify(data); const bytes=Buffer.byteLength(payload);
    if(bytes>MAX_RESULT_BYTES) throw new Error("HARNESS_RESULT_LIMIT");
    const handle=randomUUID(), sha256=digest(payload);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO harness_results VALUES(?,?,?,?,?,?,?)").run(handle,runId,callId,tool,payload,sha256,bytes);
      this.db.prepare("UPDATE harness_effects SET state='completed' WHERE run_id=? AND call_id=?").run(runId,callId);
      this.db.exec("COMMIT");
    } catch(error){this.db.exec("ROLLBACK");throw error;}
    return {schema:"proto-workbench.tool-result.v1",handle,tool,ok:data.ok!==false,sha256,bytes,data,truncated:false};
  }
  read(runId: string, handle: string): ToolResultEnvelope {
    const row=this.db.prepare("SELECT tool,payload,sha256,bytes FROM harness_results WHERE run_id=? AND handle=?").get(runId,handle) as {tool:string;payload:string;sha256:string;bytes:number}|undefined;
    if(!row) throw new Error("HARNESS_RESULT_NOT_FOUND");
    if(digest(row.payload)!==row.sha256 || Buffer.byteLength(row.payload)!==row.bytes) throw new Error("HARNESS_RESULT_DIGEST_MISMATCH");
    const data=JSON.parse(row.payload) as Record<string,unknown>;
    return {schema:"proto-workbench.tool-result.v1",handle,tool:row.tool,ok:data.ok!==false,sha256:row.sha256,bytes:row.bytes,data,truncated:false};
  }
  page(runId:string,handle:string,offset=0,limit=12_000):Record<string,unknown>{
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>24_000)throw new Error("HARNESS_RESULT_RANGE_INVALID");
    const result=this.read(runId,handle);const text=JSON.stringify(result.data);
    if(offset>text.length)throw new Error("HARNESS_RESULT_RANGE_INVALID");
    return {ok:true,handle,sha256:result.sha256,offset,content:text.slice(offset,offset+limit),next_offset:offset+limit<text.length?offset+limit:null,total_characters:text.length};
  }
}
