import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { contractDeadlineMs, requireToolContract, toolContract } from "../../shared/tool-contracts.ts";
import type { PolicyDecision } from "../../shared/tool-policy.ts";
import { validateExecutionScope, type ExecutionScope } from "./execution-scope.ts";
import { RuntimeFailure } from "./runtime-control.ts";
import { ToolExecutionJournal, type ToolExecutionIdentity } from "./tool-execution-journal.ts";
import { assertHostPolicyDecision, TOOL_POLICY_VERSION } from "./permissions.ts";

interface InvocationIdentity {
  journal?: ToolExecutionJournal;
  operationId: string;
  scope: ExecutionScope;
  tool: string;
  arguments: Record<string, unknown>;
  decisionId?: string;
  decision?: PolicyDecision;
}

/** Opaque live-host authority; copying this metadata never copies permission. */
export interface KernelContext {
  readonly mode: "production" | "ephemeral-test";
  readonly workspaceIdentity: string;
  readonly operationId: string;
  readonly inputSha256: string;
  readonly methodId: string;
  readonly policyVersion: string;
  readonly budget: Readonly<{ timeoutMs: number; maxOutputBytes: number }>;
}

export interface JournaledInvocation extends InvocationIdentity {
  journal: ToolExecutionJournal;
  decision: PolicyDecision;
  context: KernelContext & { readonly mode: "production" };
}
export interface EphemeralJournaledInvocation extends InvocationIdentity {
  context: KernelContext & { readonly mode: "ephemeral-test" };
}
type Invocation = JournaledInvocation | EphemeralJournaledInvocation;
const contexts = new WeakMap<KernelContext, { binding: string; journal?: ToolExecutionJournal; request: InvocationIdentity }>();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const binding = (request: InvocationIdentity) => hash({ operationId: request.operationId, scope: request.scope,
  tool: request.tool, arguments: request.arguments, decisionId: request.decisionId, decision: request.decision });
const refuse = (code: string, message = code): never => { throw Object.assign(new Error(message), { code, effectState: "none" }); };
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}

/** Host adapters must supply a journal and a live, input-bound policy decision.
 * The frozen JSON input is an invocation snapshot, not a claim that every domain
 * schema or referenced source file has already been scientifically validated. */
export function createProductionKernelContext(request: InvocationIdentity & { journal: ToolExecutionJournal; decision: PolicyDecision },
  workspaceIdentity: string, timeoutMs = contractDeadlineMs(request.tool, request.arguments)): JournaledInvocation["context"] {
  if (!(request.journal instanceof ToolExecutionJournal)) refuse("TOOL_EXECUTION_JOURNAL_REQUIRED");
  if (!request.decision) refuse("TOOL_POLICY_DECISION_REQUIRED");
  if (!isAbsolute(workspaceIdentity)) refuse("KERNEL_WORKSPACE_IDENTITY_REQUIRED");
  validateExecutionScope(request.scope);
  assertDecisionBinding(request);
  assertHostPolicyDecision(request.decision, request.arguments);
  requireToolContract(request.tool);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > contractDeadlineMs(request.tool, request.arguments)) refuse("KERNEL_BUDGET_INVALID");
  return issueContext(request, "production", workspaceIdentity, timeoutMs);
}

/** Test-only escape hatch is both explicit and unavailable outside node --test.
 * It retains all journal recovery semantics and never activates by omission. */
export function createEphemeralKernelContext(request: InvocationIdentity): EphemeralJournaledInvocation["context"] {
  if (!process.env.NODE_TEST_CONTEXT) refuse("KERNEL_EPHEMERAL_CONTEXT_TEST_ONLY");
  return issueContext(request, "ephemeral-test", "ephemeral:test", 630_000);
}

function issueContext<Mode extends KernelContext["mode"]>(request: InvocationIdentity, mode: Mode, workspaceIdentity: string, timeoutMs: number): KernelContext & { mode: Mode } {
  const contract = toolContract(request.tool);
  const context = freeze({ mode, workspaceIdentity, operationId: request.operationId, inputSha256: hash(request.arguments),
    methodId: contract?.capabilityId ?? request.tool, policyVersion: TOOL_POLICY_VERSION,
    budget: { timeoutMs, maxOutputBytes: contract?.outputBudget.maxBytes ?? 0 } });
  const snapshot = freeze(structuredClone({ ...request, journal: undefined }));
  contexts.set(context, { binding: binding(request), journal: request.journal, request: { ...snapshot, journal: request.journal } });
  return context;
}

function requireContext(request: Invocation): InvocationIdentity {
  const issued = request.context && contexts.get(request.context);
  if (!issued) return refuse("KERNEL_CONTEXT_REQUIRED", "A live host-issued execution context is required before dispatch.");
  if (issued.journal !== request.journal || issued.binding !== binding(request)) refuse("KERNEL_CONTEXT_BINDING_MISMATCH");
  if (request.context.mode === "production") {
    if (!request.journal) refuse("TOOL_EXECUTION_JOURNAL_REQUIRED");
    if (!request.decision) return refuse("TOOL_POLICY_DECISION_REQUIRED");
    assertHostPolicyDecision(request.decision, request.arguments);
  }
  return issued.request;
}

/** Shared transaction boundary for MCP and Chem. The adapter must acknowledge
 * dispatch immediately before handing the request to a process or provider. */
export async function invokeJournaledTool(
  request: Invocation,
  dispatch: (markDispatched: () => void, inputSnapshot: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const snapshot = requireContext(request);
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
  const identity: ToolExecutionIdentity = { operationId: snapshot.operationId, scope: snapshot.scope, tool: snapshot.tool,
    arguments: snapshot.arguments, effect: contract.effect, decisionId: snapshot.decisionId, decision: snapshot.decision };
  const journal = request.journal, prepared = journal?.begin(identity);
  if (prepared?.kind === "receipt") return prepared.receipt;
  const leaseId = prepared?.kind === "start" ? prepared.leaseId : undefined;
  let dispatched = false;
  try {
    const receipt = await dispatch(() => {
      if (dispatched) throw new Error("TOOL_ALREADY_DISPATCHED");
      requireContext(request);
      if (request.decision?.grant?.expiresAt && !(Date.parse(request.decision.grant.expiresAt) > Date.now())) refuse("POLICY_DENIED");
      if (journal && leaseId) journal.markDispatched(identity, leaseId);
      dispatched = true;
    }, snapshot.arguments);
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
export function recordPolicyDenial(request: Invocation): void {
  requireContext(request);
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

function assertDecisionBinding(request:InvocationIdentity):void {
  const decision=request.decision;
  if(decision&&(decision.tool!==request.tool||decision.surface!==request.scope.surface||decision.scopeId!==request.scope.scopeId||decision.operationId!==request.operationId
    ||(request.decisionId!==undefined&&request.decisionId!==decision.decisionId)))throw Object.assign(new Error("Policy decision is bound to a different operation."),{code:"POLICY_DENIED",effectState:"none"});
}

function explicitNoEffect(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { effectState?: unknown; effect_state?: unknown };
  return value.effectState === "none" || value.effect_state === "none";
}
