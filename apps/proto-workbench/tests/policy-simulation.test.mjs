import assert from "node:assert/strict";
import test from "node:test";

import { buildPolicySimulation, POLICY_SIMULATION_LIMITS } from "../src/main/services/policy-simulation.ts";

const WORKSPACE_URI = "file:///C:/workspace";

function environment(overrides = {}) {
  const base = {
    thread: {
      id: "thread-1",
      workspacePath: "C:\\workspace",
      title: "Decision Lab",
      mode: "act",
      modelId: "model-1",
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    },
    content: "Search PubMed, run the Python analysis, and update the reviewed report.",
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
    capabilities: {
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
    },
    toolNames: ["workspace_read", "workspace_propose_patch", "proto_pubmed_search", "proto_run_analysis"],
  };
  return { ...base, ...overrides };
}

test("Policy Simulation is stable, bounded, and never exposes an executable contract", async () => {
  const first = buildPolicySimulation(environment(), ["current", "plan-posture", "current"]);
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = buildPolicySimulation(environment(), ["current", "plan-posture"]);

  assert.equal(first.digest, second.digest);
  assert.equal(first.decisionId, second.decisionId);
  assert.notEqual(first.issuedAt, second.issuedAt);
  assert.equal(first.simulationOnly, true);
  assert.deepEqual(first.executedEffects, []);
  assert.deepEqual(first.scenarios.map((scenario) => scenario.id), ["current", "plan-posture"]);
  assert.match(first.boundary, /No scenario can launch a model/i);
});

test("Policy Simulation compares Plan, Act, network, and sandbox postures", () => {
  const report = buildPolicySimulation(environment(), [
    "plan-posture",
    "act-posture",
    "network-unavailable",
    "execution-unavailable",
    "isolated-execution-ready",
  ]);
  const scenario = (id) => report.scenarios.find((item) => item.id === id);

  assert.equal(scenario("current").state, "blocked");
  assert.equal(scenario("plan-posture").requirements.find((item) => item.id === "writes")?.state, "deferred");
  assert.equal(scenario("plan-posture").requirements.find((item) => item.id === "execution")?.state, "deferred");
  assert.equal(scenario("act-posture").requirements.find((item) => item.id === "writes")?.state, "approval-required");
  assert.equal(scenario("network-unavailable").requirements.find((item) => item.id === "network")?.state, "blocked");
  assert.equal(scenario("execution-unavailable").requirements.find((item) => item.id === "execution")?.state, "blocked");
  assert.equal(scenario("isolated-execution-ready").requirements.find((item) => item.id === "execution")?.state, "approval-required");
  assert.equal(scenario("isolated-execution-ready").wouldBeLaunchable, true);
  assert.ok(scenario("isolated-execution-ready").deltas.some((delta) => delta.requirementId === "execution" && delta.direction === "less-restrictive"));
});

test("trust drift, chat-only, and lockdown scenarios fail closed without mutating the baseline", () => {
  const input = environment();
  const snapshot = structuredClone(input);
  const report = buildPolicySimulation(input, ["workspace-drift", "model-chat-only", "strict-lockdown"]);
  const scenario = (id) => report.scenarios.find((item) => item.id === id);

  assert.equal(scenario("workspace-drift").requirements.find((item) => item.id === "workspace")?.state, "blocked");
  assert.equal(scenario("model-chat-only").requirements.find((item) => item.id === "model")?.state, "blocked");
  assert.equal(scenario("strict-lockdown").requirements.find((item) => item.id === "network")?.state, "blocked");
  assert.equal(scenario("strict-lockdown").requirements.find((item) => item.id === "writes")?.state, "blocked");
  assert.deepEqual(input, snapshot);
});

test("Policy Simulation rejects empty, oversized, excessive, and unknown inputs", () => {
  assert.throws(() => buildPolicySimulation(environment({ content: " " }), []), /non-empty mission goal/i);
  assert.throws(() => buildPolicySimulation(environment({ content: "x".repeat(POLICY_SIMULATION_LIMITS.maxGoalCharacters + 1) }), []), /limited/i);
  assert.throws(() => buildPolicySimulation(environment(), Array.from({ length: POLICY_SIMULATION_LIMITS.maxScenarios }, (_, index) => `unknown-${index}`)), /unknown scenario/i);
  assert.throws(() => buildPolicySimulation(environment(), ["not-real"]), /unknown scenario/i);
});
