import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMissionRecipe,
  buildMissionCapabilitySnapshot,
  buildMissionRecipe,
  buildResumeContract,
} from "../src/main/services/resume-contract.ts";

const now = "2026-08-31T14:00:00.000Z";
const workspaceIdentity = "a".repeat(64);

function environment(overrides = {}) {
  return {
    workspaceIdentity,
    model: {
      id: "model-1",
      name: "Local model",
      path: "C:/models/model.gguf",
      files: ["model.gguf"],
      sizeBytes: 100,
      architecture: "qwen",
      quantization: "Q4_K_M",
      contextLength: 32768,
      vision: false,
      toolCapability: "agent-ready",
      fingerprint: "b".repeat(64),
      estimatedVramBytes: 100,
      loadState: "active",
      pinned: false,
      metadataSource: "gguf",
    },
    runtime: { available: true, backend: "cuda", degraded: false, detail: "ready" },
    moduleIntegrity: {
      ok: true,
      enforced: true,
      manifestPath: "module-manifest.json",
      manifestSha256: "c".repeat(64),
      checkedAt: now,
      modules: [
        { moduleId: "core.audit", version: 1, core: true, status: "verified", disposition: "loaded", moduleSha256: "d".repeat(64), checkedArtifacts: 1, diagnostics: [] },
      ],
    },
    capabilities: {
      workspace: "file:///workspace",
      execution: {
        mode: "disabled",
        available: false,
        configured: false,
        provider_visible: false,
        smoke_verified: false,
        image_digest_pinned: false,
      },
      networkPaths: ["pubmed"],
      networkEnabled: true,
      networkAuthorization: "per-call-hmac-capability",
      filesystemSafety: {
        relativePathsOnly: true,
        reparsePointsAllowed: false,
        atomicReplace: true,
        windowsResidualSameUserRenameRace: true,
      },
    },
    toolNames: ["workspace_search", "proto_pubmed_search", "workspace_read"],
    ...overrides,
  };
}

function recipe(env = environment()) {
  return buildMissionRecipe({
    ...env,
    thread: {
      id: "thread-1",
      workspacePath: "C:/workspace",
      title: "Evidence recovery",
      mode: "plan",
      modelId: "model-1",
      createdAt: now,
      updatedAt: now,
    },
    goal: "  Search PubMed for evidence, then prepare a review plan.  ",
    createdAt: now,
  });
}

function checkpoint(missionRecipe) {
  const capturedRecipe = arguments.length === 0 ? recipe() : missionRecipe;
  return {
    id: "checkpoint-1",
    runId: "run-1",
    sourceThreadId: "thread-1",
    workspacePath: "C:/workspace",
    workspaceIdentity,
    sourceThread: {
      id: "thread-1",
      workspacePath: "C:/workspace",
      title: "Evidence recovery",
      mode: "plan",
      modelId: "model-1",
      createdAt: now,
      updatedAt: now,
    },
    messages: [],
    artifactRefs: [],
    historyHead: { sequence: 1, entrySha256: "e".repeat(64) },
    ...(capturedRecipe ? { missionRecipe: capturedRecipe } : {}),
    snapshotDigest: "f".repeat(64),
    createdAt: now,
  };
}

test("capability snapshots and Mission Recipes are normalized and content-addressed", () => {
  const left = buildMissionCapabilitySnapshot(environment());
  const right = buildMissionCapabilitySnapshot(environment({
    toolNames: ["workspace_read", "workspace_search", "proto_pubmed_search", "workspace_read"],
  }));
  assert.equal(left.digest, right.digest);
  assert.deepEqual(left.tools.names, ["proto_pubmed_search", "workspace_read", "workspace_search"]);
  assert.throws(() => buildMissionCapabilitySnapshot(environment({ toolNames: ["x".repeat(257)] })), /bounded tool names/);
  const saved = recipe();
  assert.equal(saved.goal, "Search PubMed for evidence, then prepare a review plan.");
  assert.deepEqual(saved.intent, { network: true, writes: false, execution: false });
  assert.doesNotThrow(() => assertMissionRecipe(saved));
  assert.throws(() => assertMissionRecipe({ ...saved, goal: "tampered" }), /does not match|malformed/);
});

test("an unchanged trusted environment issues a ready resume contract", () => {
  const saved = recipe();
  const contract = buildResumeContract(checkpoint(saved), buildMissionCapabilitySnapshot(environment()));
  assert.equal(contract.state, "ready");
  assert.equal(contract.launchable, true);
  assert.equal(contract.drift.every((item) => item.state === "stable"), true);
});

test("tool drift requires review without executing or mutating the checkpoint", () => {
  const saved = recipe();
  const current = buildMissionCapabilitySnapshot(environment({
    toolNames: ["workspace_read", "workspace_search", "proto_pubmed_search", "proto_crossref_search"],
  }));
  const frozenCheckpoint = checkpoint(saved);
  const before = structuredClone(frozenCheckpoint);
  const contract = buildResumeContract(frozenCheckpoint, current);
  assert.equal(contract.state, "review-required");
  assert.equal(contract.launchable, true);
  assert.equal(contract.drift.find((item) => item.id === "tools")?.state, "changed");
  assert.deepEqual(frozenCheckpoint, before);
});

test("workspace or filesystem trust drift blocks resume", () => {
  const saved = recipe();
  const unsafe = environment({ workspaceIdentity: "9".repeat(64) });
  unsafe.capabilities = {
    ...unsafe.capabilities,
    filesystemSafety: { ...unsafe.capabilities.filesystemSafety, atomicReplace: false },
  };
  const contract = buildResumeContract(checkpoint(saved), buildMissionCapabilitySnapshot(unsafe));
  assert.equal(contract.state, "blocked");
  assert.equal(contract.launchable, false);
  assert.equal(contract.drift.find((item) => item.id === "workspace")?.state, "blocked");
  assert.equal(contract.drift.find((item) => item.id === "filesystem")?.state, "blocked");
});

test("legacy checkpoints remain fork-reviewable but never pretend historical capabilities exist", () => {
  const legacy = checkpoint(undefined);
  const contract = buildResumeContract(legacy, buildMissionCapabilitySnapshot(environment()));
  assert.equal(contract.state, "review-required");
  assert.equal(contract.launchable, true);
  assert.equal(contract.drift.every((item) => item.state === "unavailable" || item.state === "stable"), true);
  assert.match(contract.warnings[0], /predates Mission Recipe capture/);
});
