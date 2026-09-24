import { executionActivityState, type ToolExecutionRecord } from "./tool-execution-journal.ts";

/** Shared durable input used by both conversation surfaces. */
export interface ExecutionActivity {
  operationId: string;
  status: string;
  blocked?: boolean;
  evidenceSource: "journal" | "legacy-result";
  execution?: Pick<ToolExecutionRecord,"operationId"|"state"|"outcome"|"effect"|"capabilityId"|"tool"|"argumentsSha256"|"updatedAt">;
}
export function executionActivity(operationId:string,status:string,record?:ToolExecutionRecord,blocked=false):ExecutionActivity {
  if(record&&record.operationId!==operationId)throw new Error("EXECUTION_ACTIVITY_BINDING_MISMATCH");
  return {operationId,status:record?executionActivityState(record):status,evidenceSource:record?"journal":"legacy-result",...(blocked?{blocked:true}:{}),
    ...(record?{execution:{operationId:record.operationId,state:record.state,effect:record.effect,outcome:record.outcome,capabilityId:record.capabilityId,tool:record.tool,argumentsSha256:record.argumentsSha256,updatedAt:record.updatedAt}}:{})};
}

/** Shared limits and evidence semantics; a completed model stream is not evidence. */
export const TURN_LIMITS = Object.freeze({ replyTokens: 4096, reserveTokens: 2048, outputTokens: 65_536, steps: 128, durationMs: 12 * 60_000 });

export function turnBudget(contextLength: number, requestedReplyTokens: number = TURN_LIMITS.replyTokens) {
  if (!Number.isSafeInteger(contextLength) || contextLength < 1024) throw new Error("Invalid loaded model context length.");
  if (!Number.isSafeInteger(requestedReplyTokens) || requestedReplyTokens < 1) throw new Error("Invalid requested reply budget.");
  const replyTokens = Math.min(requestedReplyTokens, Math.floor(contextLength / 4));
  const reserveTokens = Math.min(TURN_LIMITS.reserveTokens, Math.floor(contextLength / 8));
  return { replyTokens, inputBudget: contextLength - replyTokens - reserveTokens, reserveTokens };
}

export function toolResultFailed(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return result.ok === false || result.isError === true || ["error", "failed", "unverifiable", "incomplete"].includes(String(result.status)) || result.effect_state === "unknown"
    || (result.structuredContent !== undefined && toolResultFailed(result.structuredContent))
    || (result.data !== undefined && toolResultFailed(result.data));
}

type GateActivity={status:string;blocked?:boolean;execution?:{state:string;outcome?:string;operationId?:string;tool?:string;argumentsSha256?:string;updatedAt?:string}};
/** Only a later durable success for the same exact tool input can supersede a
 * known failed attempt. Unknown effects and missing legacy evidence never do. */
export function completionGate(activities: readonly GateActivity[]): "complete" | "incomplete-evidence" {
  const succeeded=activities.filter(item=>!item.blocked&&item.status==="complete"&&item.execution?.outcome==="ok"&&["completed","no-effect","reconciled-applied"].includes(item.execution.state));
  return activities.some(item => {
    const record=item.execution;
    const superseded=!item.blocked&&record&&record.state!=="effect-unknown"&&record.state!=="dispatched"&&record.state!=="intent"&&record.tool&&record.argumentsSha256&&record.updatedAt
      &&succeeded.some(other=>other.execution?.operationId!==record.operationId&&other.execution?.tool===record.tool&&other.execution?.argumentsSha256===record.argumentsSha256&&String(other.execution?.updatedAt)>=record.updatedAt!);
    return !superseded&&(item.blocked || item.status !== "complete" || record?.state === "effect-unknown" || record?.outcome === "tool-error");
  })
    ? "incomplete-evidence" : "complete";
}

/** Retain identity and artifact routes even when the model observation is bounded. */
export function projectToolResult(output: string, budget: number, artifactPath?: string): string {
  if (!Number.isSafeInteger(budget) || budget < 128) throw new Error("Tool projection budget must be at least 128 bytes.");
  if (Buffer.byteLength(output) <= budget) return output;
  let source: Record<string, unknown> = {};
  try {
    const value = JSON.parse(output);
    if (value && typeof value === "object" && !Array.isArray(value)) source = value;
  } catch { /* The complete source remains in its artifact. */ }
  const result: Record<string, unknown> = { truncated: true, ...(artifactPath ? { artifactPath } : {}),
    ...(typeof source.handle === "string" ? { handle: source.handle } : {}), omittedIdentityFields: 0, omittedArtifactCount: 0, preview: "" };
  const size = () => Buffer.byteLength(JSON.stringify(result));
  if (size() > budget) throw new Error("Tool projection budget cannot retain the complete result route.");
  const identityLimit = Math.max(size(), Math.floor(budget * 0.6));
  for (const key of ["ok", "isError", "status", "effect_state", "schema", "schema_version", "sha256", "tool", "run_id", "runId", "operator", "evidenceStanding", "evidence_standing", "maturity"]) {
    if (!(key in source)) continue;
    result[key] = source[key];
    if (size() > identityLimit) { delete result[key]; result.omittedIdentityFields = Number(result.omittedIdentityFields) + 1; }
  }
  if (Array.isArray(source.artifacts)) {
    const artifacts: unknown[] = [];
    result.artifacts = artifacts;
    result.omittedArtifactCount = source.artifacts.length;
    for (const item of source.artifacts) {
      artifacts.push(item);
      if (size() > identityLimit) { artifacts.pop(); break; }
      result.omittedArtifactCount = source.artifacts.length - artifacts.length;
    }
    if (!artifacts.length) delete result.artifacts;
  }
  // Measure the serialized representation: JSON escaping and Unicode can make
  // an apparently short prefix exceed the byte budget. Do not split surrogates.
  const prefix = (length: number) => output.slice(0, length > 0 && /[\uD800-\uDBFF]/.test(output[length - 1]) ? length - 1 : length);
  let low = 0, high = Math.min(output.length, budget);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2); result.preview = prefix(middle);
    if (size() <= budget) low = middle; else high = middle - 1;
  }
  result.preview = prefix(low);
  return JSON.stringify(result);
}
