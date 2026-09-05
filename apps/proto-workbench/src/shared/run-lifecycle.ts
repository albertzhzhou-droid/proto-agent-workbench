import type {
  AgentRunEvent,
  EventStatus,
  FileCheckpoint,
  PatchOperation,
  PatchProposal,
  ReviewComment,
  ReviewPacketView,
  RunAllowedActions,
  RunLifecycleProjection,
  ToolApproval,
  ValidationJournalSnapshot,
} from "./contracts.ts";

export interface RunLifecycleInput {
  events: AgentRunEvent[];
  patches?: PatchProposal[];
  approvals?: ToolApproval[];
  patchOperations?: PatchOperation[];
  checkpoints?: FileCheckpoint[];
  validationJournals?: ValidationJournalSnapshot[];
  review?: ReviewPacketView;
}

export function emptyReview(runId = ""): ReviewPacketView {
  return {
    runId,
    gate: "review-required",
    summary: "Run validation to create an evidence-backed review packet.",
    claims: [],
    checklist: [],
    unresolvedQuestions: [],
    safetyBoundary: "Software validation only; human scientific review is still required.",
  };
}

export function projectRunLifecycle(input: RunLifecycleInput): RunLifecycleProjection {
  const events = input.events;
  const patches = input.patches ?? [];
  const approvals = input.approvals ?? [];
  const operations = input.patchOperations ?? [];
  const validationJournals = input.validationJournals ?? [];
  const review = input.review;
  const latest = events.at(-1);
  const controller = [...events].reverse().find((event) => event.stage === "plan" && ["Agent plan started", "Autonomous mission", "Mission resumed"].includes(event.title));
  const harnessEvent = [...events].reverse().find((event) => typeof event.payload?.harness === "object" && event.payload.harness !== null);
  const harness = harnessEvent?.payload?.harness as {state?: string; error?: {message?: string}} | undefined;
  const pendingApprovalCount = approvals.filter((approval) => approval.status === "pending").length;
  const activePatch = patches.find((patch) => patch.status === "pending");
  const activeOperation = selectActiveOperation(operations, validationJournals);
  const activeJournal = activeOperation
    ? validationJournals.find((journal) => journal.operationId === activeOperation.id)
    : undefined;
  const uncertainArtifactStep = activeJournal?.steps.find(
    (step) => step.effect === "artifact-write" && step.state === "effect-unknown",
  );
  const validating = !harness && events.some((event) => event.stage === "validate" && event.status === "running");
  const hasReviewPacket = Boolean(
    review?.packetPath
    || review?.claims.length
    || review?.checklist.length
    || review?.approvedAt,
  );

  if (activeOperation?.state === "effect-unknown" || activeOperation?.state === "conflict") {
    return lifecycle(
      "effect-unknown",
      "recovery",
      activeOperation.state === "conflict" ? "Patch state conflicts with the workspace" : "Patch effect needs reconciliation",
      activeOperation.state === "conflict"
        ? "The current file matches neither the reviewed base nor the intended result. Proto will not overwrite it."
        : "Compare the current file hash with the reviewed base and intended result before continuing.",
      false,
    );
  }
  if (activeOperation?.state === "applying") {
    return lifecycle(
      "applying-patch",
      "patch-operation",
      "Applying reviewed patch",
      "The checkpoint is durable and the controlled file write is in progress.",
      false,
    );
  }
  if (activePatch?.restoresCheckpointId
    && (!uncertainArtifactStep || activePatch.restoresCheckpointId === activeOperation?.checkpointId)) {
    return lifecycle(
      "waiting-patch-review",
      "patch-review",
      "Checkpoint restore review required",
      `Review the reverse diff for ${shortPath(activePatch.targetPath)}. The current file remains unchanged until approval.`,
      false,
    );
  }
  if (uncertainArtifactStep && !activePatch?.restoresCheckpointId) {
    return lifecycle(
      "effect-unknown",
      "recovery",
      "Validation artifact reconciliation required",
      `${uncertainArtifactStep.title} may have written artifacts before its result became uncertain. Explicit artifact reconciliation or a checkpoint restore is required; Proto will not replay this step automatically.`,
      false,
    );
  }
  // Scientific review and historical tool events cannot override the durable
  // execution checkpoint. A valid intermediate artifact is not task completion.
  if (harness && harness.state !== "completed") {
    const detail = harness.error?.message || harnessEvent?.summary || "Execution is saved for continuation.";
    switch (harness.state) {
      case "effect-unknown": return lifecycle("effect-unknown", "recovery", "Effect needs reconciliation", detail, false);
      case "paused": return lifecycle("interrupted", "recovery", "Task paused", detail, false);
      case "incomplete": return lifecycle("interrupted", "recovery", "Task incomplete", detail, false);
      case "blocked": return lifecycle("interrupted", "recovery", "Task blocked", detail, false);
      case "failed": return lifecycle("failed", "failure", "Task failed", detail, true);
      case "cancelled": return lifecycle("cancelled", "none", "Task cancelled", detail, true);
      case "validating": return lifecycle("validating", "validation", "Verifying deliverables", detail, false);
      case "queued": return lifecycle("pending", "none", "Task queued", detail, false);
      case "preparing": case "generating": case "executing": case "checkpointing": case "recovering":
        return lifecycle("running", "none", "Task in progress", detail, false);
      default: return lifecycle("interrupted", "recovery", "Execution state unavailable", "The saved execution state is not recognized. Completion cannot be inferred.", false);
    }
  }
  if (!harness && latest?.status === "effect-unknown") {
    return lifecycle(
      "effect-unknown",
      "recovery",
      "Effect needs reconciliation",
      "The app restarted while a tool could have changed state. Inspect the ledger before continuing.",
      false,
    );
  }
  if (!harness && latest?.status === "interrupted") {
    return lifecycle(
      "interrupted",
      "recovery",
      "Run was interrupted",
      "No unfinished side effect was replayed. Review the last durable event before restarting.",
      false,
    );
  }
  if (pendingApprovalCount > 0) {
    return lifecycle(
      "waiting-tool-approval",
      "tool-approval",
      "Tool approval required",
      `${pendingApprovalCount} bounded tool action${pendingApprovalCount === 1 ? " is" : "s are"} waiting for a decision.`,
      false,
    );
  }
  if (activeOperation?.state === "validation-failed") {
    return lifecycle(
      "interrupted",
      "recovery",
      "Patch applied; validation needs attention",
      activeOperation.error || "The intended file content is present. Resume deterministic validation or prepare a checkpoint restore diff.",
      false,
    );
  }
  if (activePatch) {
    return lifecycle(
      "waiting-patch-review",
      "patch-review",
      "Patch review required",
      `Review the proposed change to ${shortPath(activePatch.targetPath)} before any file is written.`,
      false,
    );
  }
  if (activeOperation?.state === "applied" || activeOperation?.state === "validating") {
    return lifecycle(
      "validating",
      "validation",
      activeOperation.state === "applied" ? "Patch applied; validation queued" : "Validation in progress",
      "The current file matches the reviewed result and deterministic validation is the next durable step.",
      false,
    );
  }
  if (!harness && latest?.status === "approval-required") {
    return lifecycle(
      "waiting-tool-approval",
      "tool-approval",
      "Approval required",
      "A legacy run event is waiting for an explicit decision.",
      false,
    );
  }
  if (validating) {
    return lifecycle(
      "validating",
      "validation",
      "Validation in progress",
      "The approved change is being checked and evidence is being assembled.",
      false,
    );
  }
  if (!harness && controller?.status === "failed") {
    return lifecycle(
      "failed",
      "failure",
      "Run failed",
      controller.summary || "The run controller reported a blocking failure.",
      true,
    );
  }
  if (!harness && controller?.status === "cancelled") {
    return lifecycle(
      "cancelled",
      "none",
      "Run cancelled",
      controller.summary || "The request stopped without replaying unfinished actions.",
      true,
    );
  }
  if (review?.gate === "blocked") {
    return lifecycle(
      "failed",
      "failure",
      "Validation blocked review",
      review.summary || "Deterministic validation reported a blocking result.",
      true,
    );
  }
  if (!harness && latest?.status === "failed" && controller?.status !== "completed") {
    return lifecycle(
      "failed",
      "failure",
      "Run failed",
      latest.summary || "The latest run event failed.",
      true,
    );
  }
  if (!harness && latest?.status === "cancelled") {
    return lifecycle(
      "cancelled",
      "none",
      "Run cancelled",
      "The request stopped without replaying unfinished actions.",
      true,
    );
  }
  if (review?.gate === "approved") {
    return lifecycle(
      "approved",
      "none",
      "Run approved",
      review.summary || "Human review is complete and timestamped.",
      true,
    );
  }
  if (review?.gate === "ready" && hasReviewPacket) {
    return lifecycle(
      "ready-for-approval",
      "human-review",
      "Ready for final approval",
      "The checklist is complete. Record the final human decision when ready.",
      false,
    );
  }
  if (hasReviewPacket) {
    return lifecycle(
      "review-required",
      "human-review",
      "Human review required",
      review?.summary || "Review the evidence packet and complete the human checklist.",
      false,
    );
  }
  if (!harness && (latest?.status === "running" || controller?.status === "running")) {
    return lifecycle(
      "running",
      "none",
      "Agent run in progress",
      latest?.summary || "The local agent is working through the declared plan.",
      false,
    );
  }
  if (events.length > 0) {
    return lifecycle(
      "completed",
      "none",
      "Run completed",
      "The durable ledger has no unresolved approval, patch, validation, or review action.",
      true,
    );
  }
  return lifecycle(
    "pending",
    "none",
    "Run pending",
    "No durable run event has been recorded yet.",
    false,
  );
}

