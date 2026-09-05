import { createHash, randomUUID } from "node:crypto";
import Ajv from "ajv";
import { HARNESS_DEFAULTS, type HarnessCheckpoint, type HarnessMessage, type HarnessState, type HarnessToolCall, type MissionContract, type ToolResultEnvelope } from "../../shared/harness.ts";
import type { ChatCompletionChunk, ExecutionBinding } from "./inference-provider.ts";
import { assembleHarnessContext, bindCurrentExecutionState, projectToolResult, providerMessages, type HarnessToolDefinition } from "./harness-context.ts";
import { HarnessStore } from "./harness-store.ts";
import type { WorkspaceQueueState } from "./workspace-execution-queue.ts";
import { observeHarnessResult, observationProgressAction } from "./harness-observation-progress.ts";

export interface HarnessHost {
  binding(signal: AbortSignal): Promise<ExecutionBinding>;
  count(messages: HarnessMessage[], tools: HarnessToolDefinition[], signal: AbortSignal): Promise<{tokens: number; method: "exact" | "conservative-estimate"}>;
  chat(payload: Record<string, unknown>, onChunk: (chunk: ChatCompletionChunk) => void, signal: AbortSignal): Promise<void>;
  tools: HarnessToolDefinition[];
  execute(name: string, args: Record<string, unknown>, callId: string, checkpoint: HarnessCheckpoint, signal: AbortSignal, queueState?: WorkspaceQueueState): Promise<Record<string, unknown>>;
  reconcile?(name: string, args: Record<string, unknown>, callId: string, checkpoint: HarnessCheckpoint, signal: AbortSignal, queueState?: WorkspaceQueueState): Promise<Record<string, unknown> | undefined>;
  effect(name: string): "read" | "write";
  verify(checkpoint: HarnessCheckpoint, summary?: string): Promise<{ok: boolean; diagnostics: string[]; artifacts: string[]}>;
  publish(checkpoint: HarnessCheckpoint, detail: string): void;
  delta(text: string): void;
}
const definition = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): HarnessToolDefinition => ({type: "function", function: {name, description, parameters: {type: "object", properties, required, additionalProperties: false}}});
export const HARNESS_TOOLS = [
  definition("harness_discover_tools", "Find tools by name or description. Matching exact schemas are returned and remain available in subsequent rounds. Use an empty query to list all tool names.", {query: {type: "string"}}, ["query"]),
  definition("harness_read_result", "Read durable raw JSON fields omitted from a tool summary when they are needed. Supply its handle and character offset; next_offset identifies the next unread character. You do not need to exhaust unrelated metadata or every result page.", {handle: {type: "string"}, offset: {type: "integer", minimum: 0}, limit: {type: "integer", minimum: 1, maximum: 24000}}, ["handle"]),
  definition("harness_plan", "Record concrete deliverables before writing. Original user targets remain mandatory. Record zero deliverables only for read-only tasks.", {deliverables: {type: "array", maxItems: 24, items: {type: "object", required: ["path", "kind"], properties: {path: {type: "string"}, kind: {enum: ["dna", "protein", "document"]}}, additionalProperties: false}}}, ["deliverables"]),
  definition("harness_finish", "Request completion after executing the task. The host independently checks artifacts and validation evidence; failed checks keep the task open.", {summary: {type: "string", minLength: 1}}, ["summary"]),
];
const INITIAL_TOOLS = new Set(["workspace_read", "workspace_search", "workspace_propose_patch", "proto_language_reference", "proto_materials_search", "proto_materials_get", "proto_materials_materialize", "proto_materials_materialize_proteins"]);
const ajv = new Ajv({allErrors: true, strict: false});
const failure = (code: string, message: string, effectState: "none" | "unknown" = "none") => Object.assign(new Error(message), {code, effectState});

