import assert from "node:assert/strict";
import test from "node:test";
import { classifyTool, classifyToolCall, isToolExposedToModel } from "../src/main/services/permissions.ts";

test("read and deterministic Proto tools are automatically allowed", () => {
  assert.deepEqual(classifyTool("workspace_read"), { allowed: true, risk: "none" });
  assert.deepEqual(classifyTool("proto_workflow_run"), { allowed: true, risk: "none" });
  assert.deepEqual(classifyTool("proto_provenance_verify"), { allowed: true, risk: "none" });
  assert.equal(isToolExposedToModel("workspace_propose_patch"), true);
});

test("network, code execution, and unknown tools require explicit approval", () => {
  for (const tool of [
    "proto_pubmed_search",
    "proto_europe_pmc_search",
    "proto_crossref_search",
    "proto_uniprot_search",
    "proto_rhea_search",
  ]) {
    const permission = classifyTool(tool);
    assert.equal(permission.allowed, false);
    assert.equal(permission.risk, "network");
    assert.match(permission.reason, /external scientific database/i);
    assert.equal(isToolExposedToModel(tool), true);
  }
  assert.equal(classifyTool("proto_run_notebook").risk, "code-execution");
  assert.equal(classifyTool("shell_exec").allowed, false);
  assert.equal(isToolExposedToModel("shell_exec"), false);
});

test("offline scientific fixtures do not request a network approval", () => {
  assert.deepEqual(classifyToolCall("proto_europe_pmc_search", { offline: true }), { allowed: true, risk: "none" });
  assert.equal(classifyToolCall("proto_europe_pmc_search", { offline: false }).allowed, false);
  assert.equal(classifyToolCall("proto_europe_pmc_search", {}).allowed, false);
});

test("a patch proposal is safe but applying it is a write boundary", () => {
  assert.deepEqual(classifyTool("workspace_propose_patch"), { allowed: true, risk: "none" });
  assert.equal(classifyTool("workspace_apply_patch").risk, "write");
});
