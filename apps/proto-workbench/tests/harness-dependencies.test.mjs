import assert from "node:assert/strict";
import test from "node:test";
import { observedToolDependencies } from "../src/shared/harness-dependencies.ts";
import { projectRunExecution } from "../src/shared/run-execution.ts";

const call = id => ({id, type: "function", function: {name: "workspace_read", arguments: "{}"}});
const assistant = (...ids) => ({role: "assistant", content: "", tool_calls: ids.map(call)});
const result = id => ({role: "tool", content: "{}", tool_call_id: id});
test("dependencies follow observed prior results and never current-batch execution order", () => {
  const messages = [assistant("old"), result("old"), assistant("a", "b"), result("a"), result("b"), assistant("c", "d"), result("c")];
  assert.deepEqual(observedToolDependencies(messages, "d").callIds, ["a", "b"]);
  assert.deepEqual(observedToolDependencies(messages, "c").callIds, ["a", "b"]);
  assert.deepEqual(observedToolDependencies(messages, "absent").callIds, []);
  assert.deepEqual(observedToolDependencies([assistant("a", "b"), result("a"), assistant("c")], "c").callIds, ["a"]);
  assert.deepEqual(observedToolDependencies([{role: "user", content: "a result happened"}, assistant("c")], "c").callIds, []);
  const plan = assistant("plan"); plan.tool_calls[0].function.name = "harness_plan";
  assert.deepEqual(observedToolDependencies([assistant("a"), result("a"), plan, result("plan"), assistant("b")], "b").callIds, ["a"]);
});

const event = (id, callId, second, dependencies = [], extra = {}) => ({
  id, runId: "run", actor: "tool", stage: "design", title: id, summary: id, tool: "workspace_read", status: "completed",
  createdAt: `2026-09-04T00:00:0${second}.000Z`, completedAt: `2026-09-04T00:00:0${second}.500Z`,
  inputProvenance: [], outputArtifacts: [], evidenceIds: [],
  payload: {callId, harnessDependencies: {schema: "proto-workbench.observed-tool-results.v1", callIds: dependencies}}, ...extra,
});
test("persisted observed-result edges bind unique completed calls in the same run", () => {
  const events = [event("read", "a", 0), event("edit", "b", 1, ["a"]), event("verify", "c", 2, ["b"])];
  const projection = projectRunExecution(JSON.parse(JSON.stringify(events)));
  assert.deepEqual(projection.topologyEdges.map(edge => [edge.kind, edge.sourceStepId, edge.targetStepId]), [["execution", "read", "edit"], ["execution", "edit", "verify"]]);
  assert.equal(projection.quarantined.length, 0);
  for (const bad of [
    [events[0], event("bad", "d", 1, ["missing"])],
    [event("foreign", "a", 0, [], {runId: "other"}), events[1]],
    [event("unfinished", "a", 0, [], {completedAt: undefined}), events[1]],
    [event("late", "a", 0, [], {completedAt: "2026-09-04T00:00:05.000Z"}), events[1]],
    [events[0], event("duplicate", "a", 0), events[1]],
    [event("self", "a", 0, ["a"])],
  ]) {
    const blocked = projectRunExecution(bad);
    assert.equal(blocked.topologyEdges.length, 0);
    assert.ok(blocked.quarantined.some(item => item.kind === "execution-edge"));
  }
});
