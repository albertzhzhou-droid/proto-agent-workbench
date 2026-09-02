import { pathToFileURL } from "node:url";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { IPC } from "../shared/ipc.ts";

const ID = z.string().min(1).max(128);
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
const IDEMPOTENCY_KEY = z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const FILE_PATH = z.string().min(1).max(4_096);
const REVISION = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const MODEL_OPTIONS = z.object({
  contextLength: z.number().int().min(256).max(2_097_152).optional(),
  gpuLayers: z.number().int().min(0).max(2_048).optional(),
  cacheType: z.enum(["f16", "q8_0", "q4_0"]).optional(),
  kvCachePlacement: z.enum(["gpu", "cpu"]).optional(),
  allowUnsafeMemoryPressure: z.boolean().optional(),
}).strict();
const RESIDENCY_POLICY = z.object({
  mode: z.enum(["quick-switch", "auto-evict"]),
  budgetBytes: z.number().int().min(2 * 1024 ** 3).max(Number.MAX_SAFE_INTEGER),
  warmTtlMinutes: z.number().int().min(1).max(24 * 60),
  pinnedModelIds: z.array(ID).max(128),
}).strict();
const MODULE_SETTINGS = z.object({
  profile: z.enum(["core-only", "research", "full", "custom"]),
  enabledOptional: z.array(z.enum([
    "evidence.pubmed",
    "evidence.europe-pmc",
    "evidence.crossref",
    "evidence.uniprot",
    "evidence.rhea",
    "analysis.python",
    "analysis.notebook",
    "analysis.r",
    "media.vision",
  ])).max(9),
}).strict();
const ATTACHMENT = z.object({
  path: FILE_PATH,
  name: z.string().min(1).max(512),
  mediaType: z.string().min(1).max(128),
  sizeBytes: z.number().int().min(0).max(1024 ** 3),
}).strict();
const MATERIALS_SEARCH = z.object({
  query: z.string().max(512).optional(),
  kind: z.string().max(128).optional(),
  organism: z.string().max(512).optional(),
  role: z.string().max(512).optional(),
  source: z.string().max(256).optional(),
  license_id: z.string().max(128).optional(),
  status: z.enum(["DESIGN_ELIGIBLE"]).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().max(512).optional(),
  snapshot: z.string().max(128).optional(),
}).strict();
const MATERIALS_SNAPSHOT_ID = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const MATERIALS_RESOURCE_ID = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*:[^\\/\\\\]+(?:[\\/\\\\][^\\/\\\\]+)*$/);
const MATERIALS_REVIEW = z.object({
  resource_id: MATERIALS_RESOURCE_ID,
  decision: z.enum(["accept", "reject", "hold"]),
  description_en: z.string().max(4_096).optional(),
  description_zh: z.string().max(4_096).optional(),
  reviewer: z.string().max(256).optional(),
  snapshot: MATERIALS_SNAPSHOT_ID.optional(),
}).strict();
const POLICY_SCENARIO_ID = z.enum([
  "current", "plan-posture", "act-posture", "network-unavailable", "execution-unavailable",
  "isolated-execution-ready", "workspace-drift", "model-chat-only", "strict-lockdown",
]);
const DECISION_BUNDLE_REDACTION = z.enum(["metadata-only", "include-goal-preview"]);
const TRUST_POLICY_AUTHORITY = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("keyless"),
    name: z.string().min(1).max(64),
    issuer: z.string().min(3).max(512),
    subject: z.string().min(3).max(512),
  }).strict(),
  z.object({
    kind: z.literal("public-key"),
    name: z.string().min(1).max(64),
    publicKeySha256: SHA256,
  }).strict(),
]);
const TRUST_POLICY_REQUEST = z.object({
  name: z.string().min(1).max(96),
  description: z.string().min(1).max(512),
  authorities: z.array(TRUST_POLICY_AUTHORITY).min(1).max(8),
  pinCurrentModuleManifest: z.boolean(),
}).strict();
const MAP_EXPORT_METADATA = z.object({
  schema: z.literal("proto-workbench.map-export.v1"),
  exportedAt: z.string().min(20).max(64),
  format: z.enum(["svg", "png"]),
  designId: z.string().min(1).max(512),
  construct: z.string().min(1).max(512),
  artifactPath: FILE_PATH.optional(),
  artifactSha256: SHA256.optional(),
  digestStatus: z.enum(["match", "mismatch", "unverified"]),
  renderer: z.object({ name: z.literal("CGView.js"), version: z.string().min(1).max(32) }).strict(),
  topology: z.object({
    source: z.enum(["linear", "circular", "unknown"]),
    rendered: z.enum(["linear", "circular"]),
    projection: z.boolean(),
  }).strict(),
  viewOrigin: z.object({
    applied: z.boolean(),
    sourceBaseOneBased: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    mutatesSource: z.literal(false),
  }).strict(),
  coordinates: z.literal("internal 0-based end-exclusive; display 1-based inclusive"),
  renderedMapLayers: z.object({
    partAnnotations: z.boolean(),
    softwareOrfDiscovery: z.boolean(),
    softwareOrfMinimumAminoAcids: z.number().int().min(1).max(10_000).nullable(),
    coordinateRuler: z.boolean(),
    gcContentPlot: z.boolean(),
    gcSkewPlot: z.boolean(),
    gcWindowSize: z.number().int().min(1).max(2_000_000),
    featureLabelDensity: z.enum(["hidden", "balanced", "dense"]),
    hiddenFeatureCount: z.number().int().min(0).max(20_000),
    selectionOverlay: z.literal(false),
  }).strict(),
  excludedUiOverlays: z.tuple([z.literal("selection")]),
  excludedSequenceLayers: z.tuple([z.literal("complement"), z.literal("restriction_sites"), z.literal("translations")]),
  reviewStatus: z.literal("human_review_required"),
  dataMode: z.enum(["desktop", "preview", "unavailable"]),
}).strict();
const MAP_EXPORT_REQUEST = z.object({
  format: z.enum(["svg", "png"]),
  filename: z.string().min(5).max(192).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:svg|png)$/),
  bytes: z.instanceof(Uint8Array).refine((value) => value.byteLength >= 32 && value.byteLength <= 16 * 1024 * 1024),
  width: z.number().int().min(64).max(4_096),
  height: z.number().int().min(64).max(4_096),
  metadata: MAP_EXPORT_METADATA,
}).strict().superRefine((value, context) => {
  if (!value.filename.endsWith(`.${value.format}`) || value.metadata.format !== value.format) {
    context.addIssue({ code: "custom", message: "Map export format bindings do not match." });
  }
});
const noArguments = z.tuple([]);
const schemas: Record<string, z.ZodType<unknown[]>> = {
  [IPC.settingsGet]: noArguments,
  [IPC.settingsUpdate]: z.tuple([z.object({
    residencyPolicy: RESIDENCY_POLICY.optional(),
    modules: MODULE_SETTINGS.optional(),
  }).strict()]),
  [IPC.runtimeStatus]: noArguments,
  [IPC.startupRecovery]: noArguments,
  [IPC.modulesIntegrity]: noArguments,
  [IPC.modulesAuditHistory]: z.tuple([z.number().int().min(1).max(100).optional()]),
  [IPC.modelsScan]: noArguments,
  [IPC.modelsList]: noArguments,
  [IPC.modelsEstimate]: z.tuple([ID, MODEL_OPTIONS.required({ contextLength: true, gpuLayers: true })]),
  [IPC.modelsLoad]: z.tuple([ID, MODEL_OPTIONS.optional()]),
  [IPC.modelsUnload]: z.tuple([ID]),
  [IPC.modelsPolicy]: z.tuple([RESIDENCY_POLICY]),
  [IPC.modelsPin]: z.tuple([ID, z.boolean()]),
  [IPC.harnessPreflight]: z.tuple([z.object({
    threadId: ID,
    content: z.string().min(1).max(131_072),
    attachments: z.array(ATTACHMENT).max(16).optional(),
  }).strict()]),
  [IPC.harnessPolicySimulation]: z.tuple([z.object({
    threadId: ID,
    content: z.string().min(1).max(8_192),
    attachments: z.array(ATTACHMENT).max(16).optional(),
    scenarioIds: z.array(POLICY_SCENARIO_ID).min(1).max(9),
  }).strict()]),
  [IPC.harnessDecisionBundlePreview]: z.tuple([z.object({
    threadId: ID,
    content: z.string().min(1).max(8_192),
    attachments: z.array(ATTACHMENT).max(16).optional(),
    scenarioIds: z.array(POLICY_SCENARIO_ID).min(1).max(9),
    selectedScenarioId: POLICY_SCENARIO_ID,
    redaction: DECISION_BUNDLE_REDACTION,
    expectedSimulationDigest: SHA256,
  }).strict()]),
  [IPC.harnessDecisionBundleExport]: z.tuple([z.object({
    threadId: ID,
    content: z.string().min(1).max(8_192),
    attachments: z.array(ATTACHMENT).max(16).optional(),
    scenarioIds: z.array(POLICY_SCENARIO_ID).min(1).max(9),
    selectedScenarioId: POLICY_SCENARIO_ID,
    redaction: DECISION_BUNDLE_REDACTION,
    expectedSimulationDigest: SHA256,
    expectedBundleDigest: SHA256,
  }).strict()]),
  [IPC.harnessDecisionBundleVerify]: noArguments,
  [IPC.harnessTrustPolicyPreview]: z.tuple([TRUST_POLICY_REQUEST]),
  [IPC.harnessTrustPolicyExport]: z.tuple([TRUST_POLICY_REQUEST.extend({ expectedPolicyDigest: SHA256 })]),
  [IPC.harnessTrustPolicyList]: noArguments,
  [IPC.harnessSignatureEvidenceImport]: noArguments,
  [IPC.harnessSignatureEvidenceList]: noArguments,
  [IPC.harnessTrustRootCandidateImport]: noArguments,
  [IPC.harnessTrustRootCandidateList]: noArguments,
  [IPC.harnessTransparencyWitnessImport]: noArguments,
  [IPC.harnessTransparencyWitnessList]: noArguments,
  [IPC.visualizationMapExport]: z.tuple([MAP_EXPORT_REQUEST]),
  [IPC.materialsStatus]: noArguments,
  [IPC.materialsSearch]: z.tuple([MATERIALS_SEARCH]),
  [IPC.materialsGet]: z.tuple([MATERIALS_RESOURCE_ID, z.boolean()]),
  [IPC.materialsFacets]: noArguments,
  [IPC.materialsActivate]: z.tuple([MATERIALS_SNAPSHOT_ID]),
  [IPC.materialsRollback]: z.tuple([MATERIALS_SNAPSHOT_ID]),
  [IPC.materialsSync]: z.tuple([z.enum(["uniprot", "igem", "rhea", "biomodels"]), z.number().int().min(1).max(2_000_000)]),
  [IPC.materialsImport]: noArguments,
  [IPC.materialsDiff]: z.tuple([MATERIALS_SNAPSHOT_ID, MATERIALS_SNAPSHOT_ID]),
  [IPC.materialsReview]: z.tuple([MATERIALS_REVIEW]),
  [IPC.threadsCreate]: z.tuple([z.object({
    title: z.string().max(256),
    mode: z.enum(["plan", "act"]),
    modelId: ID.optional(),
  }).strict()]),
  [IPC.threadsList]: noArguments,
  [IPC.threadsGet]: z.tuple([ID]),
  [IPC.threadsUpdate]: z.tuple([ID, z.object({
    title: z.string().max(256).optional(),
    mode: z.enum(["plan", "act"]).optional(),
    modelId: ID.optional(),
  }).strict()]),
  [IPC.threadsSend]: z.tuple([ID, z.string().min(1).max(131_072), SHA256, z.array(ATTACHMENT).max(16).optional()]),
  [IPC.threadsCancel]: z.tuple([ID]),
  [IPC.filesPickAttachments]: noArguments,
  [IPC.filesPickWorkspace]: noArguments,
  [IPC.filesPickModelRoot]: noArguments,
  [IPC.filesPickRuntime]: noArguments,
  [IPC.filesList]: noArguments,
  [IPC.filesOpen]: z.tuple([FILE_PATH]),
  [IPC.filesReveal]: z.tuple([FILE_PATH]),
  [IPC.filesRead]: z.tuple([FILE_PATH]),
  [IPC.filesSearch]: z.tuple([z.string().min(1).max(512), z.string().max(64).optional()]),
  [IPC.filesProposePatch]: z.tuple([z.object({
    runId: ID,
    targetPath: FILE_PATH,
    after: z.string().max(262_144),
    rationale: z.string().min(1).max(4_096),
  }).strict()]),
  [IPC.filesApplyPatch]: z.tuple([ID, REVISION]),
  [IPC.filesRejectPatch]: z.tuple([ID, REVISION]),
  [IPC.filesReconcilePatchOperation]: z.tuple([ID, REVISION]),
  [IPC.filesResumePatchValidation]: z.tuple([ID, REVISION]),
  [IPC.filesPrepareCheckpointRestore]: z.tuple([ID, REVISION]),
  [IPC.runsList]: z.tuple([z.boolean().optional()]),
  [IPC.runsCockpit]: noArguments,
  [IPC.runsSearchEvidence]: z.tuple([z.object({
    query: z.string().max(160).optional(),
    kinds: z.array(z.enum(["run", "event", "artifact", "claim", "checkpoint", "approval", "comment"])).max(7).optional(),
    lifecycleStates: z.array(z.enum([
      "pending", "running", "waiting-tool-approval", "waiting-patch-review", "applying-patch", "validating",
      "review-required", "ready-for-approval", "approved", "completed", "failed", "cancelled", "interrupted", "effect-unknown",
    ])).max(14).optional(),
    stages: z.array(z.enum(["goal", "plan", "design", "validate", "review"])).max(5).optional(),
    exactRunId: ID.optional(),
    includeArchived: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: z.string().min(1).max(512).optional(),
  }).strict()]),
  [IPC.runsGet]: z.tuple([ID]),
  [IPC.runsGetDetail]: z.tuple([ID]),
  [IPC.runsCreateCheckpoint]: z.tuple([ID]),
  [IPC.runsPreviewResume]: z.tuple([ID]),
  [IPC.runsForkCheckpoint]: z.tuple([z.object({
    checkpointId: ID,
    expectedSnapshotDigest: SHA256,
    expectedResumeContractDigest: SHA256,
    idempotencyKey: IDEMPOTENCY_KEY,
    title: z.string().max(200).optional(),
  }).strict()]),
  [IPC.runsArchive]: z.tuple([ID, z.boolean()]),
  [IPC.reviewsGet]: z.tuple([ID]),
  [IPC.reviewsUpdateChecklist]: z.tuple([ID, ID, z.enum(["done", "pending", "blocked"])]),
  [IPC.reviewsAddComment]: z.tuple([ID, z.string().min(1).max(16_384)]),
  [IPC.reviewsListComments]: z.tuple([ID]),
  [IPC.reviewsApprove]: z.tuple([ID]),
  [IPC.approvalsList]: z.tuple([ID.optional()]),
  [IPC.approvalsResolve]: z.tuple([ID, z.enum(["approved", "rejected"])]),
};

