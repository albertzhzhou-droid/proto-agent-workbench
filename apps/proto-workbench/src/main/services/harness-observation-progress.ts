import { createHash } from "node:crypto";
import type { HarnessCheckpoint, HarnessToolCall, ToolResultEnvelope } from "../../shared/harness.ts";

const VOLATILE = /^(?:created_?at|updated_?at|observed_?at|started_?at|completed_?at|generated_?at|timestamp|elapsed(?:_?ms)?|duration(?:_?ms)?|request_?id|call_?id|handle)$/i;
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !VOLATILE.test(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");

/** Track individual observations, independent of batch order and provider IDs.
 * The bounded persisted window survives compaction, pause and service restart. */
export function observeHarnessResult(c: HarnessCheckpoint, call: HarnessToolCall, result: ToolResultEnvelope, effect: "read" | "write"): void {
  const obligations = hash({deliverables: c.contract.deliverables, reads: c.contract.requiredReads, evidence: c.contract.evidenceRequirements, material: c.contract.materialBinding});
  const state = c.observationProgress ??= {seen: [], unchanged: 0, repairIssued: (c.recoveryCounters?.progressRepairs ?? 0) > 0, obligations};
  if (state.obligations !== obligations) {state.unchanged = 0; state.obligations = obligations;}
  let args: Record<string, unknown>;
  try {args = JSON.parse(call.function.arguments);} catch {args = {invalid_arguments: call.function.arguments};}
  const data = result.data;
  let observation: unknown = data;
  if (call.function.name === "workspace_read") observation = {path: data.path ?? args.path, sha256: data.sha256, content: data.sha256 ? undefined : data.content, ok: result.ok, code: data.code};
  else if (call.function.name === "harness_finish") {args = {}; observation = {ok: result.ok, diagnostics: data.diagnostics};}
  else if (call.function.name === "harness_read_result") {const {handle: _handle, ...paging} = args; args = paging; observation = {content: data.content, offset: data.offset, next_offset: data.next_offset, ok: result.ok};}
  else if (effect === "write" && data._harnessInputs && !["workspace_propose_patch", "workspace_resume_validation"].includes(call.function.name)) {
    // Same source validation/export with new timestamped metadata paths is
    // not new source evidence. Preserve substantive input and check changes.
    const {out: _out, out_dir: _outDir, ...inputs} = args; args = inputs;
    observation = {input: data._harnessInputs, material: data._harnessMaterialBinding, ok: result.ok, code: data.code, diagnostics: data.diagnostics, checks: data.checks, validation: data.validation};
  }
  const signature = hash({tool: call.function.name, args, observation});
  const duplicate = state.seen.includes(signature);
  state.unchanged = duplicate ? state.unchanged + 1 : 0;
  state.seen = [...state.seen.filter(item => item !== signature), signature].slice(-64);
}

export function observationProgressAction(c: HarnessCheckpoint): "continue" | "repair" | "stop" {
  const state = c.observationProgress;
  if (!state) return "continue";
  // Three deliberate repeat checks with interleaved source reads remain below
  // this threshold. Extended unchanged cycles receive exactly one repair.
  return state.unchanged >= (state.repairIssued ? 8 : 12) ? state.repairIssued ? "stop" : "repair" : "continue";
}
