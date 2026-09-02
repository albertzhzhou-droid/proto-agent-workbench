import type { AgentRunEvent } from "./contracts.ts";

export type RunArtifactRole = "input" | "output" | "evidence";
export type RunArtifactBinding = "unbound" | "declared" | "digest-bound";

/**
 * Durable metadata may enrich a legacy string artifact by its exact event slot.
 * The locator is descriptive only and is never used to discover a relationship.
 */
export interface PersistedRunArtifactRef {
  id: string;
  stepId: string;
  role: RunArtifactRole;
  index: number;
  locator: string;
  sourceStepId?: string;
  sha256?: string;
  sizeBytes?: number;
}

/** A durable fork relationship supplied by the persistence layer. */
export interface PersistedRunForkRef {
  id: string;
  sourceRunId: string;
  sourceStepId: string;
  targetRunId: string;
  targetStepId: string;
  createdAt?: string;
}

export interface RunArtifactRef {
  id: string;
  stepId: string;
  runId: string;
  role: RunArtifactRole;
  index: number;
  locator: string;
  binding: RunArtifactBinding;
  sourceStepId?: string;
  sha256?: string;
  sizeBytes?: number;
}

export interface RunStepView {
  id: string;
  eventId: string;
  runId: string;
  ordinal: number;
  stage: AgentRunEvent["stage"];
  actor: AgentRunEvent["actor"];
  title: string;
  summary: string;
  status: AgentRunEvent["status"];
  tool?: string;
  createdAt: string;
  completedAt?: string;
  artifactIds: string[];
}

export interface RunTopologyEdge {
  id: string;
  kind: "artifact" | "fork";
  sourceStepId: string;
  targetStepId: string;
  sourceRunId?: string;
  targetRunId?: string;
  artifactId?: string;
  locator?: string;
}

export interface RunExecutionProjectionOptions {
  artifactRefs?: readonly PersistedRunArtifactRef[];
  forkRefs?: readonly PersistedRunForkRef[];
}

export interface RunExecutionProjection {
  steps: RunStepView[];
  artifacts: RunArtifactRef[];
  topologyEdges: RunTopologyEdge[];
  quarantined: RunProjectionQuarantine[];
}

export interface RunProjectionQuarantine {
  kind: "duplicate-event" | "artifact-reference" | "artifact-edge" | "fork-edge";
  id: string;
  reason: string;
}

export function projectRunExecution(
  events: readonly AgentRunEvent[],
  options: RunExecutionProjectionOptions = {},
): RunExecutionProjection {
  const quarantined: RunProjectionQuarantine[] = [];
  const seenEventIds = new Set<string>();
  const sortedEvents = events
    .map((event, inputIndex) => ({ event, inputIndex }))
    .sort((left, right) => compareEvents(left.event, right.event) || left.inputIndex - right.inputIndex)
    .flatMap(({ event }) => {
      if (seenEventIds.has(event.id)) {
        quarantined.push({
          kind: "duplicate-event",
          id: event.id,
          reason: "A later event snapshot reused an existing step id and was excluded from the projection.",
        });
        return [];
      }
      seenEventIds.add(event.id);
      return [event];
    });
  const explicitRefs = selectExplicitArtifactRefs(options.artifactRefs ?? []);
  const artifacts: RunArtifactRef[] = [];
  const steps = sortedEvents.map<RunStepView>((event, ordinal) => {
    const stepArtifacts = projectEventArtifacts(event, explicitRefs, quarantined);
    artifacts.push(...stepArtifacts);
    return {
      id: event.id,
      eventId: event.id,
      runId: event.runId,
      ordinal,
      stage: event.stage,
      actor: event.actor,
      title: event.title,
      summary: event.summary,
      status: event.status,
      tool: event.tool,
      createdAt: event.createdAt,
      completedAt: event.completedAt,
      artifactIds: stepArtifacts.map((artifact) => artifact.id),
    };
  });
  const stepIds = new Set(steps.map((step) => step.id));
  const artifactEdgeCandidates = artifacts
    .filter((artifact): artifact is RunArtifactRef & { sourceStepId: string } => Boolean(artifact.sourceStepId))
    .flatMap<RunTopologyEdge>((artifact) => {
      if (!stepIds.has(artifact.sourceStepId) || artifact.sourceStepId === artifact.stepId) {
        quarantined.push({
          kind: "artifact-edge",
          id: artifact.id,
          reason: !stepIds.has(artifact.sourceStepId)
            ? "The declared source step is not present in this run projection."
            : "A step cannot declare itself as the source of an artifact input.",
        });
        return [];
      }
      return [{
        id: `artifact:${artifact.id}:${artifact.sourceStepId}->${artifact.stepId}`,
        kind: "artifact",
        sourceStepId: artifact.sourceStepId,
        targetStepId: artifact.stepId,
        sourceRunId: eventRunId(sortedEvents, artifact.sourceStepId),
        targetRunId: artifact.runId,
        artifactId: artifact.id,
        locator: artifact.locator,
      }];
    })
    .sort(compareEdges);
  const artifactEdges: RunTopologyEdge[] = [];
  for (const edge of artifactEdgeCandidates) {
    if (wouldCreateCycle(artifactEdges, edge)) {
      quarantined.push({
        kind: "artifact-edge",
        id: edge.artifactId ?? edge.id,
        reason: "The declared artifact relationship would create a cycle and was excluded.",
      });
      continue;
    }
    artifactEdges.push(edge);
  }
  const forkEdges = (options.forkRefs ?? [])
    .flatMap<RunTopologyEdge>((fork) => {
      if (!stepIds.has(fork.targetStepId)
        || (fork.sourceRunId === fork.targetRunId && fork.sourceStepId === fork.targetStepId)) {
        quarantined.push({
          kind: "fork-edge",
          id: fork.id,
          reason: !stepIds.has(fork.targetStepId)
            ? "The fork target step is not present in this run projection."
            : "A fork cannot target its own source step.",
        });
        return [];
      }
      return [{
        id: `fork:${fork.id}`,
        kind: "fork",
        sourceStepId: fork.sourceStepId,
        targetStepId: fork.targetStepId,
        sourceRunId: fork.sourceRunId,
        targetRunId: fork.targetRunId,
      }];
    });

  return {
    steps,
    artifacts,
    topologyEdges: [...artifactEdges, ...forkEdges].sort(compareEdges),
    quarantined,
  };
}

