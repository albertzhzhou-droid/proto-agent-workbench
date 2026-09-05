import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateProteinMetrics,
  calculateLegacyProteinMetrics,
  proteinPropertyBins,
  extractProteinRange,
  PROTEIN_VISUALIZATION_LIMITS,
  searchProteins,
  validateProteinRange,
} from "../src/renderer/protein-sequence.ts";

function protein(overrides = {}) {
  const sequence = overrides.sequence ?? "AAAA";
  return {
    id: "uniprot:P00001",
    resourceId: "uniprot:P00001",
    name: "Alpha protein",
    sequence,
    sequenceSha256: "a".repeat(64),
    description: null,
    descriptionZh: null,
    source: { provider: "fixture", record_id: "SOURCE-ALPHA", url: "https://example.invalid/alpha", content_sha256: "a".repeat(64) },
    license: { id: "CC0-1.0", redistribution_status: "REDISTRIBUTABLE" },
    start: 0,
    end: sequence.length,
    length: sequence.length,
    metrics: calculateProteinMetrics(sequence),
    ...overrides,
  };
}

test("protein ranges are 1-based inclusive at input and bounded at extraction", () => {
  assert.deepEqual(validateProteinRange(2, 4, 5), { ok: true, range: { start: 1, end: 4 } });
  assert.equal(extractProteinRange("ABCDE", { start: 1, end: 4 }), "BCD");
  assert.equal(validateProteinRange(0, 4, 5).ok, false);
  assert.equal(validateProteinRange(4, 2, 5).ok, false);
  assert.equal(validateProteinRange(1, 6, 5).ok, false);
  assert.equal(validateProteinRange(1, PROTEIN_VISUALIZATION_LIMITS.maxSelectedResidues + 1, PROTEIN_VISUALIZATION_LIMITS.maxSelectedResidues + 1).ok, false);
  assert.equal(extractProteinRange("ABCDE", { start: -1, end: 4 }), undefined);
});

test("ambiguous residues have no fabricated mass", () => {
  assert.deepEqual(calculateProteinMetrics("AVDEBX"), {
    lengthAa: 6,
    molecularWeightDaApprox: null,
    algorithm: "proto.protein-metrics.v2",
    massStatus: "unavailable",
    massReason: "Unknown residue mass: B, X",
    composition: { A: 1, B: 1, D: 1, E: 1, V: 1, X: 1 },
    hydrophobicFraction: 0.333333,
    chargedFraction: 0.333333,
    ambiguousOrSpecialFraction: 0.333333,
  });
});

test("average masses agree with independent Biopython reference values", () => {
  for (const [sequence, expected] of [["A", 89.093], ["AA", 160.171], ["AGC", 249.287], ["U", 168.053], ["O", 255.313]]) {
    assert.equal(calculateProteinMetrics(sequence).molecularWeightDaApprox, expected);
  }
  assert.equal(calculateLegacyProteinMetrics("AGC").molecularWeightDaApprox, 195.24);
  for (const symbol of ["X", "B", "Z", "J", "*", "-"]) assert.equal(calculateProteinMetrics(`AG${symbol}`).molecularWeightDaApprox, null);
  assert.throws(() => calculateProteinMetrics(""), /non-empty/);
});

test("positional residue tracks are bounded and preserve exact bin intervals", () => {
  const bins = proteinPropertyBins("AVDEK".repeat(1000), 80);
  assert.ok(bins.length <= 80);
  assert.equal(bins[0].start, 0);
  assert.equal(bins.at(-1).end, 5000);
  assert.equal(bins.reduce((sum, bin) => sum + bin.end - bin.start, 0), 5000);
  assert.throws(() => proteinPropertyBins("AV", 0), /budget/);
});

test("protein search covers ID, name, source record, and overlapping sequence motifs", () => {
  const records = [protein(), protein({ id: "refseq:NP_2", name: "Beta enzyme", source: { provider: "fixture", record_id: "SOURCE-BETA", url: "https://example.invalid/beta", content_sha256: "b".repeat(64) }, sequence: "MAMAMA", length: 6, end: 6, metrics: calculateProteinMetrics("MAMAMA") })];
  assert.deepEqual(searchProteins(records, "P00001").matches.map((match) => match.field), ["id"]);
  assert.deepEqual(searchProteins(records, "beta enzyme").matches.map((match) => match.field), ["name"]);
  assert.deepEqual(searchProteins(records, "source-beta").matches.map((match) => match.field), ["source_record"]);
  assert.deepEqual(searchProteins(records, "AAA").matches.map((match) => [match.field, match.start, match.end]), [
    ["sequence", 0, 3],
    ["sequence", 1, 4],
  ]);
  assert.deepEqual(searchProteins(records, "mam").matches.filter((match) => match.field === "sequence").map((match) => match.start), [0, 2]);
});

test("single-residue search and global result limits have accurate truncation state", () => {
  const result = searchProteins([protein({ sequence: "A".repeat(1_000), length: 1_000, end: 1_000, metrics: calculateProteinMetrics("A".repeat(1_000)) })], "A");
  assert.equal(result.matches.length, PROTEIN_VISUALIZATION_LIMITS.maxSearchMatches);
  assert.equal(result.truncated, true);
  assert.ok(result.matches.some((match) => match.field === "sequence" && match.start === 0));
  assert.ok(result.matches.every((match) => ["id", "name", "source_record", "sequence"].includes(match.field)));
});
