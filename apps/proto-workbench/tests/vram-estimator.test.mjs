import assert from "node:assert/strict";
import test from "node:test";
import {
  assessMemoryAvailability,
  estimateModelVram,
  totalGpuLayers,
} from "../src/main/services/vram-estimator.ts";

const model = {
  id: "model-test",
  name: "Test GGUF",
  path: "model.gguf",
  files: ["model.gguf"],
  sizeBytes: 6 * 1024 ** 3,
  architecture: "llama",
  quantization: "Q4_K_M",
  contextLength: 1_048_576,
  blockCount: 32,
  embeddingLength: 4_096,
  attentionHeadCount: 32,
  attentionHeadCountKv: 8,
  attentionKeyLength: 128,
  attentionValueLength: 128,
  vision: true,
  projectorSizeBytes: 512 * 1024 ** 2,
  toolCapability: "agent-ready",
  fingerprint: "test",
  estimatedVramBytes: 0,
  loadState: "unloaded",
  pinned: false,
  metadataSource: "gguf",
};

test("VRAM estimate responds to context, cache type, offload, and projector metadata", () => {
  const layers = totalGpuLayers(model);
  assert.equal(layers, 33);
  const shortContext = estimateModelVram(model, { contextLength: 2_048, gpuLayers: layers, cacheType: "f16" });
  const longContext = estimateModelVram(model, { contextLength: 32_768, gpuLayers: layers, cacheType: "f16" });
  const quantizedCache = estimateModelVram(model, { contextLength: 32_768, gpuLayers: layers, cacheType: "q8_0" });
  const q4Cache = estimateModelVram(model, { contextLength: 32_768, gpuLayers: layers, cacheType: "q4_0" });
  const partial = estimateModelVram(model, { contextLength: 32_768, gpuLayers: 12, cacheType: "f16" });
  const cpu = estimateModelVram(model, { contextLength: 32_768, gpuLayers: 0, cacheType: "f16" });

  assert.ok(longContext.totalBytes > shortContext.totalBytes);
  assert.ok(quantizedCache.kvCacheBytes < longContext.kvCacheBytes);
  assert.ok(q4Cache.kvCacheBytes < quantizedCache.kvCacheBytes);
  assert.ok(partial.totalBytes < longContext.totalBytes);
  assert.ok(partial.ramTotalBytes > longContext.ramTotalBytes);
  assert.ok(partial.runtimeBytes >= 1.5 * 1024 ** 3);
  assert.ok(longContext.projectorBytes > 0);
  assert.equal(cpu.totalBytes, 0);
  assert.ok(cpu.ramTotalBytes > model.sizeBytes);
});

test("512K CPU Q4 KV is feasible while 1M is rejected under a 64 GiB host budget", () => {
  const layers = totalGpuLayers(model);
  const q4Cpu512K = estimateModelVram(model, {
    contextLength: 524_288,
    gpuLayers: 24,
    cacheType: "q4_0",
    kvCachePlacement: "cpu",
  });
  const q4Cpu1M = estimateModelVram(model, {
    contextLength: 1_048_576,
    gpuLayers: 24,
    cacheType: "q4_0",
    kvCachePlacement: "cpu",
  });
  const availability = {
    systemRamTotalBytes: 64 * 1024 ** 3,
    systemRamAvailableBytes: 40 * 1024 ** 3,
    gpuVramAvailableBytes: 18 * 1024 ** 3,
  };
  const safe = assessMemoryAvailability(q4Cpu512K, availability);
  const unsafe = assessMemoryAvailability(q4Cpu1M, availability);

  assert.equal(q4Cpu512K.kvCacheBytes, 0);
  assert.ok(q4Cpu512K.ramKvCacheBytes >= 17 * 1024 ** 3);
  assert.ok(q4Cpu512K.ramKvCacheBytes <= 19 * 1024 ** 3);
  assert.equal(safe.memoryPressure, "normal");
  assert.equal(unsafe.memoryPressure, "unsafe");
  assert.equal(layers, 33);
});

test("a prior live measurement calibrates the same load configuration", () => {
  const layers = totalGpuLayers(model);
  const initial = estimateModelVram(model, { contextLength: 8_192, gpuLayers: 6, cacheType: "q8_0" });
  const measuredBytes = initial.totalBytes + 1.25 * 1024 ** 3;
  const calibrated = estimateModelVram(
    {
      ...model,
      vramEstimate: {
        ...initial,
        measuredBytes,
        measuredAt: "2026-07-13T00:00:00.000Z",
        source: "measured",
      },
    },
    { contextLength: 8_192, gpuLayers: 6, cacheType: "q8_0" },
  );

  assert.ok(calibrated.totalBytes >= measuredBytes);
  assert.equal(calibrated.measuredBytes, measuredBytes);
  assert.equal(calibrated.source, "calculated");
  assert.equal(layers, 33);
});

test("unknown GGUF block metadata keeps partial GPU offload distinct from full offload", () => {
  const unknownLayers = { ...model, blockCount: undefined, metadataSource: "filename" };
  const partial = estimateModelVram(unknownLayers, {
    contextLength: 32_768,
    gpuLayers: 26,
    cacheType: "f16",
    kvCachePlacement: "cpu",
  });
  const full = estimateModelVram(unknownLayers, {
    contextLength: 32_768,
    gpuLayers: totalGpuLayers(unknownLayers),
    cacheType: "f16",
    kvCachePlacement: "cpu",
  });

  assert.equal(totalGpuLayers(unknownLayers), 999);
  assert.ok(partial.offloadFraction > 0 && partial.offloadFraction < 1);
  assert.ok(partial.weightBytes < full.weightBytes);
  assert.ok(partial.totalBytes < full.totalBytes);
  assert.equal(full.offloadFraction, 1);
});
