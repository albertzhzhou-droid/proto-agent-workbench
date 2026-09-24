import { resolve } from "node:path";
import type { BlockingClass, HarnessDiagnostic, ToolResultEnvelope } from "../../shared/harness.ts";

export const harnessDiagnostic = (code: string, subject: string, message: string,
  blockingClass: BlockingClass = "repairable", receipts: ToolResultEnvelope[] = []): HarnessDiagnostic => ({
  code, blockingClass, subject, message,
  evidenceRefs: [...new Set(receipts.map(receipt => receipt.handle).filter(handle => typeof handle === "string" && Boolean(handle)))].sort(),
});

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const scalar = (value: unknown): value is string | number | boolean => typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);

/** Compare immutable claims, never mutable file paths alone. A later committed
 * CAS edit is a different operation, not a contradiction to its predecessor.
 * Generic result JSON and model-authored claims cannot declare evidence kinds.
 * No conflicting receipt is discarded or ranked by timestamp/arrival order. */
export function conflictingReceiptDiagnostics(results: ToolResultEnvelope[], workspacePath: string): HarnessDiagnostic[] {
  type Group = {subject: string; kind: string; values: Map<string, ToolResultEnvelope[]>};
  const groups = new Map<string, Group>();
  const pathKey = (path: string) => resolve(workspacePath, path).replaceAll("\\", "/").toLowerCase();
  const claim = (subject: string, kind: string, value: unknown, receipt: ToolResultEnvelope) => {
    if (!scalar(value)) return;
    const key = JSON.stringify([subject, kind]);
    const group = groups.get(key) ?? {subject, kind, values: new Map<string, ToolResultEnvelope[]>()};
    const encoded = JSON.stringify(value), receipts = group.values.get(encoded) ?? [];
    receipts.push(receipt); group.values.set(encoded, receipts); groups.set(key, group);
  };
  for (const result of results.filter(item => item.ok)) {
    const data = result.data, operation = object(data.operation);
    const sourceOperation = ["workspace_propose_patch", "workspace_resume_validation"].includes(result.tool);
    const operationId = sourceOperation && typeof operation.id === "string" ? operation.id : undefined;
    const operationTarget = typeof operation.targetPath === "string" ? pathKey(operation.targetPath) : undefined;
    const artifacts = Array.isArray(data._harnessArtifacts) ? data._harnessArtifacts.map(object) : [];
    for (const artifact of artifacts) {
      if (typeof artifact.path !== "string" || !digest(artifact.sha256)) continue;
      const path = pathKey(artifact.path), sha256 = artifact.sha256.toLowerCase();
      // Validation may legitimately refresh derived artifacts in later phases
      // of one operation. Its committed source target alone is immutable.
      if (operationId && operationTarget === path) claim(`${path}#operation=${operationId}`, "committed-artifact-sha256", sha256, result);
      if (Number.isSafeInteger(artifact.sizeBytes) && Number(artifact.sizeBytes) >= 0) claim(`${path}#sha256=${sha256}`, "artifact-size-bytes", artifact.sizeBytes, result);
    }
    if (operationId && typeof operation.targetPath === "string" && digest(operation.resultSha256)) {
      claim(`${pathKey(operation.targetPath)}#operation=${operationId}`, "committed-artifact-sha256", operation.resultSha256.toLowerCase(), result);
    }
    const input = object(data._harnessInputs);
    if (["proto_structure_fetch", "proto_structure_import_workspace", "proto_structure_read"].includes(result.tool)) {
      const attachment = object(data.attachment);
      if (typeof attachment.id === "string" && typeof input.path === "string" && digest(input.sha256) && digest(attachment.contentSha256)) {
        claim(`${pathKey(input.path)}#sha256=${input.sha256.toLowerCase()}#attachment=${attachment.id}`, "structure-content-sha256", attachment.contentSha256.toLowerCase(), result);
      }
    }
    const materialRows = result.tool === "proto_materials_search" && Array.isArray(data.matches) ? data.matches
      : result.tool === "proto_materials_get" && data.resource ? [data.resource]
      : result.tool === "proto_protein_inspect" && Array.isArray(data.proteins) ? data.proteins : [];
    const revision = typeof data.snapshot_id === "string" ? `snapshot=${data.snapshot_id}`
      : result.tool === "proto_protein_inspect" && typeof input.path === "string" && digest(input.sha256) ? `${pathKey(input.path)}#sha256=${input.sha256.toLowerCase()}` : undefined;
    // Unversioned historical catalogue records cannot establish same-revision
    // identity. Their ordinary report verifier still checks all supplied data.
    if (!revision) continue;
    for (const value of materialRows) {
      const row = object(value), id = result.tool === "proto_protein_inspect" ? row.id : row.resource_id;
      if (typeof id !== "string" || !id) continue;
      const subject = `material:${id}#${revision}`;
      if (digest(row.sequence_sha256)) claim(subject, "sequence-sha256", row.sequence_sha256.toLowerCase(), result);
      claim(subject, "sequence-length", row.length ?? row.sequence_length, result);
      for (const field of ["source", "license"] as const) {
        for (const [key, value] of Object.entries(object(row[field])).sort(([left], [right]) => left.localeCompare(right))) claim(subject, `${field}.${key}`, value, result);
      }
    }
  }
  return [...groups.values()].filter(group => group.values.size > 1)
    .sort((left, right) => JSON.stringify([left.subject, left.kind]).localeCompare(JSON.stringify([right.subject, right.kind])))
    .map(group => harnessDiagnostic("RECEIPT_CLAIM_CONFLICT", group.subject,
      `Successful receipts disagree on ${group.kind} for ${group.subject}. Human review is required; no receipt was selected by recency.`,
      "conflicting", [...group.values.values()].flat()));
}