export function lifecycleEventStatus(projection: RunLifecycleProjection): EventStatus {
  switch (projection.state) {
    case "waiting-tool-approval":
    case "waiting-patch-review":
      return "approval-required";
    case "applying-patch":
    case "validating":
    case "running":
      return "running";
    case "review-required":
    case "ready-for-approval":
    case "completed":
      return "completed";
    case "approved":
      return "approved";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    case "effect-unknown":
      return "effect-unknown";
    default:
      return "pending";
  }
}

export function runAllowedActions(input: RunLifecycleInput): RunAllowedActions {
  const activePatch = (input.patches ?? []).find((patch) => patch.status === "pending");
  const pendingApproval = (input.approvals ?? []).some((approval) => approval.status === "pending");
  const operations = input.patchOperations ?? [];
  const validationJournals = input.validationJournals ?? [];
  const activeOperation = selectActiveOperation(operations, validationJournals);
  const activePatchOperation = activePatch
    ? operations.find((operation) => operation.patchId === activePatch.id)
    : undefined;
  const latestOperation = activeOperation ?? operations[0];
  const latestJournal = latestOperation
    ? validationJournals.find((journal) => journal.operationId === latestOperation.id)
    : undefined;
  const activeOperationIds = new Set(
    operations
      .filter((operation) => !["verified", "rolled-back"].includes(operation.state))
      .map((operation) => operation.id),
  );
  const artifactReconciliationRequired = validationJournals.some(
    (journal) => activeOperationIds.has(journal.operationId) && journal.steps.some(
      (step) => step.effect === "artifact-write" && step.state === "effect-unknown",
    ),
  );
  const checkpoint = latestOperation
    ? (input.checkpoints ?? []).find((candidate) => candidate.id === latestOperation.checkpointId)
    : undefined;
  const projection = projectRunLifecycle(input);
  const stateAllowsDecision = !["effect-unknown", "interrupted", "failed", "cancelled", "applying-patch"].includes(projection.state);
  const restoreSourceOperation = activePatch?.restoresCheckpointId
    ? operations.find((operation) => operation.checkpointId === activePatch.restoresCheckpointId)
    : undefined;
  const patchCanApply = Boolean(activePatch)
    && (!activePatchOperation || activePatchOperation.state === "prepared")
    && (
      !activeOperation
      || activeOperation.patchId === activePatch?.id
      || Boolean(
        activePatch?.restoresCheckpointId
        && restoreSourceOperation?.id === activeOperation.id
        && ["applied", "validation-failed", "verified"].includes(activeOperation.state),
      )
    );
  const stableForFinalReview = stateAllowsDecision
    && !["running", "pending", "validating"].includes(projection.state)
    && !activePatch
    && !pendingApproval
    && (!activeOperation || activeOperation.state === "verified");
  return {
    reviewPatch: stateAllowsDecision && Boolean(activePatch),
    approvePatch: stateAllowsDecision && patchCanApply,
    rejectPatch: stateAllowsDecision && Boolean(activePatch) && !activePatchOperation,
    resolveToolApproval: stateAllowsDecision && pendingApproval,
    reconcilePatchEffect: Boolean(activeOperation && ["applying", "effect-unknown", "conflict"].includes(activeOperation.state)),
    resumePatchValidation: Boolean(
      activeOperation
      && ["applied", "validation-failed"].includes(activeOperation.state)
      && !artifactReconciliationRequired
      && (!latestJournal || latestJournal.resumable),
    ),
    prepareCheckpointRestore: Boolean(
      latestOperation
      && checkpoint?.restoreState === "available"
      && ["applied", "validation-failed", "verified"].includes(latestOperation.state)
      && !activePatch,
    ),
    updateReviewChecklist: stableForFinalReview
      && Boolean(input.review?.packetPath || input.review?.claims.length || input.review?.checklist.length)
      && input.review?.gate !== "approved"
      && input.review?.gate !== "blocked",
    approveRun: stableForFinalReview && input.review?.gate === "ready",
  };
}