export interface RendererTarget {
  kind: "file" | "url";
  value: string;
  expectedUrl: string;
}

export function resolveRendererTarget(
  packaged: boolean,
  rendererEnvironmentUrl: string | undefined,
  rendererFile: string,
): RendererTarget {
  const fileUrl = pathToFileURL(rendererFile).href;
  if (packaged || !rendererEnvironmentUrl) {
    return { kind: "file", value: rendererFile, expectedUrl: fileUrl };
  }
  const url = new URL(rendererEnvironmentUrl);
  const loopbackHosts = new Set(["127.0.0.1", "[::1]"]);
  if (
    url.protocol !== "http:"
    || !loopbackHosts.has(url.hostname.toLowerCase())
    || !url.port
    || url.pathname !== "/"
    || url.search
    || url.hash
    || url.username
    || url.password
  ) {
    throw new Error("ELECTRON_RENDERER_URL must be an exact HTTP loopback origin in development.");
  }
  return { kind: "url", value: url.href, expectedUrl: url.href };
}

export function assertPrivilegedIpcSender(
  event: IpcMainInvokeEvent,
  mainWindow: BrowserWindow | null,
  expectedRendererUrl: string | undefined,
): void {
  if (
    !mainWindow
    || mainWindow.isDestroyed()
    || event.sender !== mainWindow.webContents
    || !event.senderFrame
    || event.senderFrame !== event.sender.mainFrame
    || !expectedRendererUrl
    || event.senderFrame.url !== expectedRendererUrl
  ) {
    throw new Error("Blocked privileged IPC from an untrusted renderer frame.");
  }
}

export function validateIpcArguments(channel: string, args: unknown[]): unknown[] {
  const schema = schemas[channel];
  if (!schema) throw new Error(`No privileged IPC schema is registered for ${channel}.`);
  const parsed = schema.safeParse(args);
  if (!parsed.success) throw new Error(`Invalid arguments for privileged IPC channel ${channel}.`);
  return parsed.data;
}
