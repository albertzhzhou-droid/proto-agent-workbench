import type { ChatCompletionChunk } from "./inference-provider.ts";

/**
 * Wire translation between the chat loop's OpenAI-style conversation and two provider protocols.
 * Everything here is pure: no network, no secrets, no I/O, so each rule is unit-testable.
 *
 * The loop speaks OpenAI chat: `messages` with roles system/user/assistant/tool, assistant
 * `tool_calls`, and `tool` results keyed by `tool_call_id`, streaming `choices[0].delta` chunks.
 */

type Message = Record<string, unknown>;

export interface LoopPayload {
  readonly messages: readonly Message[];
  readonly tools?: readonly Record<string, unknown>[];
  readonly tool_choice?: unknown;
  readonly max_tokens?: number;
  readonly temperature?: number;
  readonly deadline?: number;
}

export class CloudProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CloudProtocolError";
    this.code = code;
  }
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return value.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("");
  }
  return JSON.stringify(value);
}

interface ToolCall {
  readonly id: string;
  readonly function: { readonly name: string; readonly arguments: string };
}

function toolCallsOf(message: Message): ToolCall[] {
  const calls = message.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((call) => {
    if (!call || typeof call !== "object") return [];
    const record = call as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    if (typeof record.id !== "string" || typeof record.function?.name !== "string") return [];
    return [{ id: record.id, function: { name: record.function.name, arguments: typeof record.function.arguments === "string" ? record.function.arguments : "{}" } }];
  });
}

// ---------------------------------------------------------------------------
// Anthropic Messages
// ---------------------------------------------------------------------------

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };
interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

function parseToolInput(argumentsText: string): unknown {
  if (!argumentsText.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A truncated argument string cannot be replayed faithfully; an empty input is safer than a guess.
    return {};
  }
}

/**
 * OpenAI-style conversation to an Anthropic Messages body. System text is lifted out, assistant tool
 * calls become tool_use blocks, tool results become tool_result blocks in the following user turn,
 * and adjacent turns of one role merge, because the API requires strict alternation starting with a user.
 */
export function toAnthropicRequest(payload: LoopPayload, model: string, maxTokens: number): Record<string, unknown> {
  const system: string[] = [];
  const turns: AnthropicMessage[] = [];
  const push = (role: "user" | "assistant", blocks: AnthropicBlock[]) => {
    if (!blocks.length) return;
    const last = turns.at(-1);
    if (last && last.role === role) last.content.push(...blocks);
    else turns.push({ role, content: [...blocks] });
  };
  for (const message of payload.messages) {
    const role = message.role;
    if (role === "system") {
      const content = text(message.content);
      if (content) system.push(content);
    } else if (role === "user") {
      const content = text(message.content);
      if (content) push("user", [{ type: "text", text: content }]);
    } else if (role === "assistant") {
      const blocks: AnthropicBlock[] = [];
      const content = text(message.content);
      if (content) blocks.push({ type: "text", text: content });
      for (const call of toolCallsOf(message)) blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input: parseToolInput(call.function.arguments) });
      push("assistant", blocks);
    } else if (role === "tool") {
      const id = message.tool_call_id;
      if (typeof id !== "string") throw new CloudProtocolError("INVALID_TOOL_RESULT", "A tool result is missing the id of the call it answers.");
      push("user", [{ type: "tool_result", tool_use_id: id, content: text(message.content) || "(no output)" }]);
    } else {
      throw new CloudProtocolError("UNSUPPORTED_ROLE", `The conversation contains an unsupported message role.`);
    }
  }
  if (!turns.length || turns[0].role !== "user") {
    throw new CloudProtocolError("INVALID_CONVERSATION", "The provider requires the conversation to begin with a user message.");
  }
  const tools = (payload.tools ?? []).flatMap((tool) => {
    const fn = (tool as { function?: { name?: unknown; description?: unknown; parameters?: unknown } }).function;
    if (!fn || typeof fn.name !== "string") return [];
    return [{ name: fn.name, description: typeof fn.description === "string" ? fn.description : "", input_schema: fn.parameters ?? { type: "object", properties: {} } }];
  });
  return {
    model,
    max_tokens: maxTokens,
    stream: true,
    ...(system.length ? { system: system.join("\n\n") } : {}),
    messages: turns,
    ...(tools.length ? { tools, tool_choice: { type: "auto" } } : {}),
    ...(typeof payload.temperature === "number" ? { temperature: payload.temperature } : {}),
  };
}

const STOP_REASONS: Record<string, string> = { end_turn: "stop", stop_sequence: "stop", tool_use: "tool_calls", max_tokens: "length", pause_turn: "stop", refusal: "stop" };

/** Turns Anthropic stream events into the OpenAI-style chunks the chat loop consumes. */
export class AnthropicStreamTranslator {
  private readonly toolIndexByBlock = new Map<number, number>();
  private nextTool = 0;
  private inputTokens = 0;

