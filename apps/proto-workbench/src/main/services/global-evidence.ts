import { createHash } from "node:crypto";
import type {
  AgentRunEvent,
  AgentStage,
  GlobalEvidenceBinding,
  GlobalEvidenceHit,
  GlobalEvidenceKind,
  GlobalEvidenceSearchRequest,
  GlobalEvidenceSearchResult,
  RunDetail,
  RunLifecycleState,
} from "../../shared/contracts.ts";

export const GLOBAL_EVIDENCE_LIMITS = {
  runScan: 100,
  eventsPerRun: 250,
  artifactsPerRun: 200,
  claimsPerRun: 100,
  checkpointsPerRun: 50,
  approvalsPerRun: 100,
  commentsPerRun: 100,
  queryCharacters: 160,
  hitsPerPage: 50,
} as const;

const EVIDENCE_KINDS: GlobalEvidenceKind[] = ["run", "event", "artifact", "claim", "checkpoint", "approval", "comment"];
const RUN_STATES: RunLifecycleState[] = [
  "pending", "running", "waiting-tool-approval", "waiting-patch-review", "applying-patch", "validating",
  "review-required", "ready-for-approval", "approved", "completed", "failed", "cancelled", "interrupted", "effect-unknown",
];
const STAGES: AgentStage[] = ["goal", "plan", "design", "validate", "review"];
const BINDINGS: GlobalEvidenceBinding[] = ["content-addressed", "revision-bound", "recorded-locator"];

interface NormalizedRequest {
  query: string;
  kinds: GlobalEvidenceKind[];
  lifecycleStates: RunLifecycleState[];
  stages: AgentStage[];
  exactRunId?: string;
  includeArchived: boolean;
  limit: number;
  cursor?: string;
}

interface ScoredHit {
  hit: GlobalEvidenceHit;
  score: number;
}

export function buildGlobalEvidenceSearch(
  runDetails: RunDetail[],
  input: GlobalEvidenceSearchRequest = {},
  issuedAt = new Date().toISOString(),
): GlobalEvidenceSearchResult {
  if (!validTimestamp(issuedAt)) throw new Error("The Global Evidence timestamp is invalid.");
  const request = normalizeRequest(input);
  const visible = [...runDetails]
    .filter((detail) => request.includeArchived || !detail.summary.archived)
    .filter((detail) => !request.exactRunId || detail.summary.runId === request.exactRunId)
    .sort((left, right) => right.summary.createdAt.localeCompare(left.summary.createdAt)
      || left.summary.runId.localeCompare(right.summary.runId))
    .slice(0, GLOBAL_EVIDENCE_LIMITS.runScan);
  const indexed = visible.flatMap(indexRunDetail);
  const catalogDigest = sha256(stableJson({
    schema: "proto-workbench.global-evidence-catalog.v1",
    runs: visible.map((detail) => ({ runId: detail.summary.runId, revision: detail.revision })),
    itemDigests: indexed.map((item) => item.digest),
  }));
  const queryMatched = indexed
    .map((hit) => ({ hit, score: matchScore(hit, request.query) }))
    .filter((item): item is ScoredHit => item.score >= 0);
  const facets = buildFacets(queryMatched.map((item) => item.hit));
  const filtered = queryMatched
    .filter(({ hit }) => request.kinds.length === 0 || request.kinds.includes(hit.kind))
    .filter(({ hit }) => request.lifecycleStates.length === 0 || request.lifecycleStates.includes(hit.lifecycleState))
    .filter(({ hit }) => request.stages.length === 0 || (hit.stage && request.stages.includes(hit.stage)))
    .sort(compareScoredHits);
  const requestDigest = sha256(stableJson({
    query: request.query,
    kinds: request.kinds,
    lifecycleStates: request.lifecycleStates,
    stages: request.stages,
    exactRunId: request.exactRunId,
    includeArchived: request.includeArchived,
    limit: request.limit,
  }));
  const offset = request.cursor ? decodeCursor(request.cursor, catalogDigest, requestDigest) : 0;
  if (offset > filtered.length) throw new Error("The Global Evidence cursor is outside the current result set.");
  const hits = filtered.slice(offset, offset + request.limit).map((item) => item.hit);
  const nextOffset = offset + hits.length;
  const nextCursor = nextOffset < filtered.length ? encodeCursor(catalogDigest, requestDigest, nextOffset) : undefined;
  const body = {
    schema: "proto-workbench.global-evidence.v1" as const,
    catalogDigest,
    query: request.query,
    sourceRunCount: visible.length,
    indexedItemCount: indexed.length,
    totalHits: filtered.length,
    returnedCount: hits.length,
    truncated: Boolean(nextCursor),
    nextCursor,
    hits,
    facets,
    limits: GLOBAL_EVIDENCE_LIMITS,
  };
  return { ...body, digest: sha256(stableJson(body)), issuedAt };
}

