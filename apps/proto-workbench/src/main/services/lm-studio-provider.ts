import { createHash } from "node:crypto";
import type {
  LmStudioLoadedInstance,
  ModelDescriptor,
  ModelInstance,
  ModelLoadOptions,
  RuntimeStatus,
} from "../../shared/contracts.ts";
import type {
  ChatCompletionChunk,
  InferenceRuntime,
  ModelCatalogSource,
  ExecutionBinding,
  InstanceTokenizer,
  TokenCountResult,
} from "./inference-provider.ts";
import { RuntimeFailure } from "./runtime-control.ts";
import { LmStudioTokenizer } from "./lm-studio-tokenizer.ts";

export const LM_STUDIO_BASE_URL = "http://127.0.0.1:1234" as const;
export const LM_STUDIO_TOKEN_ENV_NAMES = ["LMSTUDIO_API_KEY", "LM_API_TOKEN"] as const;

const REQUEST_TIMEOUT_MS = 30_000;
const LOAD_TIMEOUT_MS = 15 * 60_000;
export const LM_STUDIO_CHAT_HEADER_TIMEOUT_MS = 10 * 60_000;
export const LM_STUDIO_CHAT_IDLE_TIMEOUT_MS = 90_000;
export const LM_STUDIO_DEFAULT_CHAT_DEADLINE_MS = 20 * 60_000;
export const LM_STUDIO_MAX_CHAT_DEADLINE_MS = 30 * 60_000;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_SSE_FRAME_BYTES = 1024 * 1024;
const MAX_SSE_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_SSE_CHUNKS = 65_536;
const MAX_MODELS = 10_000;
const TOKEN_MAX_BYTES = 4_096;

type FetchImplementation = typeof fetch;
type Environment = Readonly<Record<string, string | undefined>>;

interface LmStudioProviderOptions {
  fetchImpl?: FetchImplementation;
  environment?: Environment;
  chatDeadlineMs?: number;
  maxSseStreamBytes?: number;
  maxSseChunks?: number;
  prefillDeadlineMs?: number;
  idleDeadlineMs?: number;
  lifecycleDeadlineMs?: number;
  tokenizer?: InstanceTokenizer;
}

interface NativeLoadedInstance {
  id: string;
  config: {
    context_length: number;
    eval_batch_size?: number;
    parallel?: number;
    flash_attention?: boolean;
    num_experts?: number;
    offload_kv_cache_to_gpu?: boolean;
  };
}

interface NativeModel {
  type: "llm" | "embedding";
  publisher: string;
  key: string;
  display_name: string;
  architecture?: string | null;
  quantization: { name?: string | null; bits_per_weight?: number | null } | null;
  size_bytes: number;
  params_string?: string | null;
  loaded_instances: NativeLoadedInstance[];
  max_context_length: number;
  format?: string | null;
  capabilities?: {
    vision: boolean;
    trained_for_tool_use: boolean;
    reasoning?: {
      allowed_options: Array<"off" | "on" | "low" | "medium" | "high">;
      default: "off" | "on" | "low" | "medium" | "high";
    };
  };
  description?: string | null;
  variants?: string[];
  selected_variant?: string;
}

interface InstanceBinding {
  modelId: string;
  providerModelId: string;
  instanceId: string;
  ownedByWorkbench: boolean;
  config: NativeLoadedInstance["config"];
}

export class LmStudioProvider implements ModelCatalogSource, InferenceRuntime {
  private readonly fetchImpl: FetchImplementation;
  private readonly environment: Environment;
  private readonly chatDeadlineMs: number;
  private readonly maxSseStreamBytes: number;
  private readonly maxSseChunks: number;
  private readonly prefillDeadlineMs: number;
  private readonly idleDeadlineMs: number;
  private readonly lifecycleDeadlineMs: number;
  private readonly tokenizer?: InstanceTokenizer;
  private readonly bindings = new Map<string, InstanceBinding>();
  private nativeModels = new Map<string, NativeModel>();
  private scanController?: AbortController;

  constructor(options: LmStudioProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.environment = options.environment ?? process.env;
    this.prefillDeadlineMs = boundedInteger(options.prefillDeadlineMs ?? LM_STUDIO_CHAT_HEADER_TIMEOUT_MS, "prefillDeadlineMs", 1, LM_STUDIO_MAX_CHAT_DEADLINE_MS);
    this.idleDeadlineMs = boundedInteger(options.idleDeadlineMs ?? LM_STUDIO_CHAT_IDLE_TIMEOUT_MS, "idleDeadlineMs", 1, LM_STUDIO_MAX_CHAT_DEADLINE_MS);
    this.lifecycleDeadlineMs = boundedInteger(options.lifecycleDeadlineMs ?? LOAD_TIMEOUT_MS, "lifecycleDeadlineMs", 1, LOAD_TIMEOUT_MS);
    this.tokenizer = options.tokenizer ?? new LmStudioTokenizer();
    this.chatDeadlineMs = boundedInteger(
      options.chatDeadlineMs ?? LM_STUDIO_DEFAULT_CHAT_DEADLINE_MS,
      "chatDeadlineMs",
      1,
      LM_STUDIO_MAX_CHAT_DEADLINE_MS,
    );
    this.maxSseStreamBytes = boundedInteger(
      options.maxSseStreamBytes ?? MAX_SSE_STREAM_BYTES,
      "maxSseStreamBytes",
      1,
      MAX_SSE_STREAM_BYTES,
    );
    this.maxSseChunks = boundedInteger(
      options.maxSseChunks ?? MAX_SSE_CHUNKS,
      "maxSseChunks",
      1,
      MAX_SSE_CHUNKS,
    );
  }

