import { createHash } from "node:crypto";
import {
  CLOUD_CONTEXT_TOKENS,
  cloudModelId,
  parseCloudModelId,
  type CloudChatProtocol,
  type CloudModelInfo,
  type CloudProviderId,
} from "../../shared/cloud-chat.ts";
import type { ModelDescriptor } from "../../shared/contracts.ts";
import {
  API_KEY_SHAPE,
  PROVIDER_CREDENTIAL_ENVIRONMENT,
  PROVIDER_PINNED_HOST,
  parseGatewayEndpoint,
  type StoredKeySummary,
} from "../../shared/provider-setup.ts";
import type { ReadResult, VaultProvider } from "./credential-vault.ts";
import {
  AnthropicStreamTranslator,
  CloudProtocolError,
  SseParser,
  toAnthropicRequest,
  toOpenAIRequest,
  type LoopPayload,
} from "./cloud-protocols.ts";
import type { ChatCompletionChunk, ExecutionBinding } from "./inference-provider.ts";

/**
 * Chat against a cloud provider, behind the same runtime surface the chat loop already uses for LM
 * Studio. Trust rules:
 *
 *  - A key is read here, in the main process, only at the moment of a request, and goes only to the
 *    endpoint resolved from the credential vault's binding (or a host pinned in code). The saved
 *    workspace configuration contributes a model *name* and nothing that decides where a key goes.
 *  - A gateway key is never taken from the environment: there would be no trusted host to bind it to.
 *  - Requests refuse redirects, and every stage is bounded: body size, line size, total stream size,
 *    idle time and overall time.
 *  - Errors never include a key, and provider text is cleaned and shortened before it is shown.
 */

export interface CloudSetupView {
  readonly provider: CloudProviderId;
  readonly model: string;
}

export interface CloudVaultPort {
  list(): Promise<StoredKeySummary[]>;
  read(provider: VaultProvider): Promise<ReadResult | undefined>;
}

export interface CloudChatRuntimeOptions {
  /** The saved provider choice. Only its model name is trusted for anything. */
  readonly setup: () => Promise<CloudSetupView | undefined>;
  readonly vault: CloudVaultPort;
  readonly environment: () => NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Tighter bounds than the defaults; used by tests and never to widen them. */
  readonly limits?: Partial<CloudLimits>;
}

export class CloudChatError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CloudChatError";
    this.code = code;
  }
}

export interface CloudLimits {
  requestBytes: number;
  streamBytes: number;
  errorBytes: number;
  idleMs: number;
  maxTurnMs: number;
}
export const CLOUD_LIMITS: Readonly<CloudLimits> = Object.freeze({
  requestBytes: 8 * 1024 * 1024,
  streamBytes: 16 * 1024 * 1024,
  errorBytes: 8 * 1024,
  idleMs: 90_000,
  maxTurnMs: 15 * 60_000,
});

const PROVIDER_LABEL: Record<CloudProviderId, string> = {
  "anthropic-api": "Anthropic",
  "openai-api": "OpenAI",
  "custom-gateway": "Gateway",
};

interface Endpoint {
  readonly provider: CloudProviderId;
  readonly host: string;
  readonly url: string;
  readonly protocol: CloudChatProtocol;
  readonly flavor: "official" | "gateway";
  readonly keySource: "vault" | "environment";
  readonly key: string;
}

function isKeyProvider(provider: CloudProviderId): provider is VaultProvider {
  return provider === "anthropic-api" || provider === "openai-api" || provider === "custom-gateway";
}

function chatProtocol(value: string | undefined): CloudChatProtocol | undefined {
  return value === "messages" || value === "chat-completions" ? value : undefined;
}