  /** Returns the chunks for one event, or throws on a provider-reported error. */
  translate(event: unknown): ChatCompletionChunk[] {
    if (!event || typeof event !== "object") return [];
    const record = event as Record<string, unknown>;
    switch (record.type) {
      case "message_start": {
        const usage = (record.message as { usage?: { input_tokens?: number } } | undefined)?.usage;
        if (typeof usage?.input_tokens === "number") this.inputTokens = usage.input_tokens;
        return [];
      }
      case "content_block_start": {
        const block = record.content_block as { type?: string; id?: string; name?: string } | undefined;
        if (block?.type === "tool_use" && typeof record.index === "number" && typeof block.id === "string" && typeof block.name === "string") {
          const index = this.nextTool++;
          this.toolIndexByBlock.set(record.index, index);
          return [{ choices: [{ delta: { tool_calls: [{ index, id: block.id, type: "function", function: { name: block.name, arguments: "" } }] } }] }];
        }
        return [];
      }
      case "content_block_delta": {
        const delta = record.delta as { type?: string; text?: string; partial_json?: string } | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
          return [{ choices: [{ delta: { content: delta.text } }] }];
        }
        if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string" && typeof record.index === "number") {
          const index = this.toolIndexByBlock.get(record.index);
          if (index === undefined) return [];
          return [{ choices: [{ delta: { tool_calls: [{ index, function: { arguments: delta.partial_json } }] } }] }];
        }
        return [];
      }
      case "message_delta": {
        const delta = record.delta as { stop_reason?: string | null } | undefined;
        const usage = record.usage as { output_tokens?: number } | undefined;
        const chunks: ChatCompletionChunk[] = [];
        if (delta?.stop_reason) chunks.push({ choices: [{ finish_reason: STOP_REASONS[delta.stop_reason] ?? "stop" }] });
        if (typeof usage?.output_tokens === "number") {
          chunks.push({ usage: { prompt_tokens: this.inputTokens, completion_tokens: usage.output_tokens, total_tokens: this.inputTokens + usage.output_tokens } });
        }
        return chunks;
      }
      case "error": {
        const error = record.error as { type?: string; message?: string } | undefined;
        throw new CloudProtocolError(`PROVIDER_${(error?.type ?? "error").toUpperCase()}`, error?.message ?? "The provider reported an error mid-stream.");
      }
      default:
        return [];
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAI chat completions (and compatible gateways)
// ---------------------------------------------------------------------------

/**
 * The loop's payload is already OpenAI-shaped, so this selects the fields a provider accepts. The
 * official API takes `max_completion_tokens` and rejects a custom temperature on newer models, while
 * gateways broadly accept the classic `max_tokens` and `temperature`.
 */
export function toOpenAIRequest(payload: LoopPayload, model: string, maxTokens: number, flavor: "official" | "gateway"): Record<string, unknown> {
  const messages = payload.messages.map((message) => {
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && (message.content === null || message.content === undefined)) {
      return { ...message, content: "" };
    }
    return message;
  });
  return {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(flavor === "official" ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens, ...(typeof payload.temperature === "number" ? { temperature: payload.temperature } : {}) }),
    ...(payload.tools?.length ? { tools: payload.tools, tool_choice: "auto" } : {}),
  };
}

// ---------------------------------------------------------------------------
// Server-sent events
// ---------------------------------------------------------------------------

export const SSE_MAX_LINE_CHARS = 1024 * 1024;

/**
 * Incremental SSE parser. Feed decoded text; it yields the `data` payload of each complete event.
 * A line longer than the limit is a protocol violation, not something to buffer without bound.
 */
export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private eventName: string | undefined;

  push(chunk: string): Array<{ event?: string; data: string }> {
    this.buffer += chunk;
    const events: Array<{ event?: string; data: string }> = [];
    // A lone "\r" at the very end may be the first half of "\r\n", so it waits for the next chunk.
    const lineEnd = /\r\n|\n|\r(?!$)/;
    let match: RegExpExecArray | null;
    while ((match = lineEnd.exec(this.buffer)) !== null) {
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      if (line.length > SSE_MAX_LINE_CHARS) throw new CloudProtocolError("SSE_LINE_TOO_LONG", "The provider sent a stream line larger than allowed.");
      if (line === "") {
        if (this.data.length) events.push({ ...(this.eventName ? { event: this.eventName } : {}), data: this.data.join("\n") });
        this.data = [];
        this.eventName = undefined;
      } else if (line.startsWith("data:")) {
        this.data.push(line.slice(5).replace(/^ /, ""));
      } else if (line.startsWith("event:")) {
        this.eventName = line.slice(6).trim();
      }
    }
    if (this.buffer.length > SSE_MAX_LINE_CHARS) throw new CloudProtocolError("SSE_LINE_TOO_LONG", "The provider sent a stream line larger than allowed.");
    return events;
  }
}
