import type { AgentRunEvent } from "../shared/contracts.ts";

export function shouldFollowNewRun(selectedRunId: string | undefined, event: AgentRunEvent): boolean {
  return event.runId !== selectedRunId
    && event.stage === "goal"
    && event.actor === "user"
    && event.status === "completed";
}
