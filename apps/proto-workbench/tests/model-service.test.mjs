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

test("a generation waits for an already queued reload without blocking its unload", async () => {
  const model = descriptor("reload-race");
  const runtime = new FakeRuntime();
  const database = new FakeDatabase([model], { mode: "quick-switch", budgetBytes: 20 * GIB, warmTtlMinutes: 30, pinnedModelIds: [] });
  const service = new ModelService(database, { scan: async () => [model] }, runtime, abundantGpu, abundantRam);
  const calls = [];
  runtime.chat = async () => { calls.push("chat"); };
  try {
    await service.load(model.id, { contextLength: 4096 });
    const reload = service.load(model.id, { contextLength: 8192 });
    const generation = service.chat(model.id, {}, () => {});
    assert.equal((await reload).contextLength, 8192);
    await generation;
    assert.deepEqual(runtime.unloads, [model.id]);
    assert.deepEqual(calls, ["chat"]);
  } finally { await service.shutdown(); }
});

test("cancelling a generation waiting for residency does not wait for a model load", async () => {
  const model = descriptor("residency-cancel");
  const runtime = new FakeRuntime();
  const database = new FakeDatabase([model], { mode: "quick-switch", budgetBytes: 20 * GIB, warmTtlMinutes: 30, pinnedModelIds: [] });
  const service = new ModelService(database, { scan: async () => [model] }, runtime, abundantGpu, abundantRam);
  let release;
  try {
    await service.load(model.id, { contextLength: 4096 });
    service.loadQueue = new Promise((resolve) => { release = resolve; });
    const abort = new AbortController();
    const generation = service.chat(model.id, {}, () => {}, abort.signal);
    abort.abort();
    await assert.rejects(generation, (error) => error.code === "USER_CANCELLED");
  } finally { release?.(); await service.shutdown(); }
});

test("generation is FIFO, queued cancellation is prompt, and residency stays leased", async () => {
  const model = descriptor("queued");
  const database = new FakeDatabase([model], { mode: "quick-switch", budgetBytes: 20 * GIB, warmTtlMinutes: 30, pinnedModelIds: [] });
  const runtime = new FakeRuntime();
  const started = [];
  const releases = [];
  runtime.chat = async (_model, payload, _onChunk, signal) => {
    started.push(payload.id);
    await new Promise((resolve, reject) => {
      releases.push(resolve);
      signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
    });
  };
  const service = new ModelService(database, { scan: async () => [model] }, runtime, abundantGpu, abundantRam);
  try {
    await service.load(model.id, { contextLength: 8192 });
    const a = service.chat(model.id, { id: "A" }, () => {});
    const controller = new AbortController();
    const b = service.chat(model.id, { id: "B" }, () => {}, controller.signal);
    const rejectedB = assert.rejects(b, (error) => error.name === "AbortError");
    const c = service.chat(model.id, { id: "C" }, () => {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ["A"]);
    controller.abort();
    await rejectedB;
    await assert.rejects(service.unload(model.id), (error) => error.code === "MODEL_LEASED");
    await assert.rejects(service.load(model.id), (error) => error.code === "MODEL_LEASED");
    releases.shift()();
    await a;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ["A", "C"]);
    releases.shift()();
    await c;
    await service.unload(model.id);
    assert.deepEqual(runtime.unloads, [model.id]);
  } finally { await service.shutdown(); }
});

