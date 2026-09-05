import test from "node:test";
import assert from "node:assert/strict";
import {observeHarnessResult, observationProgressAction} from "../src/main/services/harness-observation-progress.ts";

const checkpoint = () => ({contract: {deliverables: [{path: "build/result.md", kind: "document"}], requiredReads: ["input.md"], evidenceRequirements: []}});
function observe(c, name, args, data, effect = "read") {
  observeHarnessResult(c, {id: Math.random().toString(), function: {name, arguments: JSON.stringify(args)}}, {tool: name, ok: true, data}, effect);
}
const read = (c, path = "input.md", sha = "a".repeat(64)) => observe(c, "workspace_read", {path}, {path, sha256: sha, content: "ignored when digest supplied", updated_at: new Date().toISOString()});

test("changing batches and order cannot create progress from unchanged individual reads", () => {
  const c = checkpoint();
  for (let n = 0; n < 15; n++) read(c, ["input.md", "review.md", "source.proto"][n % 3]);
  assert.equal(observationProgressAction(c), "repair");
  c.observationProgress.repairIssued = true; c.observationProgress.unchanged = 0;
  const resumed = JSON.parse(JSON.stringify(c));
  for (let n = 0; n < 8; n++) read(resumed, ["review.md", "input.md"][n % 2]);
  assert.equal(observationProgressAction(resumed), "stop");
  assert.equal(resumed.observationProgress.seen.length, 3);
});

test("three deliberate repeated checks with interleaved reads retain their full allowance", () => {
  const c = checkpoint();
  for (let n = 0; n < 3; n++) {observe(c, "proto_connectors_check", {}, {ok: true, observed_at: `time-${n}`, capabilities: ["read"]}); read(c);}
  assert.equal(observationProgressAction(c), "continue");
  assert.equal(c.observationProgress.unchanged, 4);
});

test("new source digests and declared obligations interrupt stale observation cycles", () => {
  const c = checkpoint(); for (let n = 0; n < 12; n++) read(c);
  read(c, "input.md", "b".repeat(64)); assert.equal(c.observationProgress.unchanged, 0);
  for (let n = 0; n < 12; n++) read(c, "input.md", "b".repeat(64));
  c.contract.deliverables.push({path: "build/second.md", kind: "document"}); read(c, "input.md", "b".repeat(64));
  assert.equal(observationProgressAction(c), "continue");
});

test("repeated source validation cannot reset progress through new timestamped artifact paths", () => {
  const c = checkpoint();
  for (let n = 0; n < 13; n++) observe(c, "proto_workflow_run", {path: "source.proto", out_dir: `build/run-${n}`}, {ok: true, _harnessInputs: {path: "source.proto", sha256: "a".repeat(64)}, artifacts: [`build/run-${n}/manifest.json`], _harnessArtifacts: [{path: `build/run-${n}/manifest.json`, sha256: String(n)}], created_at: String(n)}, "write");
  assert.equal(observationProgressAction(c), "repair");
});

test("raw pages remain observations by content/offset rather than ever-changing receipt handles", () => {
  const c = checkpoint();
  for (let n = 0; n < 13; n++) observe(c, "harness_read_result", {handle: `handle-${n}`, offset: 0}, {content: "same full raw page", offset: 0, next_offset: null});
  assert.equal(observationProgressAction(c), "repair");
  observe(c, "harness_read_result", {handle: "new", offset: 50}, {content: "new raw fields", offset: 50, next_offset: null});
  assert.equal(observationProgressAction(c), "continue");
});