export const initialHarnessToolNames = (tools: HarnessToolDefinition[]) => tools.filter(t => INITIAL_TOOLS.has(t.function.name)).map(t => t.function.name);
export function createHarnessCheckpoint(contract: MissionContract, instructions: string, history: HarnessMessage[] = [], tools: HarnessToolDefinition[] = []): HarnessCheckpoint {
  const now = new Date().toISOString();
  return {schema: "proto-workbench.execution.v1", revision: 0, contract, state: "queued", messages: [{role: "system", content: instructions}, ...history, {role: "user", content: contract.goal}], round: 0, generatedTokens: 0, activeTimeMs: 0, pendingCalls: [], completedCalls: [], resultHandles: [], deliveredPaths: [], fullContent: "", createdAt: now, updatedAt: now, hostRecovered: false, selectedTools: initialHarnessToolNames(tools)};
}

/** Durable, goal-independent orchestration. No task-specific host content generation. */
export class HarnessController {
  private readonly store: HarnessStore;
  private readonly host: HarnessHost;
  private readonly checkpointIntervalMs: number;
  constructor(store: HarnessStore, host: HarnessHost, options: {checkpointIntervalMs?: number} = {}) {
    this.store = store; this.host = host;
    this.checkpointIntervalMs = options.checkpointIntervalMs ?? 5000;
    if (!Number.isSafeInteger(this.checkpointIntervalMs) || this.checkpointIntervalMs < 1 || this.checkpointIntervalMs > 60000) throw new Error("Invalid heartbeat interval");
  }

  create(contract: MissionContract, instructions: string, history: HarnessMessage[] = []): HarnessCheckpoint {
    const checkpoint = createHarnessCheckpoint(contract, instructions, history, this.host.tools);
    this.store.save(checkpoint);
    return checkpoint;
  }

