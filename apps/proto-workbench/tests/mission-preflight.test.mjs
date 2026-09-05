import assert from "node:assert/strict";
import test from "node:test";

import { buildMissionPreflight, classifyMissionIntent } from "../src/main/services/mission-preflight.ts";
import { parseCapabilities } from "../src/main/services/mcp-client.ts";

const WORKSPACE_URI = "file:///C:/workspace";

test("controlled scientific workflows and local searches do not request arbitrary code or network access", () => {
  assert.deepEqual(classifyMissionIntent("Search local materials, run workflow and review, compile and export the design"), {network:false,writes:true,execution:false});
  assert.equal(classifyMissionIntent("Read the Python script without executing it").execution,false);
  assert.equal(classifyMissionIntent("Run the Python script").execution,true);
  assert.equal(classifyMissionIntent("Search PubMed online").network,true);
  assert.equal(classifyMissionIntent("Search cached PubMed results offline only").network,false);
});

function inputs(overrides = {}) {
  const base = {
    thread: {
      id: "thread-1",
      workspacePath: "C:\\workspace",
      title: "Mission",
      mode: "act",
      modelId: "model-1",
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    },
    content: "Review the local evidence and prepare a concise answer.",
    attachments: [],
    model: {
      id: "model-1",
      name: "Local Agent",
      path: "C:\\models\\agent.gguf",
      files: ["C:\\models\\agent.gguf"],
      sizeBytes: 1,
      architecture: "fixture",
      quantization: "Q4",
      contextLength: 32768,
      vision: false,
      toolCapability: "agent-ready",
      fingerprint: "f".repeat(64),
      estimatedVramBytes: 1,
      loadState: "active",
      pinned: false,
      metadataSource: "filename",
    },
    runtime: { available: true, path: "C:\\runtime\\llama-server.exe", backend: "cuda", detail: "Ready" },
    moduleIntegrity: {
      ok: true,
      enforced: true,
      manifestPath: "module-manifest.json",
      manifestSha256: "a".repeat(64),
      checkedAt: "2026-08-31T00:00:00.000Z",
      modules: [{
        moduleId: "core.audit",
        version: 1,
        core: true,
        status: "verified",
        disposition: "loaded",
        moduleSha256: "b".repeat(64),
        checkedArtifacts: 1,
        diagnostics: [],
      }],
    },
    visionModuleEnabled: false,
    workspaceUri: WORKSPACE_URI,
    capabilities: capabilities(),
    toolNames: [
      "workspace_read",
      "workspace_search",
      "workspace_propose_patch",
      "proto_pubmed_search",
      "proto_run_analysis",
    ],
  };
  return { ...base, ...overrides };
}

function capabilities(overrides = {}) {
  return {
    workspace: WORKSPACE_URI,
    execution: {
      mode: "disabled",
      available: false,
      configured: false,
      provider_visible: false,
      smoke_verified: false,
      image_digest_pinned: false,
      reason: "Configure a digest-pinned OCI sandbox.",
    },
    networkPaths: ["proto_pubmed_search"],
    networkEnabled: false,
    networkAuthorization: "per-call-hmac-capability",
    filesystemSafety: {
      relativePathsOnly: true,
      reparsePointsAllowed: false,
      atomicReplace: true,
      windowsResidualSameUserRenameRace: true,
    },
    ...overrides,
  };
}

test("a pure local mission is launchable and issuedAt is excluded from the stable digest", async () => {
  const first = buildMissionPreflight(inputs());
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = buildMissionPreflight(inputs());
  assert.equal(first.state, "ready");
  assert.equal(first.launchable, true);
  assert.equal(first.digest, second.digest);
  assert.notEqual(first.issuedAt, second.issuedAt);
});
test("launch digest binds the observed instance and loaded context while excluding transient metrics",()=>{
  const model={...inputs().model,workbenchInstance:{id:"instance-a",ownedByWorkbench:true,contextLength:32768}};
  const digest=buildMissionPreflight(inputs({model})).digest;
  assert.notEqual(buildMissionPreflight(inputs({model:{...model,workbenchInstance:{...model.workbenchInstance,id:"instance-b"}}})).digest,digest);
  assert.notEqual(buildMissionPreflight(inputs({model:{...model,workbenchInstance:{...model.workbenchInstance,contextLength:16384}}})).digest,digest);
  assert.equal(buildMissionPreflight(inputs({model:{...model,measuredVramBytes:999,lastUsedAt:"2026-09-05T00:00:00Z"}})).digest,digest);
  const observed={...model,workbenchInstance:{id:"instance-a",ownedByWorkbench:true},loadedInstances:[{id:"instance-a",contextLength:32768}]};
  assert.equal(buildMissionPreflight(inputs({model:observed})).digest,digest);
});