  cancel(): void {
    this.scanController?.abort();
  }

  async scan(_root: string, signal?: AbortSignal): Promise<ModelDescriptor[]> {
    this.scanController?.abort();
    const controller = new AbortController();
    this.scanController = controller;
    const scanSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const models = await this.synchronize(scanSignal);
      return models.map((model) => this.toDescriptor(model));
    } finally {
      if (this.scanController === controller) this.scanController = undefined;
    }
  }

  async runtimeStatus(signal?: AbortSignal): Promise<RuntimeStatus> {
    try {
      const models = await this.synchronize(signal);
      const loadedModelCount = models.reduce((count, model) => count + model.loaded_instances.length, 0);
      return {
        available: true,
        provider: "lmstudio",
        endpoint: LM_STUDIO_BASE_URL,
        modelCount: models.length,
        loadedModelCount,
        detail:
          `LM Studio is reachable at ${LM_STUDIO_BASE_URL}; discovered ${models.length} model(s) `
          + `and ${loadedModelCount} loaded instance(s).`,
      };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return {
        available: false,
        provider: "lmstudio",
        endpoint: LM_STUDIO_BASE_URL,
        modelCount: 0,
        loadedModelCount: 0,
        detail: `LM Studio is not reachable at ${LM_STUDIO_BASE_URL}: ${safeErrorMessage(error)}`,
      };
    }
  }

  async load(
    descriptor: ModelDescriptor,
    options: Partial<ModelLoadOptions>,
    signal?: AbortSignal,
  ): Promise<ModelInstance> {
    return this.withLifecycleDeadline("model-load", signal, (boundedSignal) => this.performLoad(descriptor, options, boundedSignal));
  }

  private async performLoad(
    descriptor: ModelDescriptor,
    options: Partial<ModelLoadOptions>,
    signal: AbortSignal,
  ): Promise<ModelInstance> {
    const providerModelId = requireProviderModelId(descriptor);
    const models = await this.synchronize(signal);
    const model = models.find((candidate) => candidate.key === providerModelId);
    if (!model) throw new Error(`LM Studio no longer reports model ${providerModelId}. Refresh models and try again.`);
    if (model.type !== "llm") throw new Error("Embedding models cannot be selected for Workbench chat.");
    if (options.gpuLayers !== undefined && options.gpuLayers !== 0) {
      throw new Error("LM Studio native v1 does not expose a GPU-layer count; configure engine offload in LM Studio.");
    }
    if (options.cacheType !== undefined) {
      throw new Error("LM Studio native v1 does not expose KV-cache precision; use the supported cache placement option.");
    }
    if (options.allowUnsafeMemoryPressure) {
      throw new Error("The legacy Workbench memory-pressure override is not valid for LM Studio-managed allocation.");
    }

    const currentBinding = this.bindings.get(descriptor.id);
    if (currentBinding && model.loaded_instances.some((instance) => instance.id === currentBinding.instanceId)) {
      return toModelInstance(currentBinding, "active");
    }

    // Reusing an already loaded LM Studio instance is an explicit user action.
    // It is never claimed as Workbench-owned, so disconnecting cannot unload it.
    const existing = options.instanceId
      ? model.loaded_instances.find((instance) => instance.id === options.instanceId)
      : model.loaded_instances.length === 1
        ? model.loaded_instances[0]
        : undefined;
    if (options.instanceId && !existing) {
      throw new Error("The selected LM Studio instance is no longer loaded. Refresh models and choose again.");
    }
    if (!options.instanceId && model.loaded_instances.length > 1) {
      throw new Error("Multiple LM Studio instances are loaded for this model. Select an exact instance before connecting.");
    }
    if (existing) {
      const binding: InstanceBinding = {
        modelId: descriptor.id,
        providerModelId,
        instanceId: existing.id,
        ownedByWorkbench: false,
        config: existing.config,
      };
      this.bindings.set(descriptor.id, binding);
      return toModelInstance(binding, "active");
    }

    const body: Record<string, unknown> = {
      model: providerModelId,
      echo_load_config: true,
    };
    if (/qwen3[.]8[-/]27b/i.test(providerModelId) && /q4/i.test(model.quantization?.name ?? providerModelId)) {
      body.context_length = Math.min(32_768, model.max_context_length);
    }
    if (options.contextLength !== undefined) {
      body.context_length = boundedInteger(options.contextLength, "contextLength", 256, model.max_context_length);
    }
    if (options.evalBatchSize !== undefined) {
      body.eval_batch_size = boundedInteger(options.evalBatchSize, "evalBatchSize", 1, 65_536);
    }
    if (options.flashAttention !== undefined) body.flash_attention = options.flashAttention;
    if (options.numExperts !== undefined) {
      body.num_experts = boundedInteger(options.numExperts, "numExperts", 1, 1_024);
    }
    if (options.kvCachePlacement !== undefined) {
      body.offload_kv_cache_to_gpu = options.kvCachePlacement === "gpu";
    }

    const response = await this.requestJson(
      "/api/v1/models/load",
      { method: "POST", body: JSON.stringify(body), signal },
      this.lifecycleDeadlineMs,
    );
    const record = requireRecord(response, "LM Studio load response");
    if (record.status !== "loaded" || record.type !== "llm") {
      throw new Error("LM Studio returned an invalid model load status.");
    }
    const instanceId = boundedIdentifier(record.instance_id, "LM Studio instance_id", 1, 1_024);
    let binding: InstanceBinding | undefined;
    try {
      const config = parseLoadConfig(record.load_config, model.max_context_length);
      binding = {
        modelId: descriptor.id,
        providerModelId,
        instanceId,
        ownedByWorkbench: true,
        config,
      };
      this.bindings.set(descriptor.id, binding);
      const refreshed = await this.synchronize(signal);
      const reflected = refreshed
        .find((candidate) => candidate.key === providerModelId)
        ?.loaded_instances.find((instance) => instance.id === instanceId);
      if (!reflected) {
        throw new Error("LM Studio acknowledged the load but did not report the new instance during verification.");
      }
      binding.config = reflected.config;
      return toModelInstance(binding, "active");
    } catch (verificationError) {
      // Once LM Studio has returned an instance_id, Workbench owns cleanup even
      // when the caller aborts or the catalogue can no longer be reconciled.
      if (binding) this.deleteBindingIfExact(binding);
      try {
        await this.unloadExactOwnedInstance(instanceId);
      } catch (cleanupError) {
        throw new AggregateError(
          [verificationError, cleanupError],
          `LM Studio load verification failed: ${safeErrorMessage(verificationError)} `
            + `Cleanup of Workbench-owned instance ${instanceId} also failed: ${safeErrorMessage(cleanupError)}`,
        );
      }
      throw verificationError;
    }
  }

  async unload(modelId: string): Promise<void> {
    return this.withLifecycleDeadline("model-unload", undefined, (signal) => this.performUnload(modelId, signal));
  }

  private async performUnload(modelId: string, signal: AbortSignal): Promise<void> {
    const binding = this.bindings.get(modelId);
    if (!binding) return;
    if (!binding.ownedByWorkbench) {
      this.bindings.delete(modelId);
      return;
    }
    const models = await this.synchronize(signal);
    const stillLoaded = models
      .find((model) => model.key === binding.providerModelId)
      ?.loaded_instances.some((instance) => instance.id === binding.instanceId);
    if (!stillLoaded) {
      this.bindings.delete(modelId);
      return;
    }

    const response = await this.requestJson("/api/v1/models/unload", {
      method: "POST",
      body: JSON.stringify({ instance_id: binding.instanceId }),
      signal,
    }, this.lifecycleDeadlineMs);
    const record = requireRecord(response, "LM Studio unload response");
    if (record.instance_id !== binding.instanceId) {
      throw new Error("LM Studio did not confirm the exact Workbench-owned instance unload.");
    }
    this.bindings.delete(modelId);
  }

  async unloadAll(): Promise<void> {
    const owned = [...this.bindings.values()].filter((binding) => binding.ownedByWorkbench);
    const errors: unknown[] = [];
    for (const binding of owned) {
      try {
        await this.unload(binding.modelId);
      } catch (error) {
        errors.push(error);
      }
    }
    // Externally owned instances are only disconnected locally.
    for (const [modelId, binding] of this.bindings) {
      if (!binding.ownedByWorkbench) this.bindings.delete(modelId);
    }
    if (errors.length) throw new AggregateError(errors, "Some Workbench-owned LM Studio instances could not be unloaded.");
  }

  has(modelId: string): boolean {
    const binding = this.bindings.get(modelId);
    if (!binding) return false;
    return Boolean(
      this.nativeModels.get(binding.providerModelId)
        ?.loaded_instances.some((instance) => instance.id === binding.instanceId),
    );
  }

  processId(_modelId: string): undefined {
    return undefined;
  }

  gpuAllocationBytes(_modelId: string): undefined {
    return undefined;
  }

  peekExecutionBinding(modelId: string): ExecutionBinding | undefined {
    const binding = this.bindings.get(modelId);
    if (!binding || !this.has(modelId)) return undefined;
    return {
      modelId, instanceId: binding.instanceId, contextLength: binding.config.context_length,
      ownedByWorkbench: binding.ownedByWorkbench, observedAt: new Date().toISOString(),
    };
  }

  async getExecutionBinding(modelId: string, signal?: AbortSignal): Promise<ExecutionBinding> {
    await this.synchronize(signal);
    const binding = this.peekExecutionBinding(modelId);
    if (!binding) throw new RuntimeFailure("MODEL_UNAVAILABLE", "binding", "The selected LM Studio model is not explicitly connected and loaded. Load it before chatting.", { retryable: true });
    return binding;
  }

  async countPromptTokens(modelId: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<TokenCountResult> {
    const binding = await this.getExecutionBinding(modelId, signal);
    if (this.tokenizer) {
      try {
        const tokens = await this.tokenizer.countPrompt(binding.instanceId, payload, signal);
        if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("The instance tokenizer returned an invalid token count.");
        return { tokens, method: "tokenizer" };
      } catch (error) {
        if (signal?.aborted) throw abortError();
        // SDK availability and exact template support are separate from inference.
        // Falling back is explicitly reported and never claims an exact token count.
      }
    }
    // Explicitly conservative: includes serialized tool schemas and message framing.
    return { tokens: Buffer.byteLength(JSON.stringify({ messages: payload.messages ?? [], tools: payload.tools ?? [] }), "utf8") + 512, method: "utf8-upper-bound" };
  }

  async chat(
    modelId: string,
    payload: Record<string, unknown>,
    onChunk: (chunk: ChatCompletionChunk) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const { deadline: callerDeadline, _onQueueState: _ignoredQueueState, ...requestPayload } = payload;
    if (callerDeadline !== undefined && (typeof callerDeadline !== "number" || !Number.isFinite(callerDeadline))) throw new Error("The generation deadline must be a finite epoch timestamp.");
    const totalDeadlineMs = typeof callerDeadline === "number" ? Math.min(this.chatDeadlineMs, Math.max(0, callerDeadline - Date.now())) : this.chatDeadlineMs;
    if (totalDeadlineMs <= 0) throw new RuntimeFailure("GENERATION_TIMEOUT", "generation", "The task generation deadline is exhausted.", { budgetMs: 0 });
    const deadlineController = new AbortController();
    let failure: RuntimeFailure | undefined;
    let prefillTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    const expire = (code: "PREFILL_TIMEOUT" | "STREAM_STALLED" | "GENERATION_TIMEOUT", stage: string, budgetMs: number) => {
      if (failure) return;
      failure = new RuntimeFailure(code, stage, code === "GENERATION_TIMEOUT"
        ? `LM Studio chat exceeded the ${budgetMs}-millisecond total deadline.`
        : `LM Studio ${stage} exceeded its ${budgetMs}-millisecond deadline.`, { retryable: true, budgetMs });
      deadlineController.abort();
    };
    const deadline = setTimeout(() => {
      expire("GENERATION_TIMEOUT", "generation", totalDeadlineMs);
    }, totalDeadlineMs);
    const chatSignal = signal
      ? AbortSignal.any([signal, deadlineController.signal])
      : deadlineController.signal;
    try {
      // Synchronization immediately before inference is the fail-closed JIT guard.
      // No model identifier is ever sent unless its explicit binding is still loaded.
      const binding = await this.getExecutionBinding(modelId, chatSignal);
      prefillTimer = setTimeout(() => expire("PREFILL_TIMEOUT", "prefill", this.prefillDeadlineMs), this.prefillDeadlineMs);

      // The outer deadline stays armed until [DONE], unlike the request helper's
      // header deadline, and its signal remains attached to the response body.
      const response = await this.request("/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ ...requestPayload, model: binding.instanceId, stream: true, stream_options: {include_usage: true} }),
        signal: chatSignal,
      }, 0);
      if (!response.body) throw new Error("LM Studio returned an empty streaming response.");
      const contentType = response.headers.get("content-type")?.toLocaleLowerCase() ?? "";
      if (!contentType.startsWith("text/event-stream")) {
        await response.body.cancel().catch(() => undefined);
        throw new Error("LM Studio chat response was not an SSE stream.");
      }
      await parseSse(
        response.body,
        (chunk) => {
          if (chunk.choices?.some((choice) => {
            const delta = choice.delta;
            return Boolean(delta?.content || delta?.reasoning || delta?.reasoning_content
              || delta?.tool_calls?.some((call) => call.function?.name || call.function?.arguments));
          })) {
            if (prefillTimer) clearTimeout(prefillTimer);
            prefillTimer = undefined;
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => expire("STREAM_STALLED", "stream-idle", this.idleDeadlineMs), this.idleDeadlineMs);
          }
          onChunk(chunk);
        },
        chatSignal,
        this.maxSseStreamBytes,
        this.maxSseChunks,
      );
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (failure) throw failure;
      throw error;
    } finally {
      clearTimeout(deadline);
      if (prefillTimer) clearTimeout(prefillTimer);
      if (idleTimer) clearTimeout(idleTimer);
    }
  }

  private deleteBindingIfExact(binding: InstanceBinding): void {
    const current = this.bindings.get(binding.modelId);
    if (current?.instanceId === binding.instanceId && current.ownedByWorkbench) {
      this.bindings.delete(binding.modelId);
    }
  }

  private async unloadExactOwnedInstance(instanceId: string): Promise<void> {
    // Reconciliation may itself be the failed operation, so cleanup goes
    // directly to the exact native instance and never trusts a fresh catalogue.
    const response = await this.requestJson("/api/v1/models/unload", {
      method: "POST",
      body: JSON.stringify({ instance_id: instanceId }),
    }, REQUEST_TIMEOUT_MS);
    const record = requireRecord(response, "LM Studio cleanup unload response");
    if (record.instance_id !== instanceId) {
      throw new Error("LM Studio did not confirm cleanup of the exact Workbench-owned instance.");
    }
  }

  private async synchronize(signal?: AbortSignal): Promise<NativeModel[]> {
    const payload = await this.requestJson("/api/v1/models", { method: "GET", signal });
    const record = requireRecord(payload, "LM Studio model catalog");
    if (!Array.isArray(record.models) || record.models.length > MAX_MODELS) {
      throw new Error(`LM Studio model catalog must contain at most ${MAX_MODELS} models.`);
    }
    const models = record.models.map((value, index) => parseNativeModel(value, index));
    const keys = new Set<string>();
    for (const model of models) {
      if (keys.has(model.key)) throw new Error(`LM Studio model catalog contains duplicate key ${model.key}.`);
      keys.add(model.key);
    }
    this.nativeModels = new Map(models.map((model) => [model.key, model]));
    for (const [modelId, binding] of this.bindings) {
      const loaded = this.nativeModels.get(binding.providerModelId)?.loaded_instances
        .find((instance) => instance.id === binding.instanceId);
      if (!loaded) this.bindings.delete(modelId);
      else binding.config = loaded.config;
    }
    return models;
  }

  private toDescriptor(model: NativeModel): ModelDescriptor {
    const idDigest = createHash("sha256").update(`lmstudio-id\0${model.key}`).digest("hex");
    const fingerprint = createHash("sha256").update(JSON.stringify({
      provider: "lmstudio",
      key: model.key,
      type: model.type,
      architecture: model.architecture ?? null,
      quantization: model.quantization,
      sizeBytes: model.size_bytes,
      maxContextLength: model.max_context_length,
      format: model.format ?? null,
      selectedVariant: model.selected_variant ?? null,
      capabilities: model.capabilities ?? null,
    })).digest("hex");
    const loadedInstances: LmStudioLoadedInstance[] = model.loaded_instances.map((instance) => ({
      id: instance.id,
      contextLength: instance.config.context_length,
      evalBatchSize: instance.config.eval_batch_size,
      parallel: instance.config.parallel,
      flashAttention: instance.config.flash_attention,
      numExperts: instance.config.num_experts,
      offloadKvCacheToGpu: instance.config.offload_kv_cache_to_gpu,
    }));
    return {
      id: `lmstudio:${idDigest.slice(0, 24)}`,
      name: model.display_name,
      path: `lmstudio:${model.key}`,
      files: [],
      sizeBytes: model.size_bytes,
      architecture: model.architecture ?? model.format ?? "unknown",
      quantization: model.quantization?.name ?? "unknown",
      contextLength: model.max_context_length,
      vision: model.capabilities?.vision ?? false,
      toolCapability: model.capabilities?.trained_for_tool_use ? "agent-ready" : "unknown",
      fingerprint,
      fingerprintSource: "provider-metadata",
      estimatedVramBytes: model.size_bytes,
      loadState: model.loaded_instances.length ? "warm" : "unloaded",
      pinned: false,
      metadataSource: "lmstudio",
      provider: "lmstudio",
      providerModelId: model.key,
      publisher: model.publisher,
      modelKind: model.type,
      format: model.format ?? undefined,
      paramsString: model.params_string ?? undefined,
      description: model.description ?? undefined,
      loadedInstances,
      reasoning: model.capabilities?.reasoning,
    };
  }

  private async requestJson(
    path: string,
    init: RequestInit,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const controller = new AbortController();
    let expired = false;
    const timer = setTimeout(() => { expired = true; controller.abort(); }, timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    try {
      const response = await this.request(path, { ...init, signal }, 0);
      const text = await readBoundedText(response, MAX_CATALOG_BYTES, timeoutMs, signal);
      signal.throwIfAborted();
      try { return JSON.parse(text) as unknown; }
      catch { throw new Error("LM Studio returned malformed JSON."); }
    } catch (error) {
      if (init.signal?.aborted) throw abortError();
      if (expired) throw new RuntimeFailure("PROVIDER_TIMEOUT", path.endsWith("/load") ? "model-load" : path.endsWith("/unload") ? "model-unload" : "catalog", `LM Studio request exceeded its ${timeoutMs}-millisecond total deadline.`, {
        budgetMs: timeoutMs, retryable: init.method !== "POST", effectState: init.method === "POST" ? "unknown" : "none",
      });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async withLifecycleDeadline<T>(stage: string, callerSignal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let expired = false;
    const timer = setTimeout(() => { expired = true; controller.abort(); }, this.lifecycleDeadlineMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    try {
      const result = await operation(signal);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (callerSignal?.aborted) throw abortError();
      if (expired) throw new RuntimeFailure("PROVIDER_TIMEOUT", stage, `LM Studio ${stage} exceeded its ${this.lifecycleDeadlineMs}-millisecond lifecycle deadline; reconcile the exact instance before retrying.`, {
        budgetMs: this.lifecycleDeadlineMs, effectState: "unknown", retryable: false,
      });
      throw error;
    } finally { clearTimeout(timer); }
  }

  private async request(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const timeoutController = new AbortController();
    const timeout = timeoutMs > 0 ? setTimeout(() => timeoutController.abort(), timeoutMs) : undefined;
    const requestSignal = init.signal
      ? AbortSignal.any([init.signal, timeoutController.signal])
      : timeoutController.signal;
    const token = resolveToken(this.environment);
    const headers = new Headers(init.headers);
    headers.set("accept", path === "/v1/chat/completions" ? "text/event-stream" : "application/json");
    if (init.method === "POST") headers.set("content-type", "application/json");
    if (token) headers.set("authorization", `Bearer ${token}`);
    try {
      const response = await this.fetchImpl(`${LM_STUDIO_BASE_URL}${path}`, {
        ...init,
        headers,
        redirect: "error",
        signal: requestSignal,
      });
      if (!response.ok) {
        const detail = await readBoundedText(response, MAX_ERROR_BYTES, REQUEST_TIMEOUT_MS, requestSignal).catch(() => "");
        throw new Error(formatHttpError(response.status, detail, token));
      }
      return response;
    } catch (error) {
      if (init.signal?.aborted) throw abortError();
      if (timeoutController.signal.aborted) throw new Error(`LM Studio request timed out at ${LM_STUDIO_BASE_URL}.`);
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

function requireProviderModelId(model: ModelDescriptor): string {
  if (model.provider !== "lmstudio" || !model.providerModelId) {
    throw new Error("Only LM Studio catalog models can be loaded by the LM Studio provider.");
  }
  return boundedIdentifier(model.providerModelId, "LM Studio model key", 1, 1_024);
}

function toModelInstance(binding: InstanceBinding, state: ModelInstance["state"]): ModelInstance {
  return {
    modelId: binding.modelId,
    instanceId: binding.instanceId,
    provider: "lmstudio",
    ownedByWorkbench: binding.ownedByWorkbench,
    state,
    contextLength: binding.config.context_length,
    gpuLayers: 0,
    evalBatchSize: binding.config.eval_batch_size,
    flashAttention: binding.config.flash_attention,
    numExperts: binding.config.num_experts,
    kvCachePlacement: binding.config.offload_kv_cache_to_gpu === false ? "cpu" : "gpu",
    startedAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  };
}

function parseNativeModel(value: unknown, index: number): NativeModel {
  const record = requireRecord(value, `LM Studio model ${index}`);
  if (record.type !== "llm" && record.type !== "embedding") {
    throw new Error(`LM Studio model ${index} has an unsupported type.`);
  }
  const maxContextLength = boundedInteger(record.max_context_length, "max_context_length", 1, 16_777_216);
  const capabilitiesRecord = record.capabilities === undefined
    ? undefined
    : requireRecord(record.capabilities, "model capabilities");
  let capabilities: NativeModel["capabilities"];
  if (capabilitiesRecord) {
    const reasoningRecord = capabilitiesRecord.reasoning === undefined
      ? undefined
      : requireRecord(capabilitiesRecord.reasoning, "reasoning capabilities");
    const allowed = reasoningRecord?.allowed_options;
    const allowedOptions = Array.isArray(allowed)
      ? allowed.map((option) => parseReasoningOption(option))
      : undefined;
    const defaultReasoning = reasoningRecord ? parseReasoningOption(reasoningRecord.default) : undefined;
    if (allowedOptions && defaultReasoning && !allowedOptions.includes(defaultReasoning)) {
      throw new Error("LM Studio reasoning default is not included in allowed_options.");
    }
    capabilities = {
      vision: requireBoolean(capabilitiesRecord.vision, "capabilities.vision"),
      trained_for_tool_use: requireBoolean(
        capabilitiesRecord.trained_for_tool_use,
        "capabilities.trained_for_tool_use",
      ),
      reasoning: allowedOptions && defaultReasoning
        ? { allowed_options: allowedOptions, default: defaultReasoning }
        : undefined,
    };
  }
  if (record.loaded_instances !== undefined && !Array.isArray(record.loaded_instances)) {
    throw new Error("LM Studio loaded_instances must be an array.");
  }
  const loaded = (record.loaded_instances ?? []) as unknown[];
  if (loaded.length > 1_024) throw new Error("LM Studio reported too many loaded instances for one model.");
  const loadedInstances = loaded.map((instance, loadedIndex) =>
    parseLoadedInstance(instance, maxContextLength, loadedIndex));
  const seenInstances = new Set<string>();
  for (const instance of loadedInstances) {
    if (seenInstances.has(instance.id)) throw new Error(`LM Studio reported duplicate instance ${instance.id}.`);
    seenInstances.add(instance.id);
  }

  const quantizationRecord = record.quantization === null || record.quantization === undefined
    ? null
    : requireRecord(record.quantization, "model quantization");
  return {
    type: record.type,
    publisher: boundedIdentifier(record.publisher, "publisher", 0, 512),
    key: boundedIdentifier(record.key, "model key", 1, 1_024),
    display_name: boundedIdentifier(record.display_name, "display_name", 1, 1_024),
    architecture: optionalIdentifier(record.architecture, "architecture", 256),
    quantization: quantizationRecord ? {
      name: optionalIdentifier(quantizationRecord.name, "quantization.name", 128),
      bits_per_weight: optionalFiniteNumber(quantizationRecord.bits_per_weight, "quantization.bits_per_weight", 1, 64),
    } : null,
    size_bytes: boundedInteger(record.size_bytes, "size_bytes", 0, Number.MAX_SAFE_INTEGER),
    params_string: optionalIdentifier(record.params_string, "params_string", 128),
    loaded_instances: loadedInstances,
    max_context_length: maxContextLength,
    format: record.format === null || record.format === undefined
      ? null
      : boundedIdentifier(record.format, "format", 1, 64),
    capabilities,
    description: optionalString(record.description, "description", 16_384),
    variants: parseOptionalStringArray(record.variants, "variants", 1_024, 1_024),
    selected_variant: optionalIdentifier(record.selected_variant, "selected_variant", 1_024),
  };
}

function parseLoadedInstance(value: unknown, maxContext: number, index: number): NativeLoadedInstance {
  const record = requireRecord(value, `loaded instance ${index}`);
  return {
    id: boundedIdentifier(record.id, "loaded instance id", 1, 1_024),
    config: parseLoadConfig(record.config, maxContext),
  };
}

function parseLoadConfig(value: unknown, maxContext: number): NativeLoadedInstance["config"] {
  const record = requireRecord(value, "load config");
  return {
    context_length: boundedInteger(record.context_length, "context_length", 1, maxContext),
    eval_batch_size: optionalInteger(record.eval_batch_size, "eval_batch_size", 1, 65_536),
    parallel: optionalInteger(record.parallel, "parallel", 1, 1_024),
    flash_attention: optionalBoolean(record.flash_attention, "flash_attention"),
    num_experts: optionalInteger(record.num_experts, "num_experts", 1, 1_024),
    offload_kv_cache_to_gpu: optionalBoolean(record.offload_kv_cache_to_gpu, "offload_kv_cache_to_gpu"),
  };
}

async function parseSse(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: ChatCompletionChunk) => void,
  signal?: AbortSignal,
  maxStreamBytes = MAX_SSE_STREAM_BYTES,
  maxChunks = MAX_SSE_CHUNKS,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let pendingFrameBytes = 0;
  let totalBytes = 0;
  let readChunks = 0;
  let emittedChunks = 0;
  let sawDone = false;
  const emit = (frame: string): boolean => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data) return false;
    if (data === "[DONE]") return true;
    emittedChunks += 1;
    if (emittedChunks > maxChunks) {
      throw new Error(`LM Studio SSE stream exceeded the ${maxChunks}-chunk safety limit.`);
    }
    let chunk: unknown;
    try {
      chunk = JSON.parse(data) as unknown;
    } catch {
      throw new Error("LM Studio emitted malformed SSE JSON.");
    }
    validateChatChunk(chunk);
    onChunk(chunk);
    return false;
  };
  const abortReader = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abortReader, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      readChunks += 1;
      totalBytes += value.byteLength;
      pendingFrameBytes += value.byteLength;
      if (readChunks > maxChunks) {
        throw new Error(`LM Studio SSE stream exceeded the ${maxChunks}-chunk safety limit.`);
      }
      if (totalBytes > maxStreamBytes) {
        throw new Error(`LM Studio SSE stream exceeded the ${maxStreamBytes}-byte safety limit.`);
      }
      buffer += decoder.decode(value, { stream: true });
      if (pendingFrameBytes > MAX_SSE_FRAME_BYTES && !/\r?\n\r?\n/.test(buffer)) {
        throw new Error("LM Studio SSE frame exceeded the Workbench safety limit.");
      }
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      pendingFrameBytes = encoder.encode(buffer).byteLength;
      for (const frame of frames) {
        if (encoder.encode(frame).byteLength > MAX_SSE_FRAME_BYTES) {
          throw new Error("LM Studio SSE frame exceeded the Workbench safety limit.");
        }
        if (!emit(frame)) continue;
        sawDone = true;
        await reader.cancel().catch(() => undefined);
        return;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() && emit(buffer)) sawDone = true;
    if (!sawDone) {
      throw new RuntimeFailure("STREAM_TRUNCATED", "stream", "LM Studio SSE stream ended before the required [DONE] terminator.", { retryable: true });
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (signal?.aborted) throw abortError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abortReader);
    reader.releaseLock();
  }
}

function validateChatChunk(value: unknown): asserts value is ChatCompletionChunk {
  const record = requireRecord(value, "LM Studio chat chunk");
  if (record.usage !== undefined && record.usage !== null) {
    const usage = requireRecord(record.usage, "LM Studio token usage");
    for (const field of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) {
      if (usage[field] !== undefined) boundedInteger(usage[field], `usage ${field}`, 0, 2 ** 31 - 1);
    }
    if (usage.completion_tokens_details !== undefined) {
      const details = requireRecord(usage.completion_tokens_details, "LM Studio completion token details");
      if (details.reasoning_tokens !== undefined) boundedInteger(details.reasoning_tokens, "reasoning_tokens", 0, 2 ** 31 - 1);
    }
  }
  if (record.choices === undefined) return;
  if (!Array.isArray(record.choices) || record.choices.length > 256) {
    throw new Error("LM Studio chat chunk has invalid choices.");
  }
  for (const choiceValue of record.choices) {
    const choice = requireRecord(choiceValue, "LM Studio chat choice");
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) boundedString(choice.finish_reason, "finish_reason", 1, 128);
    if (choice.delta === undefined) continue;
    const delta = requireRecord(choice.delta, "LM Studio chat delta");
    for (const key of ["content", "reasoning", "reasoning_content"] as const) {
      if (delta[key] !== undefined) boundedString(delta[key], `chat delta ${key}`, 0, MAX_SSE_FRAME_BYTES);
    }
    if (delta.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > 256) {
        throw new Error("LM Studio chat delta has invalid tool_calls.");
      }
      for (const toolValue of delta.tool_calls) {
        const tool = requireRecord(toolValue, "LM Studio tool call delta");
        boundedInteger(tool.index, "tool call index", 0, 65_535);
        optionalString(tool.id, "tool call id", 1_024);
        if (tool.type !== undefined && tool.type !== "function") throw new Error("Unsupported tool call type.");
        if (tool.function !== undefined) {
          const fn = requireRecord(tool.function, "tool call function");
          optionalString(fn.name, "tool function name", 1_024);
          optionalString(fn.arguments, "tool function arguments", MAX_SSE_FRAME_BYTES);
        }
      }
    }
  }
}

