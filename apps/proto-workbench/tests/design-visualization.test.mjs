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

async function toggleSwitchIr() {
  return JSON.parse(await readFile(resolve("..", "..", "build", "toggle_switch.ir.json"), "utf8"));
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

test("protein IR uses an isolated amino-acid domain with bounded metrics", () => {
  const sequence = "MKTWVDEFGH";
  const sequenceSha256 = createHash("sha256").update(sequence).digest("hex");
  const ir = {
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
      source: { provider: "fixture", record_id: "fixture", release: "test", url: "https://example.invalid/fixture" },
      license: { id: "CC0-1.0", redistribution_status: "REDISTRIBUTABLE" },
      metrics: { length_aa: sequence.length, hydrophobic_fraction: 0.4, composition: { M: 1, K: 1, T: 1, W: 1, V: 1, D: 1, E: 1, F: 1, G: 1, H: 1 } },
    }],
    constructs: [],
    constraints: [],
    provenance: { source: "build/protein_fixture.selection.json", snapshot_id: "fixture", selection_digest: "a".repeat(64) },
  };
  const result = parseDesignIr(ir);
  assert.equal(result.ok, true);
  assert.ok(result.design);
  assert.equal(result.design.domain, "protein");
  assert.equal(result.design.constructs.length, 0);
  assert.equal(result.design.proteins[0].length, sequence.length);
  assert.equal(result.design.proteins[0].sequenceSha256, sequenceSha256);
  assert.equal(result.design.length, sequence.length);
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
