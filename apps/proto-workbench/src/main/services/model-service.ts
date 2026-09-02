import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { freemem, totalmem } from "node:os";
import { promisify } from "node:util";
import type {
  ModelDescriptor,
  ModelInstance,
  ModelLoadOptions,
  ResidencyPolicy,
  VramEstimate,
} from "../../shared/contracts.ts";
import type { ChatCompletionChunk, InferenceRuntime, ModelCatalogSource } from "./inference-provider.ts";
import type { AppDatabase } from "./database.ts";
import { nvidiaSmiExecutable } from "./nvidia-smi.ts";
import { defaultVramBudget, expiredWarmModels, retryContext, selectEvictions, GIB } from "./residency.ts";
import {
  assessMemoryAvailability,
  defaultLoadOptions,
  estimateModelVram,
  minimumFullGpuBytes,
} from "./vram-estimator.ts";

const execFileAsync = promisify(execFile);

export interface GpuMemorySnapshot {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
}

type GpuMemoryProbe = () => Promise<GpuMemorySnapshot>;
export interface SystemMemorySnapshot {
  totalBytes: number;
  availableBytes: number;
}

type SystemMemoryProbe = () => SystemMemorySnapshot;

export class ModelService {
  private catalog: ModelDescriptor[] = [];
  private readonly instances = new Map<string, ModelInstance>();
  private readonly emitter = new EventEmitter();
  private readonly database: AppDatabase;
  private readonly catalogService: ModelCatalogSource;
  private readonly runtime: InferenceRuntime;
  private readonly gpuMemoryProbe: GpuMemoryProbe;
  private readonly systemMemoryProbe: SystemMemoryProbe;
  private policy: ResidencyPolicy;
  private activeModelId?: string;
  private ttlTimer?: NodeJS.Timeout;
  private metricsTimer?: NodeJS.Timeout;
  private metricsRefreshRunning = false;
  private scanGeneration = 0;
  private scanInFlight?: { root: string; promise: Promise<ModelDescriptor[]> };
  private loadGeneration = 0;
  private loadQueue: Promise<void> = Promise.resolve();
  private readonly loadInFlight = new Map<string, Promise<ModelInstance>>();
  private loadController?: { modelId: string; controller: AbortController };

  constructor(
    database: AppDatabase,
    catalogService: ModelCatalogSource,
    runtime: InferenceRuntime,
    gpuMemoryProbe: GpuMemoryProbe = queryNvidiaMemorySnapshot,
    systemMemoryProbe: SystemMemoryProbe = querySystemMemorySnapshot,
  ) {
    this.database = database;
    this.catalogService = catalogService;
    this.runtime = runtime;
    this.gpuMemoryProbe = gpuMemoryProbe;
    this.systemMemoryProbe = systemMemoryProbe;
    this.catalog = database.listModels().map((model) => {
      const saved = model.vramEstimate;
      const estimate = estimateModelVram(model, saved ? {
        contextLength: saved.contextLength,
        gpuLayers: saved.gpuLayers,
        cacheType: saved.cacheType,
        kvCachePlacement: saved.kvCachePlacement,
      } : defaultLoadOptions(model));
      return {
        ...model,
        loadState: "unloaded",
        measuredVramBytes: undefined,
        estimatedVramBytes: estimate.totalBytes,
        vramEstimate: estimate,
      };
    });
    this.policy = database.getSetting<ResidencyPolicy>("residencyPolicy", {
      mode: "quick-switch",
      budgetBytes: 20 * GIB,
      warmTtlMinutes: 30,
      pinnedModelIds: [],
    });
    this.ttlTimer = setInterval(() => void this.evictExpiredWarmModels(), 60_000);
    this.metricsTimer = setInterval(() => void this.refreshVramMetrics(), 2_000);
  }

  dispose(): void {
    if (this.ttlTimer) clearInterval(this.ttlTimer);
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    this.ttlTimer = undefined;
    this.metricsTimer = undefined;
  }

