import type { AgentRunEvent } from "../../shared/contracts.ts";

export interface PatchValidationOutcome {
  ok: boolean;
  error?: string;
}

export function patchValidationOutcome(events: AgentRunEvent[]): PatchValidationOutcome {
  const failed = events.find((event) =>
    event.status === "failed" || event.status === "effect-unknown" || event.status === "interrupted",
  );
  if (failed) {
    return {
      ok: false,
      error: `${failed.title}: ${failed.summary || "Validation did not complete successfully."}`,
    };
  }
  const validationRecorded = events.some((event) => event.stage === "validate" && event.status === "completed");
  const reviewRecorded = events.some((event) => event.stage === "review" && event.status === "completed");
  if (!validationRecorded || !reviewRecorded) {
    return {
      ok: false,
      error: "Validation ended without both a terminal validation event and a terminal review event.",
    };
  }
  return { ok: true };
}
