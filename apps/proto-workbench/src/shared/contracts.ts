import type { ModuleIntegrityReport, ModuleSettings } from "./modules.ts";

export type ModelLoadState =
  | "unloaded"
  | "queued"
  | "loading"
  | "active"
  | "warm"
  | "error";

export type ToolCapability = "unknown" | "agent-ready" | "chat-only";

export type KvCacheType = "f16" | "q8_0" | "q4_0";
export type KvCachePlacement = "gpu" | "cpu";
export type MemoryPressure = "normal" | "tight" | "unsafe";

export interface ModelLoadOptions {
  /** Exact pre-loaded LM Studio instance to attach; never treated as Workbench-owned. */
  instanceId?: string;
  contextLength: number;
  gpuLayers: number;
  cacheType?: KvCacheType;
  kvCachePlacement?: KvCachePlacement;
  /** LM Studio native load option. */
  evalBatchSize?: number;
  /** LM Studio native load option. */
  flashAttention?: boolean;
  /** LM Studio native MoE load option. */
  numExperts?: number;
  allowUnsafeMemoryPressure?: boolean;
}

export interface LmStudioLoadedInstance {
  id: string;
  contextLength: number;
  evalBatchSize?: number;
  parallel?: number;
  flashAttention?: boolean;
  numExperts?: number;
  offloadKvCacheToGpu?: boolean;
}

export interface ModelReasoningCapability {
  allowed_options: Array<"off" | "on" | "low" | "medium" | "high">;
  default: "off" | "on" | "low" | "medium" | "high";
}

export interface VramEstimate {
  contextLength: number;
  gpuLayers: number;
  cacheType: KvCacheType;
  kvCachePlacement: KvCachePlacement;
  totalGpuLayers: number;
  offloadFraction: number;
  weightBytes: number;
  ramWeightBytes: number;
  kvCacheTotalBytes: number;
  kvCacheBytes: number;
  ramKvCacheBytes: number;
  computeBytes: number;
  ramComputeBytes: number;
  projectorBytes: number;
  ramProjectorBytes: number;
  runtimeBytes: number;
  ramRuntimeBytes: number;
  ramTotalBytes: number;
  totalBytes: number;
  systemRamTotalBytes?: number;
  systemRamAvailableBytes?: number;
  gpuVramAvailableBytes?: number;
  ramSafetyReserveBytes?: number;
  memoryPressure?: MemoryPressure;
  memoryDiagnostics?: string[];
  measuredBytes?: number;
  measuredAt?: string;
  source: "calculated" | "measured";
}

export interface ModelDescriptor {
  id: string;
  name: string;
  path: string;
  files: string[];
  sizeBytes: number;
  architecture: string;
  quantization: string;
  contextLength: number;
  blockCount?: number;
  embeddingLength?: number;
  attentionHeadCount?: number;
  attentionHeadCountKv?: number;
  attentionKeyLength?: number;
  attentionValueLength?: number;
  projectorSizeBytes?: number;
  vision: boolean;
  projectorPath?: string;
  toolCapability: ToolCapability;
  fingerprint: string;
  fingerprintSource?: "file-content" | "provider-metadata";
  estimatedVramBytes: number;
  measuredVramBytes?: number;
  vramEstimate?: VramEstimate;
  loadState: ModelLoadState;
  pinned: boolean;
  lastUsedAt?: string;
  error?: string;
  metadataSource: "gguf" | "filename" | "lmstudio";
  provider?: "lmstudio" | "llama.cpp";
  providerModelId?: string;
  publisher?: string;
  modelKind?: "llm" | "embedding";
  format?: string;
  paramsString?: string;
  description?: string;
  loadedInstances?: LmStudioLoadedInstance[];
  workbenchInstance?: {
    id: string;
    ownedByWorkbench: boolean;
  };
  reasoning?: ModelReasoningCapability;
}

export interface ModelInstance {
  modelId: string;
  instanceId?: string;
  provider?: "lmstudio" | "llama.cpp";
  ownedByWorkbench?: boolean;
  state: ModelLoadState;
  port?: number;
  contextLength: number;
  gpuLayers: number;
  cacheType?: KvCacheType;
  kvCachePlacement?: KvCachePlacement;
  evalBatchSize?: number;
  flashAttention?: boolean;
  numExperts?: number;
  estimatedVramBytes?: number;
  measuredVramBytes?: number;
  processId?: number;
  startedAt?: string;
  lastUsedAt?: string;
  error?: string;
}

export interface ResidencyPolicy {
  mode: "quick-switch" | "auto-evict";
  budgetBytes: number;
  warmTtlMinutes: number;
  pinnedModelIds: string[];
}

export type AgentStage = "goal" | "plan" | "design" | "validate" | "review";
export type AgentActor = "user" | "assistant" | "tool" | "system";
export type EventStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "approval-required"
  | "approved"
  | "rejected"
  | "cancelled"
  | "interrupted"
  | "effect-unknown";

export interface AgentRunEvent {
  id: string;
  runId: string;
  stage: AgentStage;
  actor: AgentActor;
  title: string;
  summary: string;
  tool?: string;
  inputProvenance: string[];
  outputArtifacts: string[];
  evidenceIds: string[];
  status: EventStatus;
  createdAt: string;
  completedAt?: string;
  payload?: Record<string, unknown>;
}

export interface PatchProposal {
  id: string;
  runId: string;
  targetPath: string;
  baseSha256: string;
  baseExists: boolean;
  before: string;
  after: string;
  afterExists: boolean;
  unifiedDiff: string;
  rationale: string;
  status: "pending" | "approved" | "rejected" | "stale" | "rolled-back";
  revision: number;
  restoresCheckpointId?: string;
  createdAt: string;
}

export type PatchOperationState =
  | "prepared"
  | "applying"
  | "applied"
  | "validating"
  | "verified"
  | "validation-failed"
  | "effect-unknown"
  | "conflict"
  | "rolled-back";

export interface PatchOperation {
  id: string;
  idempotencyKey: string;
  patchId: string;
  runId: string;
  targetPath: string;
  state: PatchOperationState;
  baseSha256: string;
  baseExists: boolean;
  resultSha256: string;
  resultExists: boolean;
  observedSha256?: string;
  checkpointId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  validationStartedAt?: string;
  completedAt?: string;
  recoveredAt?: string;
  error?: string;
}

export type ValidationStepKey =
  | "design-approval"
  | "artifact-boundary"
  | "proto-check"
  | "proto-workflow"
  | "review-packet";

export type ValidationStepEffect = "none" | "workspace-read" | "artifact-write";

export type ValidationStepState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "effect-unknown";

export interface ValidationStepPlan {
  key: ValidationStepKey;
  title: string;
  sequence: number;
  effect: ValidationStepEffect;
  inputSha256: string;
}