  subscribe(listener: (models: ModelDescriptor[]) => void): () => void {
    this.emitter.on("changed", listener);
    return () => this.emitter.off("changed", listener);
  }

  list(): ModelDescriptor[] {
    return this.catalog.map((model) => ({ ...model }));
  }

  get(modelId: string): ModelDescriptor | undefined {
    const model = this.catalog.find((candidate) => candidate.id === modelId);
    return model ? { ...model } : undefined;
  }

  getActiveModel(): ModelDescriptor | undefined {
    return this.activeModelId ? this.get(this.activeModelId) : undefined;
  }

  async estimate(modelId: string, options: ModelLoadOptions): Promise<VramEstimate> {
    const estimate = estimateModelVram(this.requireModel(modelId), options);
    const gpu = await this.gpuMemoryProbe();
    const creditedInstances = this.policy.mode === "quick-switch"
      ? [...this.instances.values()]
      : [this.instances.get(modelId)].filter((instance): instance is ModelInstance => Boolean(instance));
    const residentCredit = creditedInstances.reduce((total, instance) => {
      const model = this.catalog.find((candidate) => candidate.id === instance.modelId);
      return total + (instance.measuredVramBytes ?? model?.measuredVramBytes ?? 0);
    }, 0);
    const availableVram = gpu.totalBytes > 0
      ? Math.min(gpu.totalBytes, gpu.freeBytes + residentCredit)
      : gpu.freeBytes + residentCredit;
    const system = this.systemMemoryProbe();
    return assessMemoryAvailability(estimate, {
      systemRamTotalBytes: system.totalBytes,
      systemRamAvailableBytes: system.availableBytes,
      gpuVramAvailableBytes: availableVram,
    });
  }

