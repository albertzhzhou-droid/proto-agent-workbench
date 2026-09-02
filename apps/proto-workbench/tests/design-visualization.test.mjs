import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  DESIGN_VISUALIZATION_LIMITS,
  discoverOpenReadingFrames,
  parseDesignIr,
  rotateCircularConstructView,
  searchDesign,
  sourceBaseToViewBase,
  viewBaseToSourceBase,
  viewIntervalToSourceSegments,
} from "../src/renderer/design-visualization.ts";
import { calculateProteinMetrics } from "../src/renderer/protein-sequence.ts";

async function toggleSwitchIr() {
  return JSON.parse(await readFile(resolve("..", "..", "build", "toggle_switch.ir.json"), "utf8"));
}

function validProteinIr(sequence = "MKTWVDEFGH") {
  const sequenceSha256 = createHash("sha256").update(sequence).digest("hex");
  const sourceContentSha256 = createHash("sha256")
    .update(JSON.stringify({ provider: "fixture", record_id: "fixture-record", sequence }))
    .digest("hex");
  const metrics = calculateProteinMetrics(sequence);
  return {
    schema_version: "proto-agent.ir.v1",
    domain: "protein",
    design_id: "protein_fixture",
    chassis: "protein_sequence",
    proteins: [{
      id: "uniprot:fixture",
      resource_id: "uniprot:fixture",
      type: "protein_sequence",
      name: "Fixture protein",
      sequence,
      sequence_kind: "PROTEIN",
      sequence_sha256: sequenceSha256,
      description: "A software-only protein fixture.",
      description_zh: "软件层蛋白测试记录。",
      source: {
        provider: "fixture",
        record_id: "fixture-record",
        revision: "entry-version-1",
        release: "test",
        url: "https://example.invalid/fixture",
        retrieved_at: "2026-09-02T00:00:00Z",
        content_sha256: sourceContentSha256,
        sequence_sha256: sequenceSha256,
      },
      license: {
        id: "CC0-1.0",
        url: "https://creativecommons.org/publicdomain/zero/1.0/",
        attribution: "Fixture source",
        rights_notes: "Fixture redistribution is permitted.",
        redistribution_status: "REDISTRIBUTABLE",
      },
      review_status: "DESIGN_ELIGIBLE",
      safety_status: "NO_FLAG",
      safety_flags: [],
      design_eligibility: true,
      evidence_refs: ["https://example.invalid/fixture"],
      organism: { tax_id: 1, name: "Fixture organism", strain: "" },
      role_terms: ["fixture protein"],
      metadata: { reviewed_record: true },
      metrics: {
        length_aa: metrics.lengthAa,
        molecular_weight_da_approx: metrics.molecularWeightDaApprox,
        hydrophobic_fraction: metrics.hydrophobicFraction,
        charged_fraction: metrics.chargedFraction,
        ambiguous_or_special_fraction: metrics.ambiguousOrSpecialFraction,
        composition: metrics.composition,
      },
    }],
    constructs: [],
    constraints: [],
    provenance: {
      source: "build/protein_fixture.selection.json",
      snapshot_id: "fixture",
      selection_digest: "a".repeat(64),
      selection_schema_version: "proto-agent.protein-selection.v2",
      resource_ids: ["uniprot:fixture"],
      catalog_attestation: {
        schema_version: "proto-agent.catalog-selection-attestation.v1",
        issuer: "proto-agent-materials-catalog",
        attestation_kind: "catalog-issued-content-binding",
        signature_status: "UNSIGNED",
        cryptographic_signature: false,
        authenticity: "NOT_ESTABLISHED",
        selection_digest: "a".repeat(64),
        snapshot_manifest: {
          schema_version: "proto-agent.materials.v1",
          snapshot_id: "fixture",
          record_count: 1,
          manifest_sha256: "c".repeat(64),
          catalog_sha256: "d".repeat(64),
          license_catalog_sha256: "e".repeat(64),
        },
        records: [{
          resource_id: "uniprot:fixture",
          selection_record_sha256: "f".repeat(64),
          promotion_attestation_sha256: "1".repeat(64),
          promotion_audit_sha256: "2".repeat(64),
          promotion_attestation: {
            policy_version: "proto-agent.materials-promotion-policy.2026-09",
            resource_id: "uniprot:fixture",
            decision: "PASS",
          },
        }],
        binding_sha256: "b".repeat(64),
      },
      catalog_binding_sha256: "b".repeat(64),
      catalog_signature_status: "UNSIGNED",
    },
    review_status: "human_review_required",
    safety_boundary: "Software-only fixture; human review required.",
  };
}

