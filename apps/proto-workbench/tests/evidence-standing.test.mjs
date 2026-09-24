import assert from "node:assert/strict";
import test from "node:test";
import { readEvidenceStanding } from "../src/shared/evidence-standing.ts";

test("evidence standing preserves independent axes without inferring eligibility or review", () => {
  for (const dataOrigin of ["fixture", "synthetic", "imported", "governed-snapshot", "unknown"]) {
    const standing = { dataOrigin, methodMaturity: "not-established", executionStatus: "completed", humanReview: "required" };
    assert.deepEqual(readEvidenceStanding(standing), standing);
    assert.equal(readEvidenceStanding(standing).eligibility, undefined);
  }
});

test("unknown and malformed standing remains absent instead of acquiring defaults", () => {
  assert.equal(readEvidenceStanding(undefined), undefined);
  assert.equal(readEvidenceStanding({ dataOrigin: "fixture" }), undefined);
  assert.equal(readEvidenceStanding({ dataOrigin: "fixture", methodMaturity: "not-established", executionStatus: "completed", humanReview: "required", eligibility: "safe" }), undefined);
});
