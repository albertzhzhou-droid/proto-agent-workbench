import assert from "node:assert/strict";
import test from "node:test";
import { deriveRunStageStates } from "../src/renderer/stage-state.ts";

test("a failed plan marks untouched downstream stages as not reached", () => {
  const states = deriveRunStageStates([
    { stage: "goal", status: "completed" },
    { stage: "plan", status: "completed" },
    { stage: "plan", status: "failed" },
  ]);

  assert.deepEqual(states, {
    goal: "completed",
    plan: "failed",
    design: "blocked",
    validate: "blocked",
    review: "blocked",
  });
});

test("cancelled stages remain distinct while rejected stages are failures", () => {
  const cancelled = deriveRunStageStates([{ stage: "design", status: "cancelled" }]);
  const rejected = deriveRunStageStates([{ stage: "design", status: "rejected" }]);

  assert.equal(cancelled.design, "cancelled");
  assert.equal(rejected.design, "failed");
  assert.equal(cancelled.validate, "blocked");
});

test("startup interruption and unknown side effects remain distinct", () => {
  const interrupted = deriveRunStageStates([{ stage: "plan", status: "interrupted" }]);
  const unknown = deriveRunStageStates([{ stage: "validate", status: "effect-unknown" }]);

  assert.equal(interrupted.plan, "interrupted");
  assert.equal(interrupted.design, "blocked");
  assert.equal(unknown.validate, "effect-unknown");
  assert.equal(unknown.review, "blocked");
});

test("later stages with activity retain their own state after an earlier failure", () => {
  const states = deriveRunStageStates([
    { stage: "plan", status: "failed" },
    { stage: "validate", status: "completed" },
  ]);

  assert.equal(states.design, "blocked");
  assert.equal(states.validate, "completed");
  assert.equal(states.review, "blocked");
});

test("an active event exposes a running stage even when earlier events completed", () => {
  const states = deriveRunStageStates([
    { stage: "plan", status: "completed" },
    { stage: "design", status: "completed" },
    { stage: "design", status: "running" },
  ]);

  assert.equal(states.plan, "completed");
  assert.equal(states.design, "running");
  assert.equal(states.validate, "pending");
});

test("a recovered stage uses its latest meaningful result while retaining failed ledger events", () => {
  const states = deriveRunStageStates([
    { stage: "plan", status: "completed", actor: "assistant", title: "Agent plan started" },
    { stage: "design", status: "failed", actor: "tool", title: "Propose Patch" },
    { stage: "design", status: "completed", actor: "tool", title: "Propose Patch" },
  ]);

  assert.equal(states.plan, "completed");
  assert.equal(states.design, "completed");
  assert.equal(states.validate, "pending");
});

test("durable patch operations override stale downstream event states", () => {
  const events = [
    { stage: "goal", status: "completed" },
    { stage: "plan", status: "completed" },
    { stage: "design", status: "completed" },
    { stage: "validate", status: "completed" },
    { stage: "review", status: "completed" },
  ];
  const lifecycle = (state, attention, label) => ({
    state,
    attention,
    label,
    detail: label,
    terminal: false,
  });

  assert.deepEqual(
    deriveRunStageStates(events, lifecycle("applying-patch", "patch-operation", "Applying reviewed patch")),
    {
      goal: "completed",
      plan: "completed",
      design: "running",
      validate: "blocked",
      review: "blocked",
    },
  );
  assert.deepEqual(
    deriveRunStageStates(events, lifecycle("effect-unknown", "recovery", "Patch effect needs reconciliation")),
    {
      goal: "completed",
      plan: "completed",
      design: "effect-unknown",
      validate: "blocked",
      review: "blocked",
    },
  );
  assert.deepEqual(
    deriveRunStageStates(events, lifecycle("interrupted", "recovery", "Patch applied; validation needs attention")),
    {
      goal: "completed",
      plan: "completed",
      design: "completed",
      validate: "interrupted",
      review: "blocked",
    },
  );
});