async function governedDnaIr() {
  const ir = await toggleSwitchIr();
  const part = ir.constructs[0].parts[0];
  const sequenceSha256 = createHash("sha256").update(part.sequence.toUpperCase()).digest("hex");
  part.id = "igem:fixture-record";
  part.resource_id = "igem:fixture-record";
  part.sequence_kind = "DNA";
  part.sequence_sha256 = sequenceSha256;
  part.description = "Source-grounded software visualization fixture.";
  part.description_zh = "用于软件可视化的来源可追溯测试记录。";
  part.source = {
    provider: "iGEM Registry",
    record_id: "fixture-record",
    revision: "2026-09-01T00:00:00Z",
    release: "2026-09-01",
    url: "https://example.invalid/parts/fixture-record",
    retrieved_at: "2026-09-02T00:00:00Z",
    content_sha256: "b".repeat(64),
    sequence_sha256: sequenceSha256,
  };
  part.license = {
    id: "CC-BY-4.0",
    url: "https://creativecommons.org/licenses/by/4.0/legalcode",
    attribution: "Fixture contributor",
    rights_notes: "Redistribution is permitted with attribution.",
    redistribution_status: "REDISTRIBUTABLE",
  };
  part.review_status = "DESIGN_ELIGIBLE";
  part.design_eligibility = true;
  part.safety_status = "NO_FLAG";
  part.safety_flags = [];
  part.evidence_refs = ["https://example.invalid/parts/fixture-record"];
  return ir;
}

test("toggle_switch IR normalizes without inventing biological identifiers or sequences", async () => {
  const ir = await toggleSwitchIr();
  const result = parseDesignIr(ir);

  assert.equal(result.ok, true);
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.design);
  assert.equal(result.design.schemaVersion, "proto-agent.ir.v1");
  assert.equal(result.design.designId, ir.design_id);
  assert.equal(result.design.chassis, ir.chassis);
  assert.equal(result.design.source, ir.provenance.source);
  assert.deepEqual(
    result.design.constructs.flatMap((construct) => construct.parts.map((part) => part.id)),
    ir.constructs.flatMap((construct) => construct.parts.map((part) => part.id)),
  );
  assert.equal(
    result.design.sequence,
    ir.constructs.flatMap((construct) => construct.parts.map((part) => part.sequence)).join(""),
  );
  assert.deepEqual(result.design.constraints, ir.constraints);
  assert.ok(result.design.constructs.every((construct) => construct.parts.every((part) => part.direction === 0)));
  assert.ok(result.design.constructs.every((construct) => construct.topology === "unknown"));
});

test("legacy toy DNA IR remains readable but missing governance is explicitly unverified", async () => {
  const ir = await toggleSwitchIr();
  for (const part of ir.constructs.flatMap((construct) => construct.parts)) delete part.sequence_sha256;
  const result = parseDesignIr(ir);

  assert.equal(result.ok, true);
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.design);
  const part = result.design.constructs[0].parts[0];
  assert.equal(part.resourceId, null);
  assert.equal(part.sequenceKind, null);
  assert.equal(part.sequenceSha256, null);
  assert.equal(part.source, null);
  assert.equal(part.license, null);
  assert.equal(part.governanceStatus, "unverified");
  assert.deepEqual(part.governanceGaps, [
    "design_eligibility",
    "evidence_refs",
    "license",
    "resource_id",
    "review_status",
    "safety_flags",
    "safety_status",
    "sequence_kind",
    "sequence_sha256",
    "source",
  ]);
});

test("governed DNA IR retains compiler-declared source, rights, eligibility, safety, and checked hashes", async () => {
  const ir = await governedDnaIr();
  const declared = ir.constructs[0].parts[0];
  const result = parseDesignIr(ir);

  assert.equal(result.ok, true);
  assert.ok(result.design);
  const part = result.design.constructs[0].parts[0];
  assert.equal(part.resourceId, declared.resource_id);
  assert.equal(part.sequenceKind, "DNA");
  assert.equal(part.sequenceSha256, declared.sequence_sha256);
  assert.deepEqual(part.source, declared.source);
  assert.deepEqual(part.license, declared.license);
  assert.equal(part.reviewStatus, "DESIGN_ELIGIBLE");
  assert.equal(part.designEligibility, true);
  assert.equal(part.safetyStatus, "NO_FLAG");
  assert.deepEqual(part.safetyFlags, []);
  assert.deepEqual(part.evidenceRefs, declared.evidence_refs);
  assert.equal(part.governanceStatus, "verified");
  assert.deepEqual(part.governanceGaps, []);
});

test("missing optional DNA rights evidence is an unverified gap, not an invented claim", async () => {
  const ir = await governedDnaIr();
  delete ir.constructs[0].parts[0].license.rights_notes;
  const result = parseDesignIr(ir);

  assert.equal(result.ok, true);
  assert.ok(result.design);
  const part = result.design.constructs[0].parts[0];
  assert.equal(part.governanceStatus, "unverified");
  assert.ok(part.governanceGaps.includes("license.rights_notes"));
  assert.equal(Object.hasOwn(part.license, "rights_notes"), false);
});