function indexRunDetail(detail: RunDetail): GlobalEvidenceHit[] {
  const hits: GlobalEvidenceHit[] = [];
  const historyByEvent = latestHistoryByEvent(detail);
  const runEvidenceDigest = validSha256(detail.historyHead.entrySha256) ? detail.historyHead.entrySha256 : undefined;
  hits.push(contentAddressedHit(detail, {
    id: `run:${detail.summary.runId}`,
    kind: "run",
    binding: runEvidenceDigest ? "content-addressed" : "revision-bound",
    evidenceDigest: runEvidenceDigest,
    title: detail.summary.title,
    summary: detail.summary.lifecycle.detail,
    status: detail.summary.lifecycle.state,
    occurredAt: detail.summary.createdAt,
    tags: ["run", detail.summary.lifecycle.attention, detail.summary.archived ? "archived" : "active"],
    target: { view: "runs", evidenceTab: "timeline" },
  }));

  const events = [...detail.events]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .slice(-GLOBAL_EVIDENCE_LIMITS.eventsPerRun);
  for (const event of events) {
    const revision = historyByEvent.get(event.id);
    const evidenceDigest = revision && validSha256(revision.snapshotSha256) ? revision.snapshotSha256 : undefined;
    hits.push(contentAddressedHit(detail, {
      id: `event:${detail.summary.runId}:${event.id}`,
      kind: "event",
      binding: evidenceDigest ? "content-addressed" : "revision-bound",
      evidenceDigest,
      title: event.title,
      summary: event.summary,
      status: event.status,
      occurredAt: event.completedAt ?? event.createdAt,
      stage: event.stage,
      actor: event.actor,
      tags: ["event", event.stage, event.actor, event.status, event.tool ?? "", ...event.evidenceIds.slice(0, 6)],
      target: { view: "runs", evidenceTab: "timeline", eventId: event.id },
    }));
  }

  const artifactCandidates = events.flatMap((event) => [
    ...event.inputProvenance.map((locator, index) => ({ event, locator, role: "input", index })),
    ...event.outputArtifacts.map((locator, index) => ({ event, locator, role: "output", index })),
    ...event.evidenceIds.map((locator, index) => ({ event, locator, role: "evidence", index })),
  ]).slice(-GLOBAL_EVIDENCE_LIMITS.artifactsPerRun);
  for (const { event, locator, role, index } of artifactCandidates) {
    hits.push(contentAddressedHit(detail, {
      id: `artifact:${detail.summary.runId}:${event.id}:${role}:${index}`,
      kind: "artifact",
      binding: "recorded-locator",
      title: shortLocator(locator),
      summary: `${capitalize(role)} reference recorded by ${event.title}. Current bytes remain outside this historical binding.`,
      status: event.status,
      occurredAt: event.completedAt ?? event.createdAt,
      stage: event.stage,
      actor: event.actor,
      locator,
      tags: ["artifact", role, event.stage, event.status],
      target: {
        view: "runs",
        evidenceTab: "artifacts",
        eventId: event.id,
        artifactLocator: role === "evidence" ? undefined : locator,
      },
    }));
  }

  for (const claim of detail.review.claims.slice(0, GLOBAL_EVIDENCE_LIMITS.claimsPerRun)) {
    const evidenceDigest = validSha256(detail.review.packetSha256) ? detail.review.packetSha256 : undefined;
    hits.push(contentAddressedHit(detail, {
      id: `claim:${detail.summary.runId}:${claim.id}`,
      kind: "claim",
      binding: evidenceDigest ? "content-addressed" : "revision-bound",
      evidenceDigest,
      title: claim.claim,
      summary: claim.evidence.length ? `Evidence: ${claim.evidence.join(", ")}` : "No evidence reference is recorded for this claim.",
      status: claim.status,
      occurredAt: detail.snapshotAt,
      stage: "review",
      tags: ["claim", claim.status, ...claim.evidence.slice(0, 6)],
      target: { view: "reviews" },
    }));
  }

  for (const checkpoint of [...detail.taskCheckpoints]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, GLOBAL_EVIDENCE_LIMITS.checkpointsPerRun)) {
    const eventId = [...detail.eventHistory]
      .filter((revision) => revision.sequence <= checkpoint.historyHead.sequence)
      .sort((left, right) => right.sequence - left.sequence)[0]?.eventId;
    hits.push(contentAddressedHit(detail, {
      id: `checkpoint:${detail.summary.runId}:${checkpoint.id}`,
      kind: "checkpoint",
      binding: "content-addressed",
      evidenceDigest: checkpoint.snapshotDigest,
      title: checkpoint.missionRecipe?.title ?? "Immutable task checkpoint",
      summary: `History boundary ${checkpoint.historyHead.sequence} · ${checkpoint.messages.length} messages · ${checkpoint.artifactRefs.length} artifact refs.`,
      status: checkpoint.missionRecipe ? `${checkpoint.missionRecipe.mode} recipe` : "legacy checkpoint",
      occurredAt: checkpoint.createdAt,
      tags: ["checkpoint", checkpoint.missionRecipe?.mode ?? "legacy", checkpoint.workspaceIdentity],
      target: { view: "runs", evidenceTab: "timeline", eventId },
    }));
  }

  for (const approval of [...detail.approvals]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, GLOBAL_EVIDENCE_LIMITS.approvalsPerRun)) {
    const evidenceDigest = validSha256(approval.argumentsSha256) ? approval.argumentsSha256 : undefined;
    hits.push(contentAddressedHit(detail, {
      id: `approval:${detail.summary.runId}:${approval.id}`,
      kind: "approval",
      binding: evidenceDigest ? "content-addressed" : "revision-bound",
      evidenceDigest,
      title: approval.tool,
      summary: `${approval.risk.replaceAll("-", " ")} request · arguments redacted from the global index.`,
      status: approval.status,
      occurredAt: approval.decidedAt ?? approval.createdAt,
      tags: ["approval", approval.risk, approval.status, approval.tool],
      target: { view: "runs", evidenceTab: "timeline", eventId: approval.executionEventId },
    }));
  }

  for (const comment of [...detail.comments]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, GLOBAL_EVIDENCE_LIMITS.commentsPerRun)) {
    hits.push(contentAddressedHit(detail, {
      id: `comment:${detail.summary.runId}:${comment.id}`,
      kind: "comment",
      binding: "revision-bound",
      title: "Human review comment",
      summary: comment.comment,
      status: "recorded",
      occurredAt: comment.createdAt,
      stage: "review",
      tags: ["comment", "human-review"],
      target: { view: "reviews" },
    }));
  }
  return hits;
}