  async run(c: HarnessCheckpoint, signal: AbortSignal, options: {resumed?: boolean} = {}): Promise<void> {
    // A crash may lose the provider's final usage frame. The last persisted
    // conservative count still belongs to this mission and cannot be refunded.
    c.generatedTokens += c.inFlightGenerationTokens ?? 0;
    delete c.inFlightGenerationTokens;
    delete c.error;
    const recovery = c.recoveryCounters ??= {transportRetries: 0, outputRepairs: 0, progressRepairs: 0, instanceRebinds: 0, journalReconciliations: 0, resumes: 0};
    if (options.resumed || c.round > 0) recovery.resumes += 1;
    let lastTick = Date.now();
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    const budgetAbort = new AbortController();
    const runSignal = AbortSignal.any([signal, budgetAbort.signal]);
    let queued = false;
    const account = () => { const now = Date.now(); if (!queued) c.activeTimeMs += now - lastTick; lastTick = now; };
    const save = (state: HarnessState, detail: string) => { account(); c.state = state; this.store.save(c); this.host.publish(c, detail); };
    let repairCount = 0, repeated = 0, lastSignature = "", noProgressRepaired = c.observationProgress?.repairIssued ?? recovery.progressRepairs > 0;
    let observedThisRun = false;
    let persistenceFailure: Error | undefined;
    const armBudget = () => { budgetTimer = setTimeout(() => budgetAbort.abort(failure("TASK_BUDGET_EXHAUSTED", "Active execution time exhausted.")), Math.max(1, c.contract.budgets.activeTimeMs - c.activeTimeMs)); };
    const queueState = (state: "queued" | "active", activeState: "generating" | "executing", resource: string) => {
      account(); queued = state === "queued";
      if (budgetTimer) clearTimeout(budgetTimer);
      if (!queued) armBudget();
      c.state = queued ? "queued" : activeState;
      this.host.publish(c, queued ? `Waiting for ${resource}` : activeState === "generating" ? "Waiting for model response" : "Workspace operation acquired its execution slot");
    };
    const toolQueueState: WorkspaceQueueState = state => queueState(state, "executing", "the workspace execution slot");
    armBudget();
    const heartbeat = setInterval(() => {
      try {account(); this.store.save(c); this.host.publish(c, queued ? "Waiting for an execution slot" : "Execution checkpoint saved");}
      catch (error) {persistenceFailure = error as Error; budgetAbort.abort(error);}
    }, this.checkpointIntervalMs);
    try {
      save(c.round ? "recovering" : "preparing", c.round ? "Checking durable results before continuing" : "Checking the exact loaded model instance");
      while (true) {
        if (c.pendingCalls.length) {
          save("executing", `${c.pendingCalls.length} tool operation(s) to reconcile or execute`);
          for (const call of [...c.pendingCalls]) {
            let result = this.store.resultForCall(c.contract.runId, call.id);
            if (!result) {
              if (this.store.uncertainEffect(c.contract.runId, call.id)) {
                // Recovery may inspect an existing journal even after the task
                // budget is spent. It cannot start or replay a write.
                signal.throwIfAborted();
                let recovered: Record<string, unknown> | undefined;
                try { recovered = await this.host.reconcile?.(call.function.name, JSON.parse(call.function.arguments), call.id, c, signal, toolQueueState); }
                catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), {effectState: "unknown"}); }
                if (recovered) {result = this.store.record(c.contract.runId, call.id, call.function.name, recovered); recovery.journalReconciliations += 1;}
                else throw failure("TOOL_EFFECT_UNKNOWN", "A write was interrupted without enough journal evidence to establish its result. It will not be replayed.", "unknown");
              }
            }
            if (!result) {
              account();
              const exhausted = c.round >= c.contract.budgets.maxRounds || c.generatedTokens >= c.contract.budgets.maxGeneratedTokens || c.activeTimeMs >= c.contract.budgets.activeTimeMs;
              if (exhausted && this.host.effect(call.function.name) === "write") throw failure("TASK_BUDGET_EXHAUSTED", "A pending write was not started because the task budget is exhausted. Previously committed results remain available.");
              if (call.function.name !== "harness_finish") runSignal.throwIfAborted();
              else signal.throwIfAborted();
              result = await this.execute(c, call, runSignal, toolQueueState);
            } else if (call.function.name === "harness_finish" && result.ok) {
              // A durable completion receipt is evidence of the old state, not
              // authority to mark changed or deleted artifacts complete now.
              const verified = await this.host.verify(c, String(result.data.summary ?? ""));
              if (!verified.ok) result = {...result, ok: false, data: {...result.data, ...verified}};
            }
            // Restore metadata as well as the result if a crash occurred between result and checkpoint commits.
            if (result.ok && call.function.name === "harness_plan") c.contract.deliverables = result.data.deliverables as MissionContract["deliverables"];
            if (result.ok && call.function.name === "harness_discover_tools") c.selectedTools = [...new Set([...(c.selectedTools ?? []), ...((result.data.activated as HarnessToolDefinition[] | undefined) ?? []).map(t => t.function.name)])];
            if (result.ok && result.data._harnessMaterialBinding) c.contract.materialBinding = result.data._harnessMaterialBinding as MissionContract["materialBinding"];
            if (result.data.resume_tool === "workspace_resume_validation" && this.host.tools.some(tool => tool.function.name === result.data.resume_tool)) c.selectedTools = [...new Set([...(c.selectedTools ?? []), "workspace_resume_validation"])];
            if (result.ok && Array.isArray(result.data.artifacts)) c.deliveredPaths = [...new Set([...c.deliveredPaths, ...result.data.artifacts.filter((path): path is string => typeof path === "string")])];
            if (!c.completedCalls.includes(call.id)) {
              observeHarnessResult(c, call, result, call.function.name.startsWith("harness_") ? "read" : this.host.effect(call.function.name));
              observedThisRun = true;
              c.completedCalls.push(call.id);
              c.resultHandles.push(result.handle);
              c.messages.push({role: "tool", content: projectToolResult(result), tool_call_id: call.id});
            }
            c.pendingCalls = c.pendingCalls.filter(p => p.id !== call.id);
            save("checkpointing", `${call.function.name}: ${result.ok ? "result saved" : "diagnostics saved"}`);
            if (call.function.name === "harness_finish" && result.ok) {
              signal.throwIfAborted();
              c.deliveredPaths = result.data.artifacts as string[];
              c.fullContent = String(result.data.summary);
              save("completed", "Deliverables and acceptance evidence verified");
              return;
            }
          }
        }
        runSignal.throwIfAborted();
        const progressAction = observationProgressAction(c);
        if (progressAction === "stop" && observedThisRun) throw failure("NO_PROGRESS", "The task continued observing unchanged source, tool results or validation outcomes after one bounded progress repair. All receipts and unfinished deliverables remain saved.");
        if (progressAction === "repair") {
          noProgressRepaired = true; recovery.progressRepairs += 1;
          c.observationProgress!.repairIssued = true; c.observationProgress!.unchanged = 0;
          c.messages.push({role: "user", _harnessGenerated: true, content: "Recent individual operations only repeated unchanged observations. All full results remain available. Use the saved source and validation evidence to produce the requested bounded deliverables, repair a concrete outstanding diagnostic, or request verified completion. Reordering old reads does not create progress. This is the one bounded progress repair; no host-authored result will replace your work."});
          save("recovering", "Repairing a cycle of unchanged observations");
        }
        if (c.round >= c.contract.budgets.maxRounds || c.generatedTokens >= c.contract.budgets.maxGeneratedTokens) throw failure("TASK_BUDGET_EXHAUSTED", "Round or generated-token budget exhausted. Continuation preserves all used budget.");
        const binding = await this.host.binding(runSignal);
        if (binding.modelId !== c.contract.modelId) throw failure("MODEL_BINDING_CHANGED", "The connected instance belongs to a different model from the immutable mission selection.");
        if (c.instanceId && c.instanceId !== binding.instanceId) {
          if (binding.contextLength !== c.contract.contextTokens) throw failure("MODEL_CONTEXT_MISMATCH", "A replacement instance must retain the mission's exact loaded context length.");
          const audit = this.store.record(c.contract.runId, `model-rebind-${randomUUID()}`, "harness_model_rebind", {ok: true, model_id: binding.modelId, previous_instance_id: c.instanceId, instance_id: binding.instanceId, context_tokens: binding.contextLength, observed_at: binding.observedAt, reason: "The same explicitly selected model was rediscovered with the same actual context after reconnection."});
          c.resultHandles.push(audit.handle);
          recovery.instanceRebinds += 1;
          c.instanceId = binding.instanceId;
          c.messages.push({role: "user", _harnessGenerated: true, content: `The host reverified the same approved model and exact context on a replacement runtime instance. All saved effects, constraints and budgets remain binding. Audit handle: ${audit.handle}.`});
          save("recovering", "Reconnected to the verified replacement instance of the same model");
        }
        c.instanceId = binding.instanceId;
        const primaryContext = c.contract.primaryModelContextTokens ?? (/qwen3[._-]?8.*27b.*q4/i.test(c.contract.modelId) ? HARNESS_DEFAULTS.contextTokens : undefined);
        if (primaryContext !== undefined && binding.contextLength !== primaryContext) throw failure("MODEL_CONTEXT_MISMATCH", `The primary model must be explicitly loaded with ${primaryContext.toLocaleString("en-US")} tokens.`);
        c.contract.contextTokens = binding.contextLength;
        const toolSet = [...HARNESS_TOOLS, ...this.host.tools.filter(t => c.selectedTools?.includes(t.function.name))];
        const outputTokens = Math.min(repairCount ? HARNESS_DEFAULTS.maxOutputTokens : HARNESS_DEFAULTS.outputTokens, c.contract.budgets.maxGeneratedTokens - c.generatedTokens);
        const context = await assembleHarnessContext(bindCurrentExecutionState(c), toolSet, c.contract.goal, binding.contextLength, outputTokens, async (messages, tools) => {
          const counted = await this.host.count(providerMessages(messages), tools, runSignal); c.tokenCountMethod = counted.method; return counted.tokens;
        });
        c.messages = context.messages;
        c.contextUsed = context.tokens;
        c.round += 1;
        save("generating", context.compacted ? "Structured memory restored; waiting for model response" : "Waiting for model response");
        let content = "", reasoning = "", finish: string | null | undefined, usage = 0;
        const assembled = new Map<number, HarnessToolCall>();
        let retries = 0;
        while (true) {
          try {
            await this.host.chat({messages: providerMessages(c.messages), tools: context.tools, tool_choice: "auto", temperature: 0.2, max_tokens: outputTokens,
              _onQueueState: (state: "queued" | "active") => queueState(state, "generating", "the model generation slot"),
              deadline: Date.now() + Math.min(20 * 60_000, c.contract.budgets.activeTimeMs - c.activeTimeMs)}, chunk => {
              usage = Math.max(usage, chunk.usage?.completion_tokens ?? 0);
              const choice = chunk.choices?.[0];
              if (choice?.finish_reason) finish = choice.finish_reason;
              const delta = choice?.delta;
              if (delta?.content) {content += delta.content; this.host.delta(delta.content);}
              reasoning += delta?.reasoning_content ?? delta?.reasoning ?? "";
              for (const fragment of delta?.tool_calls ?? []) {
                const call = assembled.get(fragment.index) ?? {id: `call_${randomUUID()}`, type: "function", function: {name: "", arguments: ""}};
                // IDs are host-owned and unique across rounds, including providers that reuse call IDs.
                call.function.name += fragment.function?.name ?? "";
                call.function.arguments += fragment.function?.arguments ?? "";
                assembled.set(fragment.index, call);
              }
              c.inFlightGenerationTokens = usage || Buffer.byteLength(content + reasoning + JSON.stringify([...assembled.values()]), "utf8");
            }, runSignal);
            break;
          } catch (error) {
            const e = error as {retryable?: boolean; code?: string};
            if (runSignal.aborted || content || reasoning || assembled.size || retries >= 2 || !e.retryable) {
              c.generatedTokens += c.inFlightGenerationTokens ?? 0;
              delete c.inFlightGenerationTokens;
              throw error;
            }
            retries += 1; recovery.transportRetries += 1; save("recovering", `Transport retry ${retries}/2`);
          }
        }
        // Without provider usage, byte-counting is a deliberately conservative token upper bound.
        c.generatedTokens += usage || Buffer.byteLength(content + reasoning + JSON.stringify([...assembled.values()]), "utf8");
        delete c.inFlightGenerationTokens;
        if (finish === "length" || !finish || (!content.trim() && !assembled.size)) {
          if (++repairCount > 1) throw failure(finish === "length" ? "OUTPUT_TRUNCATED" : "MODEL_OUTPUT_INCOMPLETE", "The model did not produce a complete actionable response after one repair.");
          recovery.outputRepairs += 1;
          c.messages.push({role: "user", _harnessGenerated: true, content: `The preceding response was incomplete (${finish ?? "missing terminal status"}) and no tools from it were executed. Produce a complete bounded tool call. Read large content through result handles. Use harness_finish only after acceptance checks.`});
          save("recovering", "Repairing incomplete model output");
          continue;
        }
        const calls = [...assembled.values()];
        if (!calls.length) {
          c.messages.push({role: "assistant", content});
          if (++repairCount > 1) throw failure("COMPLETION_UNVERIFIED", "The model stopped without verified completion. The task and its artifacts remain available.");
          recovery.outputRepairs += 1;
          c.messages.push({role: "user", _harnessGenerated: true, content: "Continue the requested tool workflow. When all requirements are satisfied, call harness_finish with the final summary; prose alone cannot complete this task."});
          continue;
        }
        const signature = createHash("sha256").update(JSON.stringify(calls.map(call => call.function))).digest("hex");
        repeated = signature === lastSignature ? repeated + 1 : 0; lastSignature = signature;
        if (repeated >= 2) {
          if (noProgressRepaired) throw failure("NO_PROGRESS", "The same operation recurred after one bounded progress repair. Saved for continuation.");
          noProgressRepaired = true;
          if (c.observationProgress) {c.observationProgress.repairIssued = true; c.observationProgress.unchanged = 0;}
          recovery.progressRepairs += 1;
          c.messages.push({role: "user", _harnessGenerated: true, content: "The same unchanged operation was requested repeatedly. This duplicate was not executed. Inspect the existing result and diagnostics, then change the arguments or next step to make observable progress. If the requested work is already complete, use harness_finish. One bounded progress repair is available."});
          save("recovering", "Repairing repeated operations before another effect");
          continue;
        }
        c.messages.push({role: "assistant", content, tool_calls: calls});
        c.fullContent += content;
        c.pendingCalls = calls;
        save("checkpointing", "Tool intents checkpointed before execution");
      }
    } catch (error) {
      const e = error as {code?: string; stage?: string; message?: string; retryable?: boolean; effectState?: "none" | "unknown"};
      const paused = signal.aborted && (signal.reason as {code?: string})?.code === "HARNESS_PAUSED";
      c.error = {code: persistenceFailure ? "CHECKPOINT_PERSISTENCE_FAILED" : paused ? "HARNESS_PAUSED" : signal.aborted ? "USER_CANCELLED" : budgetAbort.signal.aborted ? "TASK_BUDGET_EXHAUSTED" : e.code ?? "HARNESS_FAILURE", stage: e.stage ?? c.state, message: persistenceFailure?.message ?? (paused ? String((signal.reason as Error)?.message ?? signal.reason) : e.message ?? String(error)), retryable: paused || (e.retryable ?? false), effectState: e.effectState ?? "none"};
      save(e.effectState === "unknown" ? "effect-unknown" : paused ? "paused" : signal.aborted ? "cancelled" : "incomplete", c.error.message);
    } finally { if (budgetTimer) clearTimeout(budgetTimer); clearInterval(heartbeat); }
  }

  private async execute(c: HarnessCheckpoint, call: HarnessToolCall, signal: AbortSignal, queueState?: WorkspaceQueueState): Promise<ToolResultEnvelope> {
    const name = call.function.name;
    const definition = [...HARNESS_TOOLS, ...this.host.tools].find(t => t.function.name === name);
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments);
      if (!definition || !ajv.validate(definition.function.parameters, args)) throw new Error(ajv.errorsText());
    } catch (error) { return this.store.record(c.contract.runId, call.id, name, {ok: false, code: "INVALID_TOOL_ARGUMENTS", message: String(error)}); }
    const effect = name.startsWith("harness_") ? "read" : this.host.effect(name);
    this.store.intent(c.contract.runId, call.id, name, args, effect);
    let data: Record<string, unknown>;
    try {
      if (name === "harness_discover_tools") {
        const query = String(args.query).toLowerCase();
        const terms = [...new Set(query.split(/[\s_,;/-]+/u).filter(Boolean))];
        const matches = this.host.tools.map((tool, order) => {
          const name = tool.function.name.toLowerCase(), description = tool.function.description.toLowerCase();
          const score = !query ? 1 : name === query ? 10000 : (name.includes(query) ? 1000 : 0) + terms.reduce((sum, term) => sum + (name.includes(term) ? 10 : description.includes(term) ? 1 : 0), 0);
          return {tool, order, score};
        }).filter(candidate => candidate.score > 0).sort((left, right) => right.score-left.score || left.order-right.order).map(candidate => candidate.tool);
        const chosen = query ? matches.slice(0, 6) : [];
        c.selectedTools = [...new Set([...(c.selectedTools ?? []), ...chosen.map(t => t.function.name)])];
        data = {ok: true, names: matches.map(t => t.function.name), activated: chosen, message: query ? "Matching tools remain callable. Refine the query if more than six match." : "Search a specific name or keyword to activate its schema."};
      } else if (name === "harness_read_result") data = this.store.page(c.contract.runId, String(args.handle), Number(args.offset ?? 0), Number(args.limit ?? 12000));
      else if (name === "harness_plan") {
        const proposed = args.deliverables as MissionContract["deliverables"];
        c.contract.deliverables = [...c.contract.deliverables, ...proposed.filter(d => !c.contract.deliverables.some(old => old.path === d.path))];
        data = {ok: true, deliverables: c.contract.deliverables, scope: c.contract.scope};
      } else if (name === "harness_finish") {
        const verified = c.pendingCalls.length > 1 ? {ok: false, diagnostics: ["Completion must be requested after all other operations have committed."], artifacts: []} : await this.host.verify(c, String(args.summary));
        data = {...verified, summary: args.summary};
      } else data = await this.host.execute(name, args, call.id, c, signal, queueState);
    } catch (error) {
      const e = error as {code?: string; message?: string; effectState?: "none" | "unknown"};
      if (effect === "write" && e.effectState !== "none") throw Object.assign(error instanceof Error ? error : new Error(String(error)), {effectState: "unknown"});
      if (signal.aborted && e.effectState !== "none") throw error;
      // A proved prewrite cancellation is a durable failed result. The caller
      // checkpoints it before honoring pause/cancel, preventing false unknowns.
      data = {ok: false, code: e.code ?? "TOOL_FAILED", message: e.message ?? String(error), effect_state: "none"};
    }
    return this.store.record(c.contract.runId, call.id, name, data);
  }
}
