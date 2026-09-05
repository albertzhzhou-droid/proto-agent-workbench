import type { HarnessProjection } from "../shared/harness.ts";
import type { AgentRunEvent } from "../shared/contracts.ts";

/** Historical events and an asynchronous checkpoint read can arrive in either order. */
export function newestHarnessProjection(runId: string | undefined, ...candidates: Array<HarnessProjection | undefined>): HarnessProjection | undefined {
  if (!runId) return undefined;
  return candidates.reduce<HarnessProjection | undefined>((newest, candidate) => {
    if (!candidate || candidate.runId !== runId) return newest;
    return !newest || candidate.revision > newest.revision ? candidate : newest;
  }, undefined);
}

/** Keep the legacy audit status intact while naming the recorded mission state. */
export function harnessEventDisplayStatus(event: AgentRunEvent | undefined): "paused" | "incomplete" | undefined {
  if (!event || event.tool || !["assistant", "system"].includes(event.actor) || event.status !== "failed") return undefined;
  const harness = event.payload?.harness;
  if (!harness || typeof harness !== "object" || Array.isArray(harness)) return undefined;
  const saved = harness as Partial<HarnessProjection>;
  if (saved.runId !== event.runId || !Number.isSafeInteger(saved.revision) || saved.revision! < 0) return undefined;
  return saved.state === "paused" || saved.state === "incomplete" ? saved.state : undefined;
}