test("governed DNA IR fails closed on declared hash, URL, rights, identity, eligibility, or safety drift", async () => {
  const cases = [
    ["sequence hash", (part) => { part.sequence_sha256 = "0".repeat(64); }, "PART_SEQUENCE_HASH_MISMATCH"],
    ["sequence hash format", (part) => { part.sequence_sha256 = "not-a-digest"; }, "PART_SEQUENCE_HASH_INVALID"],
    ["source sequence hash", (part) => { part.source.sequence_sha256 = "0".repeat(64); }, "PART_SOURCE_SEQUENCE_HASH_MISMATCH"],
    ["source content hash", (part) => { part.source.content_sha256 = "invalid"; }, "PART_SOURCE_CONTENT_HASH_INVALID"],
    ["source URL", (part) => { part.source.url = "javascript:alert(1)"; }, "PART_SOURCE_URL_INVALID"],
    ["insecure source URL", (part) => { part.source.url = "http://example.invalid/parts/fixture-record"; }, "PART_SOURCE_URL_INVALID"],
    ["source retrieval timestamp", (part) => { part.source.retrieved_at = "yesterday"; }, "PART_SOURCE_RETRIEVED_AT_INVALID"],
    ["license URL", (part) => { part.license.url = "file:///rights.txt"; }, "PART_LICENSE_URL_INVALID"],
    ["insecure license URL", (part) => { part.license.url = "http://example.invalid/license"; }, "PART_LICENSE_URL_INVALID"],
    ["rights", (part) => { part.license.redistribution_status = "UNKNOWN"; }, "PART_RIGHTS_NOT_REDISTRIBUTABLE"],
    ["resource id syntax", (part) => { part.id = part.resource_id = "../not-namespaced"; }, "PART_RESOURCE_ID_INVALID"],
    ["identity", (part) => { part.resource_id = "igem:different-record"; }, "PART_RESOURCE_ID_MISMATCH"],
    ["sequence kind", (part) => { part.sequence_kind = "PROTEIN"; }, "PART_SEQUENCE_KIND_MISMATCH"],
    ["eligibility", (part) => { part.design_eligibility = false; }, "PART_DESIGN_NOT_ELIGIBLE"],
    ["safety", (part) => { part.safety_status = "REVIEW_REQUIRED"; }, "PART_SAFETY_STATUS_BLOCKED"],
    ["safety flags", (part) => { part.safety_flags = ["REVIEW_REQUIRED"]; }, "PART_SAFETY_FLAGS_BLOCKED"],
    ["empty evidence", (part) => { part.evidence_refs = []; }, "PART_EVIDENCE_REFS_MISSING"],
  ];
  for (const [label, mutate, code] of cases) {
    const ir = await governedDnaIr();
    mutate(ir.constructs[0].parts[0]);
    const result = parseDesignIr(ir);
    assert.equal(result.ok, false, label);
    assert.equal(result.design, undefined, label);
    assert.ok(result.diagnostics.some((item) => item.code === code), `${label}: missing ${code}`);
  }
});

test("DNA sequence hashes bind the canonical uppercase sequence rendered by the viewer", async () => {
  const canonical = await governedDnaIr();
  const part = canonical.constructs[0].parts[0];
  part.sequence = part.sequence.toLowerCase();
  const canonicalDigest = createHash("sha256").update(part.sequence.toUpperCase()).digest("hex");
  part.sequence_sha256 = canonicalDigest;
  part.source.sequence_sha256 = canonicalDigest;
  const accepted = parseDesignIr(canonical);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.design.constructs[0].parts[0].sequence, part.sequence.toUpperCase());
  assert.equal(accepted.design.constructs[0].parts[0].sequenceSha256, canonicalDigest);

  const rawCaseDigest = createHash("sha256").update(part.sequence).digest("hex");
  part.sequence_sha256 = rawCaseDigest;
  part.source.sequence_sha256 = rawCaseDigest;
  const rejected = parseDesignIr(canonical);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.diagnostics.some((item) => item.code === "PART_SEQUENCE_HASH_MISMATCH"));
});

test("protein IR uses an isolated amino-acid domain with bounded metrics", () => {
  const ir = validProteinIr();
  const sequence = ir.proteins[0].sequence;
  const sequenceSha256 = ir.proteins[0].sequence_sha256;
  assert.notEqual(ir.proteins[0].source.content_sha256, sequenceSha256);
  const result = parseDesignIr(ir);
  assert.equal(result.ok, true);
  assert.ok(result.design);
  assert.equal(result.design.domain, "protein");
  assert.equal(result.design.constructs.length, 0);
  assert.equal(result.design.proteins[0].length, sequence.length);
  assert.equal(result.design.proteins[0].sequenceSha256, sequenceSha256);
  assert.equal(result.design.length, sequence.length);
});

