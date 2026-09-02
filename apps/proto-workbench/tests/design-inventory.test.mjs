import assert from "node:assert/strict";
import test from "node:test";

import { groupDesignArtifacts } from "../src/renderer/design-inventory.ts";

function artifact(path, overrides = {}) {
  return {
    path,
    modifiedAt: "2026-08-30T12:00:00.000Z",
    status: "ready",
    sha256: "a".repeat(64),
    ...overrides,
  };
}

test("groups byte-identical ready artifacts and prefers a digest-matched representative", () => {
  const grouped = groupDesignArtifacts([
    artifact("build/newer.ir.json", { modifiedAt: "2026-08-30T14:00:00.000Z" }),
    artifact("build/linked.ir.json", { modifiedAt: "2026-08-30T13:00:00.000Z", provenance: { runId: "run-1" } }),
    artifact("build/matched.ir.json", { modifiedAt: "2026-08-30T11:00:00.000Z", digestBinding: { status: "match" } }),
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].path, "build/matched.ir.json");
  assert.equal(grouped[0].copyCount, 3);
});

test("keeps digest mismatches, invalid files, and distinct bytes individually visible", () => {
  const grouped = groupDesignArtifacts([
    artifact("build/normal.ir.json"),
    artifact("build/mismatch.ir.json", { digestBinding: { status: "mismatch" } }),
    artifact("build/invalid.ir.json", { status: "invalid" }),
    artifact("build/distinct.ir.json", { sha256: "b".repeat(64) }),
  ]);

  assert.deepEqual(grouped.map((item) => item.path), [
    "build/normal.ir.json",
    "build/mismatch.ir.json",
    "build/invalid.ir.json",
    "build/distinct.ir.json",
  ]);
  assert.ok(grouped.every((item) => item.copyCount === 1));
});

test("invalid dates and Unicode-equivalent paths still choose a stable representative", () => {
  const first = artifact("build/é.ir.json", { modifiedAt: "invalid" });
  const second = artifact("build/e\u0301.ir.json", { modifiedAt: "also-invalid" });
  const forward = groupDesignArtifacts([first, second]);
  const reverse = groupDesignArtifacts([second, first]);

  assert.equal(forward[0].path, reverse[0].path);
  assert.equal(forward[0].copyCount, 2);
});
