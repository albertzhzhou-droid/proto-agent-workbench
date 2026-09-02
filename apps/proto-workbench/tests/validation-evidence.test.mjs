import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  validationStepEvidenceSha256,
  validationToolOutputBindingMatches,
} from "../src/main/services/validation-evidence.ts";

function event() {
  const output = { ok: true, artifacts: ["build/run/manifest.json"], summary: "Verified" };
  return {
    id: "event-1",
    runId: "run-1",
    stage: "validate",
    actor: "tool",
    title: "Workflow provenance verified",
    summary: "Artifact digests matched.",
    tool: "proto_provenance_verify",
    inputProvenance: [],
    outputArtifacts: ["build/run/manifest.json"],
    evidenceIds: ["provenance-v1"],
    status: "completed",
    createdAt: "2026-08-31T00:00:00.000Z",
    completedAt: "2026-08-31T00:00:01.000Z",
    payload: {
      output,
      outputSha256: createHash("sha256").update(JSON.stringify(output)).digest("hex"),
    },
  };
}

test("validation evidence digest is reproducible from the durable event", () => {
  const value = event();
  assert.match(validationStepEvidenceSha256(value), /^[a-f0-9]{64}$/);
  assert.equal(validationToolOutputBindingMatches(value), true);
  assert.equal(validationStepEvidenceSha256(structuredClone(value)), validationStepEvidenceSha256(value));
});

test("mutated tool output cannot satisfy its stored output digest", () => {
  const value = event();
  value.payload.output.artifacts.push("build/run/unrecorded.json");
  assert.equal(validationToolOutputBindingMatches(value), false);
});
