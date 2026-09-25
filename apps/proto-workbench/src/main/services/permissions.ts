import type { ToolApproval } from "../../shared/contracts.ts";
import { createHash, randomUUID } from "node:crypto";
import { resolveToolContract, toolContract } from "../../shared/tool-contracts.ts";
import type { PolicyDecision, PolicyGrant, PolicySurface } from "../../shared/tool-policy.ts";

export const TOOL_POLICY_VERSION = "proto-workbench.tool-policy.v1";
const hostGrants = new WeakMap<PolicyGrant, string>();
const hostDecisions = new WeakMap<PolicyDecision, { snapshot: string; argumentsDigest: string; trustedGrant: boolean; grants: readonly PolicyGrant[]; mode?: "plan" | "act" }>();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const invalidDecision = (): never => { throw Object.assign(new Error("The policy decision or grant was not issued by this live host for these inputs."), { code: "POLICY_DENIED", effectState: "none" }); };

/** Main-process only. Call at a validated live user/mission authorization boundary.
 * Persisted JSON retains audit evidence, never this non-serializable authority. */
export function issueHostPolicyGrant(value: PolicyGrant): PolicyGrant {
  const grant = structuredClone(value);
  hostGrants.set(grant, digest(grant));
  return grant;
}

export function assertHostPolicyDecision(decision: PolicyDecision, args: Record<string, unknown>): void {
  const issued = hostDecisions.get(decision);
  if (!issued || issued.snapshot !== digest(decision) || issued.argumentsDigest !== digest(args) || !issued.trustedGrant) invalidDecision();
}

/** Adapters can normalize paths/envelopes, but must reevaluate the actual input.
 * In particular, an offline exemption cannot authorize a later online request. */
export function rebindHostPolicyDecision(decision: PolicyDecision, args: Record<string, unknown>): PolicyDecision {
  const issued = hostDecisions.get(decision);
  if (!issued || issued.snapshot !== digest(decision) || !issued.trustedGrant) return invalidDecision();
  return evaluateToolPolicy({ tool: decision.tool, args, surface: decision.surface, scopeId: decision.scopeId,
    operationId: decision.operationId, grants: issued.grants, mode: issued.mode });
}

export type ToolPermission =
  | { allowed: true; risk: "none" }
  | { allowed: false; risk: ToolApproval["risk"]; reason: string };

const DENIED_UNKNOWN: ToolPermission = {
  allowed: false,
  risk: "code-execution",
  reason: "Unknown tools are denied by default.",
};

export function classifyTool(tool: string): ToolPermission {
  const contract = toolContract(tool);
  if (!contract) return DENIED_UNKNOWN;
  switch (contract.access) {
    case "auto":
      return { allowed: true, risk: "none" };
    case "grant-network":
      return {
        allowed: false,
        risk: "network",
        reason: "This tool sends a query to an external scientific database and requires a mission network grant or explicit approval.",
      };
    case "grant-execution":
      return {
        allowed: false,
        risk: "code-execution",
        reason: "This tool executes workspace-local analysis code and requires a mission execution grant or explicit approval.",
      };
    case "grant-write":
      return {
        allowed: false,
        risk: "write",
        reason: "Workspace changes require explicit review and approval.",
      };
    default:
      return DENIED_UNKNOWN;
  }
}

export function classifyToolCall(tool: string, arguments_: Record<string, unknown>): ToolPermission {
  if (toolContract(tool)?.supportsOffline && arguments_.offline === true) {
    return { allowed: true, risk: "none" };
  }
  return classifyTool(tool);
}

/** Grants must be supplied by a trusted live host action, never by tool arguments
 * or by loading a transcript. Both Chat and Harness use this same policy. */
export function evaluateToolPolicy(input: {
  tool: string; args: Record<string, unknown>; surface: PolicySurface;
  scopeId: string; operationId: string; mode?: "plan" | "act";
  grants: readonly PolicyGrant[]; now?: Date;
}): PolicyDecision {
  const decision = evaluatePolicy(input);
  const grant = decision.grantId ? input.grants.find(value => value.id === decision.grantId) : undefined;
  hostDecisions.set(decision, { snapshot: digest(decision), argumentsDigest: digest(input.args),
    trustedGrant: !decision.grantId || !!grant && hostGrants.get(grant) === digest(grant), grants: input.grants, mode: input.mode });
  return decision;
}

function evaluatePolicy(input: {
  tool: string; args: Record<string, unknown>; surface: PolicySurface;
  scopeId: string; operationId: string; mode?: "plan" | "act";
  grants: readonly PolicyGrant[]; now?: Date;
}): PolicyDecision {
  const now = input.now ?? new Date(), contract = resolveToolContract(input.tool);
  const permission = contract ? classifyToolCall(contract.name, input.args) : DENIED_UNKNOWN;
  const base = {
    policyVersion: TOOL_POLICY_VERSION,
    decisionId: randomUUID(), tool: contract?.name ?? input.tool,
    surface: input.surface, scopeId: input.scopeId, operationId: input.operationId,
    requiredRisk: permission.risk, decidedAt: now.toISOString(),
  };
  if (!contract) return {...base, allowed: false, code: "UNKNOWN_CAPABILITY", reason: "Unknown tools are denied by default."};
  if (input.mode === "plan" && contract.effect !== "read") {
    return {...base, allowed: false, code: "PLAN_MODE_READ_ONLY", reason: "Switch to Act mode to authorize workspace effects."};
  }
  if (permission.allowed) return {...base, allowed: true, code: "POLICY_ALLOWED", reason: "The registered tool requires no additional risk grant."};
  const grant = contract.access !== "denied" && input.grants.find(value =>
    value.id && value.actor && value.scopeId === input.scopeId && value.surface === input.surface
    && value.risks.includes(permission.risk)
    && Number.isFinite(Date.parse(value.grantedAt)) && Date.parse(value.grantedAt) <= now.getTime()
    && (!value.expiresAt || (Number.isFinite(Date.parse(value.expiresAt)) && Date.parse(value.expiresAt) > now.getTime())));
  if (grant) return {...base, allowed: true, code: "POLICY_ALLOWED", reason: "An explicit host-issued scope grant covers this risk.", grantId: grant.id, grant: {...grant, risks: [...grant.risks]}};
  return {...base, allowed: false, code: "POLICY_DENIED", reason: permission.reason};
}

/**
 * Tools the model may see in its tool list. `grant-write` stays hidden: a patch
 * is applied by the reviewer, never selected by the model.
 */
export function isToolExposedToModel(tool: string): boolean {
  const access = toolContract(tool)?.access;
  return access === "auto" || access === "grant-network" || access === "grant-execution";
}

export function isNetworkTool(tool: string): boolean {
  return toolContract(tool)?.network === true;
}