export function runDetailRevision(input: RunLifecycleInput & { comments?: ReviewComment[] }): string {
  const latestEvent = input.events.at(-1);
  const patches = input.patches ?? [];
  const approvals = input.approvals ?? [];
  const operations = input.patchOperations ?? [];
  const checkpoints = input.checkpoints ?? [];
  const validationJournals = input.validationJournals ?? [];
  const comments = input.comments ?? [];
  return [
    input.events.length,
    latestEvent?.id ?? "none",
    latestEvent?.status ?? "none",
    latestEvent?.completedAt ?? latestEvent?.createdAt ?? "none",
    latestEvent?.summary ?? "none",
    patches.map((patch) => `${patch.id}:${patch.status}:${patch.revision}`).join(",") || "no-patches",
    operations.map((operation) => `${operation.id}:${operation.state}:${operation.revision}`).join(",") || "no-operations",
    validationJournals.map((journal) => `${journal.operationId}:${journal.state}:${journal.revision}:${journal.steps.map((step) => `${step.key}:${step.state}:${step.attempt}`).join(";")}`).join(",") || "no-validation-journals",
    checkpoints.map((checkpoint) => `${checkpoint.id}:${checkpoint.restoreState}:${checkpoint.revision}`).join(",") || "no-checkpoints",
    approvals.map((approval) => `${approval.id}:${approval.status}:${approval.revision}`).join(",") || "no-approvals",
    input.review?.gate ?? "no-review",
    input.review?.checklist.map((item) => `${item.id}:${item.status}`).join(",") ?? "no-checklist",
    input.review?.claims.map((claim) => `${claim.id}:${claim.status}`).join(",") ?? "no-claims",
    comments.at(-1)?.id ?? 0,
  ].join("|");
}

function lifecycle(
  state: RunLifecycleProjection["state"],
  attention: RunLifecycleProjection["attention"],
  label: string,
  detail: string,
  terminal: boolean,
): RunLifecycleProjection {
  return { state, attention, label, detail, terminal };
}

function shortPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function selectActiveOperation(
  operations: PatchOperation[],
  validationJournals: ValidationJournalSnapshot[],
): PatchOperation | undefined {
  const active = operations.filter((operation) => !["verified", "rolled-back"].includes(operation.state));
  return active.find((operation) => validationJournals.some(
    (journal) => journal.operationId === operation.id && journal.steps.some(
      (step) => step.effect === "artifact-write" && step.state === "effect-unknown",
    ),
  )) ?? active[0];
}
