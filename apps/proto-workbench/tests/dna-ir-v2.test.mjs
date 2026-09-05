import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { parseDesignIr, searchDesign } from "../src/renderer/design-visualization.ts";
import { reverseComplementDna } from "../src/renderer/dna-ir-v2.ts";
import { dnaWindowProjection, DNA_SEQUENCE_WINDOW_BASES, DNA_WINDOW_MAX_INTERVALS } from "../src/renderer/dna-window.ts";

const sha = (sequence) => createHash("sha256").update(sequence).digest("hex");
function toyIr(count = 2, length = 15) {
  const original = "ACGTRYSWKMBDHVN".repeat(Math.ceil(length / 15)).slice(0, length);
  const parts = Array.from({ length: count }, (_, index) => {
    const reverse = index % 2 === 1;
    const sequence = reverse ? reverseComplementDna(original) : original;
    return { id: "fixture:toy_dna", name: "Toy DNA fixture", type: "cds", instance_id: `slot_${index}`, sequence, sequence_sha256: sha(sequence), source_sequence_sha256: sha(original), source_direction: 0, direction: 0, start: index * length, end: (index + 1) * length, placement: { orientation: reverse ? "reverse" : "forward", transform: reverse ? "reverse_complement" : "identity", algorithm: "iupac-dna.v1" } };
  });
  const sequence = parts.map((part) => part.sequence).join("");
  return { schema_version: "proto-agent.ir.v2", domain: "dna", design_id: "dna_v2_toy_fixture", chassis: "toy", constructs: [{ name: "toy_unit", topology: "circular", sequence, length: sequence.length, sequence_sha256: sha(sequence), parts, annotations: [] }], constraints: [], provenance: { source: "build/toy.proto", parts_source: "build/toy-parts.json", source_sha256: "1".repeat(64), parts_sha256: "2".repeat(64) } };
}

test("DNA v2 preserves occurrence IDs, placement, hashes and unknown biological direction", () => {
  const parsed = parseDesignIr(toyIr());
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  assert.equal(parsed.design.schemaVersion, "proto-agent.ir.v2");
  assert.equal(parsed.design.partsSource, "build/toy-parts.json");
  assert.equal(parsed.design.constructs[0].parts[1].placement.orientation, "reverse");
  assert.equal(parsed.design.constructs[0].parts[1].direction, 0);
  assert.deepEqual(parsed.design.constructs[0].features.map((feature) => feature.id), ["slot_0", "slot_1"]);
  assert.equal(searchDesign(parsed.design, "slot_1")[0].partIndex, 1);
});

test("DNA v2 governed source hash validates original bytes on reverse placement", () => {
  const ir = toyIr();
  const part = ir.constructs[0].parts[1];
  part.source = { provider: "software fixture", record_id: "toy_dna", revision: "1", release: "fixture", url: "https://example.org/toy", retrieved_at: "2026-09-04T00:00:00Z", content_sha256: "3".repeat(64), sequence_sha256: part.source_sequence_sha256 };
  const parsed = parseDesignIr(ir);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  part.source.sequence_sha256 = part.sequence_sha256;
  assert.equal(parseDesignIr(ir).ok, false);
});

test("DNA v2 source annotations retain anchors and independently verified locations", () => {
  const ir = toyIr();
  ir.constructs[0].annotations.push({ id: "note_01", name: "Toy reverse region", type: "misc_feature", origin: "user", anchors: [{ instance_id: "slot_1", start: 1, end: 5, direction: 1 }], locations: [{ instance_id: "slot_1", start: 25, end: 29, direction: -1 }] });
  const parsed = parseDesignIr(ir);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  assert.equal(parsed.design.constructs[0].sourceAnnotations[0].anchors[0].start, 1);
  assert.equal(parsed.design.constructs[0].features[2].direction, -1);
  assert.equal(parsed.design.constructs[0].features[2].segments[0].start, 25);
  ir.constructs[0].annotations[0].locations[0].start = 24;
  assert.equal(parseDesignIr(ir).ok, false);
});

test("DNA v2 rejects placement, source, digest, geometry and schema downgrade mutations", () => {
  const mutations = [
    (ir) => { ir.constructs[0].parts[1].source_sequence_sha256 = "0".repeat(64); },
    (ir) => { ir.constructs[0].parts[1].direction = -1; },
    (ir) => { ir.constructs[0].parts[1].placement.algorithm = "unverified"; },
    (ir) => { ir.constructs[0].parts[1].start = 0; },
    (ir) => { ir.constructs[0].parts[1].instance_id = "slot_0"; },
    (ir) => { ir.schema_version = "proto-agent.ir.v1"; },
    (ir) => { ir.domain = "protein"; },
  ];
  for (const mutate of mutations) { const ir = toyIr(); mutate(ir); assert.equal(parseDesignIr(ir).ok, false); }
});

test("100kbp/2000-occurrence fixture parses without losing feature identities", () => {
  const before = performance.now();
  const parsed = parseDesignIr(toyIr(2000, 50));
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  assert.equal(parsed.design.length, 100_000);
  assert.equal(parsed.design.constructs[0].features.length, 2000);
  // This generous CPU guard detects pathological growth, not a native UI benchmark.
  assert.ok(performance.now() - before < 10_000);
});

test("one-megabase fixture uses bounded sequence windows with full-coordinate slicing", () => {
  const parsed = parseDesignIr(toyIr(2000, 500));
  assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
  const construct = parsed.design.constructs[0];
  const window = dnaWindowProjection(construct, 567_890);
  assert.equal(window.sequence.length, DNA_SEQUENCE_WINDOW_BASES);
  assert.equal(window.sequence, construct.sequence.slice(window.start, window.end));
  assert.ok(window.annotations.every((annotation) => annotation.start >= 0 && annotation.end <= DNA_SEQUENCE_WINDOW_BASES));
  assert.equal(dnaWindowProjection(construct, 999_999).end, 1_000_000);
});

test("dense window interval rendering is bounded without changing the full artifact", () => {
  const parsed = parseDesignIr(toyIr(1000, 5));
  const construct = parsed.design.constructs[0];
  const window = dnaWindowProjection(construct, 0);
  assert.equal(window.annotations.length, DNA_WINDOW_MAX_INTERVALS);
  assert.equal(window.truncated, true);
  assert.equal(construct.features.length, 1000);
  assert.throws(() => dnaWindowProjection(construct, Number.NaN));
});