test("protein IR recomputes hashes and fails closed on source, rights, eligibility, safety, or metric drift", () => {
  const cases = [
    ["sequence hash", (ir) => { ir.proteins[0].sequence_sha256 = "0".repeat(64); }, "PROTEIN_SEQUENCE_HASH_MISMATCH"],
    ["source content hash", (ir) => { ir.proteins[0].source.content_sha256 = "invalid"; }, "PROTEIN_SOURCE_CONTENT_HASH_INVALID"],
    ["source sequence hash", (ir) => { ir.proteins[0].source.sequence_sha256 = "0".repeat(64); }, "PROTEIN_SOURCE_SEQUENCE_HASH_MISMATCH"],
    ["source sequence hash format", (ir) => { ir.proteins[0].source.sequence_sha256 = "invalid"; }, "PROTEIN_SOURCE_SEQUENCE_HASH_INVALID"],
    ["source sequence hash required", (ir) => { delete ir.proteins[0].source.sequence_sha256; }, "PROTEIN_SOURCE_REQUIRED_FIELD_MISSING"],
    ["source record", (ir) => { delete ir.proteins[0].source.record_id; }, "PROTEIN_SOURCE_REQUIRED_FIELD_MISSING"],
    ["source revision", (ir) => { delete ir.proteins[0].source.revision; }, "PROTEIN_SOURCE_REQUIRED_FIELD_MISSING"],
    ["source retrieval timestamp", (ir) => { ir.proteins[0].source.retrieved_at = "yesterday"; }, "PROTEIN_SOURCE_RETRIEVED_AT_INVALID"],
    ["source object", (ir) => { delete ir.proteins[0].source; }, "PROTEIN_METADATA_INVALID"],
    ["source URL", (ir) => { ir.proteins[0].source.url = "javascript:alert(1)"; }, "PROTEIN_SOURCE_URL_INVALID"],
    ["insecure source URL", (ir) => { ir.proteins[0].source.url = "http://example.invalid/fixture"; }, "PROTEIN_SOURCE_URL_INVALID"],
    ["license", (ir) => { ir.proteins[0].license.redistribution_status = "UNKNOWN"; }, "PROTEIN_LICENSE_NOT_REDISTRIBUTABLE"],
    ["license attribution", (ir) => { delete ir.proteins[0].license.attribution; }, "PROTEIN_LICENSE_REQUIRED_FIELD_MISSING"],
    ["insecure license URL", (ir) => { ir.proteins[0].license.url = "http://example.invalid/license"; }, "PROTEIN_LICENSE_URL_INVALID"],
    ["license object", (ir) => { delete ir.proteins[0].license; }, "PROTEIN_METADATA_INVALID"],
    ["resource identity", (ir) => { ir.proteins[0].resource_id = "uniprot:different"; }, "PROTEIN_RESOURCE_ID_MISMATCH"],
    ["eligibility", (ir) => { ir.proteins[0].design_eligibility = false; }, "PROTEIN_DESIGN_ELIGIBILITY_INVALID"],
    ["safety", (ir) => { ir.proteins[0].safety_status = "REVIEW_REQUIRED"; }, "PROTEIN_SAFETY_STATUS_INVALID"],
    ["safety flags", (ir) => { ir.proteins[0].safety_flags = ["REVIEW_REQUIRED"]; }, "PROTEIN_SAFETY_FLAGS_INVALID"],
    ["evidence", (ir) => { ir.proteins[0].evidence_refs = []; }, "PROTEIN_GOVERNANCE_LIST_INVALID"],
    ["organism", (ir) => { delete ir.proteins[0].organism; }, "PROTEIN_GOVERNANCE_METADATA_INVALID"],
    ["role terms", (ir) => { delete ir.proteins[0].role_terms; }, "PROTEIN_GOVERNANCE_LIST_INVALID"],
    ["sequence kind", (ir) => { ir.proteins[0].sequence_kind = "DNA"; }, "PROTEIN_SEQUENCE_KIND_INVALID"],
    ["metrics object", (ir) => { delete ir.proteins[0].metrics; }, "PROTEIN_METRICS_INVALID"],
    ["fraction bounds", (ir) => { ir.proteins[0].metrics.hydrophobic_fraction = 7; }, "PROTEIN_METRIC_INVALID"],
    ["derived metrics", (ir) => { ir.proteins[0].metrics.composition.M = 2; }, "PROTEIN_METRICS_MISMATCH"],
  ];
  for (const [label, mutate, code] of cases) {
    const ir = validProteinIr();
    mutate(ir);
    const result = parseDesignIr(ir);
    assert.equal(result.ok, false, label);
    assert.equal(result.design, undefined, label);
    assert.ok(result.diagnostics.some((item) => item.code === code), `${label}: missing ${code}`);
  }
});

