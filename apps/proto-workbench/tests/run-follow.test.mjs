import assert from "node:assert/strict";
import test from "node:test";
import { shouldFollowNewRun } from "../src/renderer/run-follow.ts";

const goalEvent = {
  id: "goal-2",
  runId: "run-2",
  stage: "goal",
  actor: "user",
  title: "Goal defined",
  summary: "New task",
  inputProvenance: [],
  outputArtifacts: [],
  evidenceIds: [],
  status: "completed",
  createdAt: "2026-07-13T00:00:00.000Z",
};

test("a newly started user run becomes the foreground run", () => {
  assert.equal(shouldFollowNewRun("run-1", goalEvent), true);
});

test("updates from background or already selected runs do not steal focus", () => {
  assert.equal(shouldFollowNewRun("run-2", goalEvent), false);
  assert.equal(shouldFollowNewRun("run-1", { ...goalEvent, stage: "plan", actor: "assistant" }), false);
});