async function readBoundedText(response: Response, limit: number, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let bytes = 0;
  let timedOut = false;
  const cancelReader = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancelReader, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, timeoutMs);
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`LM Studio response exceeded the ${limit}-byte safety limit.`);
      }
      result += decoder.decode(value, { stream: true });
    }
    signal?.throwIfAborted();
    if (timedOut) throw new Error("LM Studio response body timed out.");
    return result + decoder.decode();
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
}

function resolveToken(environment: Environment): string | undefined {
  for (const name of LM_STUDIO_TOKEN_ENV_NAMES) {
    const value = environment[name]?.trim();
    if (!value) continue;
    if (new TextEncoder().encode(value).byteLength > TOKEN_MAX_BYTES || /[\0\r\n]/.test(value)) {
      throw new Error(`${name} is invalid; LM Studio tokens must be single-line values up to ${TOKEN_MAX_BYTES} bytes.`);
    }
    return value;
  }
  return undefined;
}

function formatHttpError(status: number, detail: string, token?: string): string {
  const redacted = token ? detail.split(token).join("[REDACTED]") : detail;
  const compact = redacted.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 1_024);
  return `LM Studio request failed with HTTP ${status}${compact ? `: ${compact}` : "."}`;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 1_024);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || /\0/.test(value)) {
    throw new Error(`${label} must be a string from ${minimum} to ${maximum} characters.`);
  }
  return value;
}

function optionalString(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return boundedString(value, label, 0, maximum);
}

function boundedIdentifier(value: unknown, label: string, minimum: number, maximum: number): string {
  const result = boundedString(value, label, minimum, maximum);
  if (/[\u0000-\u001f\u007f]/.test(result)) throw new Error(`${label} must be a single-line identifier.`);
  return result;
}

function optionalIdentifier(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return boundedIdentifier(value, label, 0, maximum);
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value as number;
}

function optionalInteger(value: unknown, label: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  return boundedInteger(value, label, minimum, maximum);
}

function optionalFiniteNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a finite number from ${minimum} to ${maximum}.`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`);
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  return requireBoolean(value, label);
}

function parseOptionalStringArray(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumLength: number,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`${label} must be a bounded array.`);
  return value.map((item) => boundedIdentifier(item, label, 1, maximumLength));
}

function parseReasoningOption(value: unknown): "off" | "on" | "low" | "medium" | "high" {
  if (value === "off" || value === "on" || value === "low" || value === "medium" || value === "high") return value;
  throw new Error("LM Studio reported an unsupported reasoning option.");
}

function abortError(): DOMException {
  return new DOMException("Cancelled", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