test("goal, mode, and attachment mutations invalidate the launch digest", () => {
  const base = buildMissionPreflight(inputs());
  const goal = buildMissionPreflight(inputs({ content: "Review a different local evidence set." }));
  const plan = buildMissionPreflight(inputs({ thread: { ...inputs().thread, mode: "plan" } }));
  const attachment = buildMissionPreflight(inputs({
    attachments: [{ path: "C:\\workspace\\evidence.md", name: "evidence.md", mediaType: "text/markdown", sizeBytes: 42 }],
  }));
  assert.notEqual(base.digest, goal.digest);
  assert.notEqual(base.digest, plan.digest);
  assert.notEqual(base.digest, attachment.digest);
});

test("Plan mode explicitly defers writes and code execution", () => {
  const report = buildMissionPreflight(inputs({
    thread: { ...inputs().thread, mode: "plan" },
    content: "Implement the update and run the Python script.",
  }));
  assert.equal(report.launchable, true);
  assert.equal(report.requirements.find((item) => item.id === "writes")?.state, "deferred");
  assert.equal(report.requirements.find((item) => item.id === "execution")?.state, "deferred");
});

test("Act mode exposes network and reviewed writes as approval-required", () => {
  const report = buildMissionPreflight(inputs({
    content: "Search PubMed, update the report, and save the reviewed patch.",
  }));
  assert.equal(report.state, "approval-required");
  assert.equal(report.requirements.find((item) => item.id === "network")?.state, "approval-required");
  assert.equal(report.requirements.find((item) => item.id === "writes")?.state, "approval-required");
});

test("Act execution blocks without a configured digest-pinned OCI sandbox", () => {
  const report = buildMissionPreflight(inputs({ content: "Run the Python analysis script." }));
  assert.equal(report.launchable, false);
  assert.equal(report.requirements.find((item) => item.id === "execution")?.state, "blocked");
});

test("Act execution becomes approval-required with a digest-pinned OCI boundary", () => {
  const report = buildMissionPreflight(inputs({
    content: "Run the Python analysis script.",
    capabilities: capabilities({
      execution: {
        mode: "oci",
        available: true,
        configured: true,
        provider_visible: true,
        smoke_verified: false,
        provider: "docker",
        image: "fixture@sha256:" + "c".repeat(64),
        image_digest_pinned: true,
      },
    }),
  }));
  assert.equal(report.state, "approval-required");
  assert.equal(report.requirements.find((item) => item.id === "execution")?.state, "approval-required");
  assert.match(report.warnings.join(" "), /not been smoke-verified/);
});

test("chat-only models and mismatched workspace capabilities fail closed", () => {
  const chatOnly = buildMissionPreflight(inputs({
    content: "Update the workspace report.",
    model: { ...inputs().model, toolCapability: "chat-only" },
  }));
  const mismatched = buildMissionPreflight(inputs({ capabilities: capabilities({ workspace: "file:///C:/other" }) }));
  assert.equal(chatOnly.requirements.find((item) => item.id === "model")?.state, "blocked");
  assert.equal(mismatched.requirements.find((item) => item.id === "workspace")?.state, "blocked");
});

test("MCP capability parsing rejects malformed or weakened capability reports", () => {
  assert.deepEqual(parseCapabilities(capabilities()), {
    ...capabilities(),
    execution: { ...capabilities().execution, provider: undefined, image: undefined },
  });
  assert.throws(() => parseCapabilities({ ...capabilities(), networkAuthorization: "none" }), /networkAuthorization/);
  assert.throws(() => parseCapabilities({ ...capabilities(), filesystemSafety: { relativePathsOnly: true } }), /filesystemSafety/);
  assert.throws(() => parseCapabilities({ ...capabilities(), execution: { ...capabilities().execution, mode: "host" } }), /execution.mode/);
});
