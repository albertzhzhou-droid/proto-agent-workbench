import assert from "node:assert/strict";
import test from "node:test";
import { projectRunExecution } from "../src/shared/run-execution.ts";

const event = (overrides = {}) => ({
  id: overrides.id ?? "event-1",
  runId: overrides.runId ?? "run-1",
  stage: overrides.stage ?? "plan",
  actor: overrides.actor ?? "assistant",
  title: overrides.title ?? "Run step",
  summary: overrides.summary ?? "Durable run event",
  tool: overrides.tool,
  inputProvenance: overrides.inputProvenance ?? [],
  outputArtifacts: overrides.outputArtifacts ?? [],
  evidenceIds: overrides.evidenceIds ?? [],
  status: overrides.status ?? "completed",
  createdAt: overrides.createdAt ?? "2026-08-30T00:00:00.000Z",
  completedAt: overrides.completedAt,
});

test("steps use chronological order and preserve durable input sequence for equal timestamps", () => {
  const projection = projectRunExecution([
    event({ id: "z-later-id", createdAt: "2026-08-30T00:00:01.000Z" }),
    event({ id: "b-equal", createdAt: "2026-08-30T00:00:00.000Z" }),
    event({ id: "a-equal", createdAt: "2026-08-30T00:00:00.000Z" }),
  ]);

  assert.deepEqual(projection.steps.map((step) => step.id), ["b-equal", "a-equal", "z-later-id"]);
  assert.deepEqual(projection.steps.map((step) => step.ordinal), [0, 1, 2]);
});

test("legacy string artifacts remain visible and explicitly unbound", () => {
  const projection = projectRunExecution([
    event({
      id: "legacy",
      inputProvenance: ["designs/input.proto"],
      outputArtifacts: ["build/output.ir.json"],
      evidenceIds: ["evidence-7"],
    }),
  ]);

  assert.deepEqual(
    projection.artifacts.map(({ role, locator, binding }) => ({ role, locator, binding })),
    [
      { role: "input", locator: "designs/input.proto", binding: "unbound" },
      { role: "output", locator: "build/output.ir.json", binding: "unbound" },
      { role: "evidence", locator: "evidence-7", binding: "unbound" },
    ],
  );
  assert.deepEqual(projection.steps[0].artifactIds, projection.artifacts.map((artifact) => artifact.id));
});

test("an artifact topology edge requires explicit source-step metadata", () => {
  const events = [
    event({ id: "produce", outputArtifacts: ["build/shared.json"] }),
    event({
      id: "consume",
      createdAt: "2026-08-30T00:00:01.000Z",
      inputProvenance: ["build/shared.json"],
    }),
  ];
  const projection = projectRunExecution(events, {
    artifactRefs: [{
      id: "artifact-consume-input-0",
      stepId: "consume",
      role: "input",
      index: 0,
      locator: "build/shared.json",
      sourceStepId: "produce",
    }],
  });

  assert.equal(projection.artifacts.find((artifact) => artifact.stepId === "consume")?.binding, "declared");
  assert.deepEqual(projection.topologyEdges, [{
    id: "artifact:artifact-consume-input-0:produce->consume",
    kind: "artifact",
    sourceStepId: "produce",
    targetStepId: "consume",
    sourceRunId: "run-1",
    targetRunId: "run-1",
    artifactId: "artifact-consume-input-0",
    locator: "build/shared.json",
  }]);
  assert.deepEqual(projection.quarantined, []);
});

test("artifact bytes are digest-bound only when both SHA-256 and byte size are valid", () => {
  const projection = projectRunExecution([
    event({ id: "digest-step", outputArtifacts: ["build/output.json", "build/declared.json"] }),
  ], {
    artifactRefs: [
      {
        id: "digest-ref",
        stepId: "digest-step",
        role: "output",
        index: 0,
        locator: "build/output.json",
        sha256: "a".repeat(64),
        sizeBytes: 42,
      },
      {
        id: "declared-ref",
        stepId: "digest-step",
        role: "output",
        index: 1,
        locator: "build/declared.json",
      },
    ],
  });

  assert.deepEqual(
    projection.artifacts.map(({ binding, sha256, sizeBytes }) => ({ binding, sha256, sizeBytes })),
    [
      { binding: "digest-bound", sha256: "a".repeat(64), sizeBytes: 42 },
      { binding: "declared", sha256: undefined, sizeBytes: undefined },
    ],
  );
});

