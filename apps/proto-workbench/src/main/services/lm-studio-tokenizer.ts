import { createHash } from "node:crypto";
import { LMStudioClient, type ChatHistoryData, type ChatMessageData, type LLMTool } from "@lmstudio/sdk";
import type { InstanceTokenizer } from "./inference-provider.ts";

interface LoadedTokenizerModel {
  identifier: string;
  getModelInfo(): Promise<{ instanceReference: string; identifier: string }>;
  applyPromptTemplate(history: ChatHistoryData, options: { toolDefinitions?: LLMTool[] }): Promise<string>;
  countTokens(text: string): Promise<number>;
}

interface TokenizerClient { llm: { listLoaded(): Promise<LoadedTokenizerModel[]> } }

/** Uses only specific already-loaded handles. SDK model(key) would implicitly load. */
export class LmStudioTokenizer implements InstanceTokenizer {
  private client?: TokenizerClient;
  private inFlight?: Promise<number>;
  private readonly cache = new Map<string, number>();
  private readonly factory: () => TokenizerClient;
  private readonly timeoutMs: number;

  constructor(options: { clientFactory?: () => TokenizerClient; timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) throw new Error("Invalid tokenizer timeout.");
    this.factory = options.clientFactory ?? (() => new LMStudioClient({
      baseUrl: "ws://127.0.0.1:1234", verboseErrorMessages: false,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    }));
  }

  async countPrompt(instanceId: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    if (this.inFlight) throw new Error("The tokenizer is still resolving an earlier request.");
    const history = promptHistory(payload.messages);
    const tools = promptTools(payload.tools);
    this.client ??= this.factory();
    const execute = async () => {
      const model = (await this.client!.llm.listLoaded()).find((entry) => entry.identifier === instanceId);
      if (!model) throw new Error("The exact model instance is not loaded for tokenization.");
      const before = await model.getModelInfo();
      if (before.identifier !== instanceId || !before.instanceReference) throw new Error("Tokenizer instance binding is invalid.");
      const formatted = await model.applyPromptTemplate(history, tools.length ? { toolDefinitions: tools } : {});
      const key = createHash("sha256").update(JSON.stringify({ instanceReference: before.instanceReference, formatted })).digest("hex");
      const cached = this.cache.get(key);
      if (cached !== undefined) return cached;
      const count = await model.countTokens(formatted);
      const after = await model.getModelInfo();
      if (after.instanceReference !== before.instanceReference || after.identifier !== instanceId) throw new Error("The model instance changed while tokenizing.");
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("The tokenizer returned an invalid count.");
      if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, count);
      return count;
    };
    const pending = execute();
    this.inFlight = pending;
    // Retain the in-flight guard after a timeout: SDK calls have no cancellation API.
    void pending.finally(() => { if (this.inFlight === pending) this.inFlight = undefined; }).catch(() => undefined);
    return new Promise<number>((resolve, reject) => {
      const abort = () => finish(() => reject(signal?.reason ?? new DOMException("Cancelled", "AbortError")));
      const timer = setTimeout(() => finish(() => reject(new Error("The exact-instance tokenizer timed out."))), this.timeoutMs);
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        action();
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      pending.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
    });
  }
}

function promptHistory(value: unknown): ChatHistoryData {
  if (!Array.isArray(value) || value.length > 1024) throw new Error("Unsupported tokenizer messages.");
  return { messages: value.map((message): ChatMessageData => {
    if (!message || typeof message !== "object") throw new Error("Invalid tokenizer message.");
    const record = message as Record<string, unknown>;
    if (typeof record.content !== "string" && record.content !== null && record.content !== undefined) throw new Error("Multimodal token counting requires a conservative estimate.");
    const content = typeof record.content === "string" ? record.content : "";
    if (record.role === "tool") return { role: "tool", content: [{ type: "toolCallResult", content,
      ...(typeof record.tool_call_id === "string" ? { toolCallId: record.tool_call_id } : {}) }] };
    if (record.role === "assistant") {
      const parts: Extract<ChatMessageData, { role: "assistant" }>["content"] = content ? [{ type: "text", text: content }] : [];
      if (record.tool_calls !== undefined) {
        if (!Array.isArray(record.tool_calls)) throw new Error("Invalid tokenizer tool calls.");
        for (const raw of record.tool_calls) {
          if (!raw || raw.type !== "function" || typeof raw.function?.name !== "string") throw new Error("Invalid tokenizer tool call.");
          const args = typeof raw.function.arguments === "string" ? JSON.parse(raw.function.arguments) : raw.function.arguments ?? {};
          if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid tokenizer tool arguments.");
          parts.push({ type: "toolCallRequest", toolCallRequest: { type: "function", name: raw.function.name,
            arguments: args, ...(typeof raw.id === "string" ? { id: raw.id } : {}) } });
        }
      }
      return { role: "assistant", content: parts };
    }
    if (record.role !== "system" && record.role !== "user") throw new Error("Unsupported tokenizer role.");
    return { role: record.role, content: [{ type: "text", text: content }] };
  }) };
}

function promptTools(value: unknown): LLMTool[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) throw new Error("Invalid tokenizer tools.");
  return value.map((raw) => {
    if (!raw || raw.type !== "function" || typeof raw.function?.name !== "string") throw new Error("Invalid tokenizer tool.");
    if (raw.function.parameters && (raw.function.parameters.type !== "object" || !raw.function.parameters.properties)) throw new Error("Unsupported tokenizer tool schema.");
    return structuredClone(raw) as LLMTool;
  });
}
