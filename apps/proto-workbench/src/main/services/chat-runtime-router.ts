import { isCloudModelId } from "../../shared/cloud-chat.ts";
import type { ModelDescriptor } from "../../shared/contracts.ts";
import type { ChatCompletionChunk, ExecutionBinding } from "./inference-provider.ts";
import type { ModelService } from "./model-service.ts";

/** What the chat loop needs from a model runtime. LM Studio's ModelService is one; the router is another. */
export type ChatRuntime = Pick<ModelService, "scan" | "load" | "getExecutionBinding" | "countExecutionTokens" | "chat">;

export interface CloudRuntimePort {
  listModels(): Promise<ModelDescriptor[]>;
  getExecutionBinding(modelId: string, signal?: AbortSignal): Promise<ExecutionBinding>;
  countExecutionTokens(modelId: string, messages: unknown[], tools?: unknown[], signal?: AbortSignal): Promise<{ tokens: number; method: "exact" | "conservative-estimate" }>;
  chat(modelId: string, payload: Record<string, unknown>, onChunk: (chunk: ChatCompletionChunk) => void, signal?: AbortSignal): Promise<void>;
}

/**
 * Sends `cloud:` model ids to the cloud runtime and everything else to LM Studio, so the chat loop
 * stays unaware of where a model runs. Choosing the route is the only thing this class decides; it
 * never converts one kind of model into the other.
 */
export class RoutingChatRuntime implements ChatRuntime {
  private readonly local: ChatRuntime;
  private readonly cloud: CloudRuntimePort;

  constructor(local: ChatRuntime, cloud: CloudRuntimePort) {
    this.local = local;
    this.cloud = cloud;
  }

  /**
   * Both lists, local first. LM Studio being down must not hide a configured cloud model, but if
   * neither is available the original LM Studio error is the one to show.
   */
  async scan(root: string): Promise<ModelDescriptor[]> {
    let local: ModelDescriptor[] = [];
    let failure: unknown;
    try {
      local = await this.local.scan(root);
    } catch (error) {
      failure = error;
    }
    const cloud = await this.cloud.listModels().catch(() => [] as ModelDescriptor[]);
    if (failure !== undefined && cloud.length === 0) throw failure;
    return [...local, ...cloud];
  }

  load: ChatRuntime["load"] = (modelId, options) => {
    if (isCloudModelId(modelId)) return Promise.reject(new Error("Cloud models are not loaded; there is nothing to connect."));
    return this.local.load(modelId, options);
  };

  getExecutionBinding: ChatRuntime["getExecutionBinding"] = (modelId, signal) =>
    isCloudModelId(modelId) ? this.cloud.getExecutionBinding(modelId, signal) : this.local.getExecutionBinding(modelId, signal);

  countExecutionTokens: ChatRuntime["countExecutionTokens"] = (modelId, messages, tools, signal) =>
    isCloudModelId(modelId) ? this.cloud.countExecutionTokens(modelId, messages, tools, signal) : this.local.countExecutionTokens(modelId, messages, tools, signal);

  chat: ChatRuntime["chat"] = (modelId, payload, onChunk, signal) =>
    isCloudModelId(modelId) ? this.cloud.chat(modelId, payload, onChunk, signal) : this.local.chat(modelId, payload, onChunk, signal);
}