test("protein and DNA visualization reject mixed domains and incomplete governed protein provenance", async () => {
  const proteinCases = [
    ["DNA constructs", (ir) => { ir.constructs = [{ name: "hidden-dna", topology: "linear", parts: [] }]; }, "PROTEIN_DNA_DOMAIN_MIXED"],
    ["chassis", (ir) => { ir.chassis = "ecoli"; }, "PROTEIN_CHASSIS_INVALID"],
    ["review boundary", (ir) => { delete ir.review_status; }, "PROTEIN_REVIEW_BOUNDARY_INVALID"],
    ["selection schema", (ir) => { ir.provenance.selection_schema_version = "proto-agent.protein-selection.v1"; }, "PROTEIN_SELECTION_SCHEMA_UNSUPPORTED"],
    ["resource binding", (ir) => { ir.provenance.resource_ids = ["uniprot:other"]; }, "PROTEIN_PROVENANCE_RESOURCE_BINDING_INVALID"],
    ["catalog trust", (ir) => { ir.provenance.catalog_attestation.authenticity = "VERIFIED"; }, "PROTEIN_CATALOG_ATTESTATION_INVALID"],
  ];
  for (const [label, mutate, code] of proteinCases) {
    const ir = validProteinIr();
    mutate(ir);
    const result = parseDesignIr(ir);
    assert.equal(result.ok, false, label);
    assert.ok(result.diagnostics.some((item) => item.code === code), `${label}: missing ${code}`);
  }

  const dnaIr = await governedDnaIr();
  dnaIr.proteins = [validProteinIr().proteins[0]];
  const dnaResult = parseDesignIr(dnaIr);
  assert.equal(dnaResult.ok, false);
  assert.ok(dnaResult.diagnostics.some((item) => item.code === "DNA_PROTEIN_DOMAIN_MIXED"));
});

test("protein IR rejects nucleotide symbols and malformed digests", () => {
  const invalid = {
    schema_version: "proto-agent.ir.v1",
    domain: "protein",
    design_id: "protein_invalid",
    chassis: "protein_sequence",
    proteins: [{ id: "uniprot:fixture", type: "protein_sequence", sequence: "ATG!", sequence_sha256: "bad" }],
    constructs: [],
    constraints: [],
    provenance: { source: "fixture" },
  };
  const result = parseDesignIr(invalid);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) => item.code === "PROTEIN_SEQUENCE_ALPHABET_INVALID"));
  assert.ok(result.diagnostics.some((item) => item.code === "PROTEIN_SEQUENCE_HASH_INVALID"));
});

test("construct topology is explicit, typed, and fails closed when invalid", async () => {
  const declared = await toggleSwitchIr();
  declared.constructs[0].topology = "circular";
  declared.constructs[1].topology = "linear";
  const declaredResult = parseDesignIr(declared);

  assert.equal(declaredResult.ok, true);
  assert.deepEqual(declaredResult.design?.constructs.map((construct) => construct.topology), ["circular", "linear"]);

  const invalid = await toggleSwitchIr();
  invalid.constructs[0].topology = "plasmid-ish";
  const invalidResult = parseDesignIr(invalid);
  assert.equal(invalidResult.ok, false);
  assert.ok(invalidResult.diagnostics.some((item) => item.code === "CONSTRUCT_TOPOLOGY_INVALID" && item.path === "$.constructs[0].topology"));
});

test("coordinates are contiguous, zero-based, and end-exclusive across constructs and parts", async () => {
  const result = parseDesignIr(await toggleSwitchIr());
  assert.ok(result.design);
  const { design } = result;

  assert.deepEqual([design.start, design.end, design.length], [0, 108, 108]);
  assert.deepEqual(
    design.constructs.map((construct) => [construct.start, construct.end, construct.length]),
    [[0, 52, 52], [52, 108, 56]],
  );
  assert.deepEqual(
    design.constructs[0].parts.map((part) => [part.start, part.end, part.localStart, part.localEnd]),
    [[0, 12, 0, 12], [12, 24, 12, 24], [24, 39, 24, 39], [39, 52, 39, 52]],
  );
  assert.deepEqual(
    design.constructs[1].parts.map((part) => [part.start, part.end, part.designStart, part.designEnd]),
    [[0, 16, 52, 68], [16, 28, 68, 80], [28, 43, 80, 95], [43, 56, 95, 108]],
  );
});

test("GC fractions are derived from actual assembled sequence", async () => {
  const result = parseDesignIr(await toggleSwitchIr());
  assert.ok(result.design);

  assert.equal(result.design.constructs[0].gcFraction, 21 / 52);
  assert.equal(result.design.constructs[1].gcFraction, 21 / 56);
  assert.equal(result.design.gcFraction, 42 / 108);
  assert.equal(result.design.gcPercent, (42 / 108) * 100);
});