test("matching artifact locators never infer a topology edge", () => {
  const projection = projectRunExecution([
    event({ id: "produce", outputArtifacts: ["build/shared.json"] }),
    event({
      id: "consume",
      createdAt: "2026-08-30T00:00:01.000Z",
      inputProvenance: ["build/shared.json"],
    }),
  ]);

  assert.deepEqual(projection.topologyEdges, []);
  assert.deepEqual(projection.artifacts.map((artifact) => artifact.binding), ["unbound", "unbound"]);
});

test("a supplied persisted fork reference exposes cross-run lineage", () => {
  const projection = projectRunExecution([
    event({ id: "fork-start", runId: "run-child" }),
  ], {
    forkRefs: [{
      id: "fork-ref-1",
      sourceRunId: "run-parent",
      sourceStepId: "parent-review",
      targetRunId: "run-child",
      targetStepId: "fork-start",
      createdAt: "2026-08-30T00:00:00.000Z",
    }],
  });

  assert.deepEqual(projection.topologyEdges, [{
    id: "fork:fork-ref-1",
    kind: "fork",
    sourceStepId: "parent-review",
    targetStepId: "fork-start",
    sourceRunId: "run-parent",
    targetRunId: "run-child",
  }]);
});

test("dangling, self-referential, cyclic, and locator-mismatched relationships are quarantined", () => {
  const projection = projectRunExecution([
    event({ id: "step-a", inputProvenance: ["a.json", "self.json", "wrong.json"] }),
    event({ id: "step-b", createdAt: "2026-08-30T00:00:01.000Z", inputProvenance: ["b.json"] }),
  ], {
    artifactRefs: [
      { id: "edge-a", stepId: "step-a", role: "input", index: 0, locator: "a.json", sourceStepId: "step-b" },
      { id: "self-edge", stepId: "step-a", role: "input", index: 1, locator: "self.json", sourceStepId: "step-a" },
      { id: "wrong-locator", stepId: "step-a", role: "input", index: 2, locator: "other.json", sourceStepId: "step-b" },
      { id: "edge-b", stepId: "step-b", role: "input", index: 0, locator: "b.json", sourceStepId: "step-a" },
    ],
    forkRefs: [{
      id: "dangling-fork",
      sourceRunId: "run-parent",
      sourceStepId: "parent-step",
      targetRunId: "run-1",
      targetStepId: "missing-step",
    }],
  });

  assert.equal(projection.topologyEdges.length, 1);
  assert.equal(projection.topologyEdges[0].id, "artifact:edge-a:step-b->step-a");
  assert.deepEqual(
    projection.quarantined.map(({ kind, id }) => ({ kind, id })),
    [
      { kind: "artifact-reference", id: "wrong-locator" },
      { kind: "artifact-edge", id: "self-edge" },
      { kind: "artifact-edge", id: "edge-b" },
      { kind: "fork-edge", id: "dangling-fork" },
    ],
  );
});

test("duplicate event ids are projected once and explicitly quarantined", () => {
  const projection = projectRunExecution([
    event({ id: "same", title: "First" }),
    event({ id: "same", title: "Second", createdAt: "2026-08-30T00:00:01.000Z" }),
  ]);

  assert.deepEqual(projection.steps.map((step) => step.title), ["First"]);
  assert.deepEqual(projection.quarantined, [{
    kind: "duplicate-event",
    id: "same",
    reason: "A later event snapshot reused an existing step id and was excluded from the projection.",
  }]);
});
