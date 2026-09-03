import type {
  AgentRunEvent,
  AgentThread,
  AppSettings,
  AppSettingsUpdate,
  ChatAttachment,
  ChatMessage,
  DecisionBundleExportReceipt,
  DecisionBundleExportRequest,
  DecisionBundlePreview,
  DecisionBundleRequest,
  DecisionBundleVerificationCatalog,
  DecisionBundleVerificationCheck,
  DecisionBundleVerificationEntry,
  FileCheckpoint,
  GlobalEvidenceHit,
  GlobalEvidenceKind,
  GlobalEvidenceSearchRequest,
  GlobalEvidenceSearchResult,
  ModelDescriptor,
  MissionPreflight,
  MissionPreflightRequest,
  PolicySimulationDelta,
  PolicySimulationReport,
  PolicySimulationRequest,
  PolicySimulationScenario,
  PolicySimulationScenarioId,
  MissionCapabilitySnapshot,
  OperatorAttentionItem,
  OperatorCockpitProjection,
  MaterialsFacets,
  MaterialsMaterializeRequest,
  MaterialsReviewInput,
  MaterialsStatus,
  PatchOperation,
  PatchProposal,
  ResidencyPolicy,
  ReviewPacketView,
  ResumeContract,
  RunCheckpoint,
  RunFork,
  RunForkResult,
  RunDetail,
  SignatureEvidenceCatalog,
  SignatureEvidenceCheck,
  SignatureEvidenceEntry,
  SignatureEvidenceImportReceipt,
  StreamEvent,
  ToolApproval,
  TrustPolicyCatalog,
  TrustPolicyCatalogEntry,
  TrustPolicyExportReceipt,
  TrustPolicyExportRequest,
  TrustPolicyPreview,
  TrustPolicyRequest,
  TrustRootLifecycleCatalog,
  TrustRootLifecycleCheck,
  TrustRootLifecycleEntry,
  TrustRootLifecycleImportReceipt,
  TransparencyWitnessCatalog,
  TransparencyWitnessCheck,
  TransparencyWitnessEntry,
  TransparencyWitnessImportReceipt,
  ValidationJournalSnapshot,
  WorkbenchApi,
} from "../shared/contracts.ts";
import { CORE_MODULES, OPTIONAL_MODULES } from "../shared/modules.ts";
import {
  emptyReview,
  lifecycleEventStatus,
  projectRunLifecycle,
  runAllowedActions,
  runDetailRevision,
} from "../shared/run-lifecycle.ts";
import type {
  PersistedRunArtifactRef,
  RunExecutionProjectionOptions,
} from "../shared/run-execution.ts";
/**
 * Keep the preview-only fixture module out of packaged renderer bundles.
 * `import.meta.glob(..., { eager: true })` is folded away by Vite for the
 * production build because this branch is guarded by the compile-time DEV
 * flag. The development preview remains synchronous for fixture-only UI tests.
 */
type DemoDataModule = typeof import("./demo-data.ts");
const previewDataModule = import.meta.env.DEV
  ? Object.values(import.meta.glob<DemoDataModule>("./demo-data.ts", { eager: true }))[0]
  : undefined;
const DEMO_EVENTS = (previewDataModule?.DEMO_EVENTS ?? []) as DemoDataModule["DEMO_EVENTS"];
const DEMO_MODELS = (previewDataModule?.DEMO_MODELS ?? []) as DemoDataModule["DEMO_MODELS"];
const DEMO_PATCH = previewDataModule?.DEMO_PATCH as DemoDataModule["DEMO_PATCH"];
const DEMO_REVIEW = previewDataModule?.DEMO_REVIEW as DemoDataModule["DEMO_REVIEW"];
const DEMO_RUNS = (previewDataModule?.DEMO_RUNS ?? []) as DemoDataModule["DEMO_RUNS"];
const DEMO_SETTINGS = previewDataModule?.DEMO_SETTINGS as DemoDataModule["DEMO_SETTINGS"];

const DEMO_DESIGN_IR = {
  schema_version: "proto-agent.ir.v1",
  design_id: "toggle_switch_v1",
  chassis: "ecoli_k12",
  constructs: [
    {
      name: "repressor_a_unit",
      parts: [
        { type: "promoter", id: "pLac", name: "Mock lac-regulated promoter", sequence: "TTGACATATAAT" },
        { type: "rbs", id: "B0034", name: "Mock ribosome binding site", sequence: "AAAGAGGAGAAA" },
        { type: "cds", id: "tetR", name: "Mock TetR coding placeholder", sequence: "ATGGCTGCTGCTTAA" },
        { type: "terminator", id: "B0015", name: "Mock double terminator", sequence: "CCGCTTAAAGCGG" },
      ],
    },
    {
      name: "reporter_unit",
      topology: "circular",
      parts: [
        { type: "promoter", id: "pTet", name: "Mock tet-regulated promoter", sequence: "TTGACAAGCTTATAAT" },
        { type: "rbs", id: "B0034", name: "Mock ribosome binding site", sequence: "AAAGAGGAGAAA" },
        { type: "cds", id: "gfp_mock", name: "Mock GFP coding placeholder", sequence: "ATGAAAGCTGCTTAA" },
        { type: "terminator", id: "B0015", name: "Mock double terminator", sequence: "CCGCTTAAAGCGG" },
      ],
      annotations: [{
        id: "preview_origin_region",
        name: "Development fixture: origin-spanning review region",
        type: "misc_feature",
        direction: "forward",
        segments: [{ start: 50, end: 56 }, { start: 0, end: 5 }],
      }, {
        id: "preview_segmented_region",
        name: "Development fixture: segmented review region",
        type: "misc_feature",
        segments: [{ start: 8, end: 14 }, { start: 24, end: 29 }],
      }, {
        id: "preview_forward_primer",
        name: "Development fixture: declared forward primer binding",
        type: "primer",
        direction: "forward",
        segments: [{ start: 16, end: 28 }],
      }, {
        id: "preview_declared_orf",
        name: "Development fixture: declared reporter ORF",
        type: "orf",
        direction: "forward",
        segments: [{ start: 28, end: 43 }],
      }],
    },
  ],
  constraints: [
    { type: "avoid_restriction_site", enzyme: "BsaI" },
    { type: "gc_content", min: "0.35", max: "0.65" },
  ],
  provenance: { source: "designs\\toggle_switch.proto" },
};

const DEMO_RUN_MANIFEST = {
  schema_version: "proto-agent.run.v1",
  run_id: "preview-toggle-switch",
  created_at: "20260830T220000Z",
  inputs: { design: "designs\\toggle_switch.proto", parts: "parts\\ecoli_k12_library.json" },
  steps: [
    { id: "check", ok: true, required: true, skipped: false },
    { id: "compile", ok: true, required: true, skipped: false },
    { id: "sequence_validate", ok: true, required: true, skipped: false },
    { id: "review", ok: true, required: true, skipped: false },
  ],
  artifacts: ["build\\runs\\preview-toggle-switch\\toggle_switch.ir.json"],
  diagnostics: [],
  review_status: "human_review_required",
  summary: "Development fixture: software checks passed; human scientific review remains required.",
  ok: true,
};

const DEMO_DESIGN_IR_CONTENT = JSON.stringify(DEMO_DESIGN_IR, null, 2);
const DEMO_DESIGN_SHA256 = "d".repeat(64);
const DEMO_PROVENANCE = {
  schema_version: "proto-agent.provenance.v1",
  run_id: "preview-toggle-switch",
  created_at: "2026-08-30T22:00:00.000Z",
  subject: {
    name: "manifest",
    path: "runs/preview-toggle-switch/manifest.json",
    sha256: "e".repeat(64),
    size: JSON.stringify(DEMO_RUN_MANIFEST, null, 2).length,
  },
  materials: [],
  artifacts: [{
    name: "artifact:0",
    path: "runs/preview-toggle-switch/toggle_switch.ir.json",
    sha256: DEMO_DESIGN_SHA256,
    size: DEMO_DESIGN_IR_CONTENT.length,
  }],
  policy: { digest: "sha256", signature: "none" },
};

