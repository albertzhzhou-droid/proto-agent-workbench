import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MAX_MATERIALS_DESIGN_SELECTION,
  MaterialsDesignSelectionError,
  assertDesignEligibleMaterial,
  createMaterialsDesignSelection,
  createMaterialsMaterializeRequest,
  mergeMaterialsSearchPages,
} from "../src/renderer/materials-design-selection.ts";

function material(resourceId, overrides = {}) {
  return {
    resource_id: resourceId,
    kind: "genetic_part",
    name: resourceId,
    aliases: [],
    description_en: "Reviewed test part",
    description_zh: "",
    organism: {},
    chassis: ["ecoli_k12", "cell_free"],
    role_terms: [],
    part_type: "promoter",
    sequence_kind: "DNA",
    sequence_length: 4,
    sequence_sha256: "a".repeat(64),
    source: {},
    license: {},
    evidence_refs: [],
    review_status: "DESIGN_ELIGIBLE",
    safety_status: "NO_FLAG",
    safety_flags: [],
    design_eligibility: true,
    metadata: {},
    ...overrides,
  };
}

function page(snapshotId, matches, matchCount, truncated, nextCursor) {
  return {
    ok: true,
    snapshot_id: snapshotId,
    matches,
    match_count: matchCount,
    returned_count: matches.length,
    truncated,
    ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
  };
}

function throwsCode(action, code) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof MaterialsDesignSelectionError);
    assert.equal(error.code, code);
    return true;
  });
}

test("builds a deterministic snapshot-bound selection and materialize request", () => {
  const selection = createMaterialsDesignSelection("public-reviewed-2026.09", [
    material("igem:z", { chassis: ["ecoli_k12"] }),
    material("igem:a", { chassis: ["cell_free", "ecoli_k12"] }),
  ]);

  assert.deepEqual(selection.resourceIds, ["igem:a", "igem:z"]);
  assert.deepEqual(selection.commonChassis, ["ecoli_k12"]);
  assert.deepEqual(createMaterialsMaterializeRequest(selection, "ecoli_k12"), {
    resource_ids: ["igem:a", "igem:z"],
    chassis: "ecoli_k12",
    snapshot: "public-reviewed-2026.09",
  });
});

test("deduplicates identical records but fails closed on canonical-ID collisions", () => {
  const first = material("igem:BBa_Test");
  const selection = createMaterialsDesignSelection("snapshot-1", [first, structuredClone(first)]);
  assert.equal(selection.materials.length, 1);

  throwsCode(
    () => createMaterialsDesignSelection("snapshot-1", [first, material("IGEM:bba_test")]),
    "DUPLICATE_CONFLICT",
  );
  throwsCode(
    () => createMaterialsDesignSelection("snapshot-1", [first, material("igem:BBa_Test", { sequence_length: 5 })]),
    "DUPLICATE_CONFLICT",
  );
});

test("enforces the fifty-distinct-material limit after deduplication", () => {
  const fifty = Array.from({ length: MAX_MATERIALS_DESIGN_SELECTION }, (_, index) => material(`igem:part_${index}`));
  assert.equal(createMaterialsDesignSelection("snapshot-1", [...fifty, structuredClone(fifty[0])]).materials.length, 50);
  throwsCode(
    () => createMaterialsDesignSelection("snapshot-1", [...fifty, material("igem:part_50")]),
    "SELECTION_LIMIT_EXCEEDED",
  );
});

test("rejects every material eligibility gate failure", () => {
  const rejected = [
    material("igem:protein", { kind: "protein_sequence" }),
    material("igem:rna", { sequence_kind: "RNA" }),
    material("igem:unsupported", { part_type: "plasmid" }),
    material("igem:review", { review_status: "REVIEW_REQUIRED" }),
    material("igem:eligibility", { design_eligibility: false }),
    material("igem:safety", { safety_status: "REVIEW_REQUIRED" }),
    material("igem:flags", { safety_flags: ["DUAL_USE_REVIEW"] }),
    material("igem:missing-flags", { safety_flags: undefined }),
  ];
  for (const candidate of rejected) {
    throwsCode(() => assertDesignEligibleMaterial(candidate), "INELIGIBLE_MATERIAL");
  }
});

