import assert from "node:assert/strict";
import test from "node:test";
import { ModelService } from "../src/main/services/model-service.ts";
import { GIB } from "../src/main/services/residency.ts";

class FakeDatabase {
  constructor(models, policy) {
    this.models = structuredClone(models);
    this.settings = new Map([["residencyPolicy", policy]]);
  }

  listModels() {
    return structuredClone(this.models);
  }

  getSetting(key, fallback) {
    return structuredClone(this.settings.get(key) ?? fallback);
  }

  setSetting(key, value) {
    this.settings.set(key, structuredClone(value));
  }

  saveModels(models) {
    this.models = structuredClone(models);
  }
}

class FakeRuntime {
  loads = [];
  unloads = [];
  residents = new Set();

  async load(model, options) {
    this.loads.push({ modelId: model.id, ...options });
    this.residents.add(model.id);
    return {
      modelId: model.id,
      state: "active",
      contextLength: options.contextLength,
      gpuLayers: options.gpuLayers,
      startedAt: new Date().toISOString(),
    };
  }

  async unload(modelId) {
    this.unloads.push(modelId);
    this.residents.delete(modelId);
  }

  async unloadAll() {
    this.residents.clear();
  }

  has(modelId) {
    return this.residents.has(modelId);
  }

  processId() {
    return undefined;
  }

  gpuAllocationBytes() {
    return undefined;
  }
}

const descriptor = (id, sizeBytes = 4 * GIB) => ({
  id,
  name: id,
  path: `C:\\models\\${id}.gguf`,
  files: [`C:\\models\\${id}.gguf`],
  sizeBytes,
  architecture: "qwen35",
  quantization: "Q4_K_M",
  contextLength: 32_768,
  blockCount: 32,
  embeddingLength: 4_096,
  attentionHeadCount: 16,
  attentionHeadCountKv: 4,
  vision: false,
  toolCapability: "agent-ready",
  fingerprint: id,
  loadState: "unloaded",
  pinned: false,
  metadataSource: "gguf",
});

const abundantGpu = async () => ({ totalBytes: 64 * GIB, usedBytes: 0, freeBytes: 64 * GIB });
const abundantRam = () => ({ totalBytes: 128 * GIB, availableBytes: 112 * GIB });

test("auto-evict allows a selected model to exceed the pool target by itself", async () => {
  const runtime = new FakeRuntime();
  const database = new FakeDatabase([descriptor("target")], {
    mode: "auto-evict",
    budgetBytes: 2 * GIB,
    warmTtlMinutes: 30,
    pinnedModelIds: [],
  });
  const service = new ModelService(database, { scan: async () => [] }, runtime, abundantGpu, abundantRam);
  try {
    const instance = await service.load("target", { contextLength: 2_048, gpuLayers: 33, cacheType: "f16" });
    assert.equal(instance.state, "active");
    assert.equal(runtime.loads.length, 1);
  } finally {
    await service.shutdown();
  }
});

test("chat requires an explicit model load and never starts one implicitly", async () => {
  const runtime = new FakeRuntime();
  runtime.chat = async () => {};
  const database = new FakeDatabase([descriptor("target")], {
    mode: "quick-switch",
    budgetBytes: 20 * GIB,
    warmTtlMinutes: 30,
    pinnedModelIds: [],
  });
  const service = new ModelService(database, { scan: async () => [] }, runtime, abundantGpu, abundantRam);
  try {
    await assert.rejects(
      service.chat("target", { messages: [] }, () => {}),
      /not loaded.*explicitly/i,
    );
    assert.equal(runtime.loads.length, 0);
    await service.load("target", { contextLength: 2_048, gpuLayers: 33, cacheType: "f16" });
    await service.chat("target", { messages: [] }, () => {});
    assert.equal(runtime.loads.length, 1);
  } finally {
    await service.shutdown();
  }
});

