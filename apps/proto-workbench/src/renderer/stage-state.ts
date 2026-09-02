import type { AgentRunEvent, RunLifecycleProjection } from "../shared/contracts.ts";

export const RUN_STAGES: Array<{ id: AgentRunEvent["stage"]; label: string }> = [
  { id: "goal", label: "Goal" },
  { id: "plan", label: "Plan" },
  { id: "design", label: "Design" },
  { id: "validate", label: "Validate" },
  { id: "review", label: "Review packet" },
];

export type RunStageState = "failed" | "cancelled" | "interrupted" | "effect-unknown" | "waiting" | "running" | "completed" | "blocked" | "pending";

const FAILED_STATUSES: AgentRunEvent["status"][] = ["failed", "rejected"];
const CANCELLED_STATUSES: AgentRunEvent["status"][] = ["cancelled"];
const INTERRUPTED_STATUSES: AgentRunEvent["status"][] = ["interrupted"];
const UNKNOWN_EFFECT_STATUSES: AgentRunEvent["status"][] = ["effect-unknown"];
type StageEvent = Pick<AgentRunEvent, "stage" | "status"> & Partial<Pick<AgentRunEvent, "actor" | "title">>;

export function deriveRunStageStates(
  events: StageEvent[],
  lifecycle?: RunLifecycleProjection,
): Record<AgentRunEvent["stage"], RunStageState> {
  const planController = events.find((event) => event.stage === "plan" && event.title === "Agent plan started")
    ?? [...events].reverse().find((event) => event.stage === "plan");
  const states = Object.fromEntries(RUN_STAGES.map((stage, index) => {
    const stageEvents = events.filter((event) => event.stage === stage.id);
    const meaningful = stageEvents.filter((event) => event.actor !== "system");
    const latest = meaningful.at(-1) ?? stageEvents.at(-1);
    const controller = stage.id === "plan" ? planController : undefined;
    const status = controller?.status ?? latest?.status;
    const waiting = stageEvents.some((event) => event.status === "approval-required");
    const running = stageEvents.some((event) => event.status === "running");
    const recovering = stage.id !== "goal"
      && planController?.status === "running"
      && stageEvents.length > 0
      && status !== "completed"
      && status !== "approved";
    const state: RunStageState = waiting
      ? "waiting"
      : running || recovering
        ? "running"
        : status && UNKNOWN_EFFECT_STATUSES.includes(status)
          ? "effect-unknown"
          : status && INTERRUPTED_STATUSES.includes(status)
            ? "interrupted"
            : status && CANCELLED_STATUSES.includes(status)
              ? "cancelled"
              : status && FAILED_STATUSES.includes(status)
                ? "failed"
                : status === "completed" || status === "approved"
                  ? "completed"
                  : "pending";
    return [stage.id, state];
  })) as Record<AgentRunEvent["stage"], RunStageState>;
  const firstTerminalStageIndex = RUN_STAGES.findIndex((stage) => ["failed", "cancelled", "interrupted", "effect-unknown"].includes(states[stage.id]));
  if (firstTerminalStageIndex >= 0) {
    for (let index = firstTerminalStageIndex + 1; index < RUN_STAGES.length; index += 1) {
      const stage = RUN_STAGES[index];
      if (states[stage.id] === "pending") states[stage.id] = "blocked";
    }
  }
  if (lifecycle?.state === "waiting-patch-review") {
    states.design = "waiting";
    states.validate = "blocked";
    states.review = "blocked";
  } else if (lifecycle?.state === "applying-patch") {
    states.design = "running";
    states.validate = "blocked";
    states.review = "blocked";
  } else if (lifecycle?.state === "validating") {
    states.design = "completed";
    states.validate = "running";
    states.review = "blocked";
  } else if (lifecycle && isPatchEffectRecovery(lifecycle)) {
    states.design = "effect-unknown";
    states.validate = "blocked";
    states.review = "blocked";
  } else if (lifecycle && isPatchValidationRecovery(lifecycle)) {
    states.design = "completed";
    states.validate = "interrupted";
    states.review = "blocked";
  }
  return states;
}

function isPatchEffectRecovery(lifecycle: RunLifecycleProjection): boolean {
  return lifecycle.state === "effect-unknown"
    && lifecycle.attention === "recovery"
    && lifecycle.label.toLocaleLowerCase().startsWith("patch");
}

function isPatchValidationRecovery(lifecycle: RunLifecycleProjection): boolean {
  return lifecycle.state === "interrupted"
    && lifecycle.attention === "recovery"
    && lifecycle.label.toLocaleLowerCase().startsWith("patch applied");
}