/** Strip anything that could carry a key or terminal control sequences, and keep it short. */
export function cleanProviderText(value: string, key: string): string {
  const withoutKey = key ? value.split(key).join("[redacted]") : value;
  return withoutKey.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

export class CloudChatRuntime {
  private readonly options: CloudChatRuntimeOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly limits: Readonly<CloudLimits>;

  constructor(options: CloudChatRuntimeOptions) {
    this.options = options;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    const requested = options.limits ?? {};
    const merged: CloudLimits = { ...CLOUD_LIMITS };
    for (const key of Object.keys(merged) as Array<keyof CloudLimits>) {
      const value = requested[key];
      // A limit can only be tightened.
      if (typeof value === "number" && value > 0 && value < merged[key]) merged[key] = value;
    }
    this.limits = Object.freeze(merged);
  }

  // -------------------------------------------------------------------------
  // Catalog: no network, no decryption
  // -------------------------------------------------------------------------

  /** The configured cloud model, when a key is available for it. Listing never contacts the provider. */
  async listModels(): Promise<ModelDescriptor[]> {
    const setup = await this.options.setup();
    if (!setup) return [];
    const availability = await this.availability(setup.provider);
    if (!availability) return [];
    const info: CloudModelInfo = { provider: setup.provider, host: availability.host, protocol: availability.protocol, keySource: availability.keySource };
    return [cloudDescriptor(setup.model, info)];
  }

  private async availability(provider: CloudProviderId): Promise<{ host: string; protocol: CloudChatProtocol; keySource: "vault" | "environment" } | undefined> {
    let stored: StoredKeySummary | undefined;
    try {
      stored = (await this.options.vault.list()).find((entry) => entry.provider === provider);
    } catch {
      stored = undefined;
    }
    if (provider === "custom-gateway") {
      const protocol = chatProtocol(stored?.protocol);
      return stored && protocol ? { host: stored.host, protocol, keySource: "vault" } : undefined;
    }
    const host = PROVIDER_PINNED_HOST[provider];
    const protocol: CloudChatProtocol = provider === "anthropic-api" ? "messages" : "chat-completions";
    if (stored) return { host, protocol, keySource: "vault" };
    const variable = PROVIDER_CREDENTIAL_ENVIRONMENT[provider];
    return (this.options.environment()[variable] ?? "").trim() ? { host, protocol, keySource: "environment" } : undefined;
  }

  // -------------------------------------------------------------------------
  // The runtime surface the chat loop consumes
  // -------------------------------------------------------------------------

  async getExecutionBinding(modelId: string): Promise<ExecutionBinding> {
    const model = await this.requireModel(modelId);
    const info = model.cloud!;
    return {
      modelId,
      instanceId: `cloud:${info.provider}:${info.host}`,
      contextLength: CLOUD_CONTEXT_TOKENS,
      ownedByWorkbench: false,
      observedAt: new Date(this.now()).toISOString(),
    };
  }

  /** An estimate, labelled as one. Providers tokenize differently and counting would mean sending the text. */
  async countExecutionTokens(modelId: string, messages: unknown[], tools: unknown[] = []): Promise<{ tokens: number; method: "exact" | "conservative-estimate" }> {
    await this.requireModel(modelId);
    const bytes = Buffer.byteLength(JSON.stringify({ messages, tools }), "utf8");
    return { tokens: Math.ceil(bytes / 3) + 64, method: "conservative-estimate" };
  }

  async chat(modelId: string, payload: Record<string, unknown>, onChunk: (chunk: ChatCompletionChunk) => void, signal?: AbortSignal): Promise<void> {
    const parsed = parseCloudModelId(modelId);
    if (!parsed) throw new CloudChatError("INVALID_MODEL", "This is not a cloud model.");
    await this.requireModel(modelId);
    const endpoint = await this.resolveEndpoint(parsed.provider);
    const loop = payload as unknown as LoopPayload;
    const maxTokens = Math.max(1, Math.min(Math.trunc(loop.max_tokens ?? 4096), 32_768));
    let body: string;
    try {
      body = JSON.stringify(
        endpoint.protocol === "messages"
          ? toAnthropicRequest(loop, parsed.model, maxTokens)
          : toOpenAIRequest(loop, parsed.model, maxTokens, endpoint.flavor),
      );
    } catch (error) {
      if (error instanceof CloudProtocolError) throw new CloudChatError(error.code, error.message);
      throw error;
    }
    if (Buffer.byteLength(body, "utf8") > this.limits.requestBytes) {
      throw new CloudChatError("REQUEST_TOO_LARGE", "The request is larger than this app will send to a provider. Use fewer or smaller attachments.");
    }

    const budgetMs = typeof loop.deadline === "number" ? loop.deadline - this.now() : this.limits.maxTurnMs;
    const turn = AbortSignal.timeout(Math.max(1000, Math.min(budgetMs, this.limits.maxTurnMs)));
    const controller = new AbortController();
    const abort = () => controller.abort();
    for (const source of [signal, turn]) {
      if (!source) continue;
      if (source.aborted) controller.abort();
      else source.addEventListener("abort", abort, { once: true });
    }
    try {
      await this.stream(endpoint, body, onChunk, controller);
    } finally {
      signal?.removeEventListener("abort", abort);
      turn.removeEventListener("abort", abort);
      controller.abort();
    }
  }

  async load(): Promise<never> {
    throw new CloudChatError("NOT_APPLICABLE", "Cloud models need no loading.");
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async requireModel(modelId: string): Promise<ModelDescriptor> {
    const model = (await this.listModels()).find((candidate) => candidate.id === modelId);
    if (!model?.cloud) {
      throw new CloudChatError("MODEL_NOT_CONFIGURED", "This cloud model is not configured, or no key is available for it. Open Settings to set up a provider.");
    }
    return model;
  }

  private async resolveEndpoint(provider: CloudProviderId): Promise<Endpoint> {
    let stored: ReadResult | undefined;
    if (isKeyProvider(provider)) {
      try {
        stored = await this.options.vault.read(provider);
      } catch (error) {
        throw new CloudChatError("KEY_UNREADABLE", error instanceof Error ? error.message : "The stored key could not be read.");
      }
    }
    if (provider === "custom-gateway") {
      if (!stored?.summary.baseUrl) throw new CloudChatError("KEY_REQUIRED", "A gateway needs a key stored for its address. Open Settings and store one.");
      const protocol = chatProtocol(stored.summary.protocol);
      if (!protocol) throw new CloudChatError("PROTOCOL_UNSUPPORTED", "Chat supports gateways that speak the Messages or Chat Completions protocol.");
      // The binding is re-validated here, so a damaged vault record cannot widen where a key may go.
      const endpoint = parseGatewayEndpoint(stored.summary.baseUrl);
      const suffix = protocol === "messages" ? "/messages" : "/chat/completions";
      return { provider, host: endpoint.host, url: `${endpoint.baseUrl}${suffix}`, protocol, flavor: "gateway", keySource: "vault", key: requireKey(stored.key) };
    }
    const host = PROVIDER_PINNED_HOST[provider];
    const protocol: CloudChatProtocol = provider === "anthropic-api" ? "messages" : "chat-completions";
    const url = provider === "anthropic-api" ? `https://${host}/v1/messages` : `https://${host}/v1/chat/completions`;
    if (stored) return { provider, host, url, protocol, flavor: "official", keySource: "vault", key: requireKey(stored.key) };
    const fromEnvironment = (this.options.environment()[PROVIDER_CREDENTIAL_ENVIRONMENT[provider]] ?? "").trim();
    if (!fromEnvironment) throw new CloudChatError("KEY_REQUIRED", "No key is available for this provider. Open Settings and store one.");
    return { provider, host, url, protocol, flavor: "official", keySource: "environment", key: requireKey(fromEnvironment) };
  }

  private headers(endpoint: Endpoint): Record<string, string> {
    return endpoint.protocol === "messages"
      ? { "x-api-key": endpoint.key, "anthropic-version": "2023-06-01", "content-type": "application/json", accept: "text/event-stream" }
      : { authorization: `Bearer ${endpoint.key}`, "content-type": "application/json", accept: "text/event-stream" };
  }

  private async stream(endpoint: Endpoint, body: string, onChunk: (chunk: ChatCompletionChunk) => void, controller: AbortController): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint.url, { method: "POST", headers: this.headers(endpoint), body, redirect: "error", signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw error instanceof Error ? error : new Error("The request was cancelled.");
      throw new CloudChatError("NETWORK", `Could not reach ${endpoint.host}: ${cleanProviderText(error instanceof Error ? error.message : "network error", endpoint.key)}`);
    }
    if (!response.ok) throw await this.httpFailure(response, endpoint);
    if (!response.body) throw new CloudChatError("EMPTY_RESPONSE", `${endpoint.host} returned no stream.`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    const parser = new SseParser();
    const translator = endpoint.protocol === "messages" ? new AnthropicStreamTranslator() : undefined;
    let total = 0;
    let finished = false;
    try {
      while (!finished) {
        const next = await readWithIdleTimeout(reader, this.limits.idleMs, controller.signal);
        if (next.done) break;
        total += next.value.byteLength;
        if (total > this.limits.streamBytes) throw new CloudChatError("RESPONSE_TOO_LARGE", "The provider's response exceeded the size this app accepts.");
        for (const event of parser.push(decoder.decode(next.value, { stream: true }))) {
          if (event.data === "[DONE]") {
            finished = true;
            break;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(event.data);
          } catch {
            throw new CloudChatError("MALFORMED_STREAM", "The provider sent a stream event this app could not read.");
          }
          const chunks = translator ? translator.translate(parsed) : [parsed as ChatCompletionChunk];
          for (const chunk of chunks) onChunk(chunk);
        }
      }
    } catch (error) {
      if (error instanceof CloudProtocolError) throw new CloudChatError(error.code, cleanProviderText(error.message, endpoint.key));
      throw error;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  private async httpFailure(response: Response, endpoint: Endpoint): Promise<CloudChatError> {
    let detail = "";
    try {
      detail = (await readBounded(response, this.limits.errorBytes)) ?? "";
    } catch {
      detail = "";
    }
    let message = "";
    try {
      const parsed = JSON.parse(detail) as { error?: { message?: unknown } | string; message?: unknown };
      const candidate = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message;
      if (typeof candidate === "string") message = candidate;
    } catch {
      message = "";
    }
    const status = response.status;
    const retry = response.headers.get("retry-after");
    const hint = status === 401 || status === 403 ? " Check the stored key." : status === 429 ? ` The provider is rate limiting this key${retry ? `; retry after ${cleanProviderText(retry, "")} seconds` : ""}.` : status >= 500 ? " The provider reported a problem; try again later." : "";
    const code = status === 401 || status === 403 ? "AUTH" : status === 404 ? "MODEL_OR_ROUTE_NOT_FOUND" : status === 429 ? "RATE_LIMITED" : status >= 500 ? "SERVER_ERROR" : "REQUEST_REJECTED";
    return new CloudChatError(code, `${endpoint.host} rejected the request (HTTP ${status}).${message ? ` ${cleanProviderText(message, endpoint.key)}` : ""}${hint}`);
  }
}

function requireKey(key: string): string {
  if (!API_KEY_SHAPE.test(key)) throw new CloudChatError("KEY_UNREADABLE", "The stored key is not usable. Store it again in Settings.");
  return key;
}

function cloudDescriptor(model: string, info: CloudModelInfo): ModelDescriptor {
  const id = cloudModelId(info.provider, model);
  return {
    id,
    name: `${model} · ${PROVIDER_LABEL[info.provider]}`,
    path: "",
    files: [],
    sizeBytes: 0,
    architecture: "cloud",
    quantization: "cloud",
    contextLength: CLOUD_CONTEXT_TOKENS,
    vision: false,
    // No probe has run, so this is deliberately not "agent-ready".
    toolCapability: "unknown",
    providerToolUseAdvertised: true,
    fingerprint: createHash("sha256").update(id).digest("hex"),
    estimatedVramBytes: 0,
    loadState: "unloaded",
    pinned: false,
    metadataSource: "cloud",
    provider: "cloud",
    providerModelId: model,
    modelKind: "llm",
    cloud: info,
  };
}

async function readWithIdleTimeout(reader: ReadableStreamDefaultReader<Uint8Array>, idleMs: number, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CloudChatError("IDLE_TIMEOUT", "The provider stopped sending data.")), idleMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([reader.read(), idle]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readBounded(response: Response, limit: number): Promise<string | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let received = 0;
  try {
    while (received < limit) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text.slice(0, limit);
}
