import { relative, resolve, isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { BlockingClass, HarnessCheckpoint, HarnessDiagnostic, MaterialBinding } from "../../shared/harness.ts";
import type { AgentRunEvent, PatchOperation, PatchProposal } from "../../shared/contracts.ts";
import type { AppDatabase } from "./database.ts";
import type { WorkspaceFiles } from "./workspace-files.ts";
import { toolDeadlineMs, type McpClient } from "./mcp-client.ts";
import { evaluateToolPolicy, issueHostPolicyGrant, rebindHostPolicyDecision } from "./permissions.ts";
import type { PolicyGrant, PolicyDecision } from "../../shared/tool-policy.ts";
import { TOOL_CONTRACTS, toolContract, toolsProducing, type ArtifactClass, type ToolContract } from "../../shared/tool-contracts.ts";
import type { HarnessStore } from "./harness-store.ts";
import { withWorkspaceWrite, withReadSlot, type WorkspaceQueueState } from "./workspace-execution-queue.ts";
import { executeHarnessStructureTool, HARNESS_STRUCTURE_TOOL_NAMES } from "./harness-structure-tools.ts";
import { inspectSourceValidation } from "./harness-source-recovery.ts";
import { verifyScientificArtifact } from "./harness-artifact-verification.ts";
import { verifyMissionDiagnostics } from "./mission-evidence.ts";
import { conflictingReceiptDiagnostics, harnessDiagnostic } from "./harness-diagnostics.ts";
import { declaredMcpToolEffect } from "./tool-effects.ts";
import { writeHarnessReconciliationProof } from "./harness-reconciliation-proof.ts";

const PARTS_TOOLS = new Set([...TOOL_CONTRACTS.values()].filter(contract => contract.preconditions.includes("material-binding")).map(contract => contract.name));
/** Only known receipt obligations have producer mappings. An unclassified
 * diagnostic remains repairable without an invented remediation promise. */
const DIAGNOSTIC_ARTIFACTS: Readonly<Record<string, ArtifactClass>> = {
  SCIENTIFIC_IR_INVALID: "compiled-design", SCIENTIFIC_COMPILATION_MISSING: "compiled-design",
  PROTEIN_COMPILE_MISSING: "compiled-design", SCIENTIFIC_EXPORT_LINEAGE_MISSING: "scientific-export",
  STRUCTURE_RECEIPT_MISSING: "structure", PROTEIN_MATERIALIZATION_MISSING: "protein-materialization",
  DNA_VALIDATION_MISSING: "design-validation", DELIVERABLE_EMPTY: "workspace-write",
  MATERIAL_REPORT_REQUIRED: "workspace-write", MATERIAL_FIELD_MISSING: "workspace-write",
  MATERIAL_HASH_MISMATCH: "workspace-write", MATERIAL_FIELD_MISMATCH: "workspace-write",
  LITERATURE_CITATION_UNBOUND: "workspace-write", LITERATURE_PROVIDER_UNCITED: "workspace-write",
  LITERATURE_CITATION_COUNT: "workspace-write",
};
/** Harness, workspace and MCP names all carry the same contract; no per-surface override. */
export const harnessToolEffect = (name: string): "read" | "write" => declaredMcpToolEffect(name);
const text = (args: Record<string, unknown>, key: string): string => {if (typeof args[key] !== "string" || !args[key]) throw new Error(`${key} must be a nonempty string`); return args[key] as string;};
const denied = (code: string, message: string) => ({ok: false, code, message, effect_state: "none"});
const artifactPaths = (value: unknown): string[] => Array.isArray(value) ? value.flatMap(item => {
  if (typeof item === "string") return [item];
  if (item && typeof item === "object" && "path" in item && typeof item.path === "string") return [item.path];
  return [];
}) : [];

/** All file mutations use the same CAS transaction as manual changes. */
export class HarnessWorkspace {
  private readonly workspace: WorkspaceFiles;
  private readonly database: AppDatabase;
  private readonly mcp: McpClient;
  private readonly store: HarnessStore;
  private readonly validate: (patch: PatchProposal, operationId: string, signal: AbortSignal) => Promise<AgentRunEvent[]>;
  private readonly publishPatch: (patch: PatchProposal) => void;
  constructor(workspace: WorkspaceFiles, database: AppDatabase, mcp: McpClient, store: HarnessStore,
    validate: (patch: PatchProposal, operationId: string, signal: AbortSignal) => Promise<AgentRunEvent[]>, publishPatch: (patch: PatchProposal) => void) {
    this.workspace = workspace; this.database = database; this.mcp = mcp; this.store = store; this.validate = validate; this.publishPatch = publishPatch;
  }

  async execute(name: string, input: Record<string, unknown>, callId: string, c: HarnessCheckpoint, signal: AbortSignal, queueState?: WorkspaceQueueState): Promise<Record<string, unknown>> {
    if (!toolContract(name)) return denied("UNKNOWN_CAPABILITY", "Unknown tools are denied by default.");
    const decision=this.policyDecision(name,input,callId,c);
    if(!decision.allowed){
      this.mcp.recordPolicyDenial?.(name,input,{operationId:callId,scope:{surface:"harness",scopeId:c.contract.runId},decision});
      return {...denied(decision.code,decision.reason),policyDecision:decision};
    }
    const sourceTool = name === "workspace_propose_patch" || name === "workspace_resume_validation";
    if (sourceTool) this.store.beginSourceOperation(c.contract.runId, callId, input, name);
    let entered = false;
    const run=async(invocationInput:Record<string,unknown>=input)=>{
    const operation = () => { entered = true; return this.executeOwned(name, invocationInput, callId, c, signal,decision); };
    try {
      return await (harnessToolEffect(name) === "write"
        ? withWorkspaceWrite(await realpath(c.contract.workspacePath), signal, operation, queueState)
        : withReadSlot(signal, operation, queueState));
    } catch (error) {
      const link = sourceTool ? this.store.sourceOperation(c.contract.runId, callId) : undefined;
      const noSourceApply = name === "workspace_propose_patch" && link?.patchId && !this.database.getPatchOperationForPatch(link.patchId);
      if (!entered || (sourceTool && (link?.phase === "prewrite" || link?.phase === "prepared" || noSourceApply))) {
        if (noSourceApply && link?.patchId) {
          const patch = this.database.getPatch(link.patchId);
          if (patch?.status === "pending") this.database.markPendingPatchStale(patch.id, patch.revision);
        }
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { effectState: "none" });
      }
      throw error;
    }
    };
    // MCP already journals its actual dispatch. Host-owned workspace/structure
    // tools use the same boundary through a local backend adapter.
    if(toolContract(name)?.surface!=="mcp"&&this.mcp.invokeLocal)return this.mcp.invokeLocal(name,input,async (mark,snapshot)=>{mark();return run(snapshot);},
      {operationId:callId,scope:{surface:"harness",scopeId:c.contract.runId},decision,decisionId:decision.decisionId});
    return run();
  }

  private policyDecision(name:string,input:Record<string,unknown>,callId:string,c:HarnessCheckpoint):PolicyDecision {
    // The saved mission contract is the existing user authorization. Its grant
    // identity is stable and the full evidence is copied into each journal row.
    const grant: PolicyGrant = issueHostPolicyGrant({id: `mission:${c.contract.runId}`, source: "mission", actor: "user",
      surface: "harness", scopeId: c.contract.runId, grantedAt: c.createdAt,
      risks: [...(c.contract.scope.network ? ["network" as const] : []), ...(c.contract.scope.execution ? ["code-execution" as const] : [])]});
    return evaluateToolPolicy({tool: name, args:input, surface: "harness", scopeId: c.contract.runId,
      operationId: callId, mode: c.contract.mode, grants: [grant]});
  }

  private async executeOwned(name: string, input: Record<string, unknown>, callId: string, c: HarnessCheckpoint, signal: AbortSignal,decision:PolicyDecision): Promise<Record<string, unknown>> {
    const args = {...input};
    if (name === "workspace_read") return {ok: true, ...await this.workspace.read(text(args, "path"))};
    if (name === "workspace_search") return {ok: true, matches: await this.workspace.search(text(args, "query"), typeof args.extension === "string" ? args.extension : undefined)};
    if (HARNESS_STRUCTURE_TOOL_NAMES.has(name)) {
      const result = await executeHarnessStructureTool(name, args, this.workspace, c.contract.workspacePath, signal);
      return {...result, _harnessArtifacts: await this.digests(artifactPaths(result.artifacts)), _harnessArguments: args};
    }
    if (PARTS_TOOLS.has(name)) {
      if (!c.contract.materialBinding) return denied("MATERIAL_BINDING_REQUIRED", "Search governed materials, materialize an eligible selection, then use its exact parts_path. The default toy library is not used for an autonomous design.");
      const binding = c.contract.materialBinding;
      const actual = await this.workspace.read(binding.partsPath);
      if (actual.sha256 !== binding.partsSha256) return denied("MATERIAL_BINDING_CHANGED", "The materialized library changed since it was bound to this task.");
      if (args.parts_path && resolve(c.contract.workspacePath, String(args.parts_path)).toLowerCase() !== actual.path.toLowerCase()) return denied("MATERIAL_BINDING_CONFLICT", "Tool arguments refer to a different library from the task binding.");
      args.parts_path = binding.partsPath;
    }
    if (name === "workspace_propose_patch") return this.apply(args, callId, c, signal);
    if (name === "workspace_resume_validation") return this.resumeValidation(args, callId, c, signal);
    for (const key of ["out", "out_dir"]) if (typeof args[key] === "string" && !this.withinRoot(c, String(args[key]), "build")) return denied("ARTIFACT_SCOPE_REQUIRED", "Generated artifacts must remain under this workspace's build directory.");
    const sourcePath = typeof args.path === "string" ? args.path : typeof args.ir_path === "string" ? args.ir_path : undefined;
    const source = sourcePath ? await this.workspace.artifactFingerprint(sourcePath).catch(() => undefined) : undefined;
    for (const key of ["path", "ir_path", "parts_path", "out", "out_dir", "manifest_path", "script", "workflow_path", "cache_dir", "registry", "fixture"]) {
      if (typeof args[key] !== "string") continue;
      const rel = relative(c.contract.workspacePath, resolve(c.contract.workspacePath, String(args[key])));
      if (rel.startsWith("..") || isAbsolute(rel)) return denied("WORKSPACE_PATH_REQUIRED", `${key} is outside the current workspace.`);
      args[key] = rel.replaceAll("\\", "/");
    }
    decision = rebindHostPolicyDecision(decision, args);
    const result = await this.mcp.call(name, args, signal, decision.requiredRisk === "network" && decision.grantId ? {runId: c.contract.runId, approvalId: decision.grantId, expiresAt: new Date(Date.now() + Math.min(10 * 60_000, c.contract.budgets.activeTimeMs - c.activeTimeMs)).toISOString()} : undefined,
      {timeoutMs: Math.max(1, Math.min(toolDeadlineMs(name, args), c.contract.budgets.activeTimeMs - c.activeTimeMs)), operationId: callId,
        scope: {surface: "harness", scopeId: c.contract.runId}, decisionId: decision.decisionId, decision});
    if (result.ok !== false && name === "proto_materials_materialize") {
      const path = text(result, "parts_path");
      const bound = await this.workspace.read(path);
      const next: MaterialBinding = {partsPath: bound.path, partsSha256: bound.sha256, snapshotId: typeof result.snapshot_id === "string" ? result.snapshot_id : undefined, selectionDigest: typeof result.selection_digest === "string" ? result.selection_digest : undefined};
      if (c.contract.materialBinding && c.contract.materialBinding.partsSha256 !== next.partsSha256 && c.deliveredPaths.some(p => p.endsWith(".proto"))) return {...result, ok: false, code: "MATERIAL_REBIND_REQUIRES_NEW_TASK", message: "Existing design outputs remain bound to the previous material snapshot."};
      c.contract.materialBinding = next;
    }
    const outputPaths = artifactPaths(result.artifacts);
    if (result.ok !== false) for (const key of name === "proto_materials_materialize" ? ["parts_path"] : name === "proto_materials_materialize_proteins" ? ["proteins_path"] : []) if (typeof result[key] === "string") outputPaths.push(String(result[key]));
    const artifacts = await this.digests(outputPaths);
    return {...result, artifacts: outputPaths, _harnessInputs: source ? {path: source.path, sha256: source.sha256, materialBinding: c.contract.materialBinding} : undefined, _harnessMaterialBinding: c.contract.materialBinding, _harnessArtifacts: artifacts, _harnessArguments: args};
  }

  private withinRoot(c: HarnessCheckpoint, path: string, root: string): boolean {
    const rel = relative(resolve(c.contract.workspacePath, root), resolve(c.contract.workspacePath, path));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }

  private async apply(args: Record<string, unknown>, callId: string, c: HarnessCheckpoint, signal: AbortSignal): Promise<Record<string, unknown>> {
    const path = text(args, "path");
    if (!c.contract.scope.writeRoots.some(root => this.withinRoot(c, path, root))) return denied("WRITE_SCOPE_REQUIRED", "The target is outside the writable roots bound at task launch.");
    const content = text(args, "content");
    if (/\.proto$/i.test(path) && !c.contract.materialBinding) return denied("MATERIAL_BINDING_REQUIRED", "Materialize eligible DNA parts before editing a design.");
    signal.throwIfAborted();
    let baseline: Awaited<ReturnType<WorkspaceFiles["read"]>> | undefined;
    try {baseline = await this.workspace.read(path);} catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as Error).message !== "Workspace file does not exist.") return denied("BASELINE_UNREADABLE", "The target could not be inspected safely. No file was changed.");
    }
    if (baseline) {
      let observedDigest: string | undefined;
      for (const handle of [...c.resultHandles].reverse()) {
        const result = this.store.read(c.contract.runId, handle);
        if (result.tool === "workspace_read" && result.ok && String(result.data.path).toLowerCase() === baseline.path.toLowerCase()) {
          observedDigest = String(result.data.sha256); break;
        }
        const validation = result.data.validation as {source?: string; sha256?: string} | undefined;
        if (["workspace_propose_patch", "workspace_resume_validation"].includes(result.tool) && result.data.effect_state === "committed" && validation?.source?.toLowerCase() === baseline.path.toLowerCase()) {
          observedDigest = validation.sha256; break;
        }
      }
      if (!observedDigest) return denied("BASELINE_READ_REQUIRED", "Read the existing target through workspace_read before replacing it. No file was changed.");
      if (observedDigest !== baseline.sha256 || (typeof args.expected_sha256 === "string" && args.expected_sha256 !== baseline.sha256)) return denied("BASELINE_CHANGED", "The target changed after the model's last bound read or committed edit. Read it again and rebase the change; no file was changed.");
    }
    const patch = await this.workspace.proposePatch({runId: c.contract.runId, targetPath: path, after: content, rationale: text(args, "rationale")});
    if (patch.baseExists !== Boolean(baseline) || (baseline && patch.baseSha256 !== baseline.sha256)) {
      this.database.markPendingPatchStale(patch.id, patch.revision);
      return denied("BASELINE_CHANGED", "The target changed while the patch was being prepared. Read it again before retrying.");
    }
    patch.materialBinding = c.contract.materialBinding;
    this.database.savePatch(patch);
    // The patch ID is durable before applyApprovedPatch creates its own durable
    // operation and before its CAS filesystem effect. Recovery follows this exact
    // patch ID, never a best-effort search by a coincidentally matching filename.
    this.store.bindSourceOperation(c.contract.runId, callId, {patchId: patch.id, targetPath: patch.targetPath, baseSha256: patch.baseSha256, resultSha256: createHash("sha256").update(patch.after).digest("hex")});
    signal.throwIfAborted();
    this.store.sourceMutationStarting(c.contract.runId, callId);
    const applied = await this.workspace.applyApprovedPatch(patch.id, patch.revision);
    this.store.sourceOperationApplied(c.contract.runId, callId, applied.operation.id);
    this.publishPatch(applied.patch);
    const validating = this.database.beginPatchValidation(applied.operation.id, applied.operation.revision);
    const events = await this.validate(applied.patch, validating.id, signal);
    const failures = events.filter(event => !["completed", "approved"].includes(event.status));
    const current = await this.workspace.assertOperationResultCurrent(validating.id);
    if (current.state !== "validating" || current.revision !== validating.revision) throw new Error("PATCH_CHANGED_DURING_VALIDATION");
    const operation = this.database.finishPatchValidation(validating.id, validating.revision, failures.length === 0, failures.map(e => e.summary).join("; ") || undefined);
    const after = await this.workspace.read(applied.patch.targetPath);
    const artifacts = [...new Set([after.path, ...events.flatMap(e => e.outputArtifacts)])];
    if (!c.deliveredPaths.includes(after.path)) c.deliveredPaths.push(after.path);
    const result = {ok: failures.length === 0, effect_state: "committed", patch: applied.patch, operation, artifacts, diagnostics: failures.map(e => ({code: "PATCH_VALIDATION_FAILED", message: e.summary})), validation: {source: after.path, sha256: after.sha256, materialBinding: patch.materialBinding, ok: failures.length === 0, steps: events.map(e => ({tool: e.tool, status: e.status}))}, _harnessArtifacts: await this.digests(artifacts)};
    this.store.stageSourceReceipt(c.contract.runId, callId, result);
    return result;
  }

  /** Inspect committed state only; no source or artifact write is replayed. */
  async reconcile(name: string, _args: Record<string, unknown>, callId: string, c: HarnessCheckpoint, signal: AbortSignal, queueState?: WorkspaceQueueState): Promise<Record<string, unknown> | undefined> {
    const journal=this.mcp.executionJournal?.(),record=journal?.get(callId);
    if(record&&(record.scope.surface!=="harness"||record.scope.scopeId!==c.contract.runId||record.tool!==name))throw new Error("HARNESS_JOURNAL_SCOPE_MISMATCH");
    if(record?.recoveredReceipt)return record.recoveredReceipt;
    if(record?.state==="reconciled-not-applied")return denied("TOOL_RECONCILED_NOT_APPLIED","The operation was inspected and did not apply. Any retry needs a new operation ID.");
    const receipt=await this.reconcileSource(name,_args,callId,c,signal,queueState);
    if(receipt&&journal&&record?.state==="effect-unknown"){
      const link=this.store.sourceOperation(c.contract.runId,callId),verdict=receipt.effect_state==="none"?"not-applied":"applied";
      const evidenceRef=await writeHarnessReconciliationProof(c.contract.workspacePath,{operationId:callId,runId:c.contract.runId,tool:name,verdict,
        actor:"harness-source-recovery",observedAt:new Date().toISOString(),patchOperationId:link?.operationId,patchId:link?.patchId,sourcePath:link?.targetPath,
        sourceSha256:link?.resultSha256,receipt});
      this.mcp.reconcileExecution(callId,verdict,"harness-source-recovery",evidenceRef);
      if(verdict==="applied")journal.recordReconciledReceipt(callId,receipt);
    }
    return receipt;
  }

  private async reconcileSource(name: string, _args: Record<string, unknown>, callId: string, c: HarnessCheckpoint, signal: AbortSignal, queueState?: WorkspaceQueueState): Promise<Record<string, unknown> | undefined> {
    if (name !== "workspace_propose_patch" && name !== "workspace_resume_validation") return undefined;
    return withWorkspaceWrite(await realpath(c.contract.workspacePath), signal, async () => {
      const link = this.store.sourceOperation(c.contract.runId, callId);
      if (!link || link.tool !== name) return undefined;
      if (link.phase === "prewrite") return denied("SOURCE_WRITE_NOT_STARTED", "The interrupted call never started a source or validation effect. Retry as a new call if still required.");
      const patch = link.patchId ? this.database.getPatch(link.patchId) : undefined;
      if (!patch || patch.runId !== c.contract.runId || patch.targetPath !== link.targetPath || patch.baseSha256 !== link.baseSha256 || createHash("sha256").update(patch.after).digest("hex") !== link.resultSha256) return undefined;
      let operation = this.database.getPatchOperationForPatch(patch.id);
      if (!operation) {
        if (name !== "workspace_propose_patch" || patch.status !== "pending") return undefined;
        this.database.markPendingPatchStale(patch.id, patch.revision);
        return denied("SOURCE_WRITE_NOT_STARTED", "No durable apply operation exists. The obsolete proposal was invalidated without replaying it.");
      }
      if ((link.operationId && link.operationId !== operation.id) || operation.runId !== c.contract.runId || operation.targetPath !== link.targetPath || operation.resultSha256 !== link.resultSha256) return undefined;
      operation = await this.workspace.reconcilePatchOperation(operation.id, operation.revision);
      if (operation.state === "prepared" && !operation.appliedAt && name === "workspace_propose_patch") {
        this.database.markPendingPatchStale(patch.id, patch.revision);
        this.database.db.prepare("UPDATE patch_operations SET active=0 WHERE id=? AND run_id=? AND revision=? AND state='prepared'").run(operation.id, c.contract.runId, operation.revision);
        return denied("SOURCE_WRITE_NOT_RETAINED", "The source matches the original base. The obsolete intent was retired without replaying it.");
      }
      if (!["applied", "validation-failed", "verified"].includes(operation.state)) return undefined;
      const current = await this.currentSource(patch, operation, c);
      if (!current) return undefined;
      if (link.receipt) {
        const recorded = link.receipt._harnessArtifacts as Array<{path: string; sha256: string}> | undefined;
        if (!recorded?.length) return undefined;
        for (const artifact of recorded) {
          const actual = await this.workspace.artifactFingerprint(artifact.path).catch(() => undefined);
          if (actual?.sha256 !== artifact.sha256) return undefined;
        }
        return {...link.receipt, recovered: true, recovery: "exact durable source and artifact receipts reopened"};
      }
      const inspection = inspectSourceValidation(patch, operation, this.database.getValidationJournal(operation.id), id => this.database.getRunEvent(id));
      if (!inspection.safe) return undefined;
      if (!inspection.complete) return {ok: false, effect_state: "committed", code: "SOURCE_VALIDATION_INCOMPLETE", operation_id: operation.id, source: current.path, sha256: current.sha256, message: "The exact source is retained. Continue its existing journal with workspace_resume_validation; do not reapply the source.", resume_tool: "workspace_resume_validation", resume_arguments: {operation_id: operation.id}};
      const provenance = await this.reopenProvenance(patch, inspection.events, c, signal);
      if (provenance === false) return undefined;
      if (!await this.currentSource(patch, operation, c)) return undefined;
      if (operation.state !== "verified") {
        const validating = this.database.beginPatchValidation(operation.id, operation.revision);
        operation = this.database.finishPatchValidation(validating.id, validating.revision, true);
      }
      return this.sourceValidationReceipt(patch, operation, inspection.events, current, provenance);
    }, queueState);
  }

  private async resumeValidation(args: Record<string, unknown>, callId: string, c: HarnessCheckpoint, signal: AbortSignal): Promise<Record<string, unknown>> {
    let operation = this.database.getPatchOperation(text(args, "operation_id"));
    const patch = operation ? this.database.getPatch(operation.patchId) : undefined;
    if (!operation || !patch || operation.runId !== c.contract.runId || patch.runId !== c.contract.runId) return denied("VALIDATION_RUN_MISMATCH", "Only this mission's existing source operation can be resumed.");
    if (!c.contract.scope.writeRoots.some(root => this.withinRoot(c, patch.targetPath, root))) return denied("WRITE_SCOPE_REQUIRED", "The operation is outside this mission's writable scope.");
    if (c.activeTimeMs >= c.contract.budgets.activeTimeMs || c.generatedTokens >= c.contract.budgets.maxGeneratedTokens || c.round >= c.contract.budgets.maxRounds) return denied("TASK_BUDGET_EXHAUSTED", "Validation continuation requires remaining mission budget.");
    signal.throwIfAborted();
    if (!await this.currentSource(patch, operation, c)) return denied("VALIDATION_INPUT_CHANGED", "The source or bound material library changed. Rebase through a new source transaction.");
    operation = await this.workspace.reconcilePatchOperation(operation.id, operation.revision);
    if (!["applied", "validation-failed", "verified"].includes(operation.state)) return denied("VALIDATION_OPERATION_NOT_READY", "The source effect has not been established; validation will not apply it.");
    const inspection = inspectSourceValidation(patch, operation, this.database.getValidationJournal(operation.id), id => this.database.getRunEvent(id));
    if (!inspection.safe) return denied("VALIDATION_EFFECT_UNKNOWN", inspection.reason ?? "Validation evidence is ambiguous; no step was replayed.");
    if (await this.reopenProvenance(patch, inspection.events, c, signal) === false) return denied("VALIDATION_ARTIFACT_CHANGED", "Completed workflow artifacts no longer match their provenance. They were not overwritten.");
    this.store.bindSourceOperation(c.contract.runId, callId, {patchId: patch.id, targetPath: patch.targetPath, baseSha256: patch.baseSha256, resultSha256: operation.resultSha256});
    signal.throwIfAborted();
    this.store.sourceMutationStarting(c.contract.runId, callId);
    this.store.sourceOperationApplied(c.contract.runId, callId, operation.id);
    let events = inspection.events;
    if (!inspection.complete) {
      if (operation.state === "verified") return denied("VALIDATION_JOURNAL_MISSING", "A verified source operation lost its validation journal.");
      operation = this.database.beginPatchValidation(operation.id, operation.revision);
      events = await this.validate(patch, operation.id, signal);
      const latest = await this.workspace.assertOperationResultCurrent(operation.id);
      if (latest.state !== "validating" || latest.revision !== operation.revision) throw new Error("PATCH_CHANGED_DURING_VALIDATION");
      const failures = events.filter(event => !["completed", "approved"].includes(event.status));
      operation = this.database.finishPatchValidation(operation.id, operation.revision, failures.length === 0, failures.map(event => event.summary).join("; ") || undefined);
    } else if (operation.state !== "verified") {
      const validating = this.database.beginPatchValidation(operation.id, operation.revision);
      operation = this.database.finishPatchValidation(validating.id, validating.revision, true);
    }
    const current = await this.currentSource(patch, operation, c);
    if (!current) throw new Error("VALIDATION_INPUT_CHANGED");
    const provenance = await this.reopenProvenance(patch, events, c, signal);
    if (provenance === false) throw new Error("VALIDATION_ARTIFACT_CHANGED");
    if (!await this.currentSource(patch, operation, c)) throw new Error("VALIDATION_INPUT_CHANGED");
    const result = this.sourceValidationReceipt(patch, operation, events, current, provenance);
    this.store.stageSourceReceipt(c.contract.runId, callId, result);
    return result;
  }

  private async currentSource(patch: PatchProposal, operation: PatchOperation, c: HarnessCheckpoint) {
    const source = await this.workspace.read(patch.targetPath).catch(() => undefined);
    if (!source || !operation.resultExists || source.sha256 !== operation.resultSha256 || source.path !== operation.targetPath) return undefined;
    const binding = patch.materialBinding;
    if (/\.proto$/i.test(patch.targetPath) && !binding) return undefined;
    if (binding) {
      if (binding.partsSha256 !== c.contract.materialBinding?.partsSha256 || resolve(c.contract.workspacePath, binding.partsPath).toLowerCase() !== resolve(c.contract.workspacePath, c.contract.materialBinding?.partsPath ?? "").toLowerCase()) return undefined;
      const current = await this.workspace.read(binding.partsPath).catch(() => undefined);
      if (current?.sha256 !== binding.partsSha256) return undefined;
    }
    return source;
  }

  private async reopenProvenance(patch: PatchProposal, events: AgentRunEvent[], c: HarnessCheckpoint, signal: AbortSignal): Promise<{path: string; sha256: string} | undefined | false> {
    if (!/\.proto$/i.test(patch.targetPath)) return undefined;
    const workflow = events.find(event => event.tool === "proto_workflow_run");
    if (!workflow) return undefined;
    const output = workflow.payload?.output as {provenance_path?: unknown} | undefined;
    if (typeof output?.provenance_path !== "string") return false;
    const path = relative(c.contract.workspacePath, resolve(c.contract.workspacePath, output.provenance_path));
    if (path.startsWith("..") || isAbsolute(path)) return false;
    const before = await this.workspace.artifactFingerprint(path).catch(() => undefined);
    if (!before) return false;
    const result = await this.mcp.call("proto_provenance_verify", {path: path.replaceAll("\\", "/")}, signal, undefined,
      {timeoutMs: 30_000, scope: {surface: "harness", scopeId: c.contract.runId, parentOperationId: patch.id}});
    const after = await this.workspace.artifactFingerprint(path).catch(() => undefined);
    return result.ok === true && after?.sha256 === before.sha256 ? {path: before.path, sha256: before.sha256} : false;
  }

  private sourceValidationReceipt(patch: PatchProposal, operation: PatchOperation, events: AgentRunEvent[], source: {path: string; sha256: string; content: string}, provenance?: {path: string; sha256: string}): Record<string, unknown> {
    const ok = operation.state === "verified";
    // Outputs without a durable digest are not relabelled as newly produced
    // artifacts during recovery. Named exports need their own producer receipt.
    return {ok, effect_state: "committed", recovered: true, patch, operation, operation_id: operation.id, artifacts: [source.path], diagnostics: ok ? [] : [{code: "PATCH_VALIDATION_FAILED", message: operation.error ?? "Validation remains incomplete."}], validation: {source: source.path, sha256: source.sha256, materialBinding: patch.materialBinding, ok, steps: events.map(event => ({tool: event.tool, status: event.status}))}, _harnessArtifacts: [{path: source.path, sha256: source.sha256, sizeBytes: Buffer.byteLength(source.content)}], ...(provenance ? {_harnessRecoveredProvenance: provenance} : {})};
  }

  async verify(c: HarnessCheckpoint, summary = "", availableToolNames?: readonly string[]): Promise<{ok: boolean; diagnostics: HarnessDiagnostic[]; artifacts: string[]}> {
    const diagnostics: HarnessDiagnostic[] = [], artifacts: string[] = [];
    // Codes and classes are host judgments. An unclassified push stays
    // `repairable`, so an omission reproduces the old retry behaviour rather
    // than inventing a new early stop.
    const results = c.resultHandles.map(h => this.store.read(c.contract.runId, h)).filter(r => r.ok);
    const push = (code: string, subject: string, message: string, blockingClass: BlockingClass = "repairable") => diagnostics.push(harnessDiagnostic(code, subject, message, blockingClass, results));
    diagnostics.push(...conflictingReceiptDiagnostics(results, c.contract.workspacePath));
    if (c.contract.requiresArtifacts && !c.contract.deliverables.length) push("DELIVERABLES_NOT_PLANNED", "contract", "The requested artifact task has no recorded deliverables. Call harness_plan.");
    if (!results.some(r => !r.tool.startsWith("harness_"))) push("NO_TOOL_EVIDENCE", "contract", "No successful workspace or scientific tool evidence exists.");
    for (const required of c.contract.requiredReads ?? []) {
      if (!results.some(r => r.tool === "workspace_read" && String(r.data.path).toLowerCase() === resolve(c.contract.workspacePath, required).toLowerCase())) push("REQUIRED_INPUT_UNREAD", required, `Required input has not been read: ${required}`, "dependency-missing");
    }
    for (const deliverable of c.contract.deliverables) {
      try {
        const file = await this.workspace.artifactFingerprint(deliverable.path);
        if (!file.sizeBytes) {push("DELIVERABLE_EMPTY", deliverable.path, `Empty deliverable: ${deliverable.path}`); continue;}
        const binaryFormat = /\.(png|pdf)$/i.exec(file.path)?.[1]?.toLowerCase();
        if (binaryFormat) {
          if (file.detectedFormat !== binaryFormat) push("DELIVERABLE_FORMAT_INVALID", deliverable.path, `Deliverable is not a structurally valid ${binaryFormat.toUpperCase()}: ${deliverable.path}`);
          // Current autonomous tools export scientific text formats. Native
          // image export has independent decoder receipts but no model-callable
          // renderer bridge yet; arbitrary workspace bytes cannot replace one.
          // No available tool can produce this receipt, so retrying cannot help.
          push("RENDERER_RECEIPT_UNAVAILABLE", deliverable.path, `Binary deliverable requires a trusted renderer/exporter receipt; this autonomous tool set cannot produce that receipt: ${deliverable.path}`, "unsupported");
        }
        const recorded = results.some(r => (r.data._harnessArtifacts as Array<{path: string; sha256: string}> | undefined)?.some(a => a.path.toLowerCase() === file.path.toLowerCase() && a.sha256 === file.sha256));
        if (!recorded) push("ARTIFACT_DIGEST_UNRECORDED", deliverable.path, `Deliverable lacks a matching committed artifact digest: ${deliverable.path}`);
        diagnostics.push(...await verifyScientificArtifact(this.workspace, file, results));
        if (deliverable.kind === "dna" || /\.proto$/i.test(file.path)) {
          const validation = results.some(r => {
            if (!["workspace_propose_patch", "workspace_resume_validation"].includes(r.tool)) return false;
            const v = r.data.validation as {source?: string; sha256?: string; ok?: boolean; materialBinding?: MaterialBinding; steps?: Array<{tool?: string; status?: string}>} | undefined;
            return v?.ok && v.source?.toLowerCase() === file.path.toLowerCase() && v.sha256 === file.sha256
              && Boolean(c.contract.materialBinding) && v.materialBinding?.partsSha256 === c.contract.materialBinding?.partsSha256
              && ["proto_check", "proto_workflow_run", "proto_provenance_verify", "proto_review_packet"].every(tool => v.steps?.some(step => step.tool === tool && step.status === "completed"));
          });
          if (!validation) push("DNA_VALIDATION_MISSING", deliverable.path, `DNA deliverable lacks current check/workflow/review evidence: ${deliverable.path}`);
        }
        if (deliverable.kind === "protein") {
          const compilation = results.filter(r => r.tool === "proto_protein_compile");
          const compiled = compilation.some(r => (r.data._harnessInputs as {sha256?: string} | undefined)?.sha256 === file.sha256 || (r.data._harnessArtifacts as Array<{sha256: string}> | undefined)?.some(a => a.sha256 === file.sha256))
            || results.some(r => r.tool === "proto_export"
              && (r.data._harnessArtifacts as Array<{path: string; sha256: string}> | undefined)?.some(a => a.path.toLowerCase() === file.path.toLowerCase() && a.sha256 === file.sha256)
              && compilation.some(compiledResult => (compiledResult.data._harnessArtifacts as Array<{sha256: string}> | undefined)?.some(a => a.sha256 === (r.data._harnessInputs as {sha256?: string} | undefined)?.sha256)));
          if (!compiled) push("PROTEIN_COMPILE_MISSING", deliverable.path, `Protein deliverable lacks a successful compile receipt: ${deliverable.path}`);
        }
        artifacts.push(file.path);
      } catch (error) {
        // The declared deliverable cannot be reopened at all. Another model
        // round cannot re-establish a file the host can no longer read.
        push("DELIVERABLE_UNREADABLE", deliverable.path, `Cannot reopen ${deliverable.path}: ${String(error)}`, "stale");
      }
    }
    if (c.contract.materialBinding) {
      const current = await this.workspace.read(c.contract.materialBinding.partsPath).catch(() => undefined);
      // Every derived receipt was bound to the old snapshot. Redoing the work
      // against a moved base is a person's decision, not a retry.
      if (current?.sha256 !== c.contract.materialBinding.partsSha256) push("MATERIAL_BINDING_STALE", c.contract.materialBinding.partsPath, "The bound material snapshot changed or is unavailable.", "stale");
    }
    diagnostics.push(...await verifyMissionDiagnostics(c.contract, results, this.workspace, summary));
    await this.withDiagnosticRemedies(diagnostics, c, availableToolNames);
    return {ok: diagnostics.length === 0, diagnostics, artifacts};
  }

  private async withDiagnosticRemedies(diagnostics: HarnessDiagnostic[], c: HarnessCheckpoint, availableToolNames?: readonly string[]): Promise<void> {
    const names = availableToolNames ?? c.selectedTools ?? [];
    for (const diagnostic of diagnostics) {
      if (diagnostic.blockingClass !== "repairable") continue;
      const artifactClass = DIAGNOSTIC_ARTIFACTS[diagnostic.code];
      if (!artifactClass) continue;
      const declared = c.contract.deliverables.find(item => item.path === diagnostic.subject);
      // Report diagnostics may concern a resource id or completion summary,
      // rather than a saved target. Do not invent a writable path or force an
      // unsupported class when the existing summary route can still satisfy it.
      const target = declared?.path ?? (artifactClass === "workspace-write" && c.contract.deliverables.length === 1 ? c.contract.deliverables[0].path : undefined);
      if (artifactClass === "workspace-write" && !target) continue;
      let protein: boolean | undefined = declared?.kind === "protein" || diagnostic.code === "PROTEIN_COMPILE_MISSING" ? true : declared?.kind === "dna" ? false : undefined;
      if (artifactClass === "compiled-design" && /\.ir\.json$/i.test(diagnostic.subject)) {
        const current = await this.workspace.read(diagnostic.subject).catch(() => undefined);
        try { const domain = JSON.parse(current?.content ?? "null")?.domain; if (domain === "protein" || domain === "dna") protein = domain === "protein"; } catch { /* Domain cannot be inferred from invalid JSON. */ }
      }
      const permitted = (contract: ToolContract) => {
        if ((c.toolCallCounts?.[contract.name] ?? 0) >= contract.maxCallsPerRun) return false;
        if (c.contract.budgets && (c.activeTimeMs >= c.contract.budgets.activeTimeMs || c.generatedTokens >= c.contract.budgets.maxGeneratedTokens || c.round >= c.contract.budgets.maxRounds)) return false;
        if (!c.contract.scope || !this.policyDecision(contract.name, {}, `diagnostic:${diagnostic.code}`, c).allowed) return false;
        if (contract.effect === "write" && (!c.contract.scope.writeRoots.length || target && !c.contract.scope.writeRoots.some(root => this.withinRoot(c, target, root)))) return false;
        return true;
      };
      const needsMaterial = (contract: ToolContract) => !c.contract.materialBinding && (contract.preconditions.includes("material-binding")
        || diagnostic.code === "DNA_VALIDATION_MISSING" || contract.name === "workspace_propose_patch" && Boolean(target && /\.proto$/i.test(target)));
      const producers = toolsProducing(artifactClass, names).filter(contract => {
        if (contract.name.startsWith("workspace_") && artifactClass !== "workspace-write" && diagnostic.code !== "DNA_VALIDATION_MISSING") return false;
        if (artifactClass === "compiled-design" && (protein === true ? contract.name !== "proto_protein_compile" : protein === false && contract.name === "proto_protein_compile")) return false;
        if (diagnostic.code === "STRUCTURE_RECEIPT_MISSING" && contract.name === "proto_structure_read") return false;
        if (diagnostic.code === "DNA_VALIDATION_MISSING" && !["workspace_propose_patch", "workspace_resume_validation"].includes(contract.name)) return false;
        return permitted(contract);
      });
      const direct = producers.find(contract => !needsMaterial(contract));
      // An absent binding is a satisfiable prerequisite when this same host
      // exposes an authorized materializer. It is not proof that the requested
      // compiler/validator is unsupported. Never invent a binding or part ID.
      const prerequisite = !direct && producers.some(needsMaterial)
        ? toolsProducing("materialized-parts", names).find(contract => permitted(contract) && !contract.preconditions.includes("material-binding")) : undefined;
      if (direct) diagnostic.remedy = {tool: direct.name, reason: `This available host tool declares ${artifactClass} receipts and satisfies the current mission authority and call allowance. Its result still requires verification.`};
      else if (prerequisite) diagnostic.remedy = {tool: prerequisite.name, reason: `First establish the missing governed material binding through this available host tool; the ${artifactClass} producer still requires that exact verified binding before dispatch.`};
      // Only a complete host inventory establishes absence. Persisted selected
      // tools are a discovery subset, so they cannot prove unsupported work.
      else if (availableToolNames) diagnostic.blockingClass = "unsupported";
    }
  }

  private async digests(paths: string[]): Promise<Array<{path: string; sha256: string; sizeBytes: number}>> {
    const entries: Array<{path: string; sha256: string; sizeBytes: number}> = [];
    for (const path of paths) {const file = await this.workspace.artifactFingerprint(path).catch(() => undefined); if (file) entries.push(file);}
    return entries;
  }
}