export interface ValidationJournalStep extends ValidationStepPlan {
  state: ValidationStepState;
  attempt: number;
  eventId?: string;
  eventIds: string[];
  outputSha256?: string;
  outputArtifacts: string[];
  evidenceIds: string[];
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  error?: string;
  invalidatedBy?: ValidationStepKey;
}

export interface ValidationJournalSnapshot {
  schema: "proto-workbench.validation-journal.v1";
  operationId: string;
  patchId: string;
  runId: string;
  planSha256: string;
  state: "pending" | "running" | "completed" | "failed" | "recovery-required";
  revision: number;
  steps: ValidationJournalStep[];
  nextStepKey?: ValidationStepKey;
  resumable: boolean;
  createdAt: string;
  updatedAt: string;
  snapshotAt: string;
  reconciliation?: {
    checkedAt: string;
    reason: string;
    repairedSteps: ValidationStepKey[];
  };
}

export interface FileCheckpoint {
  id: string;
  operationId: string;
  patchId: string;
  runId: string;
  targetPath: string;
  existed: boolean;
  sha256: string;
  resultSha256: string;
  sizeBytes: number;
  restoreState: "available" | "restore-proposed" | "restored" | "conflict";
  restorePatchId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  restoredAt?: string;
  conflictReason?: string;
}

