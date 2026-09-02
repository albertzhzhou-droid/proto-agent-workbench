import { createHash } from "node:crypto";
import type { AgentRunEvent } from "../../shared/contracts.ts";
import { sha256Canonical } from "./validation-journal.ts";

export function validationStepEvidenceSha256(event: AgentRunEvent): string {
  return sha256Canonical({
    status: event.status,
    summary: event.summary,
    outputArtifacts: event.outputArtifacts,
    evidenceIds: event.evidenceIds,
    toolOutputSha256: typeof event.payload?.outputSha256 === "string" ? event.payload.outputSha256 : undefined,
  });
}

export function validationToolOutputBindingMatches(event: AgentRunEvent): boolean {
  const output = event.payload?.output;
  const claimed = event.payload?.outputSha256;
  if (output === undefined) return claimed === undefined;
  if (typeof claimed !== "string" || !/^[a-f0-9]{64}$/.test(claimed)) return false;
  return createHash("sha256").update(JSON.stringify(output)).digest("hex") === claimed;
}