function contentAddressedHit(
  detail: RunDetail,
  input: Omit<GlobalEvidenceHit, "digest" | "runId" | "runTitle" | "runCreatedAt" | "snapshotRevision" | "lifecycleState">,
): GlobalEvidenceHit {
  const body = {
    ...input,
    title: displayText(input.title, 240),
    summary: displayText(input.summary, 600),
    occurredAt: validTimestamp(input.occurredAt) ? input.occurredAt : detail.summary.createdAt,
    locator: input.locator ? displayText(input.locator, 4_096) : undefined,
    tags: uniqueStrings(input.tags, 12, 256),
    runId: detail.summary.runId,
    runTitle: detail.summary.title,
    runCreatedAt: detail.summary.createdAt,
    snapshotRevision: detail.revision,
    lifecycleState: detail.summary.lifecycle.state,
  };
  return { ...body, digest: sha256(stableJson(body)) };
}

function latestHistoryByEvent(detail: RunDetail) {
  const selected = new Map<string, RunDetail["eventHistory"][number]>();
  for (const revision of detail.eventHistory) {
    const current = selected.get(revision.eventId);
    if (!current || revision.eventRevision > current.eventRevision
      || (revision.eventRevision === current.eventRevision && revision.sequence > current.sequence)) {
      selected.set(revision.eventId, revision);
    }
  }
  return selected;
}

function buildFacets(hits: GlobalEvidenceHit[]): GlobalEvidenceSearchResult["facets"] {
  const kinds = Object.fromEntries(EVIDENCE_KINDS.map((kind) => [kind, 0])) as Record<GlobalEvidenceKind, number>;
  const lifecycleStates: Partial<Record<RunLifecycleState, number>> = {};
  const stages = Object.fromEntries(STAGES.map((stage) => [stage, 0])) as Record<AgentStage, number>;
  const bindings = Object.fromEntries(BINDINGS.map((binding) => [binding, 0])) as Record<GlobalEvidenceBinding, number>;
  for (const hit of hits) {
    kinds[hit.kind] += 1;
    lifecycleStates[hit.lifecycleState] = (lifecycleStates[hit.lifecycleState] ?? 0) + 1;
    if (hit.stage) stages[hit.stage] += 1;
    bindings[hit.binding] += 1;
  }
  return { kinds, lifecycleStates, stages, bindings };
}