function projectEventArtifacts(
  event: AgentRunEvent,
  explicitRefs: ReadonlyMap<string, PersistedRunArtifactRef>,
  quarantined: RunProjectionQuarantine[],
): RunArtifactRef[] {
  const artifactGroups: Array<[RunArtifactRole, readonly string[]]> = [
    ["input", event.inputProvenance],
    ["output", event.outputArtifacts],
    ["evidence", event.evidenceIds],
  ];

  return artifactGroups.flatMap(([role, locators]) => locators.map((locator, index) => {
    const candidate = explicitRefs.get(artifactSlot(event.id, role, index));
    const explicit = candidate?.locator === locator ? candidate : undefined;
    if (candidate && !explicit) {
      quarantined.push({
        kind: "artifact-reference",
        id: candidate.id,
        reason: "The persisted artifact locator does not match its exact event slot.",
      });
    }
    return {
      id: explicit?.id ?? `${event.id}:${role}:${index}`,
      stepId: event.id,
      runId: event.runId,
      role,
      index,
      locator,
      binding: explicit
        ? isDigestBound(explicit) ? "digest-bound" : "declared"
        : "unbound",
      sourceStepId: explicit?.sourceStepId,
      sha256: explicit?.sha256,
      sizeBytes: explicit?.sizeBytes,
    } satisfies RunArtifactRef;
  }));
}

function selectExplicitArtifactRefs(
  references: readonly PersistedRunArtifactRef[],
): ReadonlyMap<string, PersistedRunArtifactRef> {
  const selected = new Map<string, PersistedRunArtifactRef>();
  for (const reference of [...references].sort((left, right) => compareText(left.id, right.id))) {
    const slot = artifactSlot(reference.stepId, reference.role, reference.index);
    if (!selected.has(slot)) {
      selected.set(slot, reference);
    }
  }
  return selected;
}

function artifactSlot(stepId: string, role: RunArtifactRole, index: number): string {
  return `${stepId}\u0000${role}\u0000${index}`;
}

function compareEvents(left: AgentRunEvent, right: AgentRunEvent): number {
  return compareTimestamps(left.createdAt, right.createdAt);
}

function compareTimestamps(left: string, right: string): number {
  const leftMillis = Date.parse(left);
  const rightMillis = Date.parse(right);
  if (Number.isFinite(leftMillis) && Number.isFinite(rightMillis)) {
    return leftMillis - rightMillis;
  }
  if (Number.isFinite(leftMillis)) return -1;
  if (Number.isFinite(rightMillis)) return 1;
  return compareText(left, right);
}

function compareEdges(left: RunTopologyEdge, right: RunTopologyEdge): number {
  return compareText(left.targetRunId ?? "", right.targetRunId ?? "")
    || compareText(left.targetStepId, right.targetStepId)
    || compareText(left.kind, right.kind)
    || compareText(left.id, right.id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function eventRunId(events: readonly AgentRunEvent[], stepId: string): string | undefined {
  return events.find((event) => event.id === stepId)?.runId;
}

function isDigestBound(reference: PersistedRunArtifactRef): boolean {
  return typeof reference.sha256 === "string"
    && /^[a-f0-9]{64}$/.test(reference.sha256)
    && typeof reference.sizeBytes === "number"
    && Number.isSafeInteger(reference.sizeBytes)
    && reference.sizeBytes >= 0;
}

function wouldCreateCycle(existing: readonly RunTopologyEdge[], candidate: RunTopologyEdge): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of existing) {
    const targets = outgoing.get(edge.sourceStepId) ?? [];
    targets.push(edge.targetStepId);
    outgoing.set(edge.sourceStepId, targets);
  }
  const pending = [candidate.targetStepId];
  const visited = new Set<string>();
  while (pending.length) {
    const stepId = pending.pop()!;
    if (stepId === candidate.sourceStepId) return true;
    if (visited.has(stepId)) continue;
    visited.add(stepId);
    pending.push(...(outgoing.get(stepId) ?? []));
  }
  return false;
}
