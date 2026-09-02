import type {
  MemoryPressure,
  ModelDescriptor,
  ModelLoadOptions,
  VramEstimate,
} from "../../shared/contracts.ts";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const CUDA_PROCESS_RESERVE_BYTES = 1_536 * MIB;
const LLAMA_HOST_RUNTIME_BYTES = 512 * MIB;
const UNKNOWN_LAYER_SENTINEL = 999;
// The GGUF reader is optional in the sidecar. When block metadata is absent,
// use the same 32-block fallback already used by the KV estimator instead of
// treating every positive partial-offload request as a full-GPU load.
const UNKNOWN_LAYER_ESTIMATE = 33;

export interface MemoryAvailability {
  systemRamTotalBytes: number;
  systemRamAvailableBytes: number;
  gpuVramAvailableBytes: number;
}

export function totalGpuLayers(model: ModelDescriptor): number {
  return model.blockCount && model.blockCount > 0 ? model.blockCount + 1 : UNKNOWN_LAYER_SENTINEL;
}

export function defaultLoadOptions(model: ModelDescriptor): ModelLoadOptions {
  return {
    contextLength: Math.min(model.contextLength, 32_768),
    gpuLayers: totalGpuLayers(model),
    cacheType: "f16",
    kvCachePlacement: "gpu",
  };
}

export function estimateModelVram(model: ModelDescriptor, input: ModelLoadOptions): VramEstimate {
  const contextLength = clamp(Math.round(input.contextLength), 512, model.contextLength);
  const allLayers = totalGpuLayers(model);
  const gpuLayers = clamp(Math.round(input.gpuLayers), 0, allLayers);
  const offloadFraction = gpuLayers === 0
    ? 0
    : allLayers === UNKNOWN_LAYER_SENTINEL
      ? Math.min(1, gpuLayers / UNKNOWN_LAYER_ESTIMATE)
      : gpuLayers / allLayers;
  const cacheType = input.cacheType ?? "f16";
  const kvCachePlacement = input.kvCachePlacement ?? "gpu";
  const blockCount = Math.max(1, model.blockCount ?? 32);
  const embeddingLength = Math.max(256, model.embeddingLength ?? 4_096);
  const kvHeads = Math.max(1, model.attentionHeadCountKv ?? model.attentionHeadCount ?? 8);
  const totalHeads = Math.max(kvHeads, model.attentionHeadCount ?? 32);
  const fallbackWidth = Math.max(64, Math.round((embeddingLength * kvHeads) / totalHeads));
  const keyWidth = model.attentionKeyLength ? model.attentionKeyLength * kvHeads : fallbackWidth;
  const valueWidth = model.attentionValueLength ? model.attentionValueLength * kvHeads : fallbackWidth;
  const cacheBytesPerValue = cacheType === "q4_0" ? 0.5625 : cacheType === "q8_0" ? 1.125 : 2;

  const weightTotalBytes = model.sizeBytes * 1.03;
  const weightBytes = weightTotalBytes * offloadFraction;
  const ramWeightBytes = weightTotalBytes - weightBytes;
  const kvCacheTotalBytes = contextLength * blockCount * (keyWidth + valueWidth) * cacheBytesPerValue;
  const gpuKvFraction = kvCachePlacement === "cpu" ? 0 : offloadFraction;
  const kvCacheBytes = kvCacheTotalBytes * gpuKvFraction;
  const ramKvCacheBytes = kvCacheTotalBytes - kvCacheBytes;
  const computeBaseBytes = clamp(
    contextLength * embeddingLength * 2 + 192 * MIB,
    256 * MIB,
    4 * GIB,
  );
  const computeBytes = offloadFraction === 0 ? 0 : computeBaseBytes * Math.sqrt(offloadFraction);
  const ramComputeBytes = clamp(
    256 * MIB + computeBaseBytes * Math.sqrt(1 - offloadFraction) * 0.5,
    256 * MIB,
    3 * GIB,
  );
  // llama.cpp offloads the multimodal projector independently of transformer layers.
  const projectorBytes = offloadFraction > 0 ? (model.projectorSizeBytes ?? 0) * 1.05 : 0;
  const ramProjectorBytes = offloadFraction > 0 ? 0 : (model.projectorSizeBytes ?? 0) * 1.05;
  const prior = model.vramEstimate;
  const sameMeasuredConfiguration = Boolean(
    offloadFraction > 0
      && prior?.measuredBytes
      && prior.contextLength === contextLength
      && prior.gpuLayers === gpuLayers
      && prior.cacheType === cacheType
      && (prior.kvCachePlacement ?? "gpu") === kvCachePlacement,
  );
  const nonRuntimeBytes = weightBytes + kvCacheBytes + computeBytes + projectorBytes;
  const measuredRuntimeFloor = sameMeasuredConfiguration
    ? Math.max(0, (prior?.measuredBytes ?? 0) - nonRuntimeBytes)
    : 0;
  // CUDA context and llama.cpp work buffers remain substantial even with only a few offloaded layers.
  const runtimeBytes = offloadFraction === 0
    ? 0
    : Math.max(CUDA_PROCESS_RESERVE_BYTES, measuredRuntimeFloor);
  const ramRuntimeBytes = LLAMA_HOST_RUNTIME_BYTES;
  const totalBytes = roundUp(nonRuntimeBytes + runtimeBytes, 16 * MIB);
  const ramTotalBytes = roundUp(
    ramWeightBytes + ramKvCacheBytes + ramComputeBytes + ramProjectorBytes + ramRuntimeBytes,
    16 * MIB,
  );

  return {
    contextLength,
    gpuLayers,
    cacheType,
    kvCachePlacement,
    totalGpuLayers: allLayers,
    offloadFraction,
    weightBytes: Math.round(weightBytes),
    ramWeightBytes: Math.round(ramWeightBytes),
    kvCacheTotalBytes: Math.round(kvCacheTotalBytes),
    kvCacheBytes: Math.round(kvCacheBytes),
    ramKvCacheBytes: Math.round(ramKvCacheBytes),
    computeBytes: Math.round(computeBytes),
    ramComputeBytes: Math.round(ramComputeBytes),
    projectorBytes: Math.round(projectorBytes),
    ramProjectorBytes: Math.round(ramProjectorBytes),
    runtimeBytes,
    ramRuntimeBytes,
    ramTotalBytes,
    totalBytes,
    measuredBytes: sameMeasuredConfiguration ? prior?.measuredBytes : undefined,
    measuredAt: sameMeasuredConfiguration ? prior?.measuredAt : undefined,
    source: "calculated",
  };
}