export interface ToolApproval {
  id: string;
  runId: string;
  threadId: string;
  workspacePath: string;
  serviceSessionId: string;
  tool: string;
  arguments: Record<string, unknown>;
  argumentsSha256: string;
  risk: "write" | "network" | "code-execution";
  status: "pending" | "approved" | "rejected" | "expired" | "cancelled" | "stale";
  revision: number;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decisionKey?: string;
  consumedAt?: string;
  executionEventId?: string;
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface ChatAttachment {
  path: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
}

export type MissionPreflightState = "ready" | "approval-required" | "blocked";
export type MissionRequirementState = "ready" | "approval-required" | "blocked" | "deferred";
export type MissionRequirementId =
  | "integrity"
  | "workspace"
  | "runtime"
  | "model"
  | "attachments"
  | "network"
  | "writes"
  | "execution"
  | "human-review";

export interface MissionIntent {
  network: boolean;
  writes: boolean;
  execution: boolean;
}

export interface MissionRequirement {
  id: MissionRequirementId;
  title: string;
  state: MissionRequirementState;
  detail: string;
  action?: "launchpad" | "models" | "settings" | "edit-goal";
}

export interface MissionPreflightRequest {
  threadId: string;
  content: string;
  attachments?: ChatAttachment[];
}

/** Main-process-issued launch contract. The digest excludes issuedAt and binds every trusted input. */
export interface MissionPreflight {
  schema: "proto-workbench.mission-preflight.v1";
  digest: string;
  issuedAt: string;
  threadId: string;
  mode: "plan" | "act";
  modelId?: string;
  goalPreview: string;
  goalSha256: string;
  state: MissionPreflightState;
  launchable: boolean;
  intent: MissionIntent;
  requirements: MissionRequirement[];
  warnings: string[];
  nextAction: string;
}

export type PolicySimulationScenarioId =
  | "current"
  | "plan-posture"
  | "act-posture"
  | "network-unavailable"
  | "execution-unavailable"
  | "isolated-execution-ready"
  | "workspace-drift"
  | "model-chat-only"
  | "strict-lockdown";

export type PolicySimulationDeltaDirection =
  | "unchanged"
  | "more-restrictive"
  | "less-restrictive"
  | "posture-shift";

export interface PolicySimulationRequest extends MissionPreflightRequest {
  scenarioIds: PolicySimulationScenarioId[];
}

export interface PolicySimulationDelta {
  requirementId: MissionRequirementId;
  title: string;
  baselineState: MissionRequirementState;
  scenarioState: MissionRequirementState;
  direction: PolicySimulationDeltaDirection;
  detail: string;
}

export interface PolicySimulationScenario {
  id: PolicySimulationScenarioId;
  label: string;
  summary: string;
  hypothetical: boolean;
  decisionDigest: string;
  state: MissionPreflightState;
  wouldBeLaunchable: boolean;
  intent: MissionIntent;
  requirements: MissionRequirement[];
  deltas: PolicySimulationDelta[];
  determiningRequirements: MissionRequirementId[];
  warnings: string[];
  nextAction: string;
}

/** A bounded, read-only comparison. It is never accepted as a launch or approval contract. */
export interface PolicySimulationReport {
  schema: "proto-workbench.policy-simulation.v1";
  digest: string;
  decisionId: string;
  issuedAt: string;
  threadId: string;
  goalPreview: string;
  goalSha256: string;
  simulationOnly: true;
  executedEffects: [];
  baselineScenarioId: "current";
  scenarios: PolicySimulationScenario[];
  boundary: string;
  limits: {
    maxGoalCharacters: number;
    maxScenarios: number;
  };
}

export type DecisionBundleRedaction = "metadata-only" | "include-goal-preview";

export interface DecisionBundleRequest extends PolicySimulationRequest {
  selectedScenarioId: PolicySimulationScenarioId;
  redaction: DecisionBundleRedaction;
  expectedSimulationDigest: string;
}

export interface DecisionBundleExportRequest extends DecisionBundleRequest {
  expectedBundleDigest: string;
}

export interface DecisionBundleRequirementProjection {
  id: MissionRequirementId;
  title: string;
  state: MissionRequirementState;
  detail?: string;
}

export interface DecisionBundleDeltaProjection {
  requirementId: MissionRequirementId;
  title: string;
  baselineState: MissionRequirementState;
  scenarioState: MissionRequirementState;
  direction: PolicySimulationDeltaDirection;
  detail?: string;
}

export interface DecisionBundlePreview {
  schema: "proto-workbench.decision-bundle.v1";
  mediaType: "application/vnd.proto-workbench.decision-bundle+json";
  bundleId: string;
  bundleDigest: string;
  fileName: "decision-bundle.json";
  attestation: {
    _type: "https://in-toto.io/Statement/v1";
    subject: Array<{
      name: "policy-simulation-report";
      digest: { sha256: string };
    }>;
    predicateType: "urn:proto-workbench:attestation:policy-simulation:v1";
    predicate: {
      simulation: {
        digest: string;
        decisionId: string;
        scenarioCount: number;
        boundary: string;
        executedEffects: [];
      };
      goal: {
        sha256: string;
        preview: string | null;
      };
      context: {
        threadBindingSha256: string;
        attachmentCount: number;
      };
      selectedScenario: {
        id: PolicySimulationScenarioId;
        label: string;
        summary: string;
        hypothetical: boolean;
        decisionDigest: string;
        state: MissionPreflightState;
        wouldBeLaunchable: boolean;
        determiningRequirements: MissionRequirementId[];
        requirements: DecisionBundleRequirementProjection[];
        deltas: DecisionBundleDeltaProjection[];
        warnings: string[];
        warningsRedactedCount: number;
      };
      scenarioMatrix: Array<{
        id: PolicySimulationScenarioId;
        label: string;
        state: MissionPreflightState;
        hypothetical: boolean;
        decisionDigest: string;
        wouldBeLaunchable: boolean;
        determiningRequirements: MissionRequirementId[];
      }>;
      producer: {
        name: "Proto Workbench";
        version: string;
        moduleManifestSha256: string;
      };
    };
  };
  authentication: {
    status: "unsigned";
    envelope: "none";
    assurance: "content-digest-only";
    detail: string;
  };
  redaction: {
    profile: DecisionBundleRedaction;
    removed: string[];
    pathsAlwaysRedacted: true;
  };
  boundary: string;
}

export interface DecisionBundleExportReceipt {
  schema: "proto-workbench.decision-bundle-receipt.v1";
  bundleId: string;
  bundleDigest: string;
  bundleSha256: string;
  relativePath: string;
  checksumRelativePath: string;
  bytes: number;
  exportedAt: string;
  reused: boolean;
  signatureStatus: "unsigned";
}

export type MapExportFormat = "svg" | "png";

export interface MapExportMetadata {
  readonly schema: "proto-workbench.map-export.v1";
  readonly exportedAt: string;
  readonly format: MapExportFormat;
  readonly designId: string;
  readonly construct: string;
  readonly artifactPath: string;
  readonly artifactSha256: string;
  readonly artifactSizeBytes: number;
  readonly digestStatus: "match" | "mismatch" | "unverified";
  readonly governance: {
    readonly status: "verified" | "unverified";
    readonly unverifiedPartCount: number;
    readonly gaps: readonly string[];
  };
  readonly renderer: { readonly name: "CGView.js"; readonly version: string };
  readonly topology: {
    readonly source: "linear" | "circular" | "unknown";
    readonly rendered: "linear" | "circular";
    readonly projection: boolean;
  };
  readonly viewOrigin: {
    readonly applied: boolean;
    readonly sourceBaseOneBased: number;
    readonly mutatesSource: false;
  };
  readonly coordinates: "internal 0-based end-exclusive; display 1-based inclusive";
  readonly renderedMapLayers: {
    readonly partAnnotations: boolean;
    readonly primerBindings: boolean;
    readonly softwareOrfDiscovery: boolean;
    readonly softwareOrfMinimumAminoAcids: number | null;
    readonly coordinateRuler: boolean;
    readonly gcContentPlot: boolean;
    readonly gcSkewPlot: boolean;
    readonly gcWindowSize: number;
    readonly featureLabelDensity: "hidden" | "balanced" | "dense";
    readonly hiddenFeatureCount: number;
    readonly selectionOverlay: boolean;
  };
  readonly excludedUiOverlays: readonly ["selection"];
  readonly excludedSequenceLayers: readonly ["complement", "restriction_sites", "translations"];
  readonly reviewStatus: "human_review_required";
  readonly dataMode: "desktop" | "preview" | "unavailable";
}

export interface MapExportRequest {
  readonly format: MapExportFormat;
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly metadata: MapExportMetadata;
}

export interface MapExportVerificationReceipt {
  readonly schema: "proto-workbench.map-export-verification.v1";
  readonly status: "passed" | "preview-unverified";
  readonly format: MapExportFormat;
  readonly filename: string;
  readonly relativePath?: string;
  readonly metadataRelativePath?: string;
  readonly verificationRelativePath?: string;
  readonly sha256: string;
  readonly metadataSha256: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly exportedAt: string;
  readonly verifiedAt: string;
  readonly decoder: "electron-native-image" | "chromium-isolated-image" | "browser-preview";
  readonly pixelSha256?: string;
  readonly sampledColorCount?: number;
  readonly externalResourcesBlocked: boolean;
  readonly renderedMapLayers: MapExportMetadata["renderedMapLayers"];
  readonly reviewStatus: "human_review_required";
}

export type DecisionBundleVerificationState = "content-verified" | "tampered" | "invalid";
export type DecisionBundleVerificationCheckState = "passed" | "failed" | "not-checked";
export type DecisionBundleVerificationCheckId =
  | "directory"
  | "entries"
  | "bundle-file"
  | "checksum-file"
  | "checksum-match"
  | "schema"
  | "content-digest"
  | "subject-binding";

export interface DecisionBundleVerificationCheck {
  id: DecisionBundleVerificationCheckId;
  label: string;
  state: DecisionBundleVerificationCheckState;
  detail: string;
}

export interface DecisionBundleVerificationDiagnostic {
  code: string;
  title: string;
  detail: string;
}

export interface DecisionBundleVerificationEntry {
  directoryName: string;
  state: DecisionBundleVerificationState;
  signatureStatus: "unsigned" | "unknown";
  identityAssurance: "not-verified";
  bundleId?: string;
  bundleDigest?: string;
  bundleSha256?: string;
  expectedBundleSha256?: string;
  sourceSimulationSha256?: string;
  relativePath?: string;
  checksumRelativePath?: string;
  bytes?: number;
  observedModifiedAt?: string;
  redaction?: DecisionBundleRedaction;
  goalPreviewIncluded?: boolean;
  scenarioCount?: number;
  selectedScenario?: {
    id: PolicySimulationScenarioId;
    label: string;
    state: MissionPreflightState;
    hypothetical: boolean;
  };
  producer?: {
    name: "Proto Workbench";
    version: string;
    moduleManifestSha256: string;
  };
  checks: DecisionBundleVerificationCheck[];
  diagnostics: DecisionBundleVerificationDiagnostic[];
}

export interface DecisionBundleVerificationCatalog {
  schema: "proto-workbench.decision-bundle-verification.v1";
  digest: string;
  issuedAt: string;
  scannedDirectoryCount: number;
  returnedCount: number;
  truncated: boolean;
  summary: {
    contentVerified: number;
    tampered: number;
    invalid: number;
    unsigned: number;
  };
  entries: DecisionBundleVerificationEntry[];
  limits: {
    maxDirectories: number;
    maxDirectoryEntries: number;
    maxBundleBytes: number;
  };
  boundary: string;
}

export type TrustPolicyAuthorityInput =
  | {
      kind: "keyless";
      name: string;
      issuer: string;
      subject: string;
    }
  | {
      kind: "public-key";
      name: string;
      publicKeySha256: string;
    };

export interface TrustPolicyRequest {
  name: string;
  description: string;
  authorities: TrustPolicyAuthorityInput[];
  pinCurrentModuleManifest: boolean;
}

export interface TrustPolicyExportRequest extends TrustPolicyRequest {
  expectedPolicyDigest: string;
}

export type TrustPolicyAuthority =
  | {
      kind: "keyless";
      name: string;
      certificateIssuer: string;
      certificateIdentity: string;
      trustRoot: "sigstore-public-good";
      requireTransparencyLog: true;
    }
  | {
      kind: "public-key";
      name: string;
      publicKeySha256: string;
    };

export interface TrustPolicyPreview {
  schema: "proto-workbench.trust-policy.v1";
  mediaType: "application/vnd.proto-workbench.trust-policy+json";
  policyId: string;
  policyDigest: string;
  fileName: "trust-policy.json";
  name: string;
  description: string;
  appliesTo: {
    bundleMediaType: "application/vnd.proto-workbench.decision-bundle+json";
    statementType: "https://in-toto.io/Statement/v1";
    predicateType: "urn:proto-workbench:attestation:policy-simulation:v1";
    producerName: "Proto Workbench";
    moduleManifestSha256?: string;
  };
  verification: {
    authorityMode: "any-of";
    authorities: TrustPolicyAuthority[];
    requireArtifactDigest: true;
    requireSignedTimeEvidence: true;
    allowNetworkFetch: false;
  };
  authentication: {
    status: "policy-only";
    assurance: "no-signature-evaluated";
    detail: string;
  };
  boundary: string;
}

export interface TrustPolicyExportReceipt {
  schema: "proto-workbench.trust-policy-receipt.v1";
  policyId: string;
  policyDigest: string;
  policySha256: string;
  relativePath: string;
  checksumRelativePath: string;
  bytes: number;
  exportedAt: string;
  reused: boolean;
}

export type TrustPolicyCatalogState = "valid" | "tampered" | "invalid";

export interface TrustPolicyCatalogEntry {
  directoryName: string;
  state: TrustPolicyCatalogState;
  policyId?: string;
  policyDigest?: string;
  policySha256?: string;
  expectedPolicySha256?: string;
  name?: string;
  description?: string;
  authorities?: TrustPolicyAuthority[];
  moduleManifestSha256?: string;
  relativePath?: string;
  checksumRelativePath?: string;
  bytes?: number;
  observedModifiedAt?: string;
  diagnostics: DecisionBundleVerificationDiagnostic[];
}

export interface TrustPolicyCatalog {
  schema: "proto-workbench.trust-policy-catalog.v1";
  digest: string;
  issuedAt: string;
  scannedDirectoryCount: number;
  returnedCount: number;
  truncated: boolean;
  summary: {
    valid: number;
    tampered: number;
    invalid: number;
    authorities: number;
  };
  entries: TrustPolicyCatalogEntry[];
  limits: {
    maxDirectories: number;
    maxDirectoryEntries: number;
    maxPolicyBytes: number;
  };
  boundary: string;
}

export type SignatureEvidenceState = "verified" | "incomplete" | "rejected" | "invalid";
export type SignatureEvidenceCheckState = "passed" | "failed" | "missing" | "not-checked";
export type SignatureEvidenceCheckId =
  | "directory"
  | "entries"
  | "checksums"
  | "decision-bundle"
  | "trust-policy"
  | "module-manifest"
  | "sigstore-bundle"
  | "artifact-binding"
  | "cryptographic-signature"
  | "trusted-time"
  | "trust-root"
  | "authority-identity";

export interface SignatureEvidenceCheck {
  id: SignatureEvidenceCheckId;
  label: string;
  state: SignatureEvidenceCheckState;
  detail: string;
}

export interface SignatureEvidenceIdentity {
  kind: "keyless" | "public-key";
  authorityName?: string;
  certificateIssuer?: string;
  certificateIdentity?: string;
  publicKeySha256?: string;
}

export interface SignatureEvidenceEntry {
  directoryName: string;
  state: SignatureEvidenceState;
  evidenceId?: string;
  bundleId?: string;
  bundleDigest?: string;
  policyId?: string;
  policyDigest?: string;
  artifactSha256?: string;
  signatureBundleSha256?: string;
  signatureMediaType?: "application/vnd.dev.sigstore.bundle.v0.3+json";
  signatureContent?: "message-signature" | "dsse-envelope";
  relativePath?: string;
  observedModifiedAt?: string;
  identity?: SignatureEvidenceIdentity;
  signedTime?: {
    status: "verified" | "missing" | "rejected";
    source?: "transparency-log" | "timestamp-authority";
    observedAt?: string;
  };
  trustRoot?: {
    name: "sigstore-public-good" | "policy-pinned-public-key";
    sha256: string;
    mediaType?: string;
    source: string;
  };
  checks: SignatureEvidenceCheck[];
  diagnostics: DecisionBundleVerificationDiagnostic[];
}

export interface SignatureEvidenceCatalog {
  schema: "proto-workbench.signature-evidence-catalog.v1";
  digest: string;
  issuedAt: string;
  scannedDirectoryCount: number;
  returnedCount: number;
  truncated: boolean;
  summary: {
    verified: number;
    incomplete: number;
    rejected: number;
    invalid: number;
  };
  trustRootSnapshot: {
    name: "sigstore-public-good";
    sha256: string;
    mediaType: string;
    source: string;
    updatePolicy: "manual-reviewed-replacement";
  };
  entries: SignatureEvidenceEntry[];
  limits: {
    maxDirectories: number;
    maxDirectoryEntries: number;
    maxArtifactBytes: number;
    maxSignatureBundleBytes: number;
  };
  boundary: string;
}

export interface SignatureEvidenceImportReceipt {
  schema: "proto-workbench.signature-evidence-import.v1";
  evidenceId: string;
  relativePath: string;
  importedAt: string;
  reused: boolean;
  files: string[];
}

export type TrustRootLifecycleState = "reviewable" | "current" | "rejected" | "invalid";
export type TrustRootLifecycleMode = "metadata-refresh" | "root-rotation";
export type TrustRootLifecycleCheckState = "passed" | "failed" | "warning" | "not-checked";
export type TrustRootLifecycleCheckId =
  | "directory"
  | "entries"
  | "checksums"
  | "source-record"
  | "anchor-root"
  | "root-version"
  | "old-root-threshold"
  | "new-root-threshold"
  | "root-expiry"
  | "timestamp-signature"
  | "timestamp-freshness"
  | "snapshot-binding"
  | "snapshot-signature"
  | "snapshot-freshness"
  | "targets-binding"
  | "targets-signature"
  | "targets-freshness"
  | "trusted-root-binding"
  | "trusted-root-structure"
  | "rollback-protection"
  | "change-classification";

export interface TrustRootLifecycleCheck {
  id: TrustRootLifecycleCheckId;
  label: string;
  state: TrustRootLifecycleCheckState;
  detail: string;
}

export interface TrustRootLifecycleRoleSnapshot {
  version: number;
  expires: string;
  sha256: string;
}

export interface TrustRootLifecycleEntry {
  directoryName: string;
  state: TrustRootLifecycleState;
  mode?: TrustRootLifecycleMode;
  candidateId?: string;
  relativePath?: string;
  source?: string;
  sourceCommit?: string;
  importedAt?: string;
  observedModifiedAt?: string;
  root?: {
    currentVersion: number;
    candidateVersion: number;
    currentThreshold: number;
    candidateThreshold: number;
    sha256: string;
    expires: string;
  };
  timestamp?: TrustRootLifecycleRoleSnapshot;
  snapshot?: TrustRootLifecycleRoleSnapshot;
  targets?: TrustRootLifecycleRoleSnapshot;
  trustedRoot?: {
    sha256: string;
    semanticSha256: string;
    installedSemanticSha256: string;
    changed: boolean;
    tlogCount: number;
    ctlogCount: number;
    certificateAuthorityCount: number;
    timestampAuthorityCount: number;
  };
  checks: TrustRootLifecycleCheck[];
  diagnostics: string[];
}

export interface TrustRootLifecycleCatalog {
  schema: "proto-workbench.trust-root-lifecycle-catalog.v1";
  digest: string;
  issuedAt: string;
  scannedDirectoryCount: number;
  returnedCount: number;
  truncated: boolean;
  summary: {
    reviewable: number;
    current: number;
    rejected: number;
    invalid: number;
  };
  anchor: {
    name: "sigstore-public-good";
    rootVersion: number;
    rootSha256: string;
    rootExpires: string;
    rootThreshold: number;
    timestampVersion: number;
    snapshotVersion: number;
    targetsVersion: number;
    trustedRootSha256: string;
    source: string;
    updatePolicy: "offline-review-only";
  };
  entries: TrustRootLifecycleEntry[];
  limits: {
    maxDirectories: number;
    maxDirectoryEntries: number;
    maxMetadataBytes: number;
    maxTargetBytes: number;
  };
  boundary: string;
}

export interface TrustRootLifecycleImportReceipt {
  schema: "proto-workbench.trust-root-lifecycle-import.v1";
  candidateId: string;
  relativePath: string;
  importedAt: string;
  reused: boolean;
  files: string[];
}

export type TransparencyWitnessState = "witnessed" | "current" | "rejected" | "invalid";
export type TransparencyWitnessCheckState = "passed" | "failed" | "not-checked";
export type TransparencyWitnessCheckId =
  | "directory"
  | "entries"
  | "checksums"
  | "source-record"
  | "policy-anchor"
  | "anchor-checkpoint"
  | "checkpoint-format"
  | "log-signature"
  | "witness-quorum"
  | "witness-time"
  | "leaf-binding"
  | "inclusion-structure"
  | "inclusion-proof"
  | "consistency-structure"
  | "consistency-proof"
  | "rollback-protection"
  | "fork-detection";

export interface TransparencyWitnessCheck {
  id: TransparencyWitnessCheckId;
  label: string;
  state: TransparencyWitnessCheckState;
  detail: string;
}

export interface TransparencyWitnessSignature {
  name: string;
  keyId: string;
  state: "verified" | "missing" | "rejected" | "unknown";
  signedAt?: string;
  detail: string;
}

export interface TransparencyWitnessCheckpoint {
  origin: string;
  treeSize: string;
  rootHash: string;
  bodySha256: string;
}

export interface TransparencyWitnessEntry {
  directoryName: string;
  state: TransparencyWitnessState;
  packId?: string;
  relativePath?: string;
  source?: string;
  retrievedAt?: string;
  observedModifiedAt?: string;
  anchor?: TransparencyWitnessCheckpoint;
  checkpoint?: TransparencyWitnessCheckpoint;
  logKeyId?: string;
  witnessQuorum?: {
    required: number;
    verified: number;
    configured: number;
  };
  witnesses?: TransparencyWitnessSignature[];
  inclusion?: {
    logIndex: string;
    treeSize: string;
    leafSha256: string;
    proofHashCount: number;
  };
  consistency?: {
    oldSize: string;
    newSize: string;
    proofHashCount: number;
  };
  checks: TransparencyWitnessCheck[];
  diagnostics: string[];
}

export interface TransparencyWitnessCatalog {
  schema: "proto-workbench.transparency-witness-catalog.v1";
  digest: string;
  issuedAt: string;
  scannedDirectoryCount: number;
  returnedCount: number;
  truncated: boolean;
  summary: {
    witnessed: number;
    current: number;
    rejected: number;
    invalid: number;
  };
  policy: {
    name: string;
    sha256: string;
    origin: string;
    logKeyId: string;
    witnessQuorum: number;
    witnessCount: number;
    anchorTreeSize: string;
    anchorRootHash: string;
    anchorBodySha256: string;
    retrievedAt: string;
    trustedRootSha256: string;
    source: string;
    updatePolicy: "offline-reviewed-release";
  };
  entries: TransparencyWitnessEntry[];
  limits: {
    maxDirectories: number;
    maxDirectoryEntries: number;
    maxNoteBytes: number;
    maxProofBytes: number;
    maxLeafBytes: number;
  };
  boundary: string;
}

export interface TransparencyWitnessImportReceipt {
  schema: "proto-workbench.transparency-witness-import.v1";
  packId: string;
  relativePath: string;
  importedAt: string;
  reused: boolean;
  files: string[];
}

export type ResumeDriftState = "stable" | "changed" | "blocked" | "unavailable";
export type ResumeDriftId =
  | "workspace"
  | "integrity"
  | "model"
  | "runtime"
  | "tools"
  | "network"
  | "filesystem"
  | "execution";

/** Redacted, content-addressed environment facts captured by the trusted main process. */
export interface MissionCapabilitySnapshot {
  schema: "proto-workbench.mission-capabilities.v1";
  digest: string;
  workspaceIdentity: string;
  model?: {
    id: string;
    fingerprint: string;
    toolCapability: ToolCapability;
    vision: boolean;
    active: boolean;
  };
  runtime: {
    available: boolean;
    backend?: "cuda" | "cpu";
    degraded: boolean;
  };
  integrity: {
    ok: boolean;
    enforced: boolean;
    manifestSha256?: string;
    moduleSetSha256: string;
  };
  tools: {
    names: string[];
    digest: string;
  };
  network: {
    enabled: boolean;
    authorization: "per-call-hmac-capability";
  };
  filesystem: {
    relativePathsOnly: boolean;
    reparsePointsAllowed: boolean;
    atomicReplace: boolean;
  };
  execution: {
    mode: "unsafe-host" | "oci" | "disabled";
    available: boolean;
    configured: boolean;
    providerVisible: boolean;
    imageDigestPinned: boolean;
    smokeVerified: boolean;
  };
}

/** Reusable mission intent embedded in an immutable task checkpoint. */
export interface MissionRecipe {
  schema: "proto-workbench.mission-recipe.v1";
  digest: string;
  title: string;
  mode: "plan" | "act";
  goal: string;
  goalSha256: string;
  intent: MissionIntent;
  capabilities: MissionCapabilitySnapshot;
  createdAt: string;
}

export interface ResumeDrift {
  id: ResumeDriftId;
  title: string;
  state: ResumeDriftState;
  before: string;
  now: string;
  detail: string;
  action?: "launchpad" | "models" | "settings";
}

/** Main-process-issued, single-review contract for creating a non-executing child task. */
export interface ResumeContract {
  schema: "proto-workbench.resume-contract.v1";
  digest: string;
  issuedAt: string;
  checkpointId: string;
  checkpointSnapshotDigest: string;
  recipeDigest?: string;
  state: "ready" | "review-required" | "blocked";
  launchable: boolean;
  currentCapabilities: MissionCapabilitySnapshot;
  drift: ResumeDrift[];
  warnings: string[];
  nextAction: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt: string;
  attachments?: ChatAttachment[];
  toolName?: string;
}

export interface AgentThread {
  id: string;
  workspacePath: string;
  title: string;
  mode: "plan" | "act";
  modelId?: string;
  createdAt: string;
  updatedAt: string;
}

/** One immutable revision in the durable, per-run event ledger. */
export interface RunEventHistoryRevision {
  historyId: string;
  runId: string;
  eventId: string;
  sequence: number;
  eventRevision: number;
  stage: AgentStage;
  status: EventStatus;
  rawPayload: string;
  createdAt: string;
  recordedAt: string;
  snapshotSha256: string;
  previousSha256: string;
  entrySha256: string;
}

export interface RunHistoryHead {
  sequence: number;
  entrySha256: string;
}

export interface RunCheckpointMessage extends ChatMessage {
  sourceMessageId: string;
}

/** Immutable task-context snapshot. It never represents a workspace restore point. */
export interface RunCheckpoint {
  id: string;
  runId: string;
  sourceThreadId: string;
  workspacePath: string;
  workspaceIdentity: string;
  sourceThread: AgentThread;
  messages: RunCheckpointMessage[];
  artifactRefs: string[];
  historyHead: RunHistoryHead;
  missionRecipe?: MissionRecipe;
  snapshotDigest: string;
  createdAt: string;
}

export interface RunFork {
  id: string;
  checkpointId: string;
  idempotencyKey: string;
  sourceThreadId: string;
  forkThreadId: string;
  workspaceIdentity: string;
  snapshotDigest: string;
  resumeContractDigest?: string;
  createdAt: string;
}

export interface RunForkResult {
  fork: RunFork;
  thread: AgentThread;
  messages: ChatMessage[];
}

export interface RunCheckpointForkRequest {
  checkpointId: string;
  expectedSnapshotDigest: string;
  expectedResumeContractDigest: string;
  idempotencyKey: string;
  title?: string;
}

export interface ReviewChecklistItem {
  id: string;
  label: string;
  status: "done" | "pending" | "blocked";
}

export interface EvidenceClaim {
  id: string;
  claim: string;
  evidence: string[];
  status: "supported" | "failed" | "needs-review" | "not-applicable";
}

export interface ReviewPacketView {
  runId: string;
  operationId?: string;
  validationPlanSha256?: string;
  validationJournalRevision?: number;
  packetSha256?: string;
  packetPath?: string;
  gate: "ready" | "blocked" | "review-required" | "approved";
  approvedAt?: string;
  summary: string;
  claims: EvidenceClaim[];
  checklist: ReviewChecklistItem[];
  unresolvedQuestions: string[];
  safetyBoundary: string;
}

export interface AppSettings {
  inference: {
    provider: "lmstudio";
    baseUrl: "http://127.0.0.1:1234";
    tokenEnvNames: ["LMSTUDIO_API_KEY", "LM_API_TOKEN"];
    explicitLoadOnly: true;
  };
  workspacePath: string;
  residencyPolicy: ResidencyPolicy;
  modules: ModuleSettings;
}

export type AppSettingsUpdate = Partial<Pick<AppSettings, "residencyPolicy" | "modules">>;

export interface WorkspaceEntry {
  path: string;
  relativePath: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  modifiedAt: string;
}

export type MaterialsReviewStatus = "DESIGN_ELIGIBLE" | "REVIEW_REQUIRED" | "REFERENCE_ONLY" | "QUARANTINED";

export interface MaterialsSnapshotSummary {
  snapshot_id: string;
  record_count: number;
  catalog_record_count?: number;
  quarantine_record_count?: number;
  status_counts: Record<string, number>;
  source_counts?: Record<string, number>;
  sources?: Array<Record<string, unknown>>;
  active?: boolean;
  manifest_sha256?: string;
}

export interface MaterialsStatus {
  ok: boolean;
  schema_version: string;
  active_snapshot?: string | null;
  snapshots: MaterialsSnapshotSummary[];
  staging: string[];
  overlays?: Array<Record<string, unknown>>;
}

export interface MaterialsActivationEvidence {
  /** Operator-supplied label only; this is not an authenticated identity. */
  operator: string;
  /** Reference to an external approval, review, or change record. */
  approval_reference: string;
}

export interface MaterialSummary {
  resource_id: string;
  kind: string;
  name: string;
  aliases: string[];
  description_en: string;
  description_zh: string;
  organism: Record<string, unknown>;
  chassis: string[];
  role_terms: string[];
  part_type: string;
  sequence_kind: string;
  sequence_length: number;
  sequence_sha256: string;
  source: Record<string, unknown>;
  license: Record<string, unknown>;
  evidence_refs: string[];
  review_status: MaterialsReviewStatus;
  safety_status: string;
  safety_flags: string[];
  design_eligibility: boolean;
  metadata: Record<string, unknown>;
  sequence?: string;
}

export interface MaterialsSearchRequest {
  query?: string;
  kind?: string;
  organism?: string;
  role?: string;
  source?: string;
  license_id?: string;
  limit?: number;
  cursor?: string;
  snapshot?: string;
}

export interface MaterialsSearchResult {
  ok: boolean;
  snapshot_id: string;
  matches: MaterialSummary[];
  match_count: number;
  returned_count: number;
  truncated: boolean;
  next_cursor?: string;
}

export interface MaterialsMaterializeRequest {
  resource_ids: string[];
  chassis: string;
  /** Reproducibility assertion; must remain the active snapshot. */
  snapshot: string;
}

export interface MaterialsMaterializeResult {
  ok: true;
  snapshot_id: string;
  selection_digest: string;
  parts_path: string;
  part_count: number;
}

export interface MaterialsFacets {
  ok: boolean;
  snapshot_id: string;
  kinds: Record<string, number>;
  statuses: Record<string, number>;
  safety: Record<string, number>;
  sources: Record<string, number>;
  licenses: Record<string, number>;
}

export interface MaterialsReviewInput {
  resource_id: string;
  decision: "accept" | "reject" | "hold";
  description_en?: string;
  description_zh?: string;
  reviewer?: string;
  snapshot?: string;
}

export type GlobalEvidenceKind = "run" | "event" | "artifact" | "claim" | "checkpoint" | "approval" | "comment";
export type GlobalEvidenceBinding = "content-addressed" | "revision-bound" | "recorded-locator";

export interface GlobalEvidenceSearchRequest {
  query?: string;
  kinds?: GlobalEvidenceKind[];
  lifecycleStates?: RunLifecycleState[];
  stages?: AgentStage[];
  exactRunId?: string;
  includeArchived?: boolean;
  limit?: number;
  cursor?: string;
}

export interface GlobalEvidenceTarget {
  view: "runs" | "reviews";
  evidenceTab?: "timeline" | "topology" | "artifacts";
  eventId?: string;
  artifactLocator?: string;
}

/** Redacted, content-addressed search result backed by one accessible RunDetail revision. */
export interface GlobalEvidenceHit {
  id: string;
  digest: string;
  kind: GlobalEvidenceKind;
  binding: GlobalEvidenceBinding;
  evidenceDigest?: string;
  runId: string;
  runTitle: string;
  runCreatedAt: string;
  snapshotRevision: string;
  lifecycleState: RunLifecycleState;
  title: string;
  summary: string;
  status: string;
  occurredAt: string;
  stage?: AgentStage;
  actor?: AgentActor;
  locator?: string;
  tags: string[];
  target: GlobalEvidenceTarget;
}

export interface GlobalEvidenceSearchResult {
  schema: "proto-workbench.global-evidence.v1";
  catalogDigest: string;
  digest: string;
  issuedAt: string;
  query: string;
  sourceRunCount: number;
  indexedItemCount: number;
  totalHits: number;
  returnedCount: number;
  truncated: boolean;
  nextCursor?: string;
  hits: GlobalEvidenceHit[];
  facets: {
    kinds: Record<GlobalEvidenceKind, number>;
    lifecycleStates: Partial<Record<RunLifecycleState, number>>;
    stages: Record<AgentStage, number>;
    bindings: Record<GlobalEvidenceBinding, number>;
  };
  limits: {
    runScan: number;
    eventsPerRun: number;
    artifactsPerRun: number;
    claimsPerRun: number;
    checkpointsPerRun: number;
    approvalsPerRun: number;
    commentsPerRun: number;
    queryCharacters: number;
    hitsPerPage: number;
  };
}

export interface RunSummary {
  runId: string;
  title: string;
  createdAt: string;
  status: EventStatus;
  archived: boolean;
  lifecycle: RunLifecycleProjection;
}

export type OperatorAttentionPriority = "critical" | "high" | "normal" | "monitoring";

export type OperatorAttentionAction =
  | "review-tool"
  | "review-patch"
  | "review-validation"
  | "review-effect"
  | "review-human"
  | "inspect-recovery"
  | "inspect-failure"
  | "open-run";

export interface OperatorAttentionItem {
  id: string;
  digest: string;
  runId: string;
  runTitle: string;
  runCreatedAt: string;
  snapshotRevision: string;
  attention: RunAttention;
  priority: OperatorAttentionPriority;
  label: string;
  detail: string;
  action: OperatorAttentionAction;
  actionLabel: string;
  target: "runs" | "reviews";
}

export interface MissionLibraryEntry {
  id: string;
  digest: string;
  source: "builtin" | "checkpoint";
  title: string;
  summary: string;
  mode: "plan" | "act";
  goal: string;
  intent: MissionIntent;
  sourceRunId?: string;
  recipeDigest?: string;
  capturedAt?: string;
}

export interface OperatorCockpitProjection {
  schema: "proto-workbench.operator-cockpit.v1";
  digest: string;
  issuedAt: string;
  sourceRunCount: number;
  attentionItems: OperatorAttentionItem[];
  attentionCounts: {
    total: number;
    approvals: number;
    recovery: number;
    monitoring: number;
  };
  missionLibrary: MissionLibraryEntry[];
  limits: {
    runScan: number;
    attentionItems: number;
    checkpointRecipes: number;
  };
}

export type RunLifecycleState =
  | "pending"
  | "running"
  | "waiting-tool-approval"
  | "waiting-patch-review"
  | "applying-patch"
  | "validating"
  | "review-required"
  | "ready-for-approval"
  | "approved"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "effect-unknown";

export type RunAttention =
  | "none"
  | "tool-approval"
  | "patch-review"
  | "patch-operation"
  | "validation"
  | "human-review"
  | "failure"
  | "recovery";

export interface RunLifecycleProjection {
  state: RunLifecycleState;
  attention: RunAttention;
  label: string;
  detail: string;
  terminal: boolean;
}

export interface RunAllowedActions {
  reviewPatch: boolean;
  approvePatch: boolean;
  rejectPatch: boolean;
  resolveToolApproval: boolean;
  reconcilePatchEffect: boolean;
  resumePatchValidation: boolean;
  prepareCheckpointRestore: boolean;
  updateReviewChecklist: boolean;
  approveRun: boolean;
}

export interface RunDetail {
  revision: string;
  snapshotAt: string;
  summary: RunSummary;
  events: AgentRunEvent[];
  eventHistory: RunEventHistoryRevision[];
  historyHead: RunHistoryHead;
  taskCheckpoints: RunCheckpoint[];
  runForks: RunFork[];
  patches: PatchProposal[];
  activePatch?: PatchProposal;
  patchOperations: PatchOperation[];
  activePatchOperation?: PatchOperation;
  validationJournals?: ValidationJournalSnapshot[];
  checkpoints: FileCheckpoint[];
  approvals: ToolApproval[];
  review: ReviewPacketView;
  comments: ReviewComment[];
  threadId?: string;
  workspacePath?: string;
  thread?: AgentThread;
  messages: ChatMessage[];
  contextWarning?: string;
  allowedActions: RunAllowedActions;
}

export interface ReviewComment {
  id: number;
  runId: string;
  comment: string;
  createdAt: string;
}

export interface RuntimeStatus {
  available: boolean;
  provider?: "lmstudio" | "llama.cpp";
  endpoint?: string;
  modelCount?: number;
  loadedModelCount?: number;
  path?: string;
  backend?: "cuda" | "cpu";
  degraded?: boolean;
  detail: string;
}

export interface StartupRecoveryReport {
  checkedAt: string;
  recoveredRuns: number;
  recoveredEvents: number;
  invalidatedApprovals: number;
  reconciledPatchOperations: number;
  conflictedPatchOperations: number;
  reconciledValidationJournals?: number;
  validationStepsNeedingReplay?: number;
  runIds: string[];
  workspaceFallback?: {
    requestedPath: string;
    activePath: string;
    reason: string;
  };
}

export interface StreamEvent {
  threadId: string;
  type:
    | "message-start"
    | "message-delta"
    | "message-complete"
    | "run-event"
    | "patch-proposal"
    | "approval-required"
    | "error"
    | "cancelled";
  messageId?: string;
  delta?: string;
  message?: ChatMessage;
  runEvent?: AgentRunEvent;
  patch?: PatchProposal;
  approval?: ToolApproval;
  error?: string;
}

export interface WorkbenchApi {
  app: {
    getSettings(): Promise<AppSettings>;
    updateSettings(patch: AppSettingsUpdate): Promise<AppSettings>;
    getRuntimeStatus(): Promise<RuntimeStatus>;
    getStartupRecovery(): Promise<StartupRecoveryReport>;
    getModuleIntegrity(): Promise<ModuleIntegrityReport>;
    listModuleAudits(limit?: number): Promise<ModuleIntegrityReport[]>;
  };
  models: {
    scan(): Promise<ModelDescriptor[]>;
    list(): Promise<ModelDescriptor[]>;
    estimate(modelId: string, options: ModelLoadOptions): Promise<VramEstimate>;
    load(modelId: string, options?: Partial<ModelLoadOptions>): Promise<ModelInstance>;
    unload(modelId: string): Promise<void>;
    setPolicy(policy: ResidencyPolicy): Promise<ResidencyPolicy>;
    pin(modelId: string, pinned: boolean): Promise<void>;
    subscribe(listener: (models: ModelDescriptor[]) => void): () => void;
  };
  harness: {
    preflight(input: MissionPreflightRequest): Promise<MissionPreflight>;
    simulatePolicy(input: PolicySimulationRequest): Promise<PolicySimulationReport>;
    previewDecisionBundle(input: DecisionBundleRequest): Promise<DecisionBundlePreview>;
    exportDecisionBundle(input: DecisionBundleExportRequest): Promise<DecisionBundleExportReceipt>;
    verifyDecisionBundles(): Promise<DecisionBundleVerificationCatalog>;
    previewTrustPolicy(input: TrustPolicyRequest): Promise<TrustPolicyPreview>;
    exportTrustPolicy(input: TrustPolicyExportRequest): Promise<TrustPolicyExportReceipt>;
    listTrustPolicies(): Promise<TrustPolicyCatalog>;
    importSignatureEvidence(): Promise<SignatureEvidenceImportReceipt | undefined>;
    listSignatureEvidence(): Promise<SignatureEvidenceCatalog>;
    importTrustRootCandidate(): Promise<TrustRootLifecycleImportReceipt | undefined>;
    listTrustRootCandidates(): Promise<TrustRootLifecycleCatalog>;
    importTransparencyWitnessPack(): Promise<TransparencyWitnessImportReceipt | undefined>;
    listTransparencyWitnessPacks(): Promise<TransparencyWitnessCatalog>;
  };
  visualization: {
    exportMap(input: MapExportRequest): Promise<MapExportVerificationReceipt>;
  };
  materials: {
    status(): Promise<MaterialsStatus>;
    search(input: MaterialsSearchRequest): Promise<MaterialsSearchResult>;
    get(resourceId: string, includeSequence?: boolean): Promise<{ ok: boolean; snapshot_id: string; resource: MaterialSummary }>;
    facets(): Promise<MaterialsFacets>;
    materialize(input: MaterialsMaterializeRequest): Promise<MaterialsMaterializeResult>;
    activate(snapshotId: string, evidence: MaterialsActivationEvidence): Promise<Record<string, unknown>>;
    rollback(snapshotId: string, evidence: MaterialsActivationEvidence): Promise<Record<string, unknown>>;
    sync(source: "uniprot" | "igem" | "rhea" | "biomodels", maxRecords: number): Promise<Record<string, unknown>>;
    importFile(): Promise<Record<string, unknown> | undefined>;
    diff(leftSnapshot: string, rightSnapshot: string): Promise<Record<string, unknown>>;
    review(input: MaterialsReviewInput): Promise<Record<string, unknown>>;
  };
  threads: {
    create(input: Pick<AgentThread, "title" | "mode"> & { modelId?: string }): Promise<AgentThread>;
    list(): Promise<AgentThread[]>;
    get(threadId: string): Promise<{ thread: AgentThread; messages: ChatMessage[] }>;
    update(threadId: string, patch: Partial<Pick<AgentThread, "title" | "mode" | "modelId">>): Promise<AgentThread>;
    send(threadId: string, content: string, expectedPreflightDigest: string, attachments?: ChatAttachment[]): Promise<void>;
    cancel(threadId: string): Promise<void>;
    subscribe(listener: (event: StreamEvent) => void): () => void;
  };
  files: {
    pickAttachments(): Promise<ChatAttachment[]>;
    pickWorkspace(): Promise<AppSettings | undefined>;
    pickModelRoot(): Promise<AppSettings | undefined>;
    pickRuntime(): Promise<AppSettings | undefined>;
    list(): Promise<WorkspaceEntry[]>;
    open(path: string): Promise<void>;
    reveal(path: string): Promise<void>;
    read(path: string): Promise<{ path: string; content: string; sha256: string }>;
    search(query: string, glob?: string): Promise<Array<{ path: string; line: number; preview: string }>>;
    proposePatch(input: Omit<PatchProposal, "id" | "baseSha256" | "baseExists" | "before" | "afterExists" | "unifiedDiff" | "status" | "revision" | "createdAt">): Promise<PatchProposal>;
    applyApprovedPatch(patchId: string, expectedRevision: number): Promise<{ patch: PatchProposal; operation: PatchOperation; checkpoint: FileCheckpoint; events: AgentRunEvent[] }>;
    rejectPatch(patchId: string, expectedRevision: number): Promise<PatchProposal>;
    reconcilePatchOperation(operationId: string, expectedRevision: number): Promise<PatchOperation>;
    resumePatchValidation(operationId: string, expectedRevision: number): Promise<{ operation: PatchOperation; events: AgentRunEvent[] }>;
    prepareCheckpointRestore(checkpointId: string, expectedRevision: number): Promise<PatchProposal>;
  };
  runs: {
    list(includeArchived?: boolean): Promise<RunSummary[]>;
    cockpit(): Promise<OperatorCockpitProjection>;
    searchEvidence(input: GlobalEvidenceSearchRequest): Promise<GlobalEvidenceSearchResult>;
    get(runId: string): Promise<AgentRunEvent[]>;
    getDetail(runId: string): Promise<RunDetail>;
    createCheckpoint(runId: string): Promise<RunCheckpoint>;
    previewResume(checkpointId: string): Promise<ResumeContract>;
    forkCheckpoint(input: RunCheckpointForkRequest): Promise<RunForkResult>;
    archive(runId: string, archived: boolean): Promise<void>;
  };
  reviews: {
    get(runId: string): Promise<ReviewPacketView>;
    updateChecklist(runId: string, itemId: string, status: ReviewChecklistItem["status"]): Promise<ReviewPacketView>;
    addComment(runId: string, comment: string): Promise<ReviewComment>;
    listComments(runId: string): Promise<ReviewComment[]>;
    approve(runId: string): Promise<ReviewPacketView>;
  };
  approvals: {
    list(runId?: string): Promise<ToolApproval[]>;
    resolve(approvalId: string, decision: "approved" | "rejected"): Promise<ToolApproval>;
  };
}
