import assert from "node:assert/strict";
import test from "node:test";

import {
  digestBindingForArtifact,
  normalizeWorkspaceRelativePath,
  parseDesignRunManifest,
  parseDesignProvenanceStatement,
  provenanceForArtifact,
  summarizeDesignProvenanceInventory,
} from "../src/renderer/design-artifacts.ts";

const validManifest = {
  schema_version: "proto-agent.run.v1",
  run_id: "toggle_switch-20260830T220000Z",
  created_at: "20260830T220000Z",
  inputs: { design: "C:\\workspace\\designs\\toggle_switch.proto" },
  steps: [
    { id: "check", ok: true, required: true, skipped: false },
    { id: "compile", ok: true, required: true, skipped: false },
  ],
  artifacts: ["build\\runs\\toggle_switch-20260830T220000Z\\toggle_switch.ir.json"],
  review_status: "human_review_required",
  summary: "Software checks passed; human review remains required.",
  ok: true,
};

test("run manifests normalize artifact paths and retain the review boundary", () => {
  const result = parseDesignRunManifest(validManifest, "build/runs/toggle_switch-20260830T220000Z/manifest.json");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.manifest.runId, validManifest.run_id);
  assert.equal(result.manifest.reviewStatus, "human_review_required");
  assert.equal(result.manifest.binding, "path-only");
  assert.equal(result.manifest.sourcePath, validManifest.inputs.design);
  assert.deepEqual(result.manifest.artifactPaths, ["build/runs/toggle_switch-20260830t220000z/toggle_switch.ir.json"]);
  assert.deepEqual(result.manifest.steps.map((step) => step.id), ["check", "compile"]);
});

test("artifact provenance only binds to a manifest that explicitly inventories the artifact", () => {
  const result = parseDesignRunManifest(validManifest, "build/runs/toggle_switch-20260830T220000Z/manifest.json");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    provenanceForArtifact("BUILD/RUNS/toggle_switch-20260830T220000Z/toggle_switch.ir.json", [result.manifest])?.runId,
    validManifest.run_id,
  );
  assert.equal(provenanceForArtifact("build/toggle_switch.ir.json", [result.manifest]), undefined);
});

test("malformed manifests fail closed instead of providing partial provenance", () => {
  assert.deepEqual(
    parseDesignRunManifest({ ...validManifest, schema_version: "unknown" }, "manifest.json"),
    { ok: false, error: "The file is not a proto-agent.run.v1 manifest." },
  );
  assert.deepEqual(
    parseDesignRunManifest({ ...validManifest, steps: [{ id: "compile", ok: "yes" }] }, "manifest.json"),
    { ok: false, error: "The run manifest contains a malformed workflow step." },
  );
});

test("workspace path normalization is separator and case stable", () => {
  assert.equal(normalizeWorkspaceRelativePath(".\\Build\\Runs\\A\\x.ir.json"), "build/runs/a/x.ir.json");
});

test("provenance statements bind the current artifact digest and size", () => {
  const sha256 = "a".repeat(64);
  const parsed = parseDesignProvenanceStatement({
    schema_version: "proto-agent.provenance.v1",
    run_id: "run-1",
    subject: { path: "runs/run-1/manifest.json", sha256: "b".repeat(64), size: 100 },
    artifacts: [{ path: "runs/run-1/design.ir.json", sha256, size: 42 }],
  }, "build/runs/run-1/provenance.json");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(digestBindingForArtifact("build/runs/run-1/design.ir.json", sha256, 42, [parsed.statement])?.status, "match");
  assert.equal(digestBindingForArtifact("build/runs/run-1/design.ir.json", "c".repeat(64), 42, [parsed.statement])?.status, "mismatch");
  assert.equal(digestBindingForArtifact("build/runs/run-2/design.ir.json", sha256, 42, [parsed.statement]), undefined);
});

test("malformed provenance digest records fail closed", () => {
  const parsed = parseDesignProvenanceStatement({
    schema_version: "proto-agent.provenance.v1",
    run_id: "run-1",
    subject: { sha256: "b".repeat(64) },
    artifacts: [{ path: "runs/run-1/design.ir.json", sha256: "not-a-digest", size: 42 }],
  }, "provenance.json");
  assert.deepEqual(parsed, { ok: false, error: "The provenance statement contains a malformed artifact digest record." });
});

test("provenance inventory preserves failed candidates and distinguishes a complete unlinked scan", () => {
  const statement = {
    statementPath: "build/runs/run-1/provenance.json",
    runId: "run-1",
    subjectSha256: "b".repeat(64),
    artifacts: [{ path: "runs/run-1/design.ir.json", sha256: "a".repeat(64), sizeBytes: 42 }],
  };

  assert.deepEqual(summarizeDesignProvenanceInventory([]), {
    complete: true,
    statements: [],
    diagnostics: [],
  });
  assert.deepEqual(summarizeDesignProvenanceInventory([
    { path: statement.statementPath, statement },
    { path: "build/runs/run-2/provenance.json", error: "The file is not valid JSON." },
  ]), {
    complete: false,
    statements: [statement],
    diagnostics: [{ path: "build/runs/run-2/provenance.json", message: "The file is not valid JSON." }],
  });
});
