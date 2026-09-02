import type {
  ModelDescriptor,
  ModelInstance,
  ModelLoadOptions,
  RuntimeStatus,
} from "../../shared/contracts.ts";

export interface ChatCompletionChunk {
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

/** A provider-backed catalog. The root argument is retained for IPC compatibility. */
export interface ModelCatalogSource {
  scan(root: string, signal?: AbortSignal): Promise<ModelDescriptor[]>;
  cancel?(): void;
}

/** Runtime operations consumed by the model and agent services. */
export interface InferenceRuntime {
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
