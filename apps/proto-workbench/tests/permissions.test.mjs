import assert from "node:assert/strict";
import test from "node:test";
import { classifyTool, classifyToolCall, isToolExposedToModel, evaluateToolPolicy } from "../src/main/services/permissions.ts";

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

const now = new Date("2026-09-23T12:00:00Z");
const grant = (surface) => ({id:"user-grant",source:surface === "chat" ? "session-send" : "mission",actor:"user",surface,scopeId:"scope",risks:["network","code-execution"],grantedAt:"2026-09-23T11:00:00Z",expiresAt:"2026-09-23T13:00:00Z"});
const decide = (surface, tool, grants, extra={}) => evaluateToolPolicy({surface,tool,args:{},scopeId:"scope",operationId:"operation",grants,now,...extra});

test("Chat and Harness require the same explicit risk grants", () => {
  for (const surface of ["chat","harness"]) {
    for (const tool of ["proto_pubmed_search","proto_run_analysis"]) {
      assert.equal(decide(surface,tool,[]).code,"POLICY_DENIED");
      const authorization = grant(surface), decision=decide(surface,tool,[authorization]);
      assert.equal(decision.allowed,true);
      assert.equal(decision.grantId,authorization.id);
      assert.deepEqual(decision.grant,authorization);
      authorization.risks.length=0;
      assert.equal(decision.grant.risks.length,2,"decision retains a snapshot of authorized risks");
    }
  }
});

test("expired, future, malformed, other-scope and other-surface grants cannot authorize a call", () => {
  for (const change of [{expiresAt:now.toISOString()},{grantedAt:"2027-01-01"},{expiresAt:"invalid"},{scopeId:"other"},{surface:"harness"}]) {
    assert.equal(decide("chat","proto_pubmed_search",[{...grant("chat"),...change}]).code,"POLICY_DENIED");
  }
  assert.equal(decide("chat","shell_exec",[grant("chat")]).code,"UNKNOWN_CAPABILITY");
  assert.equal(decide("chat","proto_remote_catalog",[grant("chat")]).code,"POLICY_DENIED");
  assert.equal(decide("harness","proto_compute_run",[],{mode:"plan"}).code,"PLAN_MODE_READ_ONLY");
});

test("offline exemption only applies to tools whose contract supports offline execution", () => {
  assert.equal(decide("chat","proto_pubmed_search",[],{args:{offline:true}}).allowed,true);
  for (const tool of ["proto_remote_run","proto_structure_fetch","proto_structure_search"]) {
    assert.equal(decide("chat",tool,[],{args:{offline:true}}).code,"POLICY_DENIED");
  }
});