  async chat(
    modelId: string,
    payload: Record<string, unknown>,
    onChunk: (chunk: ChatCompletionChunk) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.runtime.has(modelId)) {
      throw new Error("The selected model is not loaded or connected. Load or attach an exact instance explicitly first.");
    }
    await this.runtime.chat(modelId, payload, onChunk, signal);
  }

  setToolCapability(modelId: string, capability: ModelDescriptor["toolCapability"]): void {
    const model = this.catalog.find((candidate) => candidate.id === modelId);
    if (!model) return;
    model.toolCapability = capability;
    this.database.saveModels(this.catalog);
    this.emitChanged();
  }

  getPolicy(): ResidencyPolicy {
    return { ...this.policy, pinnedModelIds: [...this.policy.pinnedModelIds] };
  }

  async initializeBudget(): Promise<void> {
    const total = (await this.gpuMemoryProbe()).totalBytes;
    if (total <= 0) return;
    const saved = this.database.getSetting<number | null>("vramBudgetInitialized", null);
    if (saved === null) {
      this.policy.budgetBytes = defaultVramBudget(total);
      this.database.setSetting("vramBudgetInitialized", total);
      this.database.setSetting("residencyPolicy", this.policy);
    }
  }

  async scan(root: string): Promise<ModelDescriptor[]> {
    if (this.scanInFlight?.root === root) return this.scanInFlight.promise;
    const generation = ++this.scanGeneration;
    let trackedPromise!: Promise<ModelDescriptor[]>;
    trackedPromise = this.performScan(root, generation).finally(() => {
      if (this.scanInFlight?.promise === trackedPromise) this.scanInFlight = undefined;
    });
    this.scanInFlight = { root, promise: trackedPromise };
    return trackedPromise;
  }

  private async performScan(root: string, generation: number): Promise<ModelDescriptor[]> {
    let scanned: ModelDescriptor[];
    try {
      scanned = await this.catalogService.scan(root);
    } catch (error) {
      if (generation !== this.scanGeneration && isAbortError(error)) return this.list();
      throw error;
    }
    if (generation !== this.scanGeneration) return this.list();
    for (const modelId of this.instances.keys()) {
      if (this.runtime.has(modelId)) continue;
      this.instances.delete(modelId);
      if (this.activeModelId === modelId) this.activeModelId = undefined;
    }
    const previous = new Map(this.catalog.map((model) => [model.id, model]));
    this.catalog = scanned.map((model) => {
      const old = previous.get(model.id);
      const instance = this.instances.get(model.id);
      if (model.provider === "lmstudio") {
        return {
          ...model,
          pinned: this.policy.pinnedModelIds.includes(model.id) || old?.pinned || false,
          loadState: instance?.state ?? model.loadState,
          lastUsedAt: instance?.lastUsedAt ?? old?.lastUsedAt,
          workbenchInstance: instance?.instanceId
            ? { id: instance.instanceId, ownedByWorkbench: instance.ownedByWorkbench === true }
            : undefined,
        };
      }
      const saved = old?.vramEstimate;
      const estimate = estimateModelVram({ ...model, vramEstimate: old?.vramEstimate }, saved ? {
        contextLength: saved.contextLength,
        gpuLayers: saved.gpuLayers,
        cacheType: saved.cacheType,
        kvCachePlacement: saved.kvCachePlacement,
      } : defaultLoadOptions(model));
      return {
        ...model,
        pinned: this.policy.pinnedModelIds.includes(model.id) || old?.pinned || false,
        loadState: instance?.state ?? "unloaded",
        lastUsedAt: instance?.lastUsedAt ?? old?.lastUsedAt,
        measuredVramBytes: instance?.measuredVramBytes,
        estimatedVramBytes: estimate.totalBytes,
        vramEstimate: estimate,
      };
    });
    this.database.saveModels(this.catalog);
    this.emitChanged();
    return this.list();
  }

  async setPolicy(policy: ResidencyPolicy): Promise<ResidencyPolicy> {
    this.policy = {
      ...policy,
      budgetBytes: Math.max(2 * GIB, policy.budgetBytes),
      warmTtlMinutes: Math.max(1, policy.warmTtlMinutes),
      pinnedModelIds: [...new Set(policy.pinnedModelIds)],
    };
    this.database.setSetting("residencyPolicy", this.policy);
    if (this.policy.mode === "quick-switch") {
      const keep = this.activeModelId;
      await Promise.all(
        [...this.instances.keys()].filter((modelId) => modelId !== keep).map((modelId) => this.unload(modelId)),
      );
    }
    this.emitChanged();
    return this.getPolicy();
  }

  async pin(modelId: string, pinned: boolean): Promise<void> {
    const model = this.requireModel(modelId);
    model.pinned = pinned;
    this.policy.pinnedModelIds = pinned
      ? [...new Set([...this.policy.pinnedModelIds, modelId])]
      : this.policy.pinnedModelIds.filter((id) => id !== modelId);
    this.database.setSetting("residencyPolicy", this.policy);
    this.database.saveModels(this.catalog);
    this.emitChanged();
  }

  async load(
    modelId: string,
    options: Partial<ModelLoadOptions> = {},
  ): Promise<ModelInstance> {
    const existing = this.loadInFlight.get(modelId);
    if (existing) return existing;
    this.loadController?.controller.abort();
    const controller = new AbortController();
    this.loadController = { modelId, controller };
    const generation = ++this.loadGeneration;
    const requestedOptions = { ...options };
    let tracked!: Promise<ModelInstance>;
    const queued = this.loadQueue.then(
      () => this.performLoad(modelId, requestedOptions, generation, controller.signal),
      () => this.performLoad(modelId, requestedOptions, generation, controller.signal),
    );
    this.loadQueue = queued.then(() => undefined, () => undefined);
    tracked = queued.finally(() => {
      if (this.loadInFlight.get(modelId) === tracked) this.loadInFlight.delete(modelId);
      if (this.loadController?.controller === controller) this.loadController = undefined;
    });
    this.loadInFlight.set(modelId, tracked);
    return tracked;
  }

  private async performLoad(
    modelId: string,
    options: Partial<ModelLoadOptions>,
    generation: number,
    signal: AbortSignal,
  ): Promise<ModelInstance> {
    if (generation !== this.loadGeneration || signal.aborted) throw new ModelLoadSupersededError();
    const model = this.requireModel(modelId);
    const current = this.instances.get(modelId);
    const resident = current && (current.state === "active" || current.state === "warm");
    const explicitReload = Object.keys(options).length > 0;
    if (resident && !explicitReload) {
      this.markActive(modelId);
      return { ...this.instances.get(modelId)! };
    }
    if (resident) await this.performUnload(modelId);

    if (model.provider === "lmstudio") {
      return this.performProviderLoad(model, options, generation, signal);
    }

    const defaults = defaultLoadOptions(model);
    const requested = estimateModelVram(model, {
      contextLength: options.contextLength ?? defaults.contextLength,
      gpuLayers: options.gpuLayers ?? defaults.gpuLayers,
      cacheType: options.cacheType ?? defaults.cacheType,
      kvCachePlacement: options.kvCachePlacement ?? defaults.kvCachePlacement,
    });
    model.estimatedVramBytes = requested.totalBytes;
    model.vramEstimate = requested;

    if (this.policy.mode === "quick-switch") {
      await Promise.all([...this.instances.keys()].filter((id) => id !== modelId).map((id) => this.performUnload(id)));
    } else {
      const residentInstances = [...this.instances.values()].filter(
        (instance) => instance.state === "active" || instance.state === "warm" || instance.state === "loading",
      );
      const evictions = selectEvictions(
        this.catalog,
        residentInstances,
        this.policy,
        requested.totalBytes,
        modelId,
      );
      const evictionSet = new Set(evictions);
      const remainingResidents = residentInstances.filter(
        (instance) => instance.modelId !== modelId && !evictionSet.has(instance.modelId),
      );
      const remainingBytes = remainingResidents.reduce((sum, instance) => {
        const candidate = this.catalog.find((item) => item.id === instance.modelId);
        return sum + (candidate?.measuredVramBytes ?? candidate?.estimatedVramBytes ?? 0);
      }, 0);
      if (remainingBytes + requested.totalBytes > this.policy.budgetBytes && remainingResidents.length > 0) {
        const names = remainingResidents
          .map((instance) => this.catalog.find((item) => item.id === instance.modelId)?.name ?? instance.modelId)
          .join(", ");
        throw new Error(
          `Pinned resident model${remainingResidents.length === 1 ? "" : "s"} block the VRAM pool: ${names}. ` +
            "Unpin them, use Quick switch, or raise the pool budget.",
        );
      }
      await Promise.all(evictions.map((id) => this.performUnload(id)));
    }

    const gpu = await this.gpuMemoryProbe();
    const system = this.systemMemoryProbe();
    const assessed = assessMemoryAvailability(requested, {
      systemRamTotalBytes: system.totalBytes,
      systemRamAvailableBytes: system.availableBytes,
      gpuVramAvailableBytes: gpu.freeBytes,
    });
    model.estimatedVramBytes = assessed.totalBytes;
    model.vramEstimate = assessed;
    const fullGpuOffload = assessed.gpuLayers >= assessed.totalGpuLayers;
    const minimumFullBytes = minimumFullGpuBytes(assessed);
    if (fullGpuOffload && !options.allowUnsafeMemoryPressure) {
      if (gpu.freeBytes > 0 && gpu.freeBytes < minimumFullBytes) {
        const message =
          `Only ${formatGib(gpu.freeBytes)} of system VRAM is free; at least ${formatGib(minimumFullBytes)} is needed ` +
          `to avoid silent partial CPU offload. ${formatGib(gpu.usedBytes)} is already in use by GPU workloads or the desktop. ` +
          "Close or unload the other GPU workload, or choose explicit partial GPU offload.";
        this.setModelError(modelId, message);
        throw new Error(message);
      }
    }
    if (assessed.memoryPressure === "unsafe" && !options.allowUnsafeMemoryPressure) {
      const message =
        `The requested load would create unsafe memory pressure. ${assessed.memoryDiagnostics?.join(" ") ?? ""} ` +
        "Choose Q4_0, keep KV cache in system RAM, reduce context or GPU layers, or explicitly allow the experimental load.";
      this.setModelError(modelId, message.trim());
      throw new Error(message.trim());
    }

    const contextLength = assessed.contextLength;
    const gpuLayers = assessed.gpuLayers;
    this.setModelState(modelId, "loading");
    try {
      const instance = await this.runtime.load(model, {
        contextLength,
        gpuLayers,
        cacheType: assessed.cacheType,
        kvCachePlacement: assessed.kvCachePlacement,
      }, signal);
      if (generation !== this.loadGeneration) {
        await this.runtime.unload(modelId);
        throw new ModelLoadSupersededError();
      }
      if (
        fullGpuOffload
        && instance.measuredVramBytes
        && instance.measuredVramBytes < minimumFullBytes * 0.6
      ) {
        await this.runtime.unload(modelId);
        throw new Error(
          `The legacy runtime allocated only ${formatGib(instance.measuredVramBytes)} for a requested full-GPU load. ` +
          "Silent partial CPU offload was rejected; free VRAM or choose explicit partial GPU offload.",
        );
      }
      instance.estimatedVramBytes = assessed.totalBytes;
      this.instances.set(modelId, instance);
      this.markActive(modelId);
      await this.refreshVramMetrics();
      return { ...instance };
    } catch (firstError) {
      if (firstError instanceof ModelLoadSupersededError) {
        this.setModelState(modelId, "unloaded");
        throw firstError;
      }
      if (isAbortError(firstError) && signal.aborted) {
        this.setModelState(modelId, "unloaded");
        throw new ModelLoadSupersededError();
      }
      if (generation !== this.loadGeneration) {
        this.setModelState(modelId, "unloaded");
        throw new ModelLoadSupersededError();
      }
      const firstMessage = String(firstError);
      if (!/GPU_OOM|out of memory|failed to allocate/i.test(firstMessage)) {
        this.setModelError(modelId, firstMessage);
        throw firstError;
      }

      if (this.policy.mode === "auto-evict") {
        const eligible = [...this.instances.keys()].filter(
          (id) => id !== modelId && !this.policy.pinnedModelIds.includes(id),
        );
        await Promise.all(eligible.map((id) => this.performUnload(id)));
      }
      try {
        const retryEstimate = estimateModelVram(model, {
          contextLength: retryContext(contextLength),
          gpuLayers,
          cacheType: options.cacheType ?? assessed.cacheType,
          kvCachePlacement: options.kvCachePlacement ?? assessed.kvCachePlacement,
        });
        model.estimatedVramBytes = retryEstimate.totalBytes;
        model.vramEstimate = retryEstimate;
        const instance = await this.runtime.load(model, {
          contextLength: retryEstimate.contextLength,
          gpuLayers: retryEstimate.gpuLayers,
          cacheType: retryEstimate.cacheType,
          kvCachePlacement: retryEstimate.kvCachePlacement,
        }, signal);
        if (generation !== this.loadGeneration) {
          await this.runtime.unload(modelId);
          throw new ModelLoadSupersededError();
        }
        instance.estimatedVramBytes = retryEstimate.totalBytes;
        this.instances.set(modelId, instance);
        this.markActive(modelId);
        await this.refreshVramMetrics();
        return { ...instance };
      } catch (secondError) {
        if (secondError instanceof ModelLoadSupersededError) {
          this.setModelState(modelId, "unloaded");
          throw secondError;
        }
        if (isAbortError(secondError) && signal.aborted) {
          this.setModelState(modelId, "unloaded");
          throw new ModelLoadSupersededError();
        }
        const message = `${String(secondError)} Partial GPU offload is available as an explicit load option.`;
        this.setModelError(modelId, message);
        throw new Error(message);
      }
    }
  }

  private async performProviderLoad(
    model: ModelDescriptor,
    options: Partial<ModelLoadOptions>,
    generation: number,
    signal: AbortSignal,
  ): Promise<ModelInstance> {
    if (model.modelKind === "embedding") {
      throw new Error("Embedding models cannot be selected for Workbench chat.");
    }
    if (this.policy.mode === "quick-switch") {
      await Promise.all(
        [...this.instances.keys()]
          .filter((modelId) => modelId !== model.id)
          .map((modelId) => this.performUnload(modelId)),
      );
    }
    this.setModelState(model.id, "loading");
    try {
      const instance = await this.runtime.load(model, options, signal);
      if (generation !== this.loadGeneration || signal.aborted) {
        await this.runtime.unload(model.id);
        throw new ModelLoadSupersededError();
      }
      this.instances.set(model.id, instance);
      this.markActive(model.id);
      return { ...instance };
    } catch (error) {
      if (error instanceof ModelLoadSupersededError || (isAbortError(error) && signal.aborted)) {
        this.setModelState(model.id, "unloaded");
        throw new ModelLoadSupersededError();
      }
      this.setModelError(model.id, safeRuntimeError(error));
      throw error;
    }
  }

  async unload(modelId: string): Promise<void> {
    if (this.loadController?.modelId === modelId) {
      this.loadController.controller.abort();
      this.loadGeneration += 1;
    }
    const queued = this.loadQueue.then(
      () => this.performUnload(modelId),
      () => this.performUnload(modelId),
    );
    this.loadQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private async performUnload(modelId: string): Promise<void> {
    await this.runtime.unload(modelId);
    this.instances.delete(modelId);
    if (this.activeModelId === modelId) this.activeModelId = undefined;
    this.setModelState(modelId, "unloaded");
  }

  async shutdown(): Promise<void> {
    this.dispose();
    this.catalogService.cancel?.();
    this.loadController?.controller.abort();
    this.loadGeneration += 1;
    await this.loadQueue;
    await this.runtime.unloadAll();
    this.instances.clear();
  }

  private markActive(modelId: string): void {
    if (this.activeModelId && this.activeModelId !== modelId && this.policy.mode === "auto-evict") {
      const old = this.instances.get(this.activeModelId);
      if (old) {
        old.state = "warm";
        old.lastUsedAt = new Date().toISOString();
      }
      this.setModelState(this.activeModelId, "warm");
    }
    const active = this.instances.get(modelId);
    if (active) {
      active.state = "active";
      active.lastUsedAt = new Date().toISOString();
    }
    this.activeModelId = modelId;
    this.setModelState(modelId, "active");
  }

  private setModelState(modelId: string, state: ModelDescriptor["loadState"]): void {
    const model = this.catalog.find((candidate) => candidate.id === modelId);
    if (model) {
      model.loadState = state;
      if (state !== "error") model.error = undefined;
      if (state === "active" || state === "warm") model.lastUsedAt = new Date().toISOString();
      const instance = this.instances.get(modelId);
      model.workbenchInstance = instance?.instanceId && (state === "active" || state === "warm")
        ? { id: instance.instanceId, ownedByWorkbench: instance.ownedByWorkbench === true }
        : undefined;
      this.database.saveModels(this.catalog);
    }
    this.emitChanged();
  }

  private setModelError(modelId: string, error: string): void {
    const model = this.catalog.find((candidate) => candidate.id === modelId);
    if (model) model.error = error;
    this.instances.set(modelId, {
      modelId,
      state: "error",
      contextLength: this.get(modelId)?.contextLength ?? 0,
      gpuLayers: 0,
      error,
    });
    this.setModelState(modelId, "error");
  }

  private residentBytes(): number {
    return [...this.instances.values()]
      .filter((instance) => instance.state === "active" || instance.state === "warm" || instance.state === "loading")
      .reduce((sum, instance) => {
        const model = this.get(instance.modelId);
        return sum + (model?.measuredVramBytes ?? model?.estimatedVramBytes ?? 0);
      }, 0);
  }

  private async refreshVramMetrics(): Promise<void> {
    if (this.metricsRefreshRunning) return;
    this.metricsRefreshRunning = true;
    try {
    const processIds = new Map<number, string>();
    for (const modelId of this.instances.keys()) {
      const processId = this.runtime.processId(modelId);
      if (processId) processIds.set(processId, modelId);
    }
    if (!processIds.size) return;
    const usage = await queryNvidiaProcessVramBytes();
    let changed = false;
    for (const [processId, modelId] of processIds) {
      const measured = usage.get(processId) ?? this.runtime.gpuAllocationBytes(modelId);
      if (measured === undefined) continue;
      const model = this.catalog.find((candidate) => candidate.id === modelId);
      const instance = this.instances.get(modelId);
      if (!model || !instance) continue;
      if (Math.abs((model.measuredVramBytes ?? 0) - measured) < 8 * 1024 ** 2) continue;
      const measuredAt = new Date().toISOString();
      model.measuredVramBytes = measured;
      instance.measuredVramBytes = measured;
      if (model.vramEstimate) {
        model.vramEstimate = {
          ...model.vramEstimate,
          measuredBytes: measured,
          measuredAt,
          source: "measured",
        };
      }
      changed = true;
    }
    if (!changed) return;
    this.database.saveModels(this.catalog);
    this.emitChanged();
    } finally {
      this.metricsRefreshRunning = false;
    }
  }

  private async evictExpiredWarmModels(): Promise<void> {
    if (this.policy.mode !== "auto-evict") return;
    const expired = expiredWarmModels([...this.instances.values()], this.policy);
    await Promise.all(expired.map((modelId) => this.unload(modelId)));
  }

  private requireModel(modelId: string): ModelDescriptor {
    const model = this.catalog.find((candidate) => candidate.id === modelId);
    if (!model) throw new Error(`Unknown model: ${modelId}`);
    return model;
  }

  private emitChanged(): void {
    this.emitter.emit("changed", this.list());
  }
}