function normalizeRequest(input: GlobalEvidenceSearchRequest): NormalizedRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("The Global Evidence request is invalid.");
  const query = input.query === undefined ? "" : boundedText(input.query, GLOBAL_EVIDENCE_LIMITS.queryCharacters).trim();
  const kinds = normalizeEnumArray(input.kinds, EVIDENCE_KINDS, "kind");
  const lifecycleStates = normalizeEnumArray(input.lifecycleStates, RUN_STATES, "lifecycle state");
  const stages = normalizeEnumArray(input.stages, STAGES, "stage");
  const exactRunId = input.exactRunId === undefined ? undefined : boundedText(input.exactRunId, 128).trim();
  if (input.exactRunId !== undefined && !exactRunId) throw new Error("The exact run ID is invalid.");
  const limit = input.limit === undefined ? 24 : input.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > GLOBAL_EVIDENCE_LIMITS.hitsPerPage) {
    throw new Error(`Global Evidence limit must be between 1 and ${GLOBAL_EVIDENCE_LIMITS.hitsPerPage}.`);
  }
  const cursor = input.cursor === undefined ? undefined : boundedText(input.cursor, 512).trim();
  if (input.cursor !== undefined && !cursor) throw new Error("The Global Evidence cursor is invalid.");
  return {
    query,
    kinds,
    lifecycleStates,
    stages,
    exactRunId,
    includeArchived: Boolean(input.includeArchived),
    limit,
    cursor,
  };
}

function normalizeEnumArray<T extends string>(value: T[] | undefined, allowed: readonly T[], label: string): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > allowed.length || value.some((item) => !allowed.includes(item))) {
    throw new Error(`Global Evidence ${label} filter is invalid.`);
  }
  return [...new Set(value)].sort((left, right) => allowed.indexOf(left) - allowed.indexOf(right));
}

function matchScore(hit: GlobalEvidenceHit, query: string): number {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;
  const tokens = normalizedQuery.split(/\s+/u).filter(Boolean).slice(0, 16);
  const title = normalizeSearchText(hit.title);
  const runTitle = normalizeSearchText(hit.runTitle);
  const runId = normalizeSearchText(hit.runId);
  const locator = normalizeSearchText(hit.locator ?? "");
  const corpus = normalizeSearchText([
    hit.kind, hit.binding, hit.title, hit.summary, hit.status, hit.runId, hit.runTitle,
    hit.lifecycleState, hit.stage ?? "", hit.actor ?? "", hit.locator ?? "", hit.evidenceDigest ?? "", ...hit.tags,
  ].join(" "));
  if (!tokens.every((token) => corpus.includes(token))) return -1;
  let score = tokens.length * 10;
  if (title === normalizedQuery) score += 1_000;
  else if (title.startsWith(normalizedQuery)) score += 600;
  else if (title.includes(normalizedQuery)) score += 400;
  if (runId === normalizedQuery) score += 900;
  else if (runId.startsWith(normalizedQuery)) score += 450;
  if (locator === normalizedQuery) score += 850;
  else if (locator.endsWith(normalizedQuery)) score += 350;
  if (runTitle === normalizedQuery) score += 700;
  else if (runTitle.includes(normalizedQuery)) score += 300;
  return score;
}

function compareScoredHits(left: ScoredHit, right: ScoredHit): number {
  return right.score - left.score
    || right.hit.occurredAt.localeCompare(left.hit.occurredAt)
    || EVIDENCE_KINDS.indexOf(left.hit.kind) - EVIDENCE_KINDS.indexOf(right.hit.kind)
    || left.hit.id.localeCompare(right.hit.id);
}

function encodeCursor(catalogDigest: string, requestDigest: string, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, catalogDigest, requestDigest, offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, catalogDigest: string, requestDigest: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.v !== 1 || parsed.catalogDigest !== catalogDigest || parsed.requestDigest !== requestDigest
      || !Number.isInteger(parsed.offset) || Number(parsed.offset) < 1 || Number(parsed.offset) > 1_000_000) {
      throw new Error("stale");
    }
    return Number(parsed.offset);
  } catch {
    throw new Error("The Global Evidence cursor is invalid or stale; refresh the search.");
  }
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum) throw new Error(`Global Evidence text exceeds ${maximum} characters.`);
  return value.normalize("NFKC");
}

function uniqueStrings(values: string[], maximum: number, characters: number): string[] {
  return [...new Set(values.filter(Boolean).map((value) => displayText(value, characters)))].slice(0, maximum);
}

function displayText(value: string, maximum: number): string {
  const normalized = value.normalize("NFKC");
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, Math.max(0, maximum - 1))}…`;
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function shortLocator(locator: string): string {
  const normalized = locator.replaceAll("\\", "/");
  return displayText(normalized.split("/").filter(Boolean).at(-1) ?? normalized, 240);
}

function capitalize(value: string): string {
  return value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
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
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sortValue(item)]));
}
