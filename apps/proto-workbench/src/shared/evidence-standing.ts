/** Independent evidence axes. No axis implies biological safety, scientific
 * validity, materials eligibility, or another axis's status. */
export interface EvidenceStanding {
  dataOrigin: "fixture" | "synthetic" | "imported" | "governed-snapshot" | "unknown";
  /** Materials only; omitted for computations and unverified libraries. */
  eligibility?: "DESIGN_ELIGIBLE" | "QUARANTINED" | "unknown";
  methodMaturity: "not-established" | "numerical-reference-tested" | "method-implementation" | "demonstration" | "heuristic";
  executionStatus: "not-run" | "running" | "completed" | "error" | "cancelled" | "effect-unknown" | "incomplete-evidence" | "unverifiable" | "unknown";
  humanReview: "required" | "reviewed-supported" | "reviewed-rejected";
}

export function readEvidenceStanding(value: unknown): EvidenceStanding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (!["fixture", "synthetic", "imported", "governed-snapshot", "unknown"].includes(String(item.dataOrigin))
    || !["not-established", "numerical-reference-tested", "method-implementation", "demonstration", "heuristic"].includes(String(item.methodMaturity))
    || !["not-run", "running", "completed", "error", "cancelled", "effect-unknown", "incomplete-evidence", "unverifiable", "unknown"].includes(String(item.executionStatus))
    || !["required", "reviewed-supported", "reviewed-rejected"].includes(String(item.humanReview))
    || (item.eligibility !== undefined && !["DESIGN_ELIGIBLE", "QUARANTINED", "unknown"].includes(String(item.eligibility)))) return undefined;
  return { dataOrigin: item.dataOrigin, methodMaturity: item.methodMaturity, executionStatus: item.executionStatus, humanReview: item.humanReview,
    ...(item.eligibility !== undefined ? { eligibility: item.eligibility } : {}) } as EvidenceStanding;
}