function createMockWorkbench(): WorkbenchApi {
let models = structuredClone(DEMO_MODELS);
let settings = structuredClone(DEMO_SETTINGS);
let review = structuredClone(DEMO_REVIEW);
let patch = structuredClone(DEMO_PATCH);
let patchOperation: PatchOperation | undefined;
let checkpoint: FileCheckpoint | undefined;
let runList = structuredClone(DEMO_RUNS);
const reviewComments = new Map<string, Array<{ id: number; runId: string; comment: string; createdAt: string }>>();
const threads: AgentThread[] = [];
const messages = new Map<string, ChatMessage[]>();
const modelListeners = new Set<(models: ModelDescriptor[]) => void>();
const streamListeners = new Set<(event: StreamEvent) => void>();
const taskCheckpoints = new Map<string, RunCheckpoint[]>();
const runForks = new Map<string, RunFork[]>();
const forkResultsByIdempotencyKey = new Map<string, RunForkResult>();
const forkThreadIds = new Set<string>();

function previewDigest(sequence: number): string {
  const alphabet = "0123456789abcdef";
  const seed = Math.abs(sequence) + 1;
  return Array.from({ length: 64 }, (_, index) => alphabet[(seed * 7 + index * 11) % alphabet.length]).join("");
}

function mockEventHistory(runId: string, events: AgentRunEvent[]) {
  return events.map((event, index) => ({
    historyId: `preview-history-${runId}-${index + 1}`,
    runId,
    eventId: event.id,
    sequence: index + 1,
    eventRevision: 1,
    stage: event.stage,
    status: event.status,
    rawPayload: JSON.stringify(event),
    createdAt: event.createdAt,
    recordedAt: event.completedAt ?? event.createdAt,
    snapshotSha256: previewDigest(index + 2),
    previousSha256: index === 0 ? "0".repeat(64) : previewDigest(index + 3),
    entrySha256: previewDigest(index + 4),
  }));
}

function mockValidationJournal(operation: PatchOperation): ValidationJournalSnapshot {
  const definitions = [
    { key: "design-approval", title: "Design approval", effect: "none" },
    { key: "proto-check", title: "Proto check", effect: "workspace-read" },
    { key: "proto-workflow", title: "Workflow packet", effect: "artifact-write" },
    { key: "artifact-boundary", title: "Workflow provenance verification", effect: "workspace-read" },
    { key: "review-packet", title: "Review packet", effect: "artifact-write" },
  ] as const;
  const completed = operation.state === "verified";
  const recoveryRequired = operation.state === "effect-unknown" || operation.state === "conflict";
  return {
    schema: "proto-workbench.validation-journal.v1",
    operationId: operation.id,
    patchId: operation.patchId,
    runId: operation.runId,
    planSha256: "7".repeat(64),
    state: completed ? "completed" : recoveryRequired ? "recovery-required" : operation.state === "validation-failed" ? "failed" : "running",
    revision: operation.revision,
    steps: definitions.map((definition, sequence) => ({
      ...definition,
      sequence,
      inputSha256: String(sequence + 1).repeat(64),
      state: completed ? "completed" : recoveryRequired && sequence === 2 ? "effect-unknown" : sequence < 2 ? "completed" : "pending",
      attempt: sequence < 3 || completed ? 1 : 0,
      eventId: sequence < 3 || completed ? `preview-validation-${sequence}` : undefined,
      eventIds: sequence < 3 || completed ? [`preview-validation-${sequence}`] : [],
      outputSha256: sequence < 3 || completed ? String(sequence + 5).repeat(64) : undefined,
      outputArtifacts: sequence === 2 && completed
        ? ["build/runs/preview-toggle-switch/manifest.json"]
        : sequence === 3 && completed
          ? ["build/runs/preview-toggle-switch/provenance.json"]
          : sequence === 4 && completed
            ? ["build/runs/preview-toggle-switch/review.json"]
            : [],
      evidenceIds: sequence < 3 || completed ? [`preview-evidence-${sequence}`] : [],
      startedAt: sequence < 3 || completed ? operation.validationStartedAt ?? operation.updatedAt : undefined,
      completedAt: sequence < 3 || completed ? operation.completedAt ?? operation.updatedAt : undefined,
      updatedAt: operation.updatedAt,
      error: recoveryRequired && sequence === 2 ? "The artifact-write completion record was not durable before restart." : undefined,
    })),
    nextStepKey: completed ? undefined : "proto-workflow",
    resumable: !completed && !recoveryRequired,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    snapshotAt: operation.updatedAt,
  };
}

function mockRunDetail(runId: string): RunDetail {
  const storedSummary = runList.find((run) => run.runId === runId) ?? runList[0];
  if (!storedSummary) throw new Error("Run not found");
  const events = structuredClone(DEMO_EVENTS).map((event) => ({ ...event, runId }));
  const patches = runId === patch.runId ? [structuredClone(patch)] : [];
  const runReview = runId === patch.runId ? { ...structuredClone(review), runId } : emptyReview(runId);
  if (runId !== patch.runId && events.length) events[events.length - 1]!.status = storedSummary.status;
  const approvals: ToolApproval[] = [];
  const patchOperations = runId === patch.runId && patchOperation ? [structuredClone(patchOperation)] : [];
  const validationJournals = patchOperations.map((operation) => mockValidationJournal(operation));
  if (patchOperations[0] && validationJournals[0]) {
    runReview.operationId = patchOperations[0].id;
    runReview.validationPlanSha256 = validationJournals[0].planSha256;
    runReview.validationJournalRevision = validationJournals[0].revision;
    runReview.packetSha256 = "9".repeat(64);
  }
  const checkpoints = runId === patch.runId && checkpoint ? [structuredClone(checkpoint)] : [];
  const comments = structuredClone(reviewComments.get(runId) ?? []);
  const eventHistory = mockEventHistory(runId, events);
  const historyHead = {
    sequence: eventHistory.at(-1)?.sequence ?? 0,
    entrySha256: eventHistory.at(-1)?.entrySha256 ?? "0".repeat(64),
  };
  const lifecycle = projectRunLifecycle({ events, patches, approvals, patchOperations, validationJournals, checkpoints, review: runReview });
  const summary = {
    ...storedSummary,
    status: lifecycleEventStatus(lifecycle),
    lifecycle,
  };
  const thread = threads.find((item) => item.workspacePath === settings.workspacePath && !forkThreadIds.has(item.id));
  return {
    revision: runDetailRevision({ events, patches, approvals, patchOperations, validationJournals, checkpoints, review: runReview, comments }),
    snapshotAt: new Date().toISOString(),
    summary,
    events,
    eventHistory,
    historyHead,
    taskCheckpoints: structuredClone(taskCheckpoints.get(runId) ?? []),
    runForks: structuredClone(runForks.get(runId) ?? []),
    patches,
    activePatch: patches.find((item) => item.status === "pending"),
    patchOperations,
    activePatchOperation: patchOperations[0],
    validationJournals,
    checkpoints,
    approvals,
    review: runReview,
    comments,
    threadId: thread?.id,
    workspacePath: settings.workspacePath,
    thread: thread ? structuredClone(thread) : undefined,
    messages: structuredClone(thread ? messages.get(thread.id) ?? [] : []),
    allowedActions: runAllowedActions({ events, patches, approvals, patchOperations, validationJournals, checkpoints, review: runReview }),
  };
}

function previewOperatorCockpit(): OperatorCockpitProjection {
  const visibleRuns = runList.filter((run) => !run.archived);
  const attentionItems: OperatorAttentionItem[] = visibleRuns
    .filter((run) => run.lifecycle.attention !== "none")
    .map((run, index) => {
      const attention = run.lifecycle.attention;
      const action = attention === "patch-review"
        ? { action: "review-patch" as const, actionLabel: "Review diff", target: "runs" as const }
        : attention === "tool-approval"
          ? { action: "review-tool" as const, actionLabel: "Review tool", target: "runs" as const }
          : attention === "human-review"
            ? { action: "review-human" as const, actionLabel: "Open review", target: "reviews" as const }
            : attention === "recovery"
              ? { action: "inspect-recovery" as const, actionLabel: "Inspect recovery", target: "runs" as const }
              : attention === "failure"
                ? { action: "inspect-failure" as const, actionLabel: "Inspect failure", target: "runs" as const }
                : { action: "open-run" as const, actionLabel: "Open run", target: "runs" as const };
      return {
        id: `attention:${run.runId}`,
        digest: previewDigest(40 + index),
        runId: run.runId,
        runTitle: run.title,
        runCreatedAt: run.createdAt,
        snapshotRevision: `preview:${run.runId}:${run.status}`,
        attention,
        priority: attention === "failure" || attention === "recovery"
          ? "critical"
          : attention === "tool-approval" || attention === "patch-review"
            ? "high"
            : attention === "validation" || attention === "patch-operation"
              ? "monitoring"
              : "normal",
        label: run.lifecycle.label,
        detail: run.lifecycle.detail,
        ...action,
      };
    });
  const checkpointEntries = [...taskCheckpoints.entries()].flatMap(([runId, checkpoints]) => checkpoints
    .filter((checkpoint) => checkpoint.missionRecipe)
    .map((checkpoint, index) => ({
      id: `checkpoint:${checkpoint.missionRecipe!.digest}`,
      digest: previewDigest(70 + index),
      source: "checkpoint" as const,
      title: checkpoint.missionRecipe!.title,
      summary: "Captured from an immutable task checkpoint. A fresh preflight is still required.",
      mode: checkpoint.missionRecipe!.mode,
      goal: checkpoint.missionRecipe!.goal,
      intent: checkpoint.missionRecipe!.intent,
      sourceRunId: runId,
      recipeDigest: checkpoint.missionRecipe!.digest,
      capturedAt: checkpoint.createdAt,
    })));
  return {
    schema: "proto-workbench.operator-cockpit.v1",
    digest: previewDigest(39),
    issuedAt: new Date().toISOString(),
    sourceRunCount: visibleRuns.length,
    attentionItems,
    attentionCounts: {
      total: attentionItems.length,
      approvals: attentionItems.filter((item) => ["tool-approval", "patch-review", "human-review"].includes(item.attention)).length,
      recovery: attentionItems.filter((item) => ["recovery", "failure"].includes(item.attention)).length,
      monitoring: attentionItems.filter((item) => ["patch-operation", "validation"].includes(item.attention)).length,
    },
    missionLibrary: [
      ...checkpointEntries.slice(0, 8),
      {
        id: "checkpoint:preview-saved-recovery",
        digest: previewDigest(71),
        source: "checkpoint",
        title: DEMO_RUNS[0]?.title ?? "Saved task recipe",
        summary: "Saved task recipe · fresh preflight required before launch.",
        mode: "act",
        goal: "Review the current run evidence, prepare a bounded improvement proposal, and keep every effect behind explicit approval.",
        intent: { network: false, writes: true, execution: false },
        sourceRunId: visibleRuns[0]?.runId,
        recipeDigest: previewDigest(72),
        capturedAt: "2026-07-12T07:18:34.000Z",
      },
      {
        id: "builtin:evidence-gap-map",
        digest: previewDigest(73),
        source: "builtin",
        title: "Evidence gap map",
        summary: "Inventory claims, assumptions, and missing support before proposing any effect.",
        mode: "plan",
        goal: "Map the evidence gaps for this workspace goal, list assumptions and unresolved questions, and prepare a review plan without changing files or running code.",
        intent: { network: false, writes: false, execution: false },
      },
      {
        id: "builtin:controlled-change",
        digest: previewDigest(74),
        source: "builtin",
        title: "Controlled change",
        summary: "Prepare a bounded diff and its validation path behind explicit review gates.",
        mode: "act",
        goal: "Review the requested workspace improvement, describe the intended diff and validation path, then propose only reviewable changes behind explicit approval gates.",
        intent: { network: false, writes: true, execution: false },
      },
      {
        id: "builtin:recovery-review",
        digest: previewDigest(75),
        source: "builtin",
        title: "Recovery review",
        summary: "Inspect durable evidence and recommend a next decision without replaying effects.",
        mode: "plan",
        goal: "Inspect the durable run evidence, identify interrupted or uncertain effects, and recommend the next recovery decision without replaying any side effect.",
        intent: { network: false, writes: false, execution: false },
      },
    ],
    limits: { runScan: 100, attentionItems: 24, checkpointRecipes: 8 },
  };
}

function previewGlobalEvidenceSearch(input: GlobalEvidenceSearchRequest): GlobalEvidenceSearchResult {
  const query = (input.query ?? "").normalize("NFKC").trim().toLocaleLowerCase();
  const tokens = query.split(/\s+/u).filter(Boolean);
  const visibleRuns = runList
    .filter((run) => input.includeArchived || !run.archived)
    .filter((run) => !input.exactRunId || run.runId === input.exactRunId);
  const hits: GlobalEvidenceHit[] = [];
  let sequence = 120;
  const add = (detail: RunDetail, hit: Omit<GlobalEvidenceHit, "digest" | "runId" | "runTitle" | "runCreatedAt" | "snapshotRevision" | "lifecycleState">) => {
    hits.push({
      ...hit,
      digest: previewDigest(sequence++),
      runId: detail.summary.runId,
      runTitle: detail.summary.title,
      runCreatedAt: detail.summary.createdAt,
      snapshotRevision: detail.revision,
      lifecycleState: detail.summary.lifecycle.state,
    });
  };
  for (const run of visibleRuns) {
    const detail = mockRunDetail(run.runId);
    add(detail, {
      id: `run:${run.runId}`,
      kind: "run",
      binding: "revision-bound",
      title: run.title,
      summary: run.lifecycle.detail,
      status: run.lifecycle.state,
      occurredAt: run.createdAt,
      tags: ["run", run.lifecycle.attention, run.archived ? "archived" : "active"],
      target: { view: "runs", evidenceTab: "timeline" },
    });
    for (const event of detail.events) {
      add(detail, {
        id: `event:${run.runId}:${event.id}`,
        kind: "event",
        binding: "content-addressed",
        evidenceDigest: detail.eventHistory.find((revision) => revision.eventId === event.id)?.snapshotSha256,
        title: event.title,
        summary: event.summary,
        status: event.status,
        occurredAt: event.completedAt ?? event.createdAt,
        stage: event.stage,
        actor: event.actor,
        tags: ["event", event.stage, event.actor, event.status, event.tool ?? ""].filter(Boolean),
        target: { view: "runs", evidenceTab: "timeline", eventId: event.id },
      });
      for (const [index, locator] of [...event.inputProvenance, ...event.outputArtifacts, ...event.evidenceIds].entries()) {
        add(detail, {
          id: `artifact:${run.runId}:${event.id}:${index}`,
          kind: "artifact",
          binding: "recorded-locator",
          title: locator.replaceAll("\\", "/").split("/").at(-1) ?? locator,
          summary: `Recorded by ${event.title}. Current bytes remain outside this historical binding.`,
          status: event.status,
          occurredAt: event.completedAt ?? event.createdAt,
          stage: event.stage,
          actor: event.actor,
          locator,
          tags: ["artifact", event.stage, event.status],
          target: { view: "runs", evidenceTab: "artifacts", eventId: event.id, artifactLocator: locator.includes(":") && !locator.includes("/") ? undefined : locator },
        });
      }
    }
    for (const claim of detail.review.claims) {
      add(detail, {
        id: `claim:${run.runId}:${claim.id}`,
        kind: "claim",
        binding: detail.review.packetSha256 ? "content-addressed" : "revision-bound",
        evidenceDigest: detail.review.packetSha256,
        title: claim.claim,
        summary: claim.evidence.length ? `Evidence: ${claim.evidence.join(", ")}` : "No evidence reference is recorded for this claim.",
        status: claim.status,
        occurredAt: detail.snapshotAt,
        stage: "review",
        tags: ["claim", claim.status, ...claim.evidence],
        target: { view: "reviews" },
      });
    }
    for (const checkpoint of detail.taskCheckpoints) {
      add(detail, {
        id: `checkpoint:${run.runId}:${checkpoint.id}`,
        kind: "checkpoint",
        binding: "content-addressed",
        evidenceDigest: checkpoint.snapshotDigest,
        title: checkpoint.missionRecipe?.title ?? "Immutable task checkpoint",
        summary: `History boundary ${checkpoint.historyHead.sequence} · ${checkpoint.messages.length} messages · ${checkpoint.artifactRefs.length} artifact refs.`,
        status: checkpoint.missionRecipe ? `${checkpoint.missionRecipe.mode} recipe` : "legacy checkpoint",
        occurredAt: checkpoint.createdAt,
        tags: ["checkpoint", checkpoint.missionRecipe?.mode ?? "legacy"],
        target: { view: "runs", evidenceTab: "timeline", eventId: detail.eventHistory.find((revision) => revision.sequence === checkpoint.historyHead.sequence)?.eventId },
      });
    }
    if (run.lifecycle.attention === "tool-approval") {
      add(detail, {
        id: `approval:${run.runId}:preview`,
        kind: "approval",
        binding: "content-addressed",
        evidenceDigest: previewDigest(sequence++),
        title: "proto_literature_search",
        summary: "Network request · arguments redacted from the global index.",
        status: "pending",
        occurredAt: run.createdAt,
        tags: ["approval", "network", "pending"],
        target: { view: "runs", evidenceTab: "timeline" },
      });
    }
    for (const comment of detail.comments) {
      add(detail, {
        id: `comment:${run.runId}:${comment.id}`,
        kind: "comment",
        binding: "revision-bound",
        title: "Human review comment",
        summary: comment.comment,
        status: "recorded",
        occurredAt: comment.createdAt,
        stage: "review",
        tags: ["comment", "human-review"],
        target: { view: "reviews" },
      });
    }
  }
  const queryMatches = hits.filter((hit) => {
    if (!tokens.length) return true;
    const corpus = [hit.kind, hit.title, hit.summary, hit.status, hit.runId, hit.runTitle, hit.locator ?? "", ...hit.tags].join(" ").toLocaleLowerCase();
    return tokens.every((token) => corpus.includes(token));
  });
  const kinds = Object.fromEntries((["run", "event", "artifact", "claim", "checkpoint", "approval", "comment"] as GlobalEvidenceKind[]).map((kind) => [kind, queryMatches.filter((hit) => hit.kind === kind).length])) as Record<GlobalEvidenceKind, number>;
  const lifecycleStates = Object.fromEntries([...new Set(queryMatches.map((hit) => hit.lifecycleState))].map((state) => [state, queryMatches.filter((hit) => hit.lifecycleState === state).length]));
  const stages = Object.fromEntries((["goal", "plan", "design", "validate", "review"] as const).map((stage) => [stage, queryMatches.filter((hit) => hit.stage === stage).length])) as GlobalEvidenceSearchResult["facets"]["stages"];
  const bindings = Object.fromEntries((["content-addressed", "revision-bound", "recorded-locator"] as const).map((binding) => [binding, queryMatches.filter((hit) => hit.binding === binding).length])) as GlobalEvidenceSearchResult["facets"]["bindings"];
  const filtered = queryMatches
    .filter((hit) => !input.kinds?.length || input.kinds.includes(hit.kind))
    .filter((hit) => !input.lifecycleStates?.length || input.lifecycleStates.includes(hit.lifecycleState))
    .filter((hit) => !input.stages?.length || (hit.stage && input.stages.includes(hit.stage)))
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || left.id.localeCompare(right.id));
  const limit = Math.max(1, Math.min(50, input.limit ?? 24));
  const cursorMatch = input.cursor?.match(/^preview:(\d+):(\d+)$/);
  const offset = cursorMatch && Number(cursorMatch[1]) === query.length ? Number(cursorMatch[2]) : 0;
  const page = filtered.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < filtered.length ? `preview:${query.length}:${nextOffset}` : undefined;
  return {
    schema: "proto-workbench.global-evidence.v1",
    catalogDigest: previewDigest(111),
    digest: previewDigest(112 + offset),
    issuedAt: new Date().toISOString(),
    query,
    sourceRunCount: visibleRuns.length,
    indexedItemCount: hits.length,
    totalHits: filtered.length,
    returnedCount: page.length,
    truncated: Boolean(nextCursor),
    nextCursor,
    hits: page,
    facets: { kinds, lifecycleStates, stages, bindings },
    limits: {
      runScan: 100,
      eventsPerRun: 250,
      artifactsPerRun: 200,
      claimsPerRun: 100,
      checkpointsPerRun: 50,
      approvalsPerRun: 100,
      commentsPerRun: 100,
      queryCharacters: 160,
      hitsPerPage: 50,
    },
  };
}

