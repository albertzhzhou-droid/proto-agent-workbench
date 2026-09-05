import type { AgentRunEvent, PatchOperation, PatchProposal, ValidationJournalSnapshot } from "../../shared/contracts.ts";
import { validationPlanForPatch, validationPlanSha256 } from "./validation-journal.ts";
import { validationStepEvidenceSha256, validationToolOutputBindingMatches } from "./validation-evidence.ts";

/** Validate durable step evidence without replaying any scientific artifact write. */
export function inspectSourceValidation(patch: PatchProposal, operation: PatchOperation, journal: ValidationJournalSnapshot | undefined, eventById: (id: string) => AgentRunEvent | undefined): { safe: boolean; complete: boolean; events: AgentRunEvent[]; reason?: string } {
  if (!journal) return { safe: operation.state !== "verified" || !patch.targetPath.toLowerCase().endsWith(".proto"), complete: operation.state === "verified" && !patch.targetPath.toLowerCase().endsWith(".proto"), events: [] };
  if (journal.operationId !== operation.id || journal.patchId !== patch.id || journal.runId !== operation.runId || journal.planSha256 !== validationPlanSha256(validationPlanForPatch(patch, operation))) return { safe: false, complete: false, events: [], reason: "Validation journal no longer matches the source operation." };
  const events: AgentRunEvent[] = [];
  const firstIncomplete = journal.steps.findIndex(step => step.state !== "completed");
  if (firstIncomplete >= 0 && journal.steps.slice(firstIncomplete + 1).some(step => step.effect === "artifact-write" && step.state !== "pending")) return { safe: false, complete: false, events, reason: "A later artifact step was attempted after an incomplete prerequisite; explicit journal reconciliation is required." };
  for (const step of journal.steps) {
    if (step.state === "effect-unknown" || (step.effect === "artifact-write" && !["pending", "completed"].includes(step.state))) return { safe: false, complete: false, events, reason: "An artifact-writing validation step has an unknown effect; it will not be replayed." };
    if (step.state === "running") return { safe: false, complete: false, events, reason: "The validation journal still records an active step; reconcile its interrupted state first." };
    if (step.state !== "completed") continue;
    const event = step.eventId ? eventById(step.eventId) : undefined;
    if (!event || !["completed", "approved"].includes(event.status) || !step.outputSha256 || validationStepEvidenceSha256(event) !== step.outputSha256 || !validationToolOutputBindingMatches(event)) return { safe: false, complete: false, events, reason: "A completed validation step lost its bound evidence." };
    events.push(event);
  }
  return { safe: true, complete: journal.state === "completed" && journal.steps.every(step => step.state === "completed"), events };
}