test("explicit load options reload an already resident model", async () => {
  const runtime = new FakeRuntime();
  const database = new FakeDatabase([descriptor("target")], {
    mode: "quick-switch",
    budgetBytes: 20 * GIB,
    warmTtlMinutes: 30,
    pinnedModelIds: [],
  });
  const service = new ModelService(database, { scan: async () => [] }, runtime, abundantGpu, abundantRam);
  try {
    await service.load("target", { contextLength: 2_048, gpuLayers: 33, cacheType: "f16" });
    await service.load("target", { contextLength: 4_096, gpuLayers: 33, cacheType: "q8_0" });
    assert.deepEqual(runtime.loads.map((load) => load.contextLength), [2_048, 4_096]);
    assert.deepEqual(runtime.unloads, ["target"]);
  } finally {
    await service.shutdown();
  }
});

test("concurrent requests for the same model share one in-flight load", async () => {
  let releaseLoad;
  const gate = new Promise((resolve) => { releaseLoad = resolve; });
  const runtime = new FakeRuntime();
  runtime.load = async (model, options) => {
    runtime.loads.push({ modelId: model.id, ...options });
    await gate;
    runtime.residents.add(model.id);
    return {
      modelId: model.id,
      state: "active",
      contextLength: options.contextLength,
      gpuLayers: options.gpuLayers,
    };
  };
  const database = new FakeDatabase([descriptor("target")], {
    mode: "quick-switch",
    budgetBytes: 20 * GIB,
    warmTtlMinutes: 30,
    pinnedModelIds: [],
  });
  const service = new ModelService(database, { scan: async () => [] }, runtime, abundantGpu, abundantRam);
  try {
    const first = service.load("target", { contextLength: 2_048, gpuLayers: 33, cacheType: "f16" });
    const second = service.load("target", { contextLength: 2_048, gpuLayers: 33, cacheType: "f16" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.loads.length, 1);
    releaseLoad();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.modelId, "target");
    assert.equal(secondResult.modelId, "target");
    assert.equal(runtime.loads.length, 1);
  } finally {
    releaseLoad();
    await service.shutdown();
  }
});

test("newer model generation owns the runtime and superseded loads are unloaded", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const runtime = new FakeRuntime();
  let activeLoads = 0;
  let maximumConcurrentLoads = 0;
  runtime.load = async (model, options) => {
    runtime.loads.push({ modelId: model.id, ...options });
    activeLoads += 1;
    maximumConcurrentLoads = Math.max(maximumConcurrentLoads, activeLoads);
    if (model.id === "first") await firstGate;
    activeLoads -= 1;
    runtime.residents.add(model.id);
    return {
      modelId: model.id,
      state: "active",
      contextLength: options.contextLength,
      gpuLayers: options.gpuLayers,
    };
  };
  const database = new FakeDatabase([descriptor("first"), descriptor("second")], {
    mode: "quick-switch",
    budgetBytes: 20 * GIB,
    warmTtlMinutes: 30,
    pinnedModelIds: [],
  });
  const service = new ModelService(database, { scan: async () => [] }, runtime, abundantGpu, abundantRam);
  try {
    const first = service.load("first", { contextLength: 2_048, gpuLayers: 33, cacheType: "f16" });
    await new Promise((resolve) => setImmediate(resolve));
    const second = service.load("second", { contextLength: 2_048, gpuLayers: 33, cacheType: "f16" });
    releaseFirst();
    await assert.rejects(first, /superseded/);
    const instance = await second;
    assert.equal(instance.modelId, "second");
    assert.equal(maximumConcurrentLoads, 1);
    assert.ok(runtime.unloads.includes("first"));
  } finally {
    releaseFirst();
    await service.shutdown();
  }
});

