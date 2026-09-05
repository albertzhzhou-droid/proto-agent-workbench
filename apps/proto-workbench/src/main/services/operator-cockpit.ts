import { createHash } from "node:crypto";
import type {
  MissionLibraryEntry,
  OperatorAttentionItem,
  OperatorAttentionPriority,
  OperatorCockpitProjection,
  RunDetail,
} from "../../shared/contracts.ts";

export const OPERATOR_COCKPIT_LIMITS = {
  runScan: 100,
  attentionItems: 24,
  checkpointRecipes: 8,
} as const;

const BUILTIN_MISSIONS: Array<Omit<MissionLibraryEntry, "digest">> = [
  {
    id: "builtin:evidence-gap-map",
    source: "builtin",
    title: "Evidence gap map",
    summary: "Inventory claims, assumptions, and missing support before proposing any effect.",
    mode: "plan",
    goal: "Map the evidence gaps for this workspace goal, list assumptions and unresolved questions, and prepare a review plan without changing files or running code.",
    intent: { network: false, writes: false, execution: false },
  },
  {
    id: "builtin:controlled-change",
    source: "builtin",
    title: "Controlled change",
    summary: "Prepare a bounded diff and its validation path behind explicit review gates.",
    mode: "act",
    goal: "Complete the requested workspace improvement within the mission scope, record the diff, validate the result, and preserve the evidence.",
    intent: { network: false, writes: true, execution: false },
  },
  {
    id: "builtin:recovery-review",
    source: "builtin",
    title: "Recovery review",
    summary: "Inspect durable evidence and recommend a next decision without replaying effects.",
    mode: "plan",
    goal: "Inspect the durable run evidence, identify interrupted or uncertain effects, and recommend the next recovery decision without replaying any side effect.",
    intent: { network: false, writes: false, execution: false },
  },
  {
    id: "builtin:review-packet-audit",
    source: "builtin",
    title: "Review packet audit",
    summary: "Trace each recorded claim to evidence and surface unresolved human-review questions.",
    mode: "plan",
    goal: "Audit the current run review packet, trace every claim to recorded evidence, and list unsupported or human-review-required conclusions without changing files.",
    intent: { network: false, writes: false, execution: false },
  },
];

export function buildOperatorCockpit(
  runDetails: RunDetail[],
  issuedAt = new Date().toISOString(),
): OperatorCockpitProjection {
  if (!validTimestamp(issuedAt)) throw new Error("The Operator Cockpit timestamp is invalid.");
  const visible = [...runDetails]
    .filter((detail) => !detail.summary.archived)
    .sort((left, right) => right.summary.createdAt.localeCompare(left.summary.createdAt)
      || left.summary.runId.localeCompare(right.summary.runId))
    .slice(0, OPERATOR_COCKPIT_LIMITS.runScan);
  const allAttention = visible
    .filter((detail) => detail.summary.lifecycle.attention !== "none")
    .map(operatorAttentionItem)
    .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority)
      || right.runCreatedAt.localeCompare(left.runCreatedAt)
      || left.runId.localeCompare(right.runId));
  const checkpointRecipes = missionRecipes(visible);
  const builtinMissions = BUILTIN_MISSIONS.map(contentAddressedMission);
  const missionLibrary = [...checkpointRecipes, ...builtinMissions];
  const body = {
    schema: "proto-workbench.operator-cockpit.v1" as const,
    sourceRunCount: visible.length,
    attentionItems: allAttention.slice(0, OPERATOR_COCKPIT_LIMITS.attentionItems),
    attentionCounts: {
      total: allAttention.length,
      approvals: allAttention.filter((item) => ["tool-approval", "patch-review", "human-review"].includes(item.attention)).length,
      recovery: allAttention.filter((item) => ["recovery", "failure"].includes(item.attention)).length,
      monitoring: allAttention.filter((item) => ["patch-operation", "validation"].includes(item.attention)).length,
    },
    missionLibrary,
    limits: OPERATOR_COCKPIT_LIMITS,
  };
  return { ...body, digest: sha256(stableJson(body)), issuedAt };
}