async function browserSha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function browserSha256Bytes(value: Uint8Array): Promise<string> {
  const bytes = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function downloadPreviewPayload(bytes: BlobPart, filename: string, mediaType: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

const PREVIEW_POLICY_SCENARIOS: Record<PolicySimulationScenarioId, { label: string; summary: string }> = {
  current: { label: "Current controls", summary: "Re-evaluate the exact current mission posture and trusted environment snapshot." },
  "plan-posture": { label: "Plan posture", summary: "Keep the same mission and environment, but defer workspace writes and code execution." },
  "act-posture": { label: "Act posture", summary: "Keep the same mission and environment, but expose effects to their dedicated approval gates." },
  "network-unavailable": { label: "Network unavailable", summary: "Remove live lookup tools and network paths without changing the mission text." },
  "execution-unavailable": { label: "Execution unavailable", summary: "Evaluate the mission with every code-execution provider unavailable." },
  "isolated-execution-ready": { label: "Pinned sandbox available", summary: "Model a digest-pinned OCI provider that is visible but still requires a fresh per-call approval." },
  "workspace-drift": { label: "Workspace trust drift", summary: "Model a sidecar bound to a different workspace with atomic replacement unavailable." },
  "model-chat-only": { label: "Chat-only model", summary: "Model the selected runtime as unable to issue structured agent tool calls." },
  "strict-lockdown": { label: "Strict lockdown", summary: "Remove live lookup, reviewed patch, and execution capabilities while retaining read-only inspection." },
};

async function previewPolicySimulation(
  input: PolicySimulationRequest,
  baseline: MissionPreflight,
): Promise<PolicySimulationReport> {
  const scenarioIds = ["current" as const, ...[...new Set(input.scenarioIds)].filter((id) => id !== "current")].slice(0, 9);
  const scenarios: PolicySimulationScenario[] = [];
  for (const id of scenarioIds) scenarios.push(await previewPolicyScenario(baseline, id));
  const digest = await browserSha256(JSON.stringify({
    schema: "proto-workbench.policy-simulation.v1",
    threadId: baseline.threadId,
    goalSha256: baseline.goalSha256,
    scenarios: scenarios.map((scenario) => [scenario.id, scenario.decisionDigest]),
  }));
  return {
    schema: "proto-workbench.policy-simulation.v1",
    digest,
    decisionId: `sim_${digest.slice(0, 24)}`,
    issuedAt: new Date().toISOString(),
    threadId: baseline.threadId,
    goalPreview: baseline.goalPreview,
    goalSha256: baseline.goalSha256,
    simulationOnly: true,
    executedEffects: [],
    baselineScenarioId: "current",
    scenarios,
    boundary: "Comparison only. No scenario can launch a model, call a tool, resolve an approval, access the network, execute code, or change a file.",
    limits: { maxGoalCharacters: 8_192, maxScenarios: 9 },
  };
}

async function previewPolicyScenario(
  baseline: MissionPreflight,
  id: PolicySimulationScenarioId,
): Promise<PolicySimulationScenario> {
  const definition = PREVIEW_POLICY_SCENARIOS[id];
  const requirements = structuredClone(baseline.requirements);
  const warnings = [...baseline.warnings];
  const setRequirement = (requirementId: MissionPreflight["requirements"][number]["id"], state: MissionPreflight["requirements"][number]["state"], detail: string) => {
    const requirement = requirements.find((item) => item.id === requirementId);
    if (requirement) Object.assign(requirement, { state, detail });
  };
  if (id === "plan-posture") {
    if (baseline.intent.writes) setRequirement("writes", "deferred", "Plan posture records workspace changes but cannot apply them.");
    if (baseline.intent.execution) setRequirement("execution", "deferred", "Plan posture records the execution need but cannot run code.");
  } else if (id === "act-posture") {
    if (baseline.intent.writes) setRequirement("writes", "approval-required", "Act posture may propose a diff; applying it still requires explicit review.");
    if (baseline.intent.execution) setRequirement("execution", "blocked", "The preview has no configured digest-pinned OCI sandbox.");
  } else if (id === "network-unavailable" && baseline.intent.network) {
    setRequirement("network", "blocked", "The simulation removed every live scientific lookup tool.");
  } else if (id === "execution-unavailable" && baseline.intent.execution) {
    setRequirement("execution", "blocked", "The simulation removed every configured execution provider.");
  } else if (id === "isolated-execution-ready" && baseline.intent.execution) {
    setRequirement("execution", "approval-required", "A hypothetical digest-pinned OCI provider is visible; execution still requires per-call approval.");
    warnings.push("The hypothetical OCI provider is not smoke-verified and cannot be used from Decision Lab.");
  } else if (id === "workspace-drift") {
    setRequirement("workspace", "blocked", "The hypothetical sidecar is bound to a different workspace and lacks atomic replacement.");
  } else if (id === "model-chat-only" && (baseline.intent.network || baseline.intent.writes || baseline.intent.execution)) {
    setRequirement("model", "blocked", "The hypothetical model is chat-only, but this mission requires agent tools.");
  } else if (id === "strict-lockdown") {
    if (baseline.intent.network) setRequirement("network", "blocked", "Strict lockdown removes live lookup tools.");
    if (baseline.intent.writes) setRequirement("writes", "blocked", "Strict lockdown removes the reviewed patch proposal boundary.");
    if (baseline.intent.execution) setRequirement("execution", "blocked", "Strict lockdown keeps code execution unavailable.");
    if (baseline.intent.network || baseline.intent.writes || baseline.intent.execution) setRequirement("model", "blocked", "Strict lockdown exposes the model as chat-only.");
  }
  const blocked = requirements.filter((requirement) => requirement.state === "blocked");
  const gated = requirements.filter((requirement) => requirement.state === "approval-required");
  const deferred = requirements.filter((requirement) => requirement.state === "deferred");
  const state = blocked.length ? "blocked" as const : gated.length ? "approval-required" as const : "ready" as const;
  const decisionDigest = await browserSha256(JSON.stringify({ id, baseline: baseline.digest, requirements: requirements.map(({ id: requirementId, state: requirementState }) => [requirementId, requirementState]) }));
  const deltas: PolicySimulationDelta[] = requirements.map((requirement) => {
    const before = baseline.requirements.find((item) => item.id === requirement.id)!;
    const rank = { blocked: 0, deferred: 1, "approval-required": 2, ready: 3 };
    const direction = before.state === requirement.state
      ? before.detail === requirement.detail ? "unchanged" as const : "posture-shift" as const
      : rank[requirement.state] < rank[before.state] ? "more-restrictive" as const : "less-restrictive" as const;
    return { requirementId: requirement.id, title: requirement.title, baselineState: before.state, scenarioState: requirement.state, direction, detail: requirement.detail };
  });
  const determining = blocked.length ? blocked : gated.length ? gated : deferred;
  return {
    id,
    label: definition.label,
    summary: definition.summary,
    hypothetical: id !== "current",
    decisionDigest,
    state,
    wouldBeLaunchable: blocked.length === 0,
    intent: baseline.intent,
    requirements,
    deltas,
    determiningRequirements: determining.map((requirement) => requirement.id),
    warnings,
    nextAction: id === "current" ? baseline.nextAction : "Review the changed requirements. This hypothetical result cannot be used as a launch or approval contract.",
  };
}

const previewDecisionBundleExports = new Map<string, { bundle: DecisionBundlePreview; receipt: DecisionBundleExportReceipt }>();

async function previewDecisionBundle(
  report: PolicySimulationReport,
  input: DecisionBundleRequest,
): Promise<DecisionBundlePreview> {
  if (report.digest !== input.expectedSimulationDigest) throw new Error("Decision Bundle simulation digest is stale; recompute the policy simulation.");
  const selected = report.scenarios.find((scenario) => scenario.id === input.selectedScenarioId);
  if (!selected) throw new Error("The selected Decision Bundle scenario is not present in the simulation.");
  const includeDetails = input.redaction === "include-goal-preview";
  const removed = [
    "/attestation/predicate/context/threadId",
    "/attestation/predicate/context/workspacePath",
    "/attestation/predicate/context/attachmentNames",
    "/attestation/predicate/context/attachmentPaths",
    "/attestation/predicate/context/modelPath",
    "/attestation/predicate/context/runtimePath",
    ...(!includeDetails ? [
      "/attestation/predicate/goal/preview",
      "/attestation/predicate/selectedScenario/requirements/*/detail",
      "/attestation/predicate/selectedScenario/deltas/*/detail",
      "/attestation/predicate/selectedScenario/warnings",
    ] : []),
  ];
  const content: Omit<DecisionBundlePreview, "bundleId" | "bundleDigest"> = {
    schema: "proto-workbench.decision-bundle.v1",
    mediaType: "application/vnd.proto-workbench.decision-bundle+json",
    fileName: "decision-bundle.json",
    attestation: {
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: "policy-simulation-report", digest: { sha256: report.digest } }],
      predicateType: "urn:proto-workbench:attestation:policy-simulation:v1",
      predicate: {
        simulation: { digest: report.digest, decisionId: report.decisionId, scenarioCount: report.scenarios.length, boundary: report.boundary, executedEffects: [] },
        goal: { sha256: report.goalSha256, preview: includeDetails ? report.goalPreview : null },
        context: { threadBindingSha256: await browserSha256(report.threadId), attachmentCount: input.attachments?.length ?? 0 },
        selectedScenario: {
          id: selected.id,
          label: selected.label,
          summary: selected.summary,
          hypothetical: selected.hypothetical,
          decisionDigest: selected.decisionDigest,
          state: selected.state,
          wouldBeLaunchable: selected.wouldBeLaunchable,
          determiningRequirements: [...selected.determiningRequirements],
          requirements: selected.requirements.map((requirement) => ({ id: requirement.id, title: requirement.title, state: requirement.state, ...(includeDetails ? { detail: requirement.detail } : {}) })),
          deltas: selected.deltas.map((delta) => ({ requirementId: delta.requirementId, title: delta.title, baselineState: delta.baselineState, scenarioState: delta.scenarioState, direction: delta.direction, ...(includeDetails ? { detail: delta.detail } : {}) })),
          warnings: includeDetails ? [...selected.warnings] : [],
          warningsRedactedCount: includeDetails ? 0 : selected.warnings.length,
        },
        scenarioMatrix: report.scenarios.map((scenario) => ({
          id: scenario.id,
          label: scenario.label,
          state: scenario.state,
          hypothetical: scenario.hypothetical,
          decisionDigest: scenario.decisionDigest,
          wouldBeLaunchable: scenario.wouldBeLaunchable,
          determiningRequirements: [...scenario.determiningRequirements],
        })),
        producer: { name: "Proto Workbench", version: "preview", moduleManifestSha256: previewDigest(113) },
      },
    },
    authentication: {
      status: "unsigned",
      envelope: "none",
      assurance: "content-digest-only",
      detail: "No DSSE or Sigstore envelope is present. Verify the SHA-256 content binding only; publisher identity is not established.",
    },
    redaction: { profile: input.redaction, removed, pathsAlwaysRedacted: true },
    boundary: "Audit artifact only. This unsigned bundle cannot start a model, call a tool, resolve an approval, replay a decision, access the network, execute code, or authorize a file effect.",
  };
  const bundleDigest = await browserSha256(JSON.stringify(content));
  return { ...content, bundleId: `db_${bundleDigest.slice(0, 24)}`, bundleDigest };
}

function previewVerificationChecks(overrides: Partial<Record<DecisionBundleVerificationCheck["id"], DecisionBundleVerificationCheck["state"]>> = {}): DecisionBundleVerificationCheck[] {
  const definitions: Array<[DecisionBundleVerificationCheck["id"], string]> = [
    ["directory", "Canonical directory"], ["entries", "Exact artifact set"], ["bundle-file", "Bounded bundle file"],
    ["checksum-file", "Bounded checksum file"], ["checksum-match", "Checksum match"], ["schema", "Supported canonical schema"],
    ["content-digest", "Content address"], ["subject-binding", "Simulation subject binding"],
  ];
  return definitions.map(([id, label]) => {
    const state = overrides[id] ?? "passed";
    return { id, label, state, detail: state === "passed" ? "Fixture check passed." : state === "failed" ? "Fixture check failed." : "Not reached." };
  });
}

async function previewDecisionBundleVerification(): Promise<DecisionBundleVerificationCatalog> {
  const exported: DecisionBundleVerificationEntry[] = [...previewDecisionBundleExports.values()].map(({ bundle, receipt }) => ({
    directoryName: bundle.bundleId,
    state: "content-verified",
    signatureStatus: "unsigned",
    identityAssurance: "not-verified",
    bundleId: bundle.bundleId,
    bundleDigest: bundle.bundleDigest,
    bundleSha256: receipt.bundleSha256,
    expectedBundleSha256: receipt.bundleSha256,
    sourceSimulationSha256: bundle.attestation.predicate.simulation.digest,
    relativePath: receipt.relativePath,
    checksumRelativePath: receipt.checksumRelativePath,
    bytes: receipt.bytes,
    observedModifiedAt: receipt.exportedAt,
    redaction: bundle.redaction.profile,
    goalPreviewIncluded: bundle.attestation.predicate.goal.preview !== null,
    scenarioCount: bundle.attestation.predicate.simulation.scenarioCount,
    selectedScenario: {
      id: bundle.attestation.predicate.selectedScenario.id,
      label: bundle.attestation.predicate.selectedScenario.label,
      state: bundle.attestation.predicate.selectedScenario.state,
      hypothetical: bundle.attestation.predicate.selectedScenario.hypothetical,
    },
    producer: bundle.attestation.predicate.producer,
    checks: previewVerificationChecks(),
    diagnostics: [],
  }));
  const fixtures: DecisionBundleVerificationEntry[] = [
    {
      directoryName: `db_${previewDigest(141).slice(0, 24)}`,
      state: "content-verified",
      signatureStatus: "unsigned",
      identityAssurance: "not-verified",
      bundleId: `db_${previewDigest(141).slice(0, 24)}`,
      bundleDigest: previewDigest(141),
      bundleSha256: previewDigest(142),
      expectedBundleSha256: previewDigest(142),
      sourceSimulationSha256: previewDigest(143),
      relativePath: `build/decision-bundles/db_${previewDigest(141).slice(0, 24)}/decision-bundle.json`,
      checksumRelativePath: `build/decision-bundles/db_${previewDigest(141).slice(0, 24)}/SHA256SUMS.txt`,
      bytes: 10_914,
      observedModifiedAt: "2026-08-31T22:41:00.000Z",
      redaction: "metadata-only",
      goalPreviewIncluded: false,
      scenarioCount: 9,
      selectedScenario: { id: "isolated-execution-ready", label: "Pinned sandbox available", state: "approval-required", hypothetical: true },
      producer: { name: "Proto Workbench", version: "0.3.0-preview", moduleManifestSha256: previewDigest(144) },
      checks: previewVerificationChecks(),
      diagnostics: [],
    },
    {
      directoryName: `db_${previewDigest(145).slice(0, 24)}`,
      state: "tampered" as const,
      signatureStatus: "unsigned",
      identityAssurance: "not-verified",
      bundleId: `db_${previewDigest(145).slice(0, 24)}`,
      bundleDigest: previewDigest(145),
      bundleSha256: previewDigest(146),
      expectedBundleSha256: previewDigest(147),
      sourceSimulationSha256: previewDigest(148),
      relativePath: `build/decision-bundles/db_${previewDigest(145).slice(0, 24)}/decision-bundle.json`,
      checksumRelativePath: `build/decision-bundles/db_${previewDigest(145).slice(0, 24)}/SHA256SUMS.txt`,
      bytes: 11_208,
      observedModifiedAt: "2026-08-31T21:18:00.000Z",
      redaction: "include-goal-preview",
      goalPreviewIncluded: true,
      scenarioCount: 9,
      selectedScenario: { id: "workspace-drift", label: "Workspace trust drift", state: "blocked", hypothetical: true },
      producer: { name: "Proto Workbench", version: "0.3.0-preview", moduleManifestSha256: previewDigest(149) },
      checks: previewVerificationChecks({ "checksum-match": "failed" }),
      diagnostics: [{ code: "CHECKSUM_MISMATCH", title: "Bundle bytes changed", detail: "The current JSON bytes no longer match the exported checksum record." }],
    },
    {
      directoryName: `db_${previewDigest(150).slice(0, 24)}`,
      state: "invalid" as const,
      signatureStatus: "unknown",
      identityAssurance: "not-verified",
      observedModifiedAt: "2026-08-31T19:06:00.000Z",
      checks: previewVerificationChecks({ entries: "failed", "bundle-file": "not-checked", "checksum-file": "not-checked", "checksum-match": "not-checked", schema: "not-checked", "content-digest": "not-checked", "subject-binding": "not-checked" }),
      diagnostics: [{ code: "UNEXPECTED_ENTRIES", title: "Artifact set rejected", detail: "The checksum artifact is missing from this fixture directory." }],
    },
  ];
  const entries = [...exported, ...fixtures].sort((left, right) => (right.observedModifiedAt ?? "").localeCompare(left.observedModifiedAt ?? ""));
  const summary = {
    contentVerified: entries.filter((entry) => entry.state === "content-verified").length,
    tampered: entries.filter((entry) => entry.state === "tampered").length,
    invalid: entries.filter((entry) => entry.state === "invalid").length,
    unsigned: entries.filter((entry) => entry.signatureStatus === "unsigned").length,
  };
  const body = {
    schema: "proto-workbench.decision-bundle-verification.v1" as const,
    scannedDirectoryCount: entries.length,
    returnedCount: entries.length,
    truncated: false,
    summary,
    entries,
    limits: { maxDirectories: 64, maxDirectoryEntries: 256, maxBundleBytes: 512 * 1024 },
    boundary: "Read-only verification snapshot. It does not execute a bundle, establish publisher identity, authorize an effect, or guarantee that bytes remain unchanged after this scan.",
  };
  return { ...body, digest: await browserSha256(JSON.stringify(body)), issuedAt: new Date().toISOString() };
}