test("queued residency time extends the private request deadline without changing caller data", async () => {
  const model = descriptor("queue-deadline"), runtime = new FakeRuntime();
  const database = new FakeDatabase([model], {mode: "quick-switch", budgetBytes: 20 * GIB, warmTtlMinutes: 30, pinnedModelIds: []});
  const service = new ModelService(database, {scan: async () => [model]}, runtime, abundantGpu, abundantRam);
  let release; const states = []; let observed;
  runtime.chat = async (_model, payload) => {observed = payload;};
  try {
    await service.load(model.id, {contextLength: 32768});
    service.loadQueue = new Promise(resolve => {release = resolve;});
    const payload = {deadline: Date.now() + 30, _onQueueState: state => states.push(state)};
    const generation = service.chat(model.id, payload, () => {});
    await new Promise(resolve => setTimeout(resolve, 70));
    release(); await generation;
    assert.deepEqual(states, ["queued", "active"]);
    assert.ok(observed.deadline >= payload.deadline + 50);
    assert.ok(observed.deadline > Date.now());
    assert.equal(observed._onQueueState, undefined);
    assert.equal(typeof payload._onQueueState, "function");
  } finally {release?.(); await service.shutdown();}
});

test("execution budget uses observed context and shutdown cancels an active generation", async () => {
  const model = descriptor("context");
  const database = new FakeDatabase([model], { mode: "quick-switch", budgetBytes: 20 * GIB, warmTtlMinutes: 30, pinnedModelIds: [] });
  const runtime = new FakeRuntime();
  runtime.chat = async (_model, _payload, _onChunk, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
  });
  const service = new ModelService(database, { scan: async () => [model] }, runtime, abundantGpu, abundantRam);
  await service.load(model.id, { contextLength: 8192 });
  assert.equal(service.get(model.id).contextLength, 32_768);
  assert.equal(service.getLoadedContextLength(model.id), 8192);
  assert.equal((await service.getExecutionBinding(model.id)).contextLength, 8192);
  const running = service.chat(model.id, {}, () => {});
  const rejected = assert.rejects(running, (error) => error.name === "AbortError");
  await new Promise((resolve) => setImmediate(resolve));
  await service.shutdown();
  await rejected;
  assert.equal(runtime.residents.size, 0);
});

test("LM Studio models bypass the legacy GPU estimator and preserve exact instance ownership", async () => {
  const model = {
    ...descriptor("lmstudio-model"),
    contextLength: 131_072,
    path: "lmstudio:fixture/model",
    files: [],
    provider: "lmstudio",
    providerModelId: "fixture/model",
    modelKind: "llm",
    metadataSource: "lmstudio",
    loadedInstances: [],
  };
  const runtime = new FakeRuntime();
  runtime.load = async (selected, options) => {
    runtime.loads.push({ modelId: selected.id, ...options });
    runtime.residents.add(selected.id);
    return {
      modelId: selected.id,
      instanceId: "workbench-owned-instance",
      provider: "lmstudio",
      ownedByWorkbench: true,
      state: "active",
      contextLength: options.contextLength ?? 16_384,
      gpuLayers: 0,
    };
  };
  const database = new FakeDatabase([], {
    mode: "quick-switch",
    budgetBytes: 20 * GIB,
    warmTtlMinutes: 30,
    pinnedModelIds: [],
  });
  const service = new ModelService(
    database,
    { scan: async () => [model] },
    runtime,
    async () => { throw new Error("legacy GPU probe must not run"); },
    () => { throw new Error("legacy RAM probe must not run"); },
  );
  try {
    await service.scan("http://127.0.0.1:1234");
    const instance = await service.load(model.id, { contextLength: 32_768, evalBatchSize: 512 });
    assert.equal(instance.instanceId, "workbench-owned-instance");
    assert.equal(instance.ownedByWorkbench, true);
    assert.equal(service.get(model.id).workbenchInstance.id, "workbench-owned-instance");
    assert.equal(service.get(model.id).workbenchInstance.contextLength, 32_768);
    assert.equal(service.get(model.id).contextLength, model.contextLength);
    await service.scan("http://127.0.0.1:1234");
    assert.equal(service.get(model.id).workbenchInstance.contextLength, 32_768);
    assert.deepEqual(runtime.loads, [{ modelId: model.id, contextLength: 32_768, evalBatchSize: 512 }]);
  } finally {
    await service.shutdown();
  }
});

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
