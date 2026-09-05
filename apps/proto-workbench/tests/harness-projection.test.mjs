import test from "node:test";
import assert from "node:assert/strict";
import { newestHarnessProjection, harnessEventDisplayStatus } from "../src/renderer/harness-projection.ts";

test("reopened paused checkpoint supersedes the last persisted generating event", () => {
  const event = { runId: "science", revision: 19, state: "generating", contextUsed: 9000 };
  const reopened = { runId: "science", revision: 20, state: "paused", resumable: true, contextUsed: 12000 };
  assert.equal(newestHarnessProjection("science", event, reopened), reopened);
});

test("delayed checkpoint read cannot undo a new completed event", () => {
  const stale = { runId: "science", revision: 20, state: "paused" };
  const complete = { runId: "science", revision: 27, state: "completed" };
  assert.equal(newestHarnessProjection("science", complete, stale), complete);
});

test("switching runs cannot briefly display a previous run's checkpoint", () => {
  const previous = { runId: "previous", revision: 99, state: "completed" };
  assert.equal(newestHarnessProjection("next", undefined, previous), undefined);
  assert.equal(newestHarnessProjection(undefined, previous), undefined);
});

test("legacy failed mission rows name paused or incomplete states without rewriting audit events", () => {
  for (const state of ["paused", "incomplete"]) {
    const event = {runId: "science", actor: "assistant", status: "failed", payload: {harness: {runId: "science", revision: 20, state}}};
    assert.equal(harnessEventDisplayStatus(event), state);
    assert.equal(event.status, "failed");
  }
});

test("tool payloads, cross-run data and conflicting completed states cannot relabel failures", () => {
  const event = {runId: "science", actor: "assistant", status: "failed", payload: {harness: {runId: "science", revision: 20, state: "paused"}}};
  for (const other of [
    {...event, actor: "tool"}, {...event, tool: "workspace_read"}, {...event, status: "running"},
    {...event, payload: {harness: {...event.payload.harness, runId: "another"}}},
    {...event, payload: {harness: {...event.payload.harness, revision: undefined}}},
    {...event, payload: {harness: {...event.payload.harness, state: "completed"}}},
  ]) assert.equal(harnessEventDisplayStatus(other), undefined);
});