test("logical annotations preserve segmented and circular origin-wrapping geometry", async () => {
  const ir = await toggleSwitchIr();
  ir.constructs[0].topology = "circular";
  ir.constructs[0].annotations = [{
    id: "review_region",
    name: "Reviewer-defined region",
    type: "misc_feature",
    direction: "reverse",
    segments: [{ start: 48, end: 52 }, { start: 0, end: 4 }],
  }, {
    id: "segmented_region",
    type: "misc_feature",
    segments: [{ start: 8, end: 12 }, { start: 20, end: 23 }],
  }];
  const result = parseDesignIr(ir);

  assert.equal(result.ok, true);
  assert.ok(result.design);
  const construct = result.design.constructs[0];
  assert.equal(construct.features.length, construct.parts.length + 2);
  const wrapping = construct.features.at(-2);
  assert.equal(wrapping.source, "annotation");
  assert.equal(wrapping.wrapsOrigin, true);
  assert.equal(wrapping.direction, -1);
  assert.deepEqual(wrapping.segments.map((segment) => [segment.start, segment.end]), [[48, 52], [0, 4]]);
  assert.equal(wrapping.length, 8);
  assert.equal(wrapping.sequence, `${construct.sequence.slice(48, 52)}${construct.sequence.slice(0, 4)}`);
  assert.equal(searchDesign(result.design, "review_region")[0].featureIndex, construct.parts.length);
});

test("invalid annotation bounds, overlaps, and linear origin wraps fail closed", async () => {
  const outOfBounds = await toggleSwitchIr();
  outOfBounds.constructs[0].annotations = [{ id: "bad_bounds", type: "misc_feature", segments: [{ start: 0, end: 53 }] }];
  const outOfBoundsResult = parseDesignIr(outOfBounds);
  assert.equal(outOfBoundsResult.ok, false);
  assert.ok(outOfBoundsResult.diagnostics.some((item) => item.code === "ANNOTATION_SEGMENT_RANGE_INVALID"));

  const overlap = await toggleSwitchIr();
  overlap.constructs[0].annotations = [{ id: "bad_overlap", type: "misc_feature", segments: [{ start: 2, end: 9 }, { start: 8, end: 12 }] }];
  const overlapResult = parseDesignIr(overlap);
  assert.equal(overlapResult.ok, false);
  assert.ok(overlapResult.diagnostics.some((item) => item.code === "ANNOTATION_SEGMENTS_OVERLAP"));

  const linearWrap = await toggleSwitchIr();
  linearWrap.constructs[0].topology = "linear";
  linearWrap.constructs[0].annotations = [{ id: "bad_wrap", type: "misc_feature", segments: [{ start: 48, end: 52 }, { start: 0, end: 4 }] }];
  const linearWrapResult = parseDesignIr(linearWrap);
  assert.equal(linearWrapResult.ok, false);
  assert.ok(linearWrapResult.diagnostics.some((item) => item.code === "ANNOTATION_SEGMENT_ORDER_INVALID"));
});

test("invalid schemas and malformed JSON fail closed with structured diagnostics", () => {
  const wrongSchema = parseDesignIr({ schema_version: "proto-agent.ir.v2" });
  const malformed = parseDesignIr("{not json");

  assert.equal(wrongSchema.ok, false);
  assert.equal(wrongSchema.design, undefined);
  assert.ok(wrongSchema.diagnostics.some((item) => item.code === "IR_SCHEMA_UNSUPPORTED" && item.path === "$.schema_version"));
  assert.equal(malformed.ok, false);
  assert.equal(malformed.design, undefined);
  assert.deepEqual(malformed.diagnostics.map((item) => item.code), ["IR_JSON_INVALID"]);
});

test("empty constructs and oversized part sequences fail closed", async () => {
  const empty = await toggleSwitchIr();
  empty.constructs[0].parts = [];
  const emptyResult = parseDesignIr(empty);
  assert.equal(emptyResult.ok, false);
  assert.ok(emptyResult.diagnostics.some((item) => item.code === "CONSTRUCT_PARTS_INVALID"));

  const oversized = await toggleSwitchIr();
  oversized.constructs[0].parts[0].sequence = "A".repeat(DESIGN_VISUALIZATION_LIMITS.maxPartSequenceCharacters + 1);
  const oversizedResult = parseDesignIr(oversized);
  assert.equal(oversizedResult.ok, false);
  assert.ok(oversizedResult.diagnostics.some((item) => item.code === "PART_SEQUENCE_INVALID"));
});

test("HTML-like labels remain inert text data", async () => {
  const ir = await toggleSwitchIr();
  const label = '<img src=x onerror="globalThis.compromised=true">';
  ir.constructs[0].parts[0].name = label;
  const result = parseDesignIr(ir, "designs/reviewed.proto");

  assert.ok(result.design);
  assert.equal(result.design.source, "designs/reviewed.proto");
  assert.equal(result.design.constructs[0].parts[0].name, label);
  assert.equal(Object.hasOwn(result.design.constructs[0].parts[0], "html"), false);
  assert.equal(Object.hasOwn(result.design.constructs[0].parts[0], "markup"), false);
});

