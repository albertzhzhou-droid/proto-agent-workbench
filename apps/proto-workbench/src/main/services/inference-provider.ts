import type {
  ModelDescriptor,
  ModelInstance,
  ModelLoadOptions,
  RuntimeStatus,
} from "../../shared/contracts.ts";

export interface ChatCompletionChunk {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string;
      reasoning?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
}

/** An observed instance, never the catalogue's advertised maximum context. */
export interface ExecutionBinding {
  modelId: string;
  instanceId: string;
  contextLength: number;
  ownedByWorkbench: boolean;
  observedAt: string;
}

export interface TokenCountResult {
  tokens: number;
  method: "tokenizer" | "utf8-upper-bound";
}

/** Optional exact-instance adapter; implementations must never implicitly load. */
export interface InstanceTokenizer {
  countPrompt(instanceId: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<number>;
}

/** A provider-backed catalog. The root argument is retained for IPC compatibility. */
export interface ModelCatalogSource {
  scan(root: string, signal?: AbortSignal): Promise<ModelDescriptor[]>;
  cancel?(): void;
}

/** Runtime operations consumed by the model and agent services. */
export interface InferenceRuntime {
  getExecutionBinding?(modelId: string, signal?: AbortSignal): Promise<ExecutionBinding>;
  peekExecutionBinding?(modelId: string): ExecutionBinding | undefined;
  countPromptTokens?(modelId: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<TokenCountResult>;
  runtimeStatus(signal?: AbortSignal): Promise<RuntimeStatus>;
  load(
    model: ModelDescriptor,
    options: Partial<ModelLoadOptions>,
    signal?: AbortSignal,
  ): Promise<ModelInstance>;
  unload(modelId: string): Promise<void>;
  unloadAll(): Promise<void>;
  has(modelId: string): boolean;
  processId(modelId: string): number | undefined;
  gpuAllocationBytes(modelId: string): number | undefined;
  chat(
    modelId: string,
    payload: Record<string, unknown>,
    onChunk: (chunk: ChatCompletionChunk) => void,
    signal?: AbortSignal,
  ): Promise<void>;
}
