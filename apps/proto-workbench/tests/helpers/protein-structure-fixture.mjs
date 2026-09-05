import { createHash } from "node:crypto";
import { calculateProteinMetrics } from "../../src/renderer/protein-sequence.ts";

/** Software-only fixture, never a catalogue promotion or a biological identity. */
export function proteinStructureFixture(sequence = "AGC") {
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const metrics = calculateProteinMetrics(sequence);
  const id = "fixture:structure-protein";
  const ir = {
    schema_version: "proto-agent.ir.v1", domain: "protein", design_id: "structure-test", chassis: "protein_sequence",
    constructs: [], constraints: [], review_status: "human_review_required", safety_boundary: "Software-only fixture.",
    proteins: [{ id, resource_id: id, type: "protein_sequence", name: "Software fixture", sequence, sequence_kind: "PROTEIN",
      sequence_sha256: hash(sequence), description: "Software-only residue mapping fixture", description_zh: "软件测试",
      source: { provider: "fixture", record_id: "fixture", revision: "1", release: "test", url: "https://example.invalid/fixture",
        retrieved_at: "2026-09-04T00:00:00Z", content_sha256: hash("source-fixture"), sequence_sha256: hash(sequence) },
      license: { id: "CC0-1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/", attribution: "Test fixture", rights_notes: "Test-only permission", redistribution_status: "REDISTRIBUTABLE" },
      review_status: "DESIGN_ELIGIBLE", design_eligibility: true, safety_status: "NO_FLAG", safety_flags: [], evidence_refs: ["https://example.invalid/fixture"],
      organism: { name: "Test fixture" }, role_terms: ["software fixture"], metadata: {},
      metrics: { algorithm: metrics.algorithm, mass_status: metrics.massStatus, mass_reason: metrics.massReason,
        length_aa: metrics.lengthAa, molecular_weight_da_approx: metrics.molecularWeightDaApprox, composition: metrics.composition,
        hydrophobic_fraction: metrics.hydrophobicFraction, charged_fraction: metrics.chargedFraction, ambiguous_or_special_fraction: metrics.ambiguousOrSpecialFraction } }],
    provenance: { source: "build/fixture.selection.json", snapshot_id: "fixture", selection_digest: "a".repeat(64), selection_schema_version: "proto-agent.protein-selection.v2", resource_ids: [id],
      catalog_signature_status: "UNSIGNED", catalog_binding_sha256: "b".repeat(64),
      catalog_attestation: { schema_version: "proto-agent.catalog-selection-attestation.v1", issuer: "proto-agent-materials-catalog",
        attestation_kind: "catalog-issued-content-binding", signature_status: "UNSIGNED", cryptographic_signature: false, authenticity: "NOT_ESTABLISHED",
        selection_digest: "a".repeat(64), binding_sha256: "b".repeat(64), snapshot_manifest: { schema_version: "proto-agent.materials.v1", snapshot_id: "fixture", record_count: 1,
          manifest_sha256: "c".repeat(64), catalog_sha256: "d".repeat(64), license_catalog_sha256: "e".repeat(64) },
        records: [{ resource_id: id, selection_record_sha256: "f".repeat(64), promotion_attestation_sha256: "1".repeat(64), promotion_audit_sha256: "2".repeat(64),
          promotion_attestation: { policy_version: "proto-agent.materials-promotion-policy.2026-09", resource_id: id, decision: "PASS" } }] } },
  };
  const text = JSON.stringify(ir);
  return { ir, text, target: { artifactPath: "fixture.ir.json", artifactSha256: hash(text), proteinId: id, sequenceSha256: hash(sequence) } };
}

export const PDB_FIXTURE = [
  "HEADER    SOFTWARE TEST FIXTURE",
  "SEQRES   1 A    3  ALA GLY CYS",
  "ATOM      1  CA  ALA A  10       0.000   0.000   0.000  1.00 95.00           C",
  "ATOM      2  CA  GLY A  11       3.800   0.000   0.000  1.00 82.00           C",
  "ATOM      3  CA  CYS A  12       6.500   2.600   0.000  1.00 41.00           C",
  "TER", "END", "",
].join("\n");