function operatorAttentionItem(detail: RunDetail): OperatorAttentionItem {
  const lifecycle = detail.summary.lifecycle;
  const action = attentionAction(detail);
  const body = {
    id: `attention:${detail.summary.runId}`,
    runId: detail.summary.runId,
    runTitle: detail.summary.title,
    runCreatedAt: detail.summary.createdAt,
    snapshotRevision: detail.revision,
    attention: lifecycle.attention,
    priority: attentionPriority(lifecycle.attention),
    label: lifecycle.label,
    detail: lifecycle.detail,
    ...action,
  };
  return { ...body, digest: sha256(stableJson(body)) };
}

function attentionAction(detail: RunDetail): Pick<OperatorAttentionItem, "action" | "actionLabel" | "target"> {
  const attention = detail.summary.lifecycle.attention;
  if (detail.allowedActions.resolveToolApproval || attention === "tool-approval") {
    return { action: "review-tool", actionLabel: "Review tool", target: "runs" };
  }
  if (detail.allowedActions.reviewPatch || attention === "patch-review") {
    return { action: "review-patch", actionLabel: "Review diff", target: "runs" };
  }
  if (detail.allowedActions.reconcilePatchEffect) {
    return { action: "review-effect", actionLabel: "Review effect", target: "runs" };
  }
  if (detail.allowedActions.resumePatchValidation) {
    return { action: "review-validation", actionLabel: "Review validation", target: "runs" };
  }
  if (attention === "human-review") {
    return { action: "review-human", actionLabel: "Open review", target: "reviews" };
  }
  if (attention === "recovery") {
    return { action: "inspect-recovery", actionLabel: "Inspect recovery", target: "runs" };
  }
  if (attention === "failure") {
    return { action: "inspect-failure", actionLabel: "Inspect failure", target: "runs" };
  }
  return { action: "open-run", actionLabel: "Open run", target: "runs" };
}

function attentionPriority(attention: OperatorAttentionItem["attention"]): OperatorAttentionPriority {
  if (attention === "failure" || attention === "recovery") return "critical";
  if (attention === "tool-approval" || attention === "patch-review") return "high";
  if (attention === "patch-operation" || attention === "validation") return "monitoring";
  return "normal";
}

function priorityRank(priority: OperatorAttentionPriority): number {
  return { critical: 0, high: 1, normal: 2, monitoring: 3 }[priority];
}

function missionRecipes(details: RunDetail[]): MissionLibraryEntry[] {
  const checkpoints = details.flatMap((detail) => detail.taskCheckpoints
    .filter((checkpoint) => checkpoint.missionRecipe)
    .map((checkpoint) => ({ detail, checkpoint, recipe: checkpoint.missionRecipe! })))
    .sort((left, right) => right.checkpoint.createdAt.localeCompare(left.checkpoint.createdAt)
      || left.recipe.digest.localeCompare(right.recipe.digest));
  const seenGoals = new Set<string>();
  const entries: MissionLibraryEntry[] = [];
  for (const { detail, checkpoint, recipe } of checkpoints) {
    const key = `${recipe.mode}:${recipe.goalSha256}`;
    if (seenGoals.has(key)) continue;
    seenGoals.add(key);
    const entry = contentAddressedMission({
      id: `checkpoint:${recipe.digest}`,
      source: "checkpoint",
      title: recipe.title,
      summary: `Captured from ${detail.summary.title}. Reuse creates a fresh draft and requires a new Mission Preflight.`,
      mode: recipe.mode,
      goal: recipe.goal,
      intent: recipe.intent,
      sourceRunId: detail.summary.runId,
      recipeDigest: recipe.digest,
      capturedAt: checkpoint.createdAt,
    });
    entries.push(entry);
    if (entries.length >= OPERATOR_COCKPIT_LIMITS.checkpointRecipes) break;
  }
  return entries;
}

function contentAddressedMission(entry: Omit<MissionLibraryEntry, "digest">): MissionLibraryEntry {
  return { ...entry, digest: sha256(stableJson(entry)) };
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sortValue(item)]));
}
