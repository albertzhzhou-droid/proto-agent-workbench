import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import { toCgviewFeatureCoordinates } from "../src/renderer/cgview-adapter.ts";
import { parseDesignIr, searchDesign } from "../src/renderer/design-visualization.ts";
import {
  MAX_MATERIALS_DESIGN_SELECTION,
  createMaterialsDesignSelection,
  createMaterialsMaterializeRequest,
} from "../src/renderer/materials-design-selection.ts";
import { classifyVisualizationEnvelope } from "../src/renderer/visualization-envelope.ts";

const BUNDLE_ROOT = resolve("..", "..", "materials", "bundles", "public", "public-reviewed-2026.09");
const SHA256 = /^[a-f0-9]{64}$/;
const BLOB_PATH = /^blobs\/[a-f0-9]{2}\/[a-f0-9]{64}\.txt\.gz$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function governedPartIr(record, sequence, index) {
  return {
    schema_version: "proto-agent.ir.v1",
    domain: "dna",
    design_id: `igem_visualization_corpus_${index}`,
    chassis: "ecoli_k12",
    constructs: [{
      name: record.name,
      topology: "linear",
      parts: [{
        id: record.resource_id,
        resource_id: record.resource_id,
        type: record.part_type,
        name: record.name,
        sequence,
        sequence_kind: record.sequence_kind,
        sequence_sha256: record.sequence_sha256,
        description: record.description_en,
        description_zh: record.description_zh,
        source: record.source,
        license: record.license,
        review_status: record.review_status,
        design_eligibility: record.design_eligibility,
        safety_status: record.safety_status,
        safety_flags: record.safety_flags,
        evidence_refs: record.evidence_refs,
      }],
    }],
    constraints: [],
    provenance: {
      source: "materials/bundles/public/public-reviewed-2026.09",
      snapshot_id: "public-reviewed-2026.09",
    },
  };
}

test("every reviewed iGEM part has a digest-bound stable interactive visualization model", async () => {
  const [bundle, recordsText] = await Promise.all([
    readFile(resolve(BUNDLE_ROOT, "bundle.json"), "utf8").then(JSON.parse),
    readFile(resolve(BUNDLE_ROOT, "records.jsonl"), "utf8"),
  ]);
  const records = recordsText.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  const igemRecords = records.filter((record) => record.source?.provider === "iGEM Registry");

  assert.equal(records.length, bundle.record_count);
  assert.equal(igemRecords.length, bundle.source_counts["iGEM Registry"]);
  assert.ok(igemRecords.length >= 1_000, "the release corpus must retain at least 1,000 reviewed iGEM parts");

  const colorsByType = new Map();
  const seenResourceIds = new Set();
  const seenSequenceDigests = new Set();
  for (const [index, record] of igemRecords.entries()) {
    assert.match(record.resource_id, /^igem:[0-9a-f-]{36}$/);
    assert.match(record.sequence_sha256, SHA256);
    assert.match(record.sequence_path, BLOB_PATH);
    assert.equal(seenResourceIds.has(record.resource_id), false, `${record.resource_id}: duplicate resource id`);
    assert.equal(seenSequenceDigests.has(record.sequence_sha256), false, `${record.resource_id}: duplicate sequence digest`);
    seenResourceIds.add(record.resource_id);
    seenSequenceDigests.add(record.sequence_sha256);

    const compressed = await readFile(resolve(BUNDLE_ROOT, ...record.sequence_path.split("/")));
    const sequence = gunzipSync(compressed).toString("ascii");
    assert.equal(sequence.length, record.sequence_length, `${record.resource_id}: sequence length drift`);
    assert.equal(sha256(sequence), record.sequence_sha256, `${record.resource_id}: blob digest drift`);
    assert.equal(record.source.sequence_sha256, record.sequence_sha256, `${record.resource_id}: source digest drift`);

    const parsed = parseDesignIr(governedPartIr(record, sequence, index));
    assert.equal(parsed.ok, true, `${record.resource_id}: ${JSON.stringify(parsed.diagnostics)}`);
    assert.ok(parsed.design);
    const construct = parsed.design.constructs[0];
    const part = construct.parts[0];
    assert.equal(part.governanceStatus, "verified", record.resource_id);
    assert.deepEqual(part.governanceGaps, [], record.resource_id);
    assert.equal(construct.length, record.sequence_length, record.resource_id);
    assert.deepEqual(
      toCgviewFeatureCoordinates({ start: part.localStart, end: part.localEnd, direction: part.direction }, construct.length),
      { start: 1, stop: record.sequence_length },
      record.resource_id,
    );
    assert.equal(classifyVisualizationEnvelope(construct.length, construct.features.length).mode, "interactive", record.resource_id);
    assert.ok(searchDesign(parsed.design, record.resource_id).some((hit) => hit.partIndex === 0), record.resource_id);

    const knownColor = colorsByType.get(record.part_type);
    if (knownColor) assert.equal(part.color, knownColor, `${record.part_type}: unstable color`);
    else colorsByType.set(record.part_type, part.color);
  }

  assert.deepEqual([...colorsByType.keys()].sort(), ["cds", "promoter", "rbs", "terminator"]);
});

test("every reviewed iGEM part can enter a bounded snapshot-bound design selection", async () => {
  const recordsText = await readFile(resolve(BUNDLE_ROOT, "records.jsonl"), "utf8");
  const igemRecords = recordsText
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line))
    .filter((record) => record.source?.provider === "iGEM Registry");
  const selectedIds = [];
  let batchCount = 0;
  for (let offset = 0; offset < igemRecords.length; offset += MAX_MATERIALS_DESIGN_SELECTION) {
    const selection = createMaterialsDesignSelection(
      "public-reviewed-2026.09",
      igemRecords.slice(offset, offset + MAX_MATERIALS_DESIGN_SELECTION),
    );
    const request = createMaterialsMaterializeRequest(selection, "ecoli_k12");
    assert.equal(request.snapshot, "public-reviewed-2026.09");
    assert.ok(request.resource_ids.length >= 1 && request.resource_ids.length <= MAX_MATERIALS_DESIGN_SELECTION);
    selectedIds.push(...request.resource_ids);
    batchCount += 1;
  }
  assert.equal(batchCount, 21);
  assert.equal(selectedIds.length, 1_046);
  assert.equal(new Set(selectedIds).size, 1_046);
});