test("search covers design, construct, part, type, and sequence with local and design coordinates", async () => {
  const ir = await toggleSwitchIr();
  const boundaryQuery = `${ir.constructs[0].parts[0].sequence.slice(-3)}${ir.constructs[0].parts[1].sequence.slice(0, 3)}`;
  const result = parseDesignIr(ir);
  assert.ok(result.design);
  const design = result.design;

  assert.ok(searchDesign(design, "toggle_switch_v1").some((hit) => hit.field === "design"));
  assert.ok(searchDesign(design, "reporter_unit").some((hit) => hit.field === "construct" && hit.constructIndex === 1));
  assert.ok(searchDesign(design, "tetR").some((hit) => hit.field === "part" && hit.start === 24 && hit.end === 39));
  assert.ok(searchDesign(design, "promoter").some((hit) => hit.field === "type"));
  assert.equal(new Set(searchDesign(design, "promoter").map((hit) => `${hit.constructIndex}:${hit.partIndex}`)).size, searchDesign(design, "promoter").length);
  assert.ok(searchDesign(design, "ATGGCT").some((hit) => hit.field === "sequence" && hit.start === 24 && hit.end === 30));
  assert.ok(searchDesign(design, boundaryQuery).some((hit) => hit.field === "sequence" && hit.start === 9 && hit.end === 15));
  assert.deepEqual(searchDesign(design, "   "), []);
});

test("circular view origin rotation is reversible and retains source coordinates", async () => {
  const ir = await toggleSwitchIr();
  ir.constructs[0].topology = "circular";
  ir.constructs[0].annotations = [{
    id: "source_origin_wrap",
    type: "misc_feature",
    segments: [{ start: 48, end: 52 }, { start: 0, end: 4 }],
  }];
  const result = parseDesignIr(ir);
  assert.ok(result.design);
  const source = result.design.constructs[0];
  const rotated = rotateCircularConstructView(source, 10);

  assert.notEqual(rotated, source);
  assert.equal(rotated.viewOrigin, 10);
  assert.equal(rotated.sourceSequence, source.sequence);
  assert.equal(rotated.sequence, source.sequence.slice(10) + source.sequence.slice(0, 10));
  assert.equal(source.viewOrigin, undefined);
  assert.equal(source.sourceSequence, undefined);
  assert.deepEqual(rotated.features[0].segments.map((segment) => [segment.start, segment.end]), [[42, 52], [0, 2]]);
  assert.deepEqual(rotated.features[0].sourceSegments.map((segment) => [segment.start, segment.end]), [[0, 12]]);
  assert.equal(rotated.features[0].wrapsOrigin, true);
  assert.deepEqual(rotated.features.at(-1).segments.map((segment) => [segment.start, segment.end]), [[38, 42], [42, 46]]);
  assert.equal(rotated.features.at(-1).wrapsOrigin, false);

  const restored = rotateCircularConstructView(rotated, 0);
  assert.equal(restored.sequence, source.sequence);
  assert.equal(restored.viewOrigin, undefined);
  assert.equal(restored.sourceSequence, undefined);
  assert.deepEqual(restored.features.map((feature) => feature.segments), source.features.map((feature) => feature.segments));
  assert.ok(restored.features.every((feature) => feature.sourceSegments === undefined));
});

test("search on a rotated circular view reports canonical source/design spans, including origin crossings", async () => {
  const ir = await toggleSwitchIr();
  ir.constructs[0].topology = "circular";
  const result = parseDesignIr(ir);
  assert.ok(result.design);
  const source = result.design.constructs[0];
  const rotated = rotateCircularConstructView(source, 10);
  const rotatedDesign = { ...result.design, constructs: [rotated, ...result.design.constructs.slice(1)] };

  const partHit = searchDesign(rotatedDesign, source.parts[0].id)
    .find((hit) => hit.field === "part" && hit.constructIndex === 0);
  assert.ok(partHit);
  assert.deepEqual([partHit.start, partHit.end, partHit.designStart, partHit.designEnd], [0, 12, 0, 12]);
  assert.deepEqual(partHit.segments.map((segment) => [segment.start, segment.end]), [[0, 12]]);
  assert.deepEqual(partHit.viewSegments.map((segment) => [segment.start, segment.end]), [[42, 52], [0, 2]]);

  const sourceOriginQuery = source.sequence.slice(-2) + source.sequence.slice(0, 4);
  const sourceOriginHit = searchDesign(rotatedDesign, sourceOriginQuery)
    .find((hit) => hit.field === "sequence" && hit.segments?.length === 2);
  assert.ok(sourceOriginHit);
  assert.deepEqual(
    sourceOriginHit.segments.map((segment) => [segment.start, segment.end, segment.designStart, segment.designEnd]),
    [[50, 52, 50, 52], [0, 4, 0, 4]],
  );
  assert.deepEqual(
    [sourceOriginHit.start, sourceOriginHit.end, sourceOriginHit.designStart, sourceOriginHit.designEnd],
    [50, 52, 50, 52],
  );
  assert.deepEqual(sourceOriginHit.viewSegments.map((segment) => [segment.start, segment.end]), [[40, 46]]);

  // This motif crosses the displayed (rotated) origin but is contiguous in
  // immutable source coordinates. View-local 50..56 must never escape as its
  // source/design location.
  const viewOriginQuery = source.sequence.slice(8, 14);
  const viewOriginHit = searchDesign(rotatedDesign, viewOriginQuery)
    .find((hit) => hit.field === "sequence" && hit.start === 8 && hit.end === 14);
  assert.ok(viewOriginHit);
  assert.deepEqual(
    viewOriginHit.segments.map((segment) => [segment.start, segment.end, segment.designStart, segment.designEnd]),
    [[8, 14, 8, 14]],
  );
  assert.deepEqual(viewOriginHit.viewSegments.map((segment) => [segment.start, segment.end]), [[50, 52], [0, 4]]);
});