class ModelLoadSupersededError extends Error {
  constructor() {
    super("Model load was superseded by a newer model transition.");
    this.name = "AbortError";
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function safeRuntimeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 2_048);
}

async function queryNvidiaMemorySnapshot(): Promise<GpuMemorySnapshot> {
  try {
    const { stdout } = await execFileAsync(
      nvidiaSmiExecutable(),
      ["--query-gpu=memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"],
      { windowsHide: true, timeout: 5_000 },
    );
    const [totalMib, usedMib, freeMib] = String(stdout)
      .trim()
      .split(/\r?\n/, 1)[0]
      .split(",")
      .map((value) => Number(value.trim()));
    if (![totalMib, usedMib, freeMib].every(Number.isFinite)) {
      return { totalBytes: 0, usedBytes: 0, freeBytes: 0 };
    }
    return {
      totalBytes: totalMib * 1024 ** 2,
      usedBytes: usedMib * 1024 ** 2,
      freeBytes: freeMib * 1024 ** 2,
    };
  } catch {
    return { totalBytes: 0, usedBytes: 0, freeBytes: 0 };
  }
}

function formatGib(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`;
}

async function queryNvidiaProcessVramBytes(): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  try {
    const { stdout } = await execFileAsync(
      nvidiaSmiExecutable(),
      ["--query-compute-apps=pid,used_gpu_memory", "--format=csv,noheader,nounits"],
      { windowsHide: true, timeout: 5_000 },
    );
    for (const line of String(stdout).trim().split(/\r?\n/)) {
      const [pidText, memoryText] = line.split(",").map((value) => value.trim());
      const pid = Number(pidText);
      const memoryMib = Number(memoryText);
      if (Number.isInteger(pid) && Number.isFinite(memoryMib)) result.set(pid, memoryMib * 1024 ** 2);
    }
  } catch {
    // CPU-only systems and WDDM configurations may not expose per-process usage.
  }
  return result;
}

function querySystemMemorySnapshot(): SystemMemorySnapshot {
  return { totalBytes: totalmem(), availableBytes: freemem() };
}