test("search-page merge can retain non-DNA materials without making them selectable", () => {
  const protein = material("uniprot:P00001", {
    kind: "protein_sequence",
    sequence_kind: "PROTEIN",
    part_type: "",
    chassis: ["protein_sequence"],
  });
  const merged = mergeMaterialsSearchPages([page("snapshot-1", [protein], 1, false)]);
  assert.deepEqual(merged.matches, [protein]);
  throwsCode(() => createMaterialsDesignSelection("snapshot-1", merged.matches), "INELIGIBLE_MATERIAL");
});

test("requires a nonempty selection with at least one exact shared chassis", () => {
  throwsCode(() => createMaterialsDesignSelection("snapshot-1", []), "INVALID_SELECTION");
  throwsCode(
    () => createMaterialsDesignSelection("snapshot-1", [
      material("igem:first", { chassis: ["ecoli_k12"] }),
      material("igem:second", { chassis: ["cell_free"] }),
    ]),
    "NO_COMMON_CHASSIS",
  );
});

test("merges overlapping pages, deduplicates records, and preserves pagination state", () => {
  const first = material("igem:first");
  const second = material("igem:second");
  const third = material("igem:third");
  const merged = mergeMaterialsSearchPages([
    page("snapshot-1", [first, second], 3, true, "cursor-2"),
    page("snapshot-1", [structuredClone(second), third], 3, false),
  ]);

  assert.equal(merged.snapshot_id, "snapshot-1");
  assert.deepEqual(merged.matches.map((entry) => entry.resource_id), ["igem:first", "igem:second", "igem:third"]);
  assert.equal(merged.returned_count, 3);
  assert.equal(merged.match_count, 3);
  assert.equal(merged.truncated, false);
  assert.equal(merged.next_cursor, undefined);
});

test("page merge fails closed on snapshot, total, and duplicate-record disagreement", () => {
  const first = material("igem:first");
  throwsCode(
    () => mergeMaterialsSearchPages([
      page("snapshot-1", [first], 2, true, "cursor-1"),
      page("snapshot-2", [material("igem:second")], 2, false),
    ]),
    "SNAPSHOT_MISMATCH",
  );
  throwsCode(
    () => mergeMaterialsSearchPages([
      page("snapshot-1", [first], 2, true, "cursor-1"),
      page("snapshot-1", [material("igem:second")], 3, false),
    ]),
    "PAGE_TOTAL_MISMATCH",
  );
  throwsCode(
    () => mergeMaterialsSearchPages([
      page("snapshot-1", [first], 1, true, "cursor-1"),
      page("snapshot-1", [material("igem:first", { sequence_length: 5 })], 1, false),
    ]),
    "DUPLICATE_CONFLICT",
  );
});

test("materialize request rejects an unshared chassis and a modified selection", () => {
  const selection = createMaterialsDesignSelection("snapshot-1", [material("igem:first", { chassis: ["ecoli_k12"] })]);
  throwsCode(() => createMaterialsMaterializeRequest(selection, "cell_free"), "INVALID_CHASSIS");
  throwsCode(
    () => createMaterialsMaterializeRequest({ ...selection, resourceIds: ["igem:other"] }, "ecoli_k12"),
    "INVALID_SELECTION",
  );
});

test("Materials UI mutually excludes materialization and catalogue administration", async () => {
  const source = await readFile(new URL("../src/renderer/OperationalPages.tsx", import.meta.url), "utf8");
  const page = source.slice(source.indexOf("function MaterialsPage"), source.indexOf("function ReviewsPage"));
  assert.match(page, /const operationBusy = busy \|\| materializing;/);
  assert.doesNotMatch(page, /disabled=\{busy(?:\s|\||\})/);
  assert.doesNotMatch(page, /disabled=\{materializing(?:\s|\||\})/);
});
