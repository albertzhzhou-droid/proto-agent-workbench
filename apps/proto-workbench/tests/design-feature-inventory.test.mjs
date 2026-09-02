import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFeatureInventory,
  featureInventoryTypes,
  MAX_FEATURE_FILTER_QUERY_CHARS,
  normalizeFeatureFilterQuery,
} from "../src/renderer/design-feature-inventory.ts";

const features = [
  feature("promoter-a", "Alpha promoter", "promoter", "part", 20, 40),
  feature("orf-z", "Zeta ORF", "orf", "software", 5, 95),
  feature("cds-b", "Beta CDS", "CDS", "annotation", 40, 70),
  feature("primer-2", null, "primer", "annotation", 72, 82),
];

test("feature inventory filters by bounded query, type, and source without losing canonical indexes", () => {
  assert.equal(normalizeFeatureFilterQuery(`  ${"x".repeat(200)}  `).length, MAX_FEATURE_FILTER_QUERY_CHARS);

  const result = buildFeatureInventory(features, {
    query: "beta",
    type: "cds",
    source: "annotation",
    sortKey: "coordinate",
    sortDirection: "asc",
  });

  assert.deepEqual(result.map((entry) => ({ id: entry.feature.id, index: entry.featureIndex })), [
    { id: "cds-b", index: 2 },
  ]);
  assert.deepEqual(featureInventoryTypes(features), ["CDS", "orf", "primer", "promoter"]);
});

test("feature inventory sorting is stable, reversible, and keeps hidden rows discoverable", () => {
  const hidden = new Set([1]);
  const byLength = buildFeatureInventory(features, {
    query: "",
    type: "all",
    source: "all",
    sortKey: "length",
    sortDirection: "desc",
    hiddenFeatureIndexes: hidden,
  });
  assert.deepEqual(byLength.map((entry) => entry.feature.id), ["orf-z", "cds-b", "promoter-a", "primer-2"]);
  assert.equal(byLength[0].hidden, true);

  const byName = buildFeatureInventory(features, {
    query: "",
    type: "all",
    source: "all",
    sortKey: "name",
    sortDirection: "asc",
  });
  assert.deepEqual(byName.map((entry) => entry.feature.id), ["promoter-a", "cds-b", "primer-2", "orf-z"]);
});

function feature(id, name, type, source, start, end) {
  return {
    id,
    name,
    type,
    source,
    sequence: "A".repeat(end - start),
    length: end - start,
    gcFraction: 0,
    gcPercent: 0,
    direction: 1,
    color: "#000000",
    segments: [{ start, end, designStart: start, designEnd: end, length: end - start }],
    wrapsOrigin: false,
  };
}
