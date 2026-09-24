/** Host-issued authorization evidence. Persisted records explain a decision;
 * they do not authorize future calls merely because they can be loaded. */
export type PolicyRisk = "network" | "code-execution" | "write";
export type PolicySurface = "chat" | "harness" | "compute" | "workflow" | "design" | "chemistry" | "validation" | "figure" | "system" | "legacy";

export interface PolicyGrant {
  id: string;
  source: "session-send" | "mission" | "explicit-approval";
  actor: string;
  surface: PolicySurface;
  scopeId: string;
  risks: PolicyRisk[];
  grantedAt: string;
  expiresAt?: string;
}

export interface PolicyDecision {
  decisionId: string;
  tool: string;
  surface: PolicySurface;
  scopeId: string;
  operationId: string;
  allowed: boolean;
  code: "POLICY_ALLOWED" | "POLICY_DENIED" | "UNKNOWN_CAPABILITY" | "PLAN_MODE_READ_ONLY";
  requiredRisk: PolicyRisk | "none";
  reason: string;
  decidedAt: string;
  grantId?: string;
  /** Snapshot binds the audit record to what actually authorized this call. */
  grant?: PolicyGrant;
}
