import { requireToolContract, toolContract } from "../../shared/tool-contracts.ts";
import type { PolicyDecision } from "../../shared/tool-policy.ts";
import { validateExecutionScope, type ExecutionScope } from "./execution-scope.ts";
import { RuntimeFailure } from "./runtime-control.ts";
import { ToolExecutionJournal, type ToolExecutionIdentity } from "./tool-execution-journal.ts";

export interface JournaledInvocation {
  journal?: ToolExecutionJournal;
  operationId: string;
  scope: ExecutionScope;
  tool: string;
  arguments: Record<string, unknown>;
  decisionId?: string;
  decision?: PolicyDecision;
}

/** Shared transaction boundary for MCP and Chem. The adapter must acknowledge
 * dispatch immediately before handing the request to a process or provider. */
export async function invokeJournaledTool(
  request: JournaledInvocation,
  dispatch: (markDispatched: () => void) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const contract = requireToolContract(request.tool);
  validateExecutionScope(request.scope);
  if (request.decision) {
    const decision = request.decision;
    assertDecisionBinding(request);
    if (!decision.allowed) recordPolicyDenial(request);
    if (!decision.allowed || (decision.grant?.expiresAt !== undefined && !(Date.parse(decision.grant.expiresAt) > Date.now()))) {
      throw Object.assign(new Error("The policy decision does not authorize this tool operation."), { code: "POLICY_DENIED", effectState: "none" });
    }
  }
  // Caller-supplied effect fields are intentionally ignored, including runtime
  // JavaScript callers that bypass the TypeScript interface.
  const identity: ToolExecutionIdentity = { operationId: request.operationId, scope: request.scope, tool: request.tool,
    arguments: request.arguments, effect: contract.effect, decisionId: request.decisionId, decision: request.decision };
  const journal = request.journal, prepared = journal?.begin(identity);
  if (prepared?.kind === "receipt") return prepared.receipt;
  const leaseId = prepared?.kind === "start" ? prepared.leaseId : undefined;
  let dispatched = false;
  try {
    const receipt = await dispatch(() => {
      if (dispatched) throw new Error("TOOL_ALREADY_DISPATCHED");
      if (journal && leaseId) journal.markDispatched(identity, leaseId);
      dispatched = true;
    });
    if (!dispatched) throw new Error("TOOL_DISPATCH_NOT_ACKNOWLEDGED");
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("TOOL_EXECUTION_RECEIPT_INVALID");
    const payload = JSON.stringify(receipt);
    if (Buffer.byteLength(payload) > contract.outputBudget.maxBytes) throw new Error("TOOL_EXECUTION_RECEIPT_LIMIT");
    if (journal && leaseId) journal.complete(identity, leaseId, receipt);
    return receipt;
  } catch (error) {
    const confirmedNone = explicitNoEffect(error);
    if (journal && leaseId) {
      try {
        if (dispatched && contract.effect === "write" && !confirmedNone) journal.markUnknown(identity, leaseId);
        else journal.markNoEffect(identity, leaseId, confirmedNone);
      } catch (journalError) {
        throw new RuntimeFailure("TOOL_EFFECT_UNKNOWN", "tool-execution-journal",
          `The ${request.tool} receipt could not be durably recorded: ${journalError instanceof Error ? journalError.message : String(journalError)}`,
          { effectState: dispatched && contract.effect === "write" ? "unknown" : "none" });
      }
    }
    throw Object.assign(error instanceof Error?error:new Error(String(error)),{effectState:dispatched&&contract.effect==="write"&&!confirmedNone?"unknown":"none"});
  }
}

/** Record a refusal as durable evidence.
 *
 * A denial is a real decision about a real request, so it belongs in the same
 * ledger as an execution: without a row, an audit cannot distinguish a call the
 * policy refused from one that was never attempted. Nothing is dispatched, so the
 * row settles immediately at `no-effect` and carries the decision that produced it.
 * An unregistered tool has no contract and therefore no effect to record; the
 * refusal itself is what the caller reports.
 */
export function recordPolicyDenial(request: JournaledInvocation): void {
  if (!request.journal || !request.decision || request.decision.allowed) return;
  const contract = toolContract(request.tool);
  if (!contract) return;
  validateExecutionScope(request.scope);
  assertDecisionBinding(request);
  const identity: ToolExecutionIdentity = { operationId: request.operationId, scope: request.scope, tool: request.tool,
    arguments: request.arguments, effect: contract.effect,
    decisionId: request.decisionId ?? request.decision.decisionId, decision: request.decision };
  const prepared = request.journal.begin(identity);
  // A prior receipt for this operation ID outranks a late denial; leave it intact.
  if (prepared.kind !== "start") return;
  request.journal.markNoEffect(identity, prepared.leaseId, true,
    { ok: false, code: request.decision.code, message: request.decision.reason, effect_state: "none" });
}

function assertDecisionBinding(request:JournaledInvocation):void {
  const decision=request.decision;
  if(decision&&(decision.tool!==request.tool||decision.surface!==request.scope.surface||decision.scopeId!==request.scope.scopeId||decision.operationId!==request.operationId
    ||(request.decisionId!==undefined&&request.decisionId!==decision.decisionId)))throw Object.assign(new Error("Policy decision is bound to a different operation."),{code:"POLICY_DENIED",effectState:"none"});
}

function explicitNoEffect(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { effectState?: unknown; effect_state?: unknown };
  return value.effectState === "none" || value.effect_state === "none";
}