const previewTrustPolicyExports = new Map<string, { policy: TrustPolicyPreview; receipt: TrustPolicyExportReceipt }>();

async function previewTrustPolicy(input: TrustPolicyRequest): Promise<TrustPolicyPreview> {
  if (!input.name.trim() || !input.description.trim() || input.authorities.length < 1 || input.authorities.length > 8) {
    throw new Error("Trust Policy requires a name, description, and between 1 and 8 authorities.");
  }
  const authorities = input.authorities.map((authority) => authority.kind === "keyless" ? {
    kind: "keyless" as const,
    name: authority.name.trim(),
    certificateIssuer: authority.issuer.trim(),
    certificateIdentity: authority.subject.trim(),
    trustRoot: "sigstore-public-good" as const,
    requireTransparencyLog: true as const,
  } : {
    kind: "public-key" as const,
    name: authority.name.trim(),
    publicKeySha256: authority.publicKeySha256,
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const content = {
    schema: "proto-workbench.trust-policy.v1" as const,
    mediaType: "application/vnd.proto-workbench.trust-policy+json" as const,
    fileName: "trust-policy.json" as const,
    name: input.name.trim(),
    description: input.description.trim(),
    appliesTo: {
      bundleMediaType: "application/vnd.proto-workbench.decision-bundle+json" as const,
      statementType: "https://in-toto.io/Statement/v1" as const,
      predicateType: "urn:proto-workbench:attestation:policy-simulation:v1" as const,
      producerName: "Proto Workbench" as const,
      ...(input.pinCurrentModuleManifest ? { moduleManifestSha256: previewDigest(160) } : {}),
    },
    verification: {
      authorityMode: "any-of" as const,
      authorities,
      requireArtifactDigest: true as const,
      requireSignedTimeEvidence: true as const,
      allowNetworkFetch: false as const,
    },
    authentication: {
      status: "policy-only" as const,
      assurance: "no-signature-evaluated" as const,
      detail: "This content-addressed policy defines exact authority constraints. It is not verification evidence and does not activate trust by itself.",
    },
    boundary: "Policy artifact only. Rules are evaluated only after cryptographic signature, certificate or key, trusted-time, and artifact-digest verification succeeds. This policy cannot sign a bundle, create a key, trust an identity, authorize an effect, or fetch verification material from the network.",
  };
  const policyDigest = await browserSha256(JSON.stringify(content));
  return { ...content, policyId: `tp_${policyDigest.slice(0, 24)}`, policyDigest };
}

function trustPolicyEntry(policy: TrustPolicyPreview, receipt: TrustPolicyExportReceipt): TrustPolicyCatalogEntry {
  return {
    directoryName: policy.policyId,
    state: "valid",
    policyId: policy.policyId,
    policyDigest: policy.policyDigest,
    policySha256: receipt.policySha256,
    expectedPolicySha256: receipt.policySha256,
    name: policy.name,
    description: policy.description,
    authorities: policy.verification.authorities,
    moduleManifestSha256: policy.appliesTo.moduleManifestSha256,
    relativePath: receipt.relativePath,
    checksumRelativePath: receipt.checksumRelativePath,
    bytes: receipt.bytes,
    observedModifiedAt: receipt.exportedAt,
    diagnostics: [],
  };
}

async function previewTrustPolicyCatalog(): Promise<TrustPolicyCatalog> {
  const fixturePolicy = await previewTrustPolicy({
    name: "Fixture release workflow",
    description: "Preview-only exact identity constraints for the local release review flow.",
    pinCurrentModuleManifest: true,
    authorities: [{
      kind: "keyless",
      name: "Fixture GitHub workflow",
      issuer: "https://token.actions.githubusercontent.com",
      subject: "https://github.com/local-fixture/proto-workbench/.github/workflows/release.yml@refs/heads/main",
    }],
  });
  const fixtureSerialized = `${JSON.stringify(fixturePolicy, null, 2)}\n`;
  const fixtureSha256 = await browserSha256(fixtureSerialized);
  const fixtureReceipt: TrustPolicyExportReceipt = {
    schema: "proto-workbench.trust-policy-receipt.v1",
    policyId: fixturePolicy.policyId,
    policyDigest: fixturePolicy.policyDigest,
    policySha256: fixtureSha256,
    relativePath: `build/trust-policies/${fixturePolicy.policyId}/trust-policy.json`,
    checksumRelativePath: `build/trust-policies/${fixturePolicy.policyId}/SHA256SUMS.txt`,
    bytes: new TextEncoder().encode(fixtureSerialized).byteLength,
    exportedAt: "2026-08-31T23:04:00.000Z",
    reused: false,
  };
  const entries: TrustPolicyCatalogEntry[] = [
    ...[...previewTrustPolicyExports.values()].map(({ policy, receipt }) => trustPolicyEntry(policy, receipt)),
    trustPolicyEntry(fixturePolicy, fixtureReceipt),
    {
      directoryName: `tp_${previewDigest(161).slice(0, 24)}`,
      state: "tampered",
      policySha256: previewDigest(162),
      expectedPolicySha256: previewDigest(163),
      relativePath: `build/trust-policies/tp_${previewDigest(161).slice(0, 24)}/trust-policy.json`,
      checksumRelativePath: `build/trust-policies/tp_${previewDigest(161).slice(0, 24)}/SHA256SUMS.txt`,
      bytes: 2_044,
      observedModifiedAt: "2026-08-31T21:44:00.000Z",
      diagnostics: [{ code: "CHECKSUM_MISMATCH", title: "Policy bytes changed", detail: "The current policy bytes no longer match the exported checksum record." }],
    },
    {
      directoryName: `tp_${previewDigest(164).slice(0, 24)}`,
      state: "invalid",
      observedModifiedAt: "2026-08-31T20:11:00.000Z",
      diagnostics: [{ code: "UNEXPECTED_ENTRIES", title: "Policy artifact set rejected", detail: "An unexpected file is present in this fixture policy directory." }],
    },
  ];
  entries.sort((left, right) => (right.observedModifiedAt ?? "").localeCompare(left.observedModifiedAt ?? ""));
  const summary = {
    valid: entries.filter((entry) => entry.state === "valid").length,
    tampered: entries.filter((entry) => entry.state === "tampered").length,
    invalid: entries.filter((entry) => entry.state === "invalid").length,
    authorities: entries.filter((entry) => entry.state === "valid").reduce((total, entry) => total + (entry.authorities?.length ?? 0), 0),
  };
  const body = {
    schema: "proto-workbench.trust-policy-catalog.v1" as const,
    scannedDirectoryCount: entries.length,
    returnedCount: entries.length,
    truncated: false,
    summary,
    entries,
    limits: { maxDirectories: 32, maxDirectoryEntries: 128, maxPolicyBytes: 64 * 1024 },
    boundary: "Read-only Trust Policy catalog. A valid policy is an exact rule set, not signature evidence, key material, an activated trust decision, or authorization to execute an effect.",
  };
  return { ...body, digest: await browserSha256(JSON.stringify(body)), issuedAt: new Date().toISOString() };
}

function previewSignatureChecks(overrides: Partial<Record<SignatureEvidenceCheck["id"], SignatureEvidenceCheck["state"]>> = {}): SignatureEvidenceCheck[] {
  const definitions: Array<[SignatureEvidenceCheck["id"], string]> = [
    ["directory", "Canonical directory"], ["entries", "Exact evidence set"], ["checksums", "SHA-256 manifest"],
    ["decision-bundle", "Decision Bundle"], ["trust-policy", "Trust Policy"], ["module-manifest", "Module manifest binding"],
    ["sigstore-bundle", "Sigstore v0.3 structure"], ["artifact-binding", "Artifact binding"],
    ["cryptographic-signature", "Cryptographic signature"], ["trusted-time", "Trusted time"],
    ["trust-root", "Trust root"], ["authority-identity", "Exact authority identity"],
  ];
  return definitions.map(([id, label]) => ({ id, label, state: overrides[id] ?? "passed", detail: overrides[id] === "missing" ? "Required evidence is not present." : overrides[id] === "failed" ? "This verification stage failed closed." : "Exact local verification passed." }));
}

async function previewSignatureEvidenceCatalog(): Promise<SignatureEvidenceCatalog> {
  const rootSha = "a040678bbcc3e3f708a107e3955308bcb4fd31d58860dde6317ea18416af9d36";
  const verifiedId = `se_${previewDigest(171).slice(0, 24)}`;
  const incompleteId = `se_${previewDigest(172).slice(0, 24)}`;
  const rejectedId = `se_${previewDigest(173).slice(0, 24)}`;
  const entries: SignatureEvidenceEntry[] = [
    {
      directoryName: verifiedId, evidenceId: verifiedId, state: "verified", bundleId: `db_${previewDigest(174).slice(0, 24)}`,
      bundleDigest: previewDigest(175), policyId: `tp_${previewDigest(176).slice(0, 24)}`, policyDigest: previewDigest(177),
      artifactSha256: previewDigest(178), signatureBundleSha256: previewDigest(179), signatureMediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      signatureContent: "message-signature", relativePath: `build/signature-evidence/${verifiedId}`, observedModifiedAt: "2026-08-31T23:42:00.000Z",
      identity: { kind: "keyless", authorityName: "Release workflow", certificateIssuer: "https://token.actions.githubusercontent.com", certificateIdentity: "https://github.com/example/proto-workbench/.github/workflows/release.yml@refs/heads/main" },
      signedTime: { status: "verified", source: "transparency-log", observedAt: "2026-08-31T23:41:39.000Z" },
      trustRoot: { name: "sigstore-public-good", sha256: rootSha, mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1", source: "Pinned reviewed snapshot" },
      checks: previewSignatureChecks(), diagnostics: [],
    },
    {
      directoryName: incompleteId, evidenceId: incompleteId, state: "incomplete", bundleId: `db_${previewDigest(180).slice(0, 24)}`,
      bundleDigest: previewDigest(181), policyId: `tp_${previewDigest(182).slice(0, 24)}`, policyDigest: previewDigest(183),
      artifactSha256: previewDigest(184), signatureBundleSha256: previewDigest(185), signatureMediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      signatureContent: "message-signature", relativePath: `build/signature-evidence/${incompleteId}`, observedModifiedAt: "2026-08-31T22:16:00.000Z",
      identity: { kind: "public-key", authorityName: "Offline release key", publicKeySha256: previewDigest(186) },
      signedTime: { status: "missing" }, trustRoot: { name: "policy-pinned-public-key", sha256: previewDigest(186), source: `Trust Policy tp_${previewDigest(182).slice(0, 24)}` },
      checks: previewSignatureChecks({ "trusted-time": "missing" }), diagnostics: [{ code: "SIGNED_TIME_MISSING", title: "Trusted time evidence is missing", detail: "The signature is valid, but the policy-required trusted time stage is incomplete." }],
    },
    {
      directoryName: rejectedId, evidenceId: rejectedId, state: "rejected", bundleId: `db_${previewDigest(187).slice(0, 24)}`,
      bundleDigest: previewDigest(188), policyId: `tp_${previewDigest(189).slice(0, 24)}`, policyDigest: previewDigest(190),
      artifactSha256: previewDigest(191), signatureBundleSha256: previewDigest(192), signatureMediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      signatureContent: "dsse-envelope", relativePath: `build/signature-evidence/${rejectedId}`, observedModifiedAt: "2026-08-31T21:48:00.000Z",
      identity: { kind: "keyless", certificateIssuer: "https://github.com/login/oauth", certificateIdentity: "untrusted@example.test" },
      signedTime: { status: "verified", source: "transparency-log", observedAt: "2026-08-31T21:47:33.000Z" },
      trustRoot: { name: "sigstore-public-good", sha256: rootSha, mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1", source: "Pinned reviewed snapshot" },
      checks: previewSignatureChecks({ "authority-identity": "failed" }), diagnostics: [{ code: "KEYLESS_POLICY_MISMATCH", title: "Certificate identity is not allowed by policy", detail: "Cryptography and trusted time passed, but the exact issuer and SAN are not authorized." }],
    },
  ];
  const body = {
    schema: "proto-workbench.signature-evidence-catalog.v1" as const,
    scannedDirectoryCount: entries.length, returnedCount: entries.length, truncated: false,
    summary: { verified: 1, incomplete: 1, rejected: 1, invalid: 0 },
    trustRootSnapshot: { name: "sigstore-public-good" as const, sha256: rootSha, mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1", source: "Pinned reviewed snapshot", updatePolicy: "manual-reviewed-replacement" as const },
    entries,
    limits: { maxDirectories: 32, maxDirectoryEntries: 8, maxArtifactBytes: 512 * 1024, maxSignatureBundleBytes: 2 * 1024 * 1024 },
    boundary: "Offline, read-only verification snapshot. It never signs, generates keys, activates trust, authorizes effects, or fetches verification material from the network.",
  };
  return { ...body, digest: await browserSha256(JSON.stringify(body)), issuedAt: new Date().toISOString() };
}

function previewTrustRootChecks(overrides: Partial<Record<TrustRootLifecycleCheck["id"], TrustRootLifecycleCheck["state"]>> = {}): TrustRootLifecycleCheck[] {
  const definitions: Array<[TrustRootLifecycleCheck["id"], string, string]> = [
    ["directory", "Canonical directory", "Candidate directory is canonical and contains no linked entries."],
    ["entries", "Exact seven-file pack", "The candidate contains the exact offline lifecycle artifact set."],
    ["checksums", "SHA-256 manifest", "Every candidate byte matches the canonical checksum manifest."],
    ["source-record", "Pinned source record", "SOURCE.json binds the reviewed HTTPS origin and exact commit."],
    ["anchor-root", "Pinned anchor", "The bundled root v15 matches the locally pinned anchor digest."],
    ["root-version", "Sequential root", "Candidate root version is either current or exactly current + 1."],
    ["old-root-threshold", "Old-root threshold", "The current root threshold authorizes this candidate root."],
    ["new-root-threshold", "New-root threshold", "The candidate root satisfies its own signing threshold."],
    ["root-expiry", "Root expiry", "Candidate root remains valid at the declared review time."],
    ["timestamp-signature", "Timestamp signature", "Timestamp metadata is signed by the candidate timestamp role."],
    ["timestamp-freshness", "Timestamp freshness", "Timestamp metadata is unexpired and not rolled back."],
    ["snapshot-binding", "Snapshot binding", "Timestamp binds the exact snapshot version, length, and digest."],
    ["snapshot-signature", "Snapshot signature", "Snapshot metadata satisfies its delegated threshold."],
    ["snapshot-freshness", "Snapshot freshness", "Snapshot metadata is unexpired and not rolled back."],
    ["targets-binding", "Targets binding", "Snapshot binds the exact targets version, length, and digest."],
    ["targets-signature", "Targets signature", "Targets metadata satisfies its delegated threshold."],
    ["targets-freshness", "Targets freshness", "Targets metadata is unexpired and not rolled back."],
    ["trusted-root-binding", "Trusted-root binding", "Targets binds the exact trusted_root.json bytes."],
    ["trusted-root-structure", "Trusted-root structure", "Sigstore trust material parses with supported authorities."],
    ["rollback-protection", "Rollback protection", "All role versions meet or exceed the pinned checkpoint."],
    ["change-classification", "Change classification", "Signed changes are separated from a current no-op refresh."],
  ];
  return definitions.map(([id, label, passedDetail]) => {
    const state = overrides[id] ?? "passed";
    const detail = state === "failed"
      ? id === "root-version" ? "Candidate root v14 is older than the pinned root v15; rollback is rejected."
        : id.includes("freshness") || id === "root-expiry" ? "Metadata is expired at the declared review time."
          : "This verification stage failed closed."
      : state === "warning" ? "Review is required before this stage can be considered current."
        : state === "not-checked" ? "An earlier failure prevented this stage from being trusted."
          : passedDetail;
    return { id, label, state, detail };
  });
}

async function previewTrustRootLifecycleCatalog(): Promise<TrustRootLifecycleCatalog> {
  const anchorSha = "bc232178369634dc10c4d34df3ef64fa2ae642d5dc2c019335a1c22ba700319b";
  const installedTrustedRootSha = "a040678bbcc3e3f708a107e3955308bcb4fd31d58860dde6317ea18416af9d36";
  const sourceCommit = "e3399e7e6f2c3f4039aa2464f95f7d8fcf57910c";
  const entries: TrustRootLifecycleEntry[] = [
    {
      directoryName: `tr_${previewDigest(201).slice(0, 24)}`,
      candidateId: `tr_${previewDigest(201).slice(0, 24)}`,
      state: "reviewable",
      mode: "root-rotation",
      relativePath: `build/trust-root-candidates/tr_${previewDigest(201).slice(0, 24)}`,
      source: "https://github.com/sigstore/root-signing",
      sourceCommit,
      importedAt: "2026-08-31T23:58:00.000Z",
      observedModifiedAt: "2026-08-31T23:58:00.000Z",
      root: { currentVersion: 15, candidateVersion: 16, currentThreshold: 3, candidateThreshold: 3, sha256: previewDigest(202), expires: "2027-02-18T16:00:00Z" },
      timestamp: { version: 772, expires: "2026-09-08T19:20:59Z", sha256: previewDigest(203) },
      snapshot: { version: 166, expires: "2036-05-15T16:00:00Z", sha256: previewDigest(204) },
      targets: { version: 15, expires: "2036-05-09T16:00:00Z", sha256: previewDigest(205) },
      trustedRoot: { sha256: previewDigest(206), semanticSha256: previewDigest(207), installedSemanticSha256: previewDigest(208), changed: true, tlogCount: 2, ctlogCount: 1, certificateAuthorityCount: 2, timestampAuthorityCount: 1 },
      checks: previewTrustRootChecks(),
      diagnostics: [],
    },
    {
      directoryName: `tr_${previewDigest(211).slice(0, 24)}`,
      candidateId: `tr_${previewDigest(211).slice(0, 24)}`,
      state: "current",
      mode: "metadata-refresh",
      relativePath: `build/trust-root-candidates/tr_${previewDigest(211).slice(0, 24)}`,
      source: "https://github.com/sigstore/root-signing",
      sourceCommit,
      importedAt: "2026-08-31T23:22:00.000Z",
      observedModifiedAt: "2026-08-31T23:22:00.000Z",
      root: { currentVersion: 15, candidateVersion: 15, currentThreshold: 3, candidateThreshold: 3, sha256: anchorSha, expires: "2026-11-20T13:58:18Z" },
      timestamp: { version: 771, expires: "2026-09-07T19:20:59Z", sha256: previewDigest(212) },
      snapshot: { version: 165, expires: "2036-05-15T16:00:00Z", sha256: previewDigest(213) },
      targets: { version: 14, expires: "2036-05-09T16:00:00Z", sha256: previewDigest(214) },
      trustedRoot: { sha256: installedTrustedRootSha, semanticSha256: previewDigest(215), installedSemanticSha256: previewDigest(215), changed: false, tlogCount: 2, ctlogCount: 1, certificateAuthorityCount: 2, timestampAuthorityCount: 1 },
      checks: previewTrustRootChecks(),
      diagnostics: [],
    },
    {
      directoryName: `tr_${previewDigest(221).slice(0, 24)}`,
      candidateId: `tr_${previewDigest(221).slice(0, 24)}`,
      state: "rejected",
      mode: "metadata-refresh",
      relativePath: `build/trust-root-candidates/tr_${previewDigest(221).slice(0, 24)}`,
      source: "https://github.com/sigstore/root-signing",
      sourceCommit: "a".repeat(40),
      importedAt: "2026-08-31T22:41:00.000Z",
      observedModifiedAt: "2026-08-31T22:41:00.000Z",
      root: { currentVersion: 15, candidateVersion: 14, currentThreshold: 3, candidateThreshold: 3, sha256: previewDigest(222), expires: "2026-08-20T13:58:18Z" },
      timestamp: { version: 770, expires: "2026-08-30T19:20:59Z", sha256: previewDigest(223) },
      snapshot: { version: 164, expires: "2036-05-15T16:00:00Z", sha256: previewDigest(224) },
      targets: { version: 13, expires: "2036-05-09T16:00:00Z", sha256: previewDigest(225) },
      trustedRoot: { sha256: previewDigest(226), semanticSha256: previewDigest(227), installedSemanticSha256: previewDigest(215), changed: true, tlogCount: 1, ctlogCount: 1, certificateAuthorityCount: 1, timestampAuthorityCount: 0 },
      checks: previewTrustRootChecks({
        "root-version": "failed", "root-expiry": "failed", "timestamp-freshness": "failed", "rollback-protection": "failed",
        "snapshot-binding": "not-checked", "snapshot-signature": "not-checked", "snapshot-freshness": "not-checked",
        "targets-binding": "not-checked", "targets-signature": "not-checked", "targets-freshness": "not-checked",
        "trusted-root-binding": "not-checked", "trusted-root-structure": "not-checked", "change-classification": "not-checked",
      }),
      diagnostics: [
        "ROOT_VERSION_ROLLBACK: Candidate root v14 is older than pinned root v15.",
        "ROOT_EXPIRED: Candidate root expired before the declared review time.",
        "TIMESTAMP_ROLLBACK: Timestamp v770 is older than checkpoint v771.",
      ],
    },
  ];
  const body = {
    schema: "proto-workbench.trust-root-lifecycle-catalog.v1" as const,
    scannedDirectoryCount: entries.length,
    returnedCount: entries.length,
    truncated: false,
    summary: { reviewable: 1, current: 1, rejected: 1, invalid: 0 },
    anchor: {
      name: "sigstore-public-good" as const,
      rootVersion: 15,
      rootSha256: anchorSha,
      rootExpires: "2026-11-20T13:58:18Z",
      rootThreshold: 3,
      timestampVersion: 771,
      snapshotVersion: 165,
      targetsVersion: 14,
      trustedRootSha256: installedTrustedRootSha,
      source: `sigstore/root-signing@${sourceCommit}`,
      updatePolicy: "offline-review-only" as const,
    },
    entries,
    limits: { maxDirectories: 24, maxDirectoryEntries: 7, maxMetadataBytes: 512 * 1024, maxTargetBytes: 512 * 1024 },
    boundary: "Read-only lifecycle review. Candidate packs cannot fetch metadata, sign roots, generate keys, replace the pinned anchor, activate trust, or authorize an effect.",
  };
  return { ...body, digest: await browserSha256(JSON.stringify(body)), issuedAt: new Date().toISOString() };
}

function previewTransparencyWitnessChecks(overrides: Partial<Record<TransparencyWitnessCheck["id"], TransparencyWitnessCheck["state"]>> = {}): TransparencyWitnessCheck[] {
  const definitions: Array<[TransparencyWitnessCheck["id"], string, string]> = [
    ["directory", "Canonical directory", "Content-addressed pack directory is canonical and link-free."],
    ["entries", "Exact six-file pack", "The pack contains only the two notes, two proofs, source record, and checksum manifest."],
    ["checksums", "SHA-256 manifest", "Every imported byte matches the canonical checksum manifest."],
    ["source-record", "Source record", "SOURCE.json binds the HTTPS origin and retrieval time."],
    ["policy-anchor", "Pinned witness policy", "The offline policy is bound to the installed Sigstore TrustedRoot."],
    ["anchor-checkpoint", "Pinned checkpoint", "The pack starts from the exact release-pinned witnessed checkpoint."],
    ["checkpoint-format", "C2SP checkpoint format", "Origin, uint64 size, 32-byte root, and signed-note framing are canonical."],
    ["log-signature", "Transparency log signature", "The checkpoint is signed by the TrustedRoot-bound Rekor v2 Ed25519 key."],
    ["witness-quorum", "Witness quorum", "Two configured witnesses independently cosigned the exact checkpoint body."],
    ["witness-time", "Witness timestamps", "Accepted cosignatures carry bounded non-zero timestamps."],
    ["leaf-binding", "Exact leaf binding", "The inclusion proof starts from the exact imported leaf bytes."],
    ["inclusion-structure", "Inclusion structure", "Index, tree size, and proof hash count are bounded and checkpoint-bound."],
    ["inclusion-proof", "Merkle inclusion", "RFC 6962 inclusion reconstructs the verified checkpoint root."],
    ["consistency-structure", "Consistency structure", "Proof sizes exactly match the pinned and candidate checkpoints."],
    ["consistency-proof", "Merkle consistency", "RFC 6962 consistency proves an append-only extension."],
    ["rollback-protection", "Rollback protection", "Candidate tree size is not below the pinned checkpoint."],
    ["fork-detection", "Split-view detection", "Equal-size checkpoints cannot commit to different roots."],
  ];
  return definitions.map(([id, label, passedDetail]) => {
    const state = overrides[id] ?? "passed";
    const detail = state === "failed"
      ? id === "rollback-protection" ? "Candidate tree size is below the release-pinned checkpoint."
        : id === "fork-detection" ? "The same tree size was presented with a different Merkle root."
          : id === "consistency-proof" ? "The proof does not establish an append-only extension."
            : "This transparency verification stage failed closed."
      : state === "not-checked" ? "An earlier trust failure prevented this stage from being evaluated."
        : passedDetail;
    return { id, label, state, detail };
  });
}

async function previewTransparencyWitnessCatalog(): Promise<TransparencyWitnessCatalog> {
  const anchorRoot = "Hrd6ULSLixNGejXGuYEESDe5TykvlYq5ACLI+VsdVMg=";
  const anchorBody = "9ad268597f331f72d3bcc5eb0a2849e34a6f38b31ebd8020b6d5daeee463a176";
  const witnessNames = ["witness.stagemole.eu", "staging.witness.transparency.goog/ring-any-bells"];
  const witnessRows = (signedAt: string) => [
    { name: witnessNames[0]!, keyId: "67f7aea0", state: "verified" as const, signedAt, detail: "Timestamped cosignature verified." },
    { name: witnessNames[1]!, keyId: "2e1a8dc9", state: "verified" as const, signedAt, detail: "Timestamped cosignature verified." },
  ];
  const anchor = { origin: "log2025-1.rekor.sigstore.dev", treeSize: "91610831", rootHash: anchorRoot, bodySha256: anchorBody };
  const entries: TransparencyWitnessEntry[] = [
    {
      directoryName: `tw_${previewDigest(241).slice(0, 24)}`,
      packId: `tw_${previewDigest(241).slice(0, 24)}`,
      state: "witnessed",
      relativePath: `build/transparency-witness/tw_${previewDigest(241).slice(0, 24)}`,
      source: "https://log2025-1.rekor.sigstore.dev/checkpoint",
      retrievedAt: "2026-09-01T21:17:42.000Z",
      observedModifiedAt: "2026-09-01T21:17:43.000Z",
      anchor,
      checkpoint: { origin: anchor.origin, treeSize: "91611328", rootHash: "uWCzbybnjkR6y1Y4DMz6aCdxvBMhfFl2iUSK5uQ16D0=", bodySha256: previewDigest(242) },
      logKeyId: "cf119915",
      witnessQuorum: { required: 2, verified: 2, configured: 2 },
      witnesses: witnessRows("2026-09-01T21:17:42.000Z"),
      inclusion: { logIndex: "91611290", treeSize: "91611328", leafSha256: previewDigest(243), proofHashCount: 27 },
      consistency: { oldSize: "91610831", newSize: "91611328", proofHashCount: 23 },
      checks: previewTransparencyWitnessChecks(),
      diagnostics: [],
    },
    {
      directoryName: `tw_${previewDigest(251).slice(0, 24)}`,
      packId: `tw_${previewDigest(251).slice(0, 24)}`,
      state: "current",
      relativePath: `build/transparency-witness/tw_${previewDigest(251).slice(0, 24)}`,
      source: "https://log2025-1.rekor.sigstore.dev/checkpoint",
      retrievedAt: "2026-09-01T20:58:08.000Z",
      observedModifiedAt: "2026-09-01T20:58:09.000Z",
      anchor,
      checkpoint: anchor,
      logKeyId: "cf119915",
      witnessQuorum: { required: 2, verified: 2, configured: 2 },
      witnesses: witnessRows("2026-09-01T20:58:08.000Z"),
      inclusion: { logIndex: "91610830", treeSize: "91610831", leafSha256: previewDigest(252), proofHashCount: 27 },
      consistency: { oldSize: "91610831", newSize: "91610831", proofHashCount: 0 },
      checks: previewTransparencyWitnessChecks(),
      diagnostics: [],
    },
    {
      directoryName: `tw_${previewDigest(261).slice(0, 24)}`,
      packId: `tw_${previewDigest(261).slice(0, 24)}`,
      state: "rejected",
      relativePath: `build/transparency-witness/tw_${previewDigest(261).slice(0, 24)}`,
      source: "https://mirror.invalid.example/checkpoint",
      retrievedAt: "2026-09-01T20:52:00.000Z",
      observedModifiedAt: "2026-09-01T20:52:01.000Z",
      anchor,
      checkpoint: { origin: anchor.origin, treeSize: "91610000", rootHash: "ckja5jhxbSJaXVdlJ6KdPNlh7QszBdkuqdpcqC2P7W0=", bodySha256: previewDigest(262) },
      logKeyId: "cf119915",
      witnessQuorum: { required: 2, verified: 2, configured: 2 },
      witnesses: witnessRows("2026-09-01T20:52:00.000Z"),
      inclusion: { logIndex: "91609999", treeSize: "91610000", leafSha256: previewDigest(263), proofHashCount: 27 },
      consistency: { oldSize: "91610831", newSize: "91610000", proofHashCount: 0 },
      checks: previewTransparencyWitnessChecks({ "rollback-protection": "failed", "consistency-proof": "failed" }),
      diagnostics: [
        "CHECKPOINT_ROLLBACK: Candidate tree size 91610000 is below pinned size 91610831.",
        "CONSISTENCY_PROOF_INVALID: A smaller tree cannot be an append-only extension of the pinned checkpoint.",
      ],
    },
    {
      directoryName: `tw_${previewDigest(271).slice(0, 24)}`,
      packId: `tw_${previewDigest(271).slice(0, 24)}`,
      state: "rejected",
      relativePath: `build/transparency-witness/tw_${previewDigest(271).slice(0, 24)}`,
      source: "https://mirror.invalid.example/checkpoint",
      retrievedAt: "2026-09-01T20:49:00.000Z",
      observedModifiedAt: "2026-09-01T20:49:01.000Z",
      anchor,
      checkpoint: { origin: anchor.origin, treeSize: anchor.treeSize, rootHash: "3d3N8qvsBORe4qK2mY/yd1fCbhCcXlCXT9OYfiXDDEQ=", bodySha256: previewDigest(272) },
      logKeyId: "cf119915",
      witnessQuorum: { required: 2, verified: 2, configured: 2 },
      witnesses: witnessRows("2026-09-01T20:49:00.000Z"),
      inclusion: { logIndex: "91610830", treeSize: anchor.treeSize, leafSha256: previewDigest(273), proofHashCount: 27 },
      consistency: { oldSize: anchor.treeSize, newSize: anchor.treeSize, proofHashCount: 0 },
      checks: previewTransparencyWitnessChecks({ "fork-detection": "failed", "consistency-proof": "failed" }),
      diagnostics: [
        "CHECKPOINT_FORK: The pinned tree size was presented with a different Merkle root.",
        "CONSISTENCY_PROOF_INVALID: Equal-size consistency requires identical roots and an empty proof.",
      ],
    },
  ];
  const body = {
    schema: "proto-workbench.transparency-witness-catalog.v1" as const,
    scannedDirectoryCount: entries.length,
    returnedCount: entries.length,
    truncated: false,
    summary: { witnessed: 1, current: 1, rejected: 2, invalid: 0 },
    policy: {
      name: "Rekor v2 offline witness review policy",
      sha256: "ccb7e9345e880c39265f633474395c6879318ec60f9e438b8c298fb4d30661cd",
      origin: anchor.origin,
      logKeyId: "cf119915",
      witnessQuorum: 2,
      witnessCount: 2,
      anchorTreeSize: anchor.treeSize,
      anchorRootHash: anchor.rootHash,
      anchorBodySha256: anchor.bodySha256,
      retrievedAt: "2026-09-01T20:58:08.000Z",
      trustedRootSha256: "a040678bbcc3e3f708a107e3955308bcb4fd31d58860dde6317ea18416af9d36",
      source: "https://log2025-1.rekor.sigstore.dev/checkpoint",
      updatePolicy: "offline-reviewed-release" as const,
    },
    entries,
    limits: { maxDirectories: 24, maxDirectoryEntries: 6, maxNoteBytes: 64 * 1024, maxProofBytes: 512 * 1024, maxLeafBytes: 256 * 1024 },
    boundary: "Offline, read-only transparency verification. No checkpoint fetch, witness contact, log submission, signing, cosigning, policy replacement, state advance, or effect authorization is available.",
  };
  return { ...body, digest: await browserSha256(JSON.stringify(body)), issuedAt: new Date().toISOString() };
}

const mockWorkbench: WorkbenchApi = {
  app: {
    async getSettings() {
      return structuredClone(settings);
    },
    async updateSettings(next: AppSettingsUpdate) {
      settings = { ...settings, ...next };
      return structuredClone(settings);
    },
    async getRuntimeStatus() {
      return {
        available: true,
        provider: "lmstudio" as const,
        endpoint: "http://127.0.0.1:1234",
        modelCount: models.length,
        loadedModelCount: models.reduce((sum, model) => sum + (model.loadedInstances?.length ?? 0), 0),
        degraded: false,
        detail: "LM Studio native API is available at the fixed loopback endpoint.",
      };
    },
    async getStartupRecovery() {
      return {
        checkedAt: new Date().toISOString(),
        recoveredRuns: 0,
        recoveredEvents: 0,
        invalidatedApprovals: 0,
        reconciledPatchOperations: 0,
        conflictedPatchOperations: 0,
        reconciledValidationJournals: 0,
        validationStepsNeedingReplay: 0,
        runIds: [],
      };
    },
    async getModuleIntegrity() {
      return {
        ok: true,
        enforced: true,
        auditId: "demo-audit",
        manifestPath: "out/module-manifest.json",
        checkedAt: new Date().toISOString(),
        manifestSha256: "demo",
        modules: [...CORE_MODULES, ...OPTIONAL_MODULES].map((module) => ({
          moduleId: module.id,
          version: module.version,
          core: module.core,
          status: "verified" as const,
          disposition: (module.core ? "loaded" : "available") as "loaded" | "available",
          moduleSha256: "0".repeat(64),
          checkedArtifacts: 1,
          diagnostics: [],
        })),
      };
    },
    async listModuleAudits() {
      return [await mockWorkbench.app.getModuleIntegrity()];
    },
  },
  models: {
    async scan() {
      return structuredClone(models);
    },
    async list() {
      return structuredClone(models);
    },
    async estimate(modelId, options) {
      const model = models.find((item) => item.id === modelId);
      if (!model) throw new Error("Model not found");
      const totalLayers = model.blockCount ? model.blockCount + 1 : 999;
      const fraction = Math.min(1, Math.max(0, options.gpuLayers / Math.max(1, totalLayers)));
      const cacheFactor = options.cacheType === "q4_0" ? 0.28125 : options.cacheType === "q8_0" ? 0.5625 : 1;
      const kvCacheTotalBytes = Math.round(options.contextLength * 18_000 * cacheFactor);
      const gpuKvFraction = options.kvCachePlacement === "cpu" ? 0 : fraction;
      const weightBytes = Math.round(model.sizeBytes * 1.03 * fraction);
      const ramWeightBytes = Math.round(model.sizeBytes * 1.03 - weightBytes);
      const kvCacheBytes = Math.round(kvCacheTotalBytes * gpuKvFraction);
      const ramKvCacheBytes = kvCacheTotalBytes - kvCacheBytes;
      const computeBytes = Math.round(256 * 1024 ** 2 * fraction);
      const ramComputeBytes = 256 * 1024 ** 2;
      const runtimeBytes = fraction ? 320 * 1024 ** 2 : 0;
      const ramRuntimeBytes = 512 * 1024 ** 2;
      const totalBytes = weightBytes + kvCacheBytes + computeBytes + runtimeBytes;
      const ramTotalBytes = ramWeightBytes + ramKvCacheBytes + ramComputeBytes + ramRuntimeBytes;
      return {
        contextLength: options.contextLength,
        gpuLayers: options.gpuLayers,
        cacheType: options.cacheType ?? "f16",
        kvCachePlacement: options.kvCachePlacement ?? "gpu",
        totalGpuLayers: totalLayers,
        offloadFraction: fraction,
        weightBytes,
        ramWeightBytes,
        kvCacheTotalBytes,
        kvCacheBytes,
        ramKvCacheBytes,
        computeBytes,
        ramComputeBytes,
        projectorBytes: 0,
        ramProjectorBytes: 0,
        runtimeBytes,
        ramRuntimeBytes,
        ramTotalBytes,
        totalBytes,
        systemRamTotalBytes: 64 * 1024 ** 3,
        systemRamAvailableBytes: 40 * 1024 ** 3,
        gpuVramAvailableBytes: 20 * 1024 ** 3,
        ramSafetyReserveBytes: 8 * 1024 ** 3,
        memoryPressure: ramTotalBytes > 32 * 1024 ** 3 ? "unsafe" as const : "normal" as const,
        memoryDiagnostics: ["Mock resource estimate."],
        source: "calculated" as const,
      };
    },
    async load(modelId) {
      models = models.map((model) => {
        if (model.id === modelId) {
          const instanceId = model.loadedInstances?.[0]?.id ?? `${model.id}-mock-workbench`;
          const loadedInstances = model.loadedInstances?.length
            ? model.loadedInstances
            : [{ id: instanceId, contextLength: Math.min(model.contextLength, 32_768), evalBatchSize: 512, flashAttention: true, offloadKvCacheToGpu: true }];
          return {
            ...model,
            loadedInstances,
            workbenchInstance: { id: instanceId, ownedByWorkbench: model.loadedInstances?.length ? false : true },
            loadState: "active",
            lastUsedAt: new Date().toISOString(),
          };
        }
        if (settings.residencyPolicy.mode === "quick-switch") return { ...model, workbenchInstance: undefined, loadState: model.loadedInstances?.length ? "warm" : "unloaded" };
        return model.loadState === "active" ? { ...model, workbenchInstance: undefined, loadState: model.loadedInstances?.length ? "warm" : "unloaded" } : model;
      });
      notifyModels();
      return {
        modelId,
        state: "active",
        contextLength: models.find((model) => model.id === modelId)?.contextLength ?? 32768,
        gpuLayers: 999,
        startedAt: new Date().toISOString(),
      };
    },
    async unload(modelId) {
      models = models.map((model) => (model.id === modelId
        ? {
            ...model,
            loadedInstances: model.workbenchInstance?.ownedByWorkbench ? [] : model.loadedInstances,
            workbenchInstance: undefined,
            loadState: model.workbenchInstance?.ownedByWorkbench || !model.loadedInstances?.length ? "unloaded" : "warm",
          }
        : model));
      notifyModels();
    },
    async setPolicy(policy: ResidencyPolicy) {
      settings.residencyPolicy = structuredClone(policy);
      return structuredClone(policy);
    },
    async pin(modelId, pinned) {
      models = models.map((model) => (model.id === modelId ? { ...model, pinned } : model));
      settings.residencyPolicy.pinnedModelIds = pinned
        ? [...new Set([...settings.residencyPolicy.pinnedModelIds, modelId])]
        : settings.residencyPolicy.pinnedModelIds.filter((id) => id !== modelId);
      notifyModels();
    },
    subscribe(listener) {
      modelListeners.add(listener);
      return () => modelListeners.delete(listener);
    },
  },
  harness: {
    async preflight(input: MissionPreflightRequest): Promise<MissionPreflight> {
      const thread = threads.find((item) => item.id === input.threadId);
      if (!thread) throw new Error("Thread not found");
      const model = models.find((item) => item.id === thread.modelId);
      const goal = input.content.normalize("NFKC").trim();
      const writes = /\b(?:write|edit|change|modify|update|create|patch|apply|implement|fix|upgrade|build)\b|写入|修改|编辑|更新|创建|补丁|实现|修复|升级|构建/iu.test(goal);
      const network = /\b(?:search|browse|query|fetch|download|pubmed|crossref|uniprot|rhea|online|internet|web)\b|联网|上网|网络|在线|检索|搜索|查询|下载/iu.test(goal);
      const execution = /\b(?:run|execute|python|notebook|script|shell|terminal|benchmark|train|simulate)\b|运行|执行|脚本|终端|命令|测试|训练|模拟/iu.test(goal);
      const requirements: MissionPreflight["requirements"] = [
        { id: "integrity", title: "Core integrity", state: "ready", detail: "Preview module manifest passed its audit." },
        { id: "workspace", title: "Workspace binding", state: "ready", detail: "Preview sidecar is bound to this workspace." },
        { id: "runtime", title: "Local runtime", state: "ready", detail: "CUDA inference runtime is available." },
        {
          id: "model",
          title: "Model capability",
          state: model?.loadState === "active" && model.toolCapability !== "chat-only" ? "ready" : "blocked",
          detail: model?.loadState === "active" ? "The active local model is agent-ready." : "Load the selected local model.",
          action: "models",
        },
        { id: "attachments", title: "Attachment contract", state: "ready", detail: `${input.attachments?.length ?? 0} attachment grants are bound to this preview.` },
        { id: "network", title: "Live network boundary", state: network ? "approval-required" : "ready", detail: network ? "Each live lookup requires a fresh approval." : "Network remains disabled by default." },
        { id: "writes", title: "Workspace changes", state: writes ? thread.mode === "plan" ? "deferred" : "approval-required" : "ready", detail: writes ? thread.mode === "plan" ? "Plan mode defers workspace changes." : "Applying a proposed diff requires review." : "No write intent detected." },
        { id: "execution", title: "Code execution", state: execution ? thread.mode === "plan" ? "deferred" : "blocked" : "ready", detail: execution ? thread.mode === "plan" ? "Plan mode records but does not execute code." : "Configure a digest-pinned OCI sandbox first." : "No execution intent detected." },
        { id: "human-review", title: "Human review", state: "ready", detail: "Every later side effect uses its own gate." },
      ];
      const launchable = !requirements.some((item) => item.state === "blocked");
      const state = launchable
        ? requirements.some((item) => item.state === "approval-required") ? "approval-required" as const : "ready" as const
        : "blocked" as const;
      const goalSha256 = await browserSha256(goal);
      const digest = await browserSha256(JSON.stringify({
        threadId: thread.id,
        mode: thread.mode,
        model: model ? [model.id, model.fingerprint, model.loadState] : null,
        goalSha256,
        attachments: input.attachments ?? [],
        requirements: requirements.map(({ id, state: requirementState }) => [id, requirementState]),
      }));
      return {
        schema: "proto-workbench.mission-preflight.v1",
        digest,
        issuedAt: new Date().toISOString(),
        threadId: thread.id,
        mode: thread.mode,
        modelId: model?.id,
        goalPreview: goal.slice(0, 180),
        goalSha256,
        state,
        launchable,
        intent: { network, writes, execution },
        requirements,
        warnings: [],
        nextAction: launchable ? "Start this exact preview mission." : requirements.find((item) => item.state === "blocked")?.detail ?? "Resolve the blocker.",
      };
    },
    async simulatePolicy(input: PolicySimulationRequest): Promise<PolicySimulationReport> {
      const baseline = await mockWorkbench.harness.preflight(input);
      return previewPolicySimulation(input, baseline);
    },
    async previewDecisionBundle(input: DecisionBundleRequest): Promise<DecisionBundlePreview> {
      const baseline = await mockWorkbench.harness.preflight(input);
      const report = await previewPolicySimulation(input, baseline);
      return previewDecisionBundle(report, input);
    },
    async exportDecisionBundle(input: DecisionBundleExportRequest): Promise<DecisionBundleExportReceipt> {
      const bundle = await mockWorkbench.harness.previewDecisionBundle(input);
      if (bundle.bundleDigest !== input.expectedBundleDigest) throw new Error("Decision Bundle digest is stale; preview it again before export.");
      const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
      const bundleSha256 = await browserSha256(serialized);
      const reused = previewDecisionBundleExports.has(bundle.bundleId);
      const root = `build/decision-bundles/${bundle.bundleId}`;
      const receipt: DecisionBundleExportReceipt = {
        schema: "proto-workbench.decision-bundle-receipt.v1",
        bundleId: bundle.bundleId,
        bundleDigest: bundle.bundleDigest,
        bundleSha256,
        relativePath: `${root}/decision-bundle.json`,
        checksumRelativePath: `${root}/SHA256SUMS.txt`,
        bytes: new TextEncoder().encode(serialized).byteLength,
        exportedAt: new Date().toISOString(),
        reused,
        signatureStatus: "unsigned",
      };
      previewDecisionBundleExports.set(bundle.bundleId, { bundle, receipt });
      return receipt;
    },
    async verifyDecisionBundles(): Promise<DecisionBundleVerificationCatalog> {
      return previewDecisionBundleVerification();
    },
    async previewTrustPolicy(input: TrustPolicyRequest): Promise<TrustPolicyPreview> {
      return previewTrustPolicy(input);
    },
    async exportTrustPolicy(input: TrustPolicyExportRequest): Promise<TrustPolicyExportReceipt> {
      const policy = await previewTrustPolicy(input);
      if (policy.policyDigest !== input.expectedPolicyDigest) throw new Error("Trust Policy digest is stale; preview it again before export.");
      const serialized = `${JSON.stringify(policy, null, 2)}\n`;
      const policySha256 = await browserSha256(serialized);
      const reused = previewTrustPolicyExports.has(policy.policyId);
      const root = `build/trust-policies/${policy.policyId}`;
      const receipt: TrustPolicyExportReceipt = {
        schema: "proto-workbench.trust-policy-receipt.v1",
        policyId: policy.policyId,
        policyDigest: policy.policyDigest,
        policySha256,
        relativePath: `${root}/trust-policy.json`,
        checksumRelativePath: `${root}/SHA256SUMS.txt`,
        bytes: new TextEncoder().encode(serialized).byteLength,
        exportedAt: new Date().toISOString(),
        reused,
      };
      previewTrustPolicyExports.set(policy.policyId, { policy, receipt });
      return receipt;
    },
    async listTrustPolicies(): Promise<TrustPolicyCatalog> {
      return previewTrustPolicyCatalog();
    },
    async importSignatureEvidence(): Promise<SignatureEvidenceImportReceipt | undefined> {
      return undefined;
    },
    async listSignatureEvidence(): Promise<SignatureEvidenceCatalog> {
      return previewSignatureEvidenceCatalog();
    },
    async importTrustRootCandidate(): Promise<TrustRootLifecycleImportReceipt | undefined> {
      return undefined;
    },
    async listTrustRootCandidates(): Promise<TrustRootLifecycleCatalog> {
      return previewTrustRootLifecycleCatalog();
    },
    async importTransparencyWitnessPack(): Promise<TransparencyWitnessImportReceipt | undefined> {
      return undefined;
    },
    async listTransparencyWitnessPacks(): Promise<TransparencyWitnessCatalog> {
      return previewTransparencyWitnessCatalog();
    },
  },
  visualization: {
    async exportMap(input) {
      const bytes = new Uint8Array(input.bytes);
      const metadataPayload = `${JSON.stringify(input.metadata, null, 2)}\n`;
      const sha256 = await browserSha256Bytes(bytes);
      const metadataSha256 = await browserSha256(metadataPayload);
      const verifiedAt = new Date().toISOString();
      const metadataFilename = input.filename.replace(/\.(?:svg|png)$/i, ".metadata.json");
      const verificationFilename = input.filename.replace(/\.(?:svg|png)$/i, ".verification.json");
      const receipt = {
        schema: "proto-workbench.map-export-verification.v1" as const,
        status: "preview-unverified" as const,
        format: input.format,
        filename: input.filename,
        sha256,
        metadataSha256,
        bytes: bytes.byteLength,
        width: input.width,
        height: input.height,
        exportedAt: input.metadata.exportedAt,
        verifiedAt,
        decoder: "browser-preview" as const,
        externalResourcesBlocked: false,
        renderedMapLayers: input.metadata.renderedMapLayers,
        reviewStatus: "human_review_required" as const,
      };
      downloadPreviewPayload(bytes, input.filename, input.format === "svg" ? "image/svg+xml" : "image/png");
      downloadPreviewPayload(metadataPayload, metadataFilename, "application/json");
      downloadPreviewPayload(`${JSON.stringify(receipt, null, 2)}\n`, verificationFilename, "application/json");
      return receipt;
    },
  },
  materials: {
    async status(): Promise<MaterialsStatus> {
      return {
        ok: true,
        schema_version: "proto-agent.materials.v1",
        active_snapshot: "seed-2026.08",
        staging: [],
        overlays: [],
        snapshots: [{ snapshot_id: "seed-2026.08", record_count: 3, catalog_record_count: 3, quarantine_record_count: 0, status_counts: { DESIGN_ELIGIBLE: 0, REVIEW_REQUIRED: 0, REFERENCE_ONLY: 3, QUARANTINED: 0 }, active: true }],
      };
    },
    async search() {
      return { ok: true, snapshot_id: "seed-2026.08", matches: [], match_count: 0, returned_count: 0, truncated: false };
    },
    async get() {
      throw new Error("The preview seed has no DESIGN_ELIGIBLE materials.");
    },
    async facets(): Promise<MaterialsFacets> {
      return { ok: true, snapshot_id: "seed-2026.08", kinds: {}, statuses: { DESIGN_ELIGIBLE: 0 }, safety: { NO_FLAG: 0 }, sources: {}, licenses: {} };
    },
    async materialize(_input: MaterialsMaterializeRequest) { throw new Error("Materials materialization is unavailable in preview mode; use the desktop app."); },
    async activate() { throw new Error("Snapshot administration is unavailable in preview mode."); },
    async rollback() { throw new Error("Snapshot administration is unavailable in preview mode."); },
    async sync() { throw new Error("Materials sync is unavailable in preview mode; use the desktop app."); },
    async importFile() { throw new Error("Materials import is unavailable in preview mode; use the desktop app."); },
    async diff() { throw new Error("Snapshot diff is unavailable in preview mode; use the desktop app."); },
    async review(_input: MaterialsReviewInput) { throw new Error("Materials review is unavailable in preview mode; use the desktop app."); },
  },
  threads: {
    async create(input) {
      const now = new Date().toISOString();
      const thread: AgentThread = {
        id: crypto.randomUUID(),
        workspacePath: settings.workspacePath,
        createdAt: now,
        updatedAt: now,
        ...input,
      };
      threads.unshift(thread);
      messages.set(thread.id, []);
      return structuredClone(thread);
    },
    async list() {
      return structuredClone(threads);
    },
    async get(threadId) {
      const thread = threads.find((item) => item.id === threadId);
      if (!thread) throw new Error("Thread not found");
      return { thread: structuredClone(thread), messages: structuredClone(messages.get(threadId) ?? []) };
    },
    async update(threadId, patch_) {
      const index = threads.findIndex((item) => item.id === threadId);
      if (index < 0) throw new Error("Thread not found");
      threads[index] = { ...threads[index], ...patch_, updatedAt: new Date().toISOString() };
      return structuredClone(threads[index]);
    },
    async send(threadId, content, _expectedPreflightDigest, attachments: ChatAttachment[] = []) {
      const createdAt = new Date().toISOString();
      const user: ChatMessage = { id: crypto.randomUUID(), role: "user", content, attachments, createdAt };
      const list = messages.get(threadId) ?? [];
      list.push(user);
      messages.set(threadId, list);
      const messageId = crypto.randomUUID();
      emit({ threadId, type: "message-start", messageId });
      const response =
        "I mapped this goal to the local Proto workflow. I will search approved parts, prepare a reviewable diff, and keep deterministic validation and evidence visible in the run ledger.";
      let offset = 0;
      const timer = window.setInterval(() => {
        const delta = response.slice(offset, offset + 5);
        offset += 5;
        if (delta) emit({ threadId, type: "message-delta", messageId, delta });
        if (offset >= response.length) {
          window.clearInterval(timer);
          const assistant: ChatMessage = {
            id: messageId,
            role: "assistant",
            content: response,
            createdAt: new Date().toISOString(),
          };
          list.push(assistant);
          emit({ threadId, type: "message-complete", messageId, message: assistant });
        }
      }, 28);
    },
    async cancel(threadId) {
      emit({ threadId, type: "cancelled" });
    },
    subscribe(listener) {
      streamListeners.add(listener);
      return () => streamListeners.delete(listener);
    },
  },
  files: {
    async pickAttachments() {
      return [];
    },
    async pickWorkspace() {
      return undefined;
    },
    async pickModelRoot() {
      return undefined;
    },
    async pickRuntime() {
      return undefined;
    },
    async list() {
      return [
        {
          path: "designs/toggle_switch.proto",
          relativePath: "designs/toggle_switch.proto",
          name: "toggle_switch.proto",
          mediaType: "text/x-proto",
          sizeBytes: 1240,
          modifiedAt: new Date().toISOString(),
        },
        {
          path: "build/runs/preview-toggle-switch/toggle_switch.ir.json",
          relativePath: "build/runs/preview-toggle-switch/toggle_switch.ir.json",
          name: "toggle_switch.ir.json",
          mediaType: "application/json",
          sizeBytes: DEMO_DESIGN_IR_CONTENT.length,
          modifiedAt: new Date().toISOString(),
        },
        {
          path: "build/runs/preview-toggle-switch/provenance.json",
          relativePath: "build/runs/preview-toggle-switch/provenance.json",
          name: "provenance.json",
          mediaType: "application/json",
          sizeBytes: JSON.stringify(DEMO_PROVENANCE, null, 2).length,
          modifiedAt: new Date().toISOString(),
        },
        {
          path: "build/runs/preview-toggle-switch/manifest.json",
          relativePath: "build/runs/preview-toggle-switch/manifest.json",
          name: "manifest.json",
          mediaType: "application/json",
          sizeBytes: JSON.stringify(DEMO_RUN_MANIFEST).length,
          modifiedAt: new Date().toISOString(),
        },
      ];
    },
    async open() {},
    async reveal() {},
    async read(path) {
      const lower = path.toLocaleLowerCase();
      const content = lower.endsWith(".ir.json")
        ? DEMO_DESIGN_IR_CONTENT
        : lower.endsWith("validation_report.json")
          ? JSON.stringify({
              schemaVersion: "proto.validation-report.v1",
              status: "passed",
              diagnostics: [],
              checkedArtifact: "designs/toggle_switch.proto",
              safetyBoundary: "Software validation only.",
            }, null, 2)
          : lower.endsWith("review_packet.json")
            ? JSON.stringify(review, null, 2)
        : lower.endsWith("manifest.json")
          ? JSON.stringify(DEMO_RUN_MANIFEST, null, 2)
          : lower.endsWith("provenance.json")
            ? JSON.stringify(DEMO_PROVENANCE, null, 2)
            : lower.endsWith("plan.yaml")
              ? "goal: reviewable promoter design\nsteps:\n  - design\n  - validate\n  - review\n"
              : patch.after;
      return { path, content, sha256: lower.endsWith(".ir.json") ? DEMO_DESIGN_SHA256 : "e".repeat(64) };
    },
    async search() {
      return [];
    },
    async proposePatch(input) {
      patch = { ...patch, ...input, status: "pending" };
      return structuredClone(patch);
    },
    async applyApprovedPatch() {
      patch.status = "approved";
      patch.revision += 1;
      const now = new Date().toISOString();
      patchOperation = {
        id: crypto.randomUUID(),
        idempotencyKey: `patch:${patch.id}:demo`,
        patchId: patch.id,
        runId: patch.runId,
        targetPath: patch.targetPath,
        state: "verified",
        baseSha256: patch.baseSha256,
        baseExists: patch.baseExists,
        resultSha256: "demo-result",
        resultExists: patch.afterExists,
        checkpointId: crypto.randomUUID(),
        revision: 4,
        createdAt: now,
        updatedAt: now,
        appliedAt: now,
        validationStartedAt: now,
        completedAt: now,
      };
      checkpoint = {
        id: patchOperation.checkpointId,
        operationId: patchOperation.id,
        patchId: patch.id,
        runId: patch.runId,
        targetPath: patch.targetPath,
        existed: patch.baseExists,
        sha256: patch.baseSha256,
        resultSha256: patchOperation.resultSha256,
        sizeBytes: patch.before.length,
        restoreState: "available",
        revision: 0,
        createdAt: now,
        updatedAt: now,
      };
      const appliedEvent: AgentRunEvent = {
        ...DEMO_EVENTS[3],
        id: crypto.randomUUID(),
        title: "Diff approved",
        status: "approved",
        createdAt: new Date().toISOString(),
      };
      return { patch: structuredClone(patch), operation: structuredClone(patchOperation), checkpoint: structuredClone(checkpoint), events: [appliedEvent] };
    },
    async rejectPatch() {
      patch.status = "rejected";
      patch.revision += 1;
      return structuredClone(patch);
    },
    async reconcilePatchOperation() {
      if (!patchOperation) throw new Error("No patch operation in preview mode.");
      return structuredClone(patchOperation);
    },
    async resumePatchValidation() {
      if (!patchOperation) throw new Error("No patch operation in preview mode.");
      patchOperation = { ...patchOperation, state: "verified", revision: patchOperation.revision + 1, updatedAt: new Date().toISOString() };
      return { operation: structuredClone(patchOperation), events: [] };
    },
    async prepareCheckpointRestore() {
      if (!checkpoint) throw new Error("No checkpoint in preview mode.");
      patch = {
        ...patch,
        id: crypto.randomUUID(),
        status: "pending",
        revision: 0,
        before: patch.after,
        after: patch.before,
        restoresCheckpointId: checkpoint.id,
        rationale: "Restore the durable checkpoint through a new reviewed diff.",
      };
      checkpoint = { ...checkpoint, restoreState: "restore-proposed", restorePatchId: patch.id, revision: checkpoint.revision + 1 };
      return structuredClone(patch);
    },
  },
  runs: {
    async list(includeArchived = false) {
      return runList
        .filter((run) => includeArchived || !run.archived)
        .map((run) => structuredClone(mockRunDetail(run.runId).summary));
    },
    async cockpit(): Promise<OperatorCockpitProjection> {
      return structuredClone(previewOperatorCockpit());
    },
    async searchEvidence(input): Promise<GlobalEvidenceSearchResult> {
      return structuredClone(previewGlobalEvidenceSearch(input));
    },
    async get(runId) {
      return mockRunDetail(runId).events;
    },
    async getDetail(runId) {
      return structuredClone(mockRunDetail(runId));
    },
    async createCheckpoint(runId) {
      const detail = mockRunDetail(runId);
      const createdAt = new Date().toISOString();
      const existing = taskCheckpoints.get(runId) ?? [];
      const sourceThread = detail.thread ?? {
        id: `preview-thread-${runId}`,
        workspacePath: settings.workspacePath,
        title: detail.summary.title,
        mode: "act" as const,
        modelId: models.find((model) => model.loadState === "active")?.id,
        createdAt: detail.summary.createdAt,
        updatedAt: createdAt,
      };
      const sourceMessages = messages.get(sourceThread.id) ?? detail.messages;
      const activeModel = models.find((model) => model.loadState === "active");
      const capabilitySnapshot: MissionCapabilitySnapshot = {
        schema: "proto-workbench.mission-capabilities.v1",
        digest: previewDigest(8),
        workspaceIdentity: "a".repeat(64),
        model: activeModel ? {
          id: activeModel.id,
          fingerprint: activeModel.fingerprint,
          toolCapability: activeModel.toolCapability,
          vision: activeModel.vision,
          active: true,
        } : undefined,
        runtime: { available: true, backend: "cuda", degraded: false },
        integrity: { ok: true, enforced: false, moduleSetSha256: previewDigest(6) },
        tools: { names: ["proto_check", "proto_review_packet", "workspace_read", "workspace_search"], digest: previewDigest(7) },
        network: { enabled: true, authorization: "per-call-hmac-capability" },
        filesystem: { relativePathsOnly: true, reparsePointsAllowed: false, atomicReplace: true },
        execution: { mode: "disabled", available: false, configured: false, providerVisible: false, imageDigestPinned: false, smokeVerified: false },
      };
      const goal = [...sourceMessages].reverse().find((message) => message.role === "user")?.content ?? detail.summary.title;
      const checkpoint: RunCheckpoint = {
        id: `preview-task-checkpoint-${runId}-${existing.length + 1}`,
        runId,
        sourceThreadId: sourceThread.id,
        workspacePath: sourceThread.workspacePath,
        workspaceIdentity: "a".repeat(64),
        sourceThread: structuredClone(sourceThread),
        messages: sourceMessages.map((message) => ({ ...structuredClone(message), sourceMessageId: message.id })),
        artifactRefs: [...new Set(detail.events.flatMap((event) => [...event.inputProvenance, ...event.outputArtifacts, ...event.evidenceIds]))],
        historyHead: structuredClone(detail.historyHead),
        missionRecipe: {
          schema: "proto-workbench.mission-recipe.v1",
          digest: previewDigest(9),
          title: sourceThread.title,
          mode: sourceThread.mode,
          goal,
          goalSha256: previewDigest(10),
          intent: { network: true, writes: false, execution: false },
          capabilities: capabilitySnapshot,
          createdAt,
        },
        snapshotDigest: previewDigest(existing.length + 12),
        createdAt,
      };
      taskCheckpoints.set(runId, [...existing, checkpoint]);
      return structuredClone(checkpoint);
    },
    async previewResume(checkpointId) {
      const checkpoint = [...taskCheckpoints.values()].flat().find((candidate) => candidate.id === checkpointId);
      if (!checkpoint) throw new Error("The preview task checkpoint was not found.");
      const currentCapabilities = structuredClone(checkpoint.missionRecipe?.capabilities) ?? {
        schema: "proto-workbench.mission-capabilities.v1" as const,
        digest: previewDigest(11),
        workspaceIdentity: checkpoint.workspaceIdentity,
        runtime: { available: true, backend: "cuda" as const, degraded: false },
        integrity: { ok: true, enforced: false, moduleSetSha256: previewDigest(6) },
        tools: { names: ["proto_check", "workspace_read"], digest: previewDigest(13) },
        network: { enabled: true, authorization: "per-call-hmac-capability" as const },
        filesystem: { relativePathsOnly: true, reparsePointsAllowed: false, atomicReplace: true },
        execution: { mode: "disabled" as const, available: false, configured: false, providerVisible: false, imageDigestPinned: false, smokeVerified: false },
      };
      currentCapabilities.digest = previewDigest(11);
      currentCapabilities.tools = {
        names: [...currentCapabilities.tools.names, "proto_crossref_search"],
        digest: previewDigest(13),
      };
      const contract: ResumeContract = {
        schema: "proto-workbench.resume-contract.v1",
        digest: previewDigest(14),
        issuedAt: new Date().toISOString(),
        checkpointId,
        checkpointSnapshotDigest: checkpoint.snapshotDigest,
        recipeDigest: checkpoint.missionRecipe?.digest,
        state: "review-required",
        launchable: true,
        currentCapabilities,
        drift: [
          { id: "workspace", title: "Workspace identity", state: "stable", before: "aaaaaaaa", now: "aaaaaaaa", detail: "The canonical workspace identity still matches." },
          { id: "integrity", title: "Module integrity", state: "stable", before: "trusted · 66666666", now: "trusted · 66666666", detail: "Core module identity still matches the saved recipe." },
          { id: "model", title: "Model identity", state: "stable", before: "GPT-OSS 20B", now: "GPT-OSS 20B · active", detail: "The saved local model remains active." },
          { id: "runtime", title: "Inference runtime", state: "stable", before: "CUDA · ready", now: "CUDA · ready", detail: "Runtime availability is unchanged." },
          { id: "tools", title: "Tool surface", state: "changed", before: "4 tools · 77777777", now: "5 tools · dddddddd", detail: "Crossref is newly available. Replayed reasoning may choose a different evidence path." },
          { id: "network", title: "Network authorization", state: "stable", before: "available · per-call approval", now: "available · per-call approval", detail: "No prior network approval is inherited." },
          { id: "filesystem", title: "Filesystem safety", state: "stable", before: "contained · atomic", now: "contained · atomic", detail: "Path containment and atomic replacement remain enforced." },
          { id: "execution", title: "Execution boundary", state: "stable", before: "Disabled", now: "Disabled", detail: "Execution remains disabled." },
        ],
        warnings: [],
        nextAction: "Review the added tool, then create a non-executing child task. Its first mission still requires a fresh Mission Preflight.",
      };
      return structuredClone(contract);
    },
    async forkCheckpoint(input) {
      const existingResult = forkResultsByIdempotencyKey.get(input.idempotencyKey);
      if (existingResult) {
        if (existingResult.fork.checkpointId !== input.checkpointId
          || existingResult.fork.snapshotDigest !== input.expectedSnapshotDigest
          || existingResult.fork.resumeContractDigest !== input.expectedResumeContractDigest) {
          throw new Error("The preview idempotency key is already bound to a different task checkpoint.");
        }
        return structuredClone(existingResult);
      }
      const checkpoint = [...taskCheckpoints.values()].flat().find((candidate) => candidate.id === input.checkpointId);
      if (!checkpoint) throw new Error("The preview task checkpoint was not found.");
      if (checkpoint.snapshotDigest !== input.expectedSnapshotDigest) throw new Error("The preview task checkpoint digest changed.");
      if (input.expectedResumeContractDigest !== previewDigest(14)) throw new Error("The preview resume contract changed.");
      const createdAt = new Date().toISOString();
      const thread: AgentThread = {
        ...structuredClone(checkpoint.sourceThread),
        id: `preview-fork-thread-${crypto.randomUUID()}`,
        title: input.title?.trim() || `${checkpoint.sourceThread.title} · fork`,
        createdAt,
        updatedAt: createdAt,
      };
      const forkMessages: ChatMessage[] = checkpoint.messages.map((message) => ({
        id: `preview-fork-message-${crypto.randomUUID()}`,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        attachments: message.attachments ? structuredClone(message.attachments) : undefined,
        toolName: message.toolName,
      }));
      const fork: RunFork = {
        id: `preview-run-fork-${crypto.randomUUID()}`,
        checkpointId: checkpoint.id,
        idempotencyKey: input.idempotencyKey,
        sourceThreadId: checkpoint.sourceThreadId,
        forkThreadId: thread.id,
        workspaceIdentity: checkpoint.workspaceIdentity,
        snapshotDigest: checkpoint.snapshotDigest,
        resumeContractDigest: input.expectedResumeContractDigest,
        createdAt,
      };
      threads.push(thread);
      forkThreadIds.add(thread.id);
      messages.set(thread.id, forkMessages);
      runForks.set(checkpoint.runId, [...(runForks.get(checkpoint.runId) ?? []), fork]);
      const result = { fork, thread, messages: forkMessages };
      forkResultsByIdempotencyKey.set(input.idempotencyKey, structuredClone(result));
      return structuredClone(result);
    },
    async archive(runId, archived) {
      runList = runList.map((run) => (run.runId === runId ? { ...run, archived } : run));
    },
  },
  reviews: {
    async get() {
      return structuredClone(review);
    },
    async updateChecklist(_runId, itemId, status) {
      review.checklist = review.checklist.map((item) => (item.id === itemId ? { ...item, status } : item));
      if (review.checklist.every((item) => item.status === "done")) review.gate = "ready";
      return structuredClone(review);
    },
    async addComment(runId, comment) {
      const item = { id: Date.now(), runId, comment, createdAt: new Date().toISOString() };
      reviewComments.set(runId, [...(reviewComments.get(runId) ?? []), item]);
      return structuredClone(item);
    },
    async listComments(runId) {
      return structuredClone(reviewComments.get(runId) ?? []);
    },
    async approve() {
      if (review.gate !== "ready") throw new Error("Complete the checklist first.");
      review = { ...review, gate: "approved", approvedAt: new Date().toISOString() };
      return structuredClone(review);
    },
  },
  approvals: {
    async list(): Promise<ToolApproval[]> {
      return [];
    },
    async resolve(_approvalId, _decision): Promise<ToolApproval> {
      throw new Error("No pending approval in preview mode.");
    },
  },
};

function notifyModels() {
  const snapshot = structuredClone(models);
  for (const listener of modelListeners) listener(snapshot);
}

function emit(event: StreamEvent) {
  for (const listener of streamListeners) listener(structuredClone(event));
}

return mockWorkbench;
}

const explicitLocalFixturePreview = !/\bElectron\//i.test(navigator.userAgent)
  && (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost")
  && window.location.search === "?fixtures=1";
const previewWorkbench = import.meta.env.DEV || explicitLocalFixturePreview ? createMockWorkbench() : undefined;

export const workbenchApi = () => {
  if (window.workbench) return window.workbench;
  if (previewWorkbench && !/\bElectron\//i.test(navigator.userAgent)) return previewWorkbench;
  throw new Error("The secure Electron preload bridge is unavailable. Proto Workbench will not fall back to demo data.");
};

export const workbenchDataMode = (): "desktop" | "preview" | "unavailable" => {
  if (window.workbench) return "desktop";
  if (previewWorkbench && !/\bElectron\//i.test(navigator.userAgent)) return "preview";
  return "unavailable";
};

type PreviewPersistedArtifactRef = PersistedRunArtifactRef & {
  sha256?: string;
  sizeBytes?: number;
};

export interface PreviewRunEvidenceFixture {
  runId: string;
  execution: RunExecutionProjectionOptions & {
    artifactRefs: PreviewPersistedArtifactRef[];
  };
}

/**
 * Explicit Stage 5 lineage is a development fixture only. Desktop runs receive
 * no synthetic references and therefore never infer an edge from a locator.
 */
export function previewRunEvidenceFixture(runId: string): PreviewRunEvidenceFixture | undefined {
  if (workbenchDataMode() !== "preview") return undefined;
  return {
    runId,
    execution: {
      artifactRefs: [
        {
          id: "preview-plan-output",
          stepId: "event-plan-102712",
          role: "output",
          index: 0,
          locator: "plan.yaml",
          sha256: "1".repeat(64),
          sizeBytes: 1840,
        },
        {
          id: "preview-plan-design-lineage",
          stepId: "event-design-104158",
          role: "input",
          index: 0,
          locator: "plan.yaml",
          sourceStepId: "event-plan-102712",
        },
        {
          id: "preview-design-output",
          stepId: "event-design-104158",
          role: "output",
          index: 0,
          locator: "designs/toggle_switch.proto",
          sha256: "2".repeat(64),
          sizeBytes: DEMO_PATCH.before.length,
        },
        {
          id: "preview-diff-current-checkpoint",
          stepId: "event-diff",
          role: "input",
          index: 0,
          locator: "designs/toggle_switch.proto (current)",
          sourceStepId: "event-design-104158",
          sha256: "3".repeat(64),
          sizeBytes: DEMO_PATCH.before.length,
        },
        {
          id: "preview-diff-proposal",
          stepId: "event-diff",
          role: "output",
          index: 0,
          locator: "designs/toggle_switch.proto (proposed)",
          sha256: "4".repeat(64),
          sizeBytes: DEMO_PATCH.after.length,
        },
        {
          id: "preview-validation-report",
          stepId: "event-validate-110247",
          role: "output",
          index: 0,
          locator: "build/validation_report.json",
          sha256: "5".repeat(64),
          sizeBytes: 2634,
        },
        {
          id: "preview-workflow-manifest",
          stepId: "event-validate-110305",
          role: "output",
          index: 0,
          locator: "build/runs/toggle_switch/manifest.json",
          sha256: "6".repeat(64),
          sizeBytes: JSON.stringify(DEMO_RUN_MANIFEST, null, 2).length,
        },
        {
          id: "preview-review-packet",
          stepId: "event-review-111834",
          role: "output",
          index: 0,
          locator: "build/reviews/toggle_switch/review_packet.json",
          sha256: "7".repeat(64),
          sizeBytes: 6120,
        },
      ],
    },
  };
}