test("view and source coordinate mappings stay bounded across the circular origin", () => {
  assert.equal(sourceBaseToViewBase(10, 10, 52), 0);
  assert.equal(sourceBaseToViewBase(0, 10, 52), 42);
  assert.equal(viewBaseToSourceBase(0, 10, 52), 10);
  assert.equal(viewBaseToSourceBase(51, 10, 52), 9);
  assert.deepEqual(viewIntervalToSourceSegments(40, 50, 10, 52), [{ start: 50, end: 52 }, { start: 0, end: 8 }]);
  assert.deepEqual(viewIntervalToSourceSegments(0, 4, 10, 52), [{ start: 10, end: 14 }]);
  assert.equal(sourceBaseToViewBase(-1, 10, 52), undefined);
  assert.deepEqual(viewIntervalToSourceSegments(50, 53, 10, 52), []);
});

test("view origin rotation fails closed for non-circular constructs and invalid origins", async () => {
  const result = parseDesignIr(await toggleSwitchIr());
  assert.ok(result.design);
  const unknown = result.design.constructs[0];
  assert.equal(rotateCircularConstructView(unknown, 10), unknown);
  const circular = { ...unknown, topology: "circular" };
  assert.equal(rotateCircularConstructView(circular, -1), circular);
  assert.equal(rotateCircularConstructView(circular, circular.length), circular);
});

test("software ORF discovery is bounded, strand-aware, and explicitly derived", () => {
  const forwardSequence = `ATG${"AAA".repeat(5)}TAA`;
  const reverseSequence = reverseComplement(forwardSequence);
  const forward = discoverOpenReadingFrames(forwardSequence, { topology: "linear", constructStart: 20, minimumAminoAcids: 5 });
  const reverse = discoverOpenReadingFrames(reverseSequence, { topology: "linear", minimumAminoAcids: 5 });

  assert.equal(forward.truncated, false);
  assert.equal(forward.features.length, 1);
  assert.equal(forward.features[0].source, "software");
  assert.equal(forward.features[0].direction, 1);
  assert.deepEqual(forward.features[0].segments.map((segment) => [segment.start, segment.end, segment.designStart, segment.designEnd]), [[0, 21, 20, 41]]);
  assert.match(forward.features[0].name, /Software-inferred ORF/);

  assert.equal(reverse.features.length, 1);
  assert.equal(reverse.features[0].direction, -1);
  assert.deepEqual(reverse.features[0].segments.map((segment) => [segment.start, segment.end]), [[0, 21]]);

  const bounded = discoverOpenReadingFrames("ATGTAA".repeat(10), { topology: "linear", minimumAminoAcids: 1, maximumFeatures: 3 });
  assert.equal(bounded.features.length, 3);
  assert.equal(bounded.truncated, true);
  assert.deepEqual(discoverOpenReadingFrames("ATGTAA", { topology: "linear", minimumAminoAcids: 0 }), { features: [], truncated: false });
});

test("software ORF discovery preserves circular origin traversal on both strands", () => {
  const circularSequence = `TAA${"CCC".repeat(3)}ATG${"AAA".repeat(2)}`;
  const forward = discoverOpenReadingFrames(circularSequence, { topology: "circular", minimumAminoAcids: 2 });
  const reverse = discoverOpenReadingFrames(reverseComplement(circularSequence), { topology: "circular", minimumAminoAcids: 2 });

  const forwardWrap = forward.features.find((feature) => feature.direction === 1 && feature.wrapsOrigin);
  assert.ok(forwardWrap);
  assert.deepEqual(forwardWrap.segments.map((segment) => [segment.start, segment.end]), [[12, 21], [0, 3]]);
  assert.equal(forwardWrap.length, 12);

  const reverseWrap = reverse.features.find((feature) => feature.direction === -1 && feature.wrapsOrigin);
  assert.ok(reverseWrap);
  assert.equal(reverseWrap.length, 12);
  assert.deepEqual(reverseWrap.segments.map((segment) => [segment.start, segment.end]), [[0, 9], [18, 21]]);
});

function reverseComplement(sequence) {
  const complement = { A: "T", C: "G", G: "C", T: "A" };
  return [...sequence].reverse().map((base) => complement[base]).join("");
}
