import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "../src/main/services/database.ts";
import { ModelService } from "../src/main/services/model-service.ts";

function model(overrides = {}) {
  return {
    id: "lmstudio:fixture-model",
    name: "Fixture model",
    path: "provider://fixture/model",
    files: [],
    sizeBytes: 1,
    architecture: "fixture",
    quantization: "Q4",
    contextLength: 4096,
    vision: false,
    toolCapability: "unknown",
    providerToolUseAdvertised: true,
    fingerprint: "a".repeat(64),
    estimatedVramBytes: 1,
    loadState: "unloaded",
    pinned: false,
    metadataSource: "lmstudio",
    provider: "lmstudio",
    providerModelId: "fixture/model",
    modelKind: "llm",
    ...overrides,
  };
}

function fixtureRuntime({ malformed = false } = {}) {
  let binding;
  const runtime = {
    has: (modelId) => binding?.modelId === modelId,
    load: async (descriptor, options) => {
      binding = { modelId: descriptor.id, instanceId: "loaded-exact-instance", contextLength: options.contextLength ?? 4096, ownedByWorkbench: true };
      return { ...binding, provider: "lmstudio", state: "active", gpuLayers: 0, startedAt: new Date().toISOString() };
    },
    getExecutionBinding: async (modelId) => {
      if (binding?.modelId !== modelId) throw new Error("not connected");
      return { ...binding, observedAt: new Date().toISOString() };
    },
    chat: async (_modelId, payload, onChunk) => {
      assert.equal(payload.tool_choice.function.name, "proto_probe_echo");
      const text = payload.messages[1].content;
      const nonce = text.match(/nonce ([0-9a-f-]+)\./)?.[1];
      assert.ok(nonce);
      const args = malformed ? "{" : JSON.stringify({ marker: "proto-tool-probe-v1", nonce });
      onChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "proto_probe_echo", arguments: args } }] } }] });
      onChunk({ choices: [{ finish_reason: "tool_calls", delta: {} }] });
    },
    unload: async (modelId) => { if (binding?.modelId === modelId) binding = undefined; },
    unloadAll: async () => { binding = undefined; },
    runtimeStatus: async () => ({ available: true, provider: "lmstudio", modelCount: 1, loadedModelCount: binding ? 1 : 0, detail: "fixture" }),
    processId: () => undefined,
    gpuAllocationBytes: () => undefined,
  };
  return runtime;
}

const noGpu = async () => ({ totalBytes: 0, usedBytes: 0, freeBytes: 0 });
const noRamProbe = () => ({ totalBytes: 1024 ** 3, availableBytes: 1024 ** 3 });

test("tool probe is explicit, exact-instance-bound, and required for agent-ready", async () => {
  const database = new AppDatabase(":memory:");
  const descriptor = model();
  const runtime = fixtureRuntime();
  const service = new ModelService(database, { authoritativeEndpoint: "http://127.0.0.1:1234", scan: async () => [descriptor] }, runtime, noGpu, noRamProbe);
  try {
    await service.scan("");
    assert.equal(service.get(descriptor.id).toolCapability, "unknown");
    await service.load(descriptor.id);
    const probe = await service.probeToolCapability(descriptor.id);
    assert.equal(probe.status, "passed");
    assert.equal(probe.instanceId, "loaded-exact-instance");
    assert.equal(probe.modelFingerprint, descriptor.fingerprint);
    assert.match(probe.requestSha256, /^[a-f0-9]{64}$/);
    assert.match(probe.responseSha256, /^[a-f0-9]{64}$/);
    assert.equal(service.get(descriptor.id).toolCapability, "agent-ready");

    await service.unload(descriptor.id);
    assert.equal(service.get(descriptor.id).toolCapability, "unknown", "a probe cannot certify a disconnected instance");
    const persisted = database.listLatestModelToolCapabilityProbes();
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].probeId, probe.probeId);
  } finally {
    await service.shutdown();
    database.close();
  }
});

test("unavailable exact model instances remain visible as failed probe attempts", async () => {
  const database = new AppDatabase(":memory:");
  const descriptor = model();
  const runtime = fixtureRuntime();
  const service = new ModelService(database, { authoritativeEndpoint: "http://127.0.0.1:1234", scan: async () => [descriptor] }, runtime, noGpu, noRamProbe);
  try {
    await service.scan("");
    const probe = await service.probeToolCapability(descriptor.id);
    assert.equal(probe.status, "unavailable");
    assert.equal(probe.failureCode, "MODEL_NOT_CONNECTED");
    assert.equal(service.get(descriptor.id).toolCapability, "unknown");
    assert.equal(database.listLatestModelToolCapabilityProbes()[0].status, "unavailable");
  } finally {
    await service.shutdown();
    database.close();
  }
});

test("malformed forced tool arguments are retained as malformed, not promoted to support", async () => {
  const database = new AppDatabase(":memory:");
  const descriptor = model();
  const runtime = fixtureRuntime({ malformed: true });
  const service = new ModelService(database, { authoritativeEndpoint: "http://127.0.0.1:1234", scan: async () => [descriptor] }, runtime, noGpu, noRamProbe);
  try {
    await service.scan("");
    await service.load(descriptor.id);
    const probe = await service.probeToolCapability(descriptor.id);
    assert.equal(probe.status, "malformed");
    assert.equal(probe.failureCode, "TOOL_ARGUMENTS_INVALID_JSON");
    assert.equal(service.get(descriptor.id).toolCapability, "unknown");
  } finally {
    await service.shutdown();
    database.close();
  }
});