test("runtime spawn failures leave the model in a recoverable error state", async () => {
  const runtime = new FakeRuntime();
  runtime.load = async () => {
    throw new Error("Unable to start llama-server.exe: spawn ENOENT");
  };
  const database = new FakeDatabase([descriptor("target")], {
    mode: "quick-switch",
    budgetBytes: 20 * GIB,
    warmTtlMinutes: 30,
    pinnedModelIds: [],
  });
  const service = new ModelService(database, { scan: async () => [] }, runtime, abundantGpu, abundantRam);
  try {
    await assert.rejects(
      service.load("target", { contextLength: 2_048, gpuLayers: 33, cacheType: "f16" }),
      /Unable to start llama-server/,
    );
    assert.equal(service.get("target").loadState, "error");
    assert.match(service.get("target").error, /spawn ENOENT/);
  } finally {
    await service.shutdown();
  }
});

test("external VRAM pressure blocks silent partial offload but allows an explicit partial load", async () => {
  const runtime = new FakeRuntime();
  const database = new FakeDatabase([descriptor("target")], {
    mode: "quick-switch",
    budgetBytes: 20 * GIB,
    warmTtlMinutes: 30,
    pinnedModelIds: [],
  });
  const pressuredGpu = async () => ({ totalBytes: 24 * GIB, usedBytes: 20 * GIB, freeBytes: 4 * GIB });
  const service = new ModelService(database, { scan: async () => [] }, runtime, pressuredGpu, abundantRam);
  try {
    await assert.rejects(
      service.load("target", { contextLength: 2_048, gpuLayers: 33, cacheType: "f16" }),
      /avoid silent partial CPU offload/,
    );
    assert.equal(runtime.loads.length, 0);

    const instance = await service.load("target", { contextLength: 2_048, gpuLayers: 4, cacheType: "f16" });
    assert.equal(instance.state, "active");
    assert.equal(runtime.loads.length, 1);
    assert.equal(runtime.loads[0].gpuLayers, 4);
  } finally {
    await service.shutdown();
  }
});

test("the explicit experimental-memory acknowledgement bypasses every preflight gate", async () => {
  const runtime = new FakeRuntime();
  const database = new FakeDatabase([descriptor("target")], {
    mode: "quick-switch",
    budgetBytes: 20 * GIB,
    warmTtlMinutes: 30,
    pinnedModelIds: [],
  });
  const pressuredGpu = async () => ({ totalBytes: 24 * GIB, usedBytes: 23 * GIB, freeBytes: 1 * GIB });
  const service = new ModelService(database, { scan: async () => [] }, runtime, pressuredGpu, abundantRam);
  try {
    const instance = await service.load("target", {
      contextLength: 2_048,
      gpuLayers: 33,
      cacheType: "f16",
      allowUnsafeMemoryPressure: true,
    });
    assert.equal(instance.state, "active");
    assert.equal(runtime.loads.length, 1);
    assert.equal(runtime.loads[0].gpuLayers, 33);
  } finally {
    await service.shutdown();
  }
});

test("quick-switch estimates credit VRAM that the current resident will release", async () => {
  const runtime = new FakeRuntime();
  const database = new FakeDatabase([descriptor("resident"), descriptor("target")], {
    mode: "quick-switch",
    budgetBytes: 20 * GIB,
    warmTtlMinutes: 30,
    pinnedModelIds: [],
  });
  const pressuredGpu = async () => ({ totalBytes: 24 * GIB, usedBytes: 20 * GIB, freeBytes: 4 * GIB });
  const service = new ModelService(database, { scan: async () => [] }, runtime, pressuredGpu, abundantRam);
  service.instances.set("resident", {
    modelId: "resident",
    state: "active",
    contextLength: 2_048,
    gpuLayers: 33,
    measuredVramBytes: 8 * GIB,
  });
  try {
    const estimate = await service.estimate("target", {
      contextLength: 2_048,
      gpuLayers: 33,
      cacheType: "f16",
    });
    assert.equal(estimate.gpuVramAvailableBytes, 12 * GIB);
    assert.equal(estimate.memoryPressure, "normal");
  } finally {
    await service.shutdown();
  }
});
