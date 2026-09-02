import { createHash } from "node:crypto";
import type {
  PatchOperation,
  PatchProposal,
  ValidationJournalSnapshot,
  ValidationJournalStep,
  ValidationStepPlan,
} from "../../shared/contracts.ts";

export function validationPlanForPatch(
  patch: PatchProposal,
  operation: PatchOperation,
): ValidationStepPlan[] {
  const common = {
    operationId: operation.id,
    patchId: patch.id,
    patchRevision: patch.revision,
    targetPath: patch.targetPath,
    resultSha256: operation.resultSha256,
    resultExists: operation.resultExists,
  };
  const plan: Array<Omit<ValidationStepPlan, "sequence" | "inputSha256"> & { input: unknown }> = [
    {
      key: "design-approval",
      title: "Code change approved",
      effect: "none",
      input: { ...common, rationale: patch.rationale },
    },
  ];
  if (patch.targetPath.toLocaleLowerCase().endsWith(".proto")) {
    plan.push(
      {
        key: "proto-check",
        title: "Proto validation",
        effect: "workspace-read",
        input: { ...common, tool: "proto_check" },
      },
      {
        key: "proto-workflow",
        title: "Design workflow",
        effect: "artifact-write",
        input: { ...common, tool: "proto_workflow_run" },
      },
      {
        key: "artifact-boundary",
        title: "Workflow provenance verification",
        effect: "workspace-read",
        input: {
          ...common,
          tool: "proto_provenance_verify",
          sourceStep: "proto-workflow",
          sourceField: "provenance_path",
        },
      },
      {
        key: "review-packet",
        title: "Review packet created",
        effect: "artifact-write",
        input: { ...common, tool: "proto_review_packet" },
      },
    );
  } else {
    plan.push(
      {
        key: "artifact-boundary",
        title: "Artifact validation boundary",
        effect: "none",
        input: { ...common, rule: "non-proto-human-review-boundary" },
      },
      {
        key: "review-packet",
        title: "Artifact ready for human review",
        effect: "none",
        input: { ...common, rule: "artifact-review-packet" },
      },
    );
  }
  return plan.map((step, sequence) => ({
    key: step.key,
    title: step.title,
    sequence,
    effect: step.effect,
    inputSha256: sha256Canonical(step.input),
  }));
}

export function validationPlanSha256(plan: ValidationStepPlan[]): string {
  return sha256Canonical(plan.map((step) => ({
    key: step.key,
    title: step.title,
    sequence: step.sequence,
    effect: step.effect,
    inputSha256: step.inputSha256,
  })));
}

export function validationJournalState(
  steps: ValidationJournalStep[],
): ValidationJournalSnapshot["state"] {
  if (steps.some((step) => step.state === "running")) return "running";
  if (steps.some((step) => step.state === "effect-unknown" || step.state === "interrupted")) {
    return "recovery-required";
  }
  if (steps.some((step) => step.state === "failed")) return "failed";
  if (steps.length > 0 && steps.every((step) => step.state === "completed")) return "completed";
  return "pending";
}

export function validationJournalNextStep(
  steps: ValidationJournalStep[],
): ValidationJournalStep | undefined {
  return [...steps]
    .sort((left, right) => left.sequence - right.sequence)
    .find((step) => step.state !== "completed");
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