export function assessMemoryAvailability(
  estimate: VramEstimate,
  availability: MemoryAvailability,
): VramEstimate {
  const ramSafetyReserveBytes = clamp(availability.systemRamTotalBytes * 0.125, 4 * GIB, 8 * GIB);
  const ramAfterLoad = availability.systemRamAvailableBytes - estimate.ramTotalBytes;
  const vramAfterLoad = availability.gpuVramAvailableBytes - estimate.totalBytes;
  const diagnostics: string[] = [];
  let memoryPressure: MemoryPressure = "normal";

  if (availability.systemRamAvailableBytes > 0 && ramAfterLoad < ramSafetyReserveBytes) {
    memoryPressure = "unsafe";
    diagnostics.push(
      `System RAM would fall below the ${formatGib(ramSafetyReserveBytes)} safety reserve ` +
      `(${formatGib(Math.max(0, ramAfterLoad))} projected free).`,
    );
  } else if (availability.systemRamAvailableBytes > 0 && ramAfterLoad < ramSafetyReserveBytes * 1.5) {
    memoryPressure = "tight";
    diagnostics.push(`System RAM headroom is tight (${formatGib(ramAfterLoad)} projected free).`);
  }

  if (estimate.totalBytes > 0 && availability.gpuVramAvailableBytes > 0 && vramAfterLoad < 0) {
    memoryPressure = "unsafe";
    diagnostics.push(
      `Calculated VRAM exceeds current free VRAM by ${formatGib(Math.abs(vramAfterLoad))}; reduce GPU layers or move KV cache to RAM.`,
    );
  } else if (
    estimate.totalBytes > 0
    && availability.gpuVramAvailableBytes > 0
    && vramAfterLoad < 1024 * MIB
    && memoryPressure === "normal"
  ) {
    memoryPressure = "tight";
    diagnostics.push(`GPU headroom is tight (${formatGib(vramAfterLoad)} projected free).`);
  }

  if (!diagnostics.length) {
    diagnostics.push(
      `Projected headroom: ${formatGib(ramAfterLoad)} system RAM and ${formatGib(vramAfterLoad)} VRAM.`,
    );
  }

  return {
    ...estimate,
    systemRamTotalBytes: availability.systemRamTotalBytes,
    systemRamAvailableBytes: availability.systemRamAvailableBytes,
    gpuVramAvailableBytes: availability.gpuVramAvailableBytes,
    ramSafetyReserveBytes,
    memoryPressure,
    memoryDiagnostics: diagnostics,
  };
}

export function minimumFullGpuBytes(estimate: VramEstimate): number {
  const conservativeWeightFloor = estimate.weightBytes * 0.8;
  const cacheFloor = estimate.kvCacheBytes * 0.5;
  return Math.min(
    estimate.totalBytes,
    roundUp(conservativeWeightFloor + cacheFloor + estimate.projectorBytes + estimate.runtimeBytes, 16 * MIB),
  );
}

function formatGib(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundUp(value: number, unit: number): number {
  return Math.ceil(value / unit) * unit;
}
