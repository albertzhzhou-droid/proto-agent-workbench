import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentThread,
  AppSettingsUpdate,
  AppSettings,
  ChatAttachment,
  DecisionBundleExportRequest,
  DecisionBundleRequest,
  GlobalEvidenceSearchRequest,
  MaterialsActivationEvidence,
  MaterialsMaterializeRequest,
  ModelDescriptor,
  ModelLoadOptions,
  MaterialsSearchRequest,
  MaterialsReviewInput,
  MapExportRequest,
  MissionPreflightRequest,
  PolicySimulationRequest,
  PatchProposal,
  ResidencyPolicy,
  ReviewChecklistItem,
  RunCheckpointForkRequest,
  StreamEvent,
  TrustPolicyAuthorityInput,
  TrustPolicyExportRequest,
  TrustPolicyRequest,
  WorkbenchApi,
} from "../shared/contracts.ts";
import { IPC } from "../shared/ipc.ts";

const MAX_IPC_ARGUMENT_CHARACTERS = 512 * 1024;
const MAX_BINARY_IPC_BYTES = 16 * 1024 * 1024;

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const serialized = JSON.stringify(args);
  if (serialized.length > MAX_IPC_ARGUMENT_CHARACTERS) {
    return Promise.reject(new Error("IPC request exceeds the renderer-to-main payload limit."));
  }
  return ipcRenderer.invoke(channel, ...args);
}

function invokeMapExport(input: MapExportRequest): ReturnType<WorkbenchApi["visualization"]["exportMap"]> {
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 32 || input.bytes.byteLength > MAX_BINARY_IPC_BYTES) {
    return Promise.reject(new Error("Map export payload is outside the renderer-to-main binary limit."));
  }
  return ipcRenderer.invoke(IPC.visualizationMapExport, input);
}

function boundedString(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} is invalid or exceeds ${maximum} characters.`);
  }
  return value;
}

function boundedActivationEvidence(input: MaterialsActivationEvidence): MaterialsActivationEvidence {
  const operator = boundedString(input?.operator, "operator", 128).trim();
  const approvalReference = boundedString(input?.approval_reference, "approval_reference", 512).trim();
  if (!operator || !approvalReference || /[\u0000-\u001f\u007f\u0085\u2028\u2029]/u.test(operator + approvalReference)) {
    throw new Error("Activation evidence must contain bounded, non-empty, single-line operator and approval-reference values.");
  }
  return { operator, approval_reference: approvalReference };
}

function sha256Digest(value: unknown, label: string): string {
  const digest = boundedString(value, label, 64);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  return digest;
}

function boundedTrustAuthorities(authorities: TrustPolicyAuthorityInput[]): TrustPolicyAuthorityInput[] {
  if (!Array.isArray(authorities) || authorities.length < 1 || authorities.length > 8) {
    throw new Error("Trust Policy requires between 1 and 8 authorities.");
  }
  return authorities.map((authority) => authority.kind === "keyless" ? {
    kind: "keyless" as const,
    name: boundedString(authority.name, "authority name", 64),
    issuer: boundedString(authority.issuer, "certificate issuer", 512),
    subject: boundedString(authority.subject, "certificate identity", 512),
  } : {
    kind: "public-key" as const,
    name: boundedString(authority.name, "authority name", 64),
    publicKeySha256: sha256Digest(authority.publicKeySha256, "public key digest"),
  });
}

function boundedTrustPolicy(input: TrustPolicyRequest) {
  return {
    name: boundedString(input.name, "policy name", 96),
    description: boundedString(input.description, "policy description", 512),
    authorities: boundedTrustAuthorities(input.authorities),
    pinCurrentModuleManifest: Boolean(input.pinCurrentModuleManifest),
  };
}

function idempotencyKey(value: unknown): string {
  const key = boundedString(value, "idempotencyKey", 128);
  if (key.length < 8 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(key)) {
    throw new Error("idempotencyKey must be an 8-128 character stable token.");
  }
  return key;
}

const api: WorkbenchApi = {
  app: {
    getSettings: () => invoke(IPC.settingsGet) as Promise<AppSettings>,
    updateSettings: (patch: AppSettingsUpdate) => invoke(IPC.settingsUpdate, patch) as Promise<AppSettings>,
    getRuntimeStatus: () => invoke(IPC.runtimeStatus),
    getStartupRecovery: () => invoke(IPC.startupRecovery),
    getModuleIntegrity: () => invoke(IPC.modulesIntegrity),
    listModuleAudits: (limit?: number) => invoke(IPC.modulesAuditHistory, limit),
  },
  models: {
    scan: () => invoke(IPC.modelsScan),
    list: () => invoke(IPC.modelsList),
    estimate: (modelId: string, options: ModelLoadOptions) => invoke(IPC.modelsEstimate, boundedString(modelId, "modelId", 128), options),
    load: (modelId: string, options?: Partial<ModelLoadOptions>) =>
      invoke(IPC.modelsLoad, boundedString(modelId, "modelId", 128), options),
    unload: (modelId: string) => invoke(IPC.modelsUnload, boundedString(modelId, "modelId", 128)),
    setPolicy: (policy: ResidencyPolicy) => invoke(IPC.modelsPolicy, policy),
    pin: (modelId: string, pinned: boolean) => invoke(IPC.modelsPin, boundedString(modelId, "modelId", 128), pinned),
    subscribe: (listener: (models: ModelDescriptor[]) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, models: ModelDescriptor[]) => listener(models);
      ipcRenderer.on(IPC.modelsChanged, wrapped);
      return () => ipcRenderer.removeListener(IPC.modelsChanged, wrapped);
    },
  },
  harness: {
    listExecutions: () => invoke(IPC.harnessExecutions),
    resumeExecution: (runId) => invoke(IPC.harnessResume, runId),
    pauseExecution: (runId) => invoke(IPC.harnessPause, runId),
    preflight: (input: MissionPreflightRequest) => invoke(IPC.harnessPreflight, {
      threadId: boundedString(input.threadId, "threadId", 128),
      content: boundedString(input.content, "message", 131_072),
      attachments: input.attachments,
    }),
    simulatePolicy: (input: PolicySimulationRequest) => invoke(IPC.harnessPolicySimulation, {
      threadId: boundedString(input.threadId, "threadId", 128),
      content: boundedString(input.content, "simulation goal", 8_192),
      attachments: input.attachments,
      scenarioIds: [...new Set(input.scenarioIds)].slice(0, 9),
    }),
    previewDecisionBundle: (input: DecisionBundleRequest) => invoke(IPC.harnessDecisionBundlePreview, {
      threadId: boundedString(input.threadId, "threadId", 128),
      content: boundedString(input.content, "simulation goal", 8_192),
      attachments: input.attachments,
      scenarioIds: [...new Set(input.scenarioIds)].slice(0, 9),
      selectedScenarioId: input.selectedScenarioId,
      redaction: input.redaction,
      expectedSimulationDigest: sha256Digest(input.expectedSimulationDigest, "expectedSimulationDigest"),
    }),
    exportDecisionBundle: (input: DecisionBundleExportRequest) => invoke(IPC.harnessDecisionBundleExport, {
      threadId: boundedString(input.threadId, "threadId", 128),
      content: boundedString(input.content, "simulation goal", 8_192),
      attachments: input.attachments,
      scenarioIds: [...new Set(input.scenarioIds)].slice(0, 9),
      selectedScenarioId: input.selectedScenarioId,
      redaction: input.redaction,
      expectedSimulationDigest: sha256Digest(input.expectedSimulationDigest, "expectedSimulationDigest"),
      expectedBundleDigest: sha256Digest(input.expectedBundleDigest, "expectedBundleDigest"),
    }),
    verifyDecisionBundles: () => invoke(IPC.harnessDecisionBundleVerify),
    previewTrustPolicy: (input: TrustPolicyRequest) => invoke(IPC.harnessTrustPolicyPreview, boundedTrustPolicy(input)),
    exportTrustPolicy: (input: TrustPolicyExportRequest) => invoke(IPC.harnessTrustPolicyExport, {
      ...boundedTrustPolicy(input),
      expectedPolicyDigest: sha256Digest(input.expectedPolicyDigest, "expectedPolicyDigest"),
    }),
    listTrustPolicies: () => invoke(IPC.harnessTrustPolicyList),
    importSignatureEvidence: () => invoke(IPC.harnessSignatureEvidenceImport),
    listSignatureEvidence: () => invoke(IPC.harnessSignatureEvidenceList),
    importTrustRootCandidate: () => invoke(IPC.harnessTrustRootCandidateImport),
    listTrustRootCandidates: () => invoke(IPC.harnessTrustRootCandidateList),
    importTransparencyWitnessPack: () => invoke(IPC.harnessTransparencyWitnessImport),
    listTransparencyWitnessPacks: () => invoke(IPC.harnessTransparencyWitnessList),
  },
  visualization: {
    exportMap: (input: MapExportRequest) => invokeMapExport(input),
  },
  designs: {
    prepareEdit: input => invoke(IPC.designPrepareEdit, input),
    commitEdit: input => invoke(IPC.designCommitEdit, input),
  },
  proteinStructures: {
    list: input => invoke(IPC.structureList, input),
    search: input => invoke(IPC.structureSearch, input),
    fetch: input => invoke(IPC.structureFetch, input),
    importFile: input => invoke(IPC.structureImport, input),
    read: input => invoke(IPC.structureRead, input),
    saveView: input => invoke(IPC.structureSaveView, input),
    readView: input => invoke(IPC.structureReadView, input),
    prepareTracks: input => invoke(IPC.structurePrepareTracks, input),
    exportTracks: input => {
      if (input.format === "png" && (!(input.png instanceof Uint8Array) || input.png.byteLength < 32 || input.png.byteLength > MAX_BINARY_IPC_BYTES)) {
        return Promise.reject(new Error("Invalid sequence landscape PNG size."));
      }
      if (JSON.stringify({ ...input, png: undefined }).length > MAX_IPC_ARGUMENT_CHARACTERS) {
        return Promise.reject(new Error("Sequence landscape request exceeds the payload limit."));
      }
      return ipcRenderer.invoke(IPC.structureExportTracks, input);
    },
    exportImage: input => {
      if (!(input.png instanceof Uint8Array) || input.png.byteLength < 32 || input.png.byteLength > MAX_BINARY_IPC_BYTES) return Promise.reject(new Error("Invalid structure PNG size."));
      return ipcRenderer.invoke(IPC.structureExportImage, input);
    },
  },
  materials: {
    status: () => invoke(IPC.materialsStatus),
    search: (input: MaterialsSearchRequest) => {
      const query = input.query === undefined ? "" : boundedString(input.query, "query", 512, true);
      const limit = input.limit === undefined ? undefined : Math.max(1, Math.min(50, Math.trunc(input.limit)));
      return invoke(IPC.materialsSearch, { ...input, query, limit });
    },
    get: (resourceId: string, includeSequence = false) => invoke(IPC.materialsGet, boundedString(resourceId, "resourceId", 256), Boolean(includeSequence)),
    facets: () => invoke(IPC.materialsFacets),
    materialize: (input: MaterialsMaterializeRequest) => invoke(IPC.materialsMaterialize, {
      resource_ids: input.resource_ids.map((resourceId) => boundedString(resourceId, "resourceId", 256)),
      chassis: boundedString(input.chassis, "chassis", 256),
      snapshot: boundedString(input.snapshot, "snapshot", 128),
    }),
    activate: (snapshotId: string, evidence: MaterialsActivationEvidence) => invoke(
      IPC.materialsActivate,
      boundedString(snapshotId, "snapshotId", 128),
      boundedActivationEvidence(evidence),
    ),
    rollback: (snapshotId: string, evidence: MaterialsActivationEvidence) => invoke(
      IPC.materialsRollback,
      boundedString(snapshotId, "snapshotId", 128),
      boundedActivationEvidence(evidence),
    ),
    sync: (source: "uniprot" | "igem" | "rhea" | "biomodels", maxRecords: number) => invoke(IPC.materialsSync, source, Math.max(1, Math.min(2_000_000, Math.trunc(maxRecords)))),
    importFile: () => invoke(IPC.materialsImport),
    diff: (leftSnapshot: string, rightSnapshot: string) => invoke(IPC.materialsDiff, boundedString(leftSnapshot, "leftSnapshot", 128), boundedString(rightSnapshot, "rightSnapshot", 128)),
    review: (input: MaterialsReviewInput) => invoke(IPC.materialsReview, {
      resource_id: boundedString(input.resource_id, "resourceId", 256),
      decision: input.decision,
      description_en: input.description_en === undefined ? undefined : boundedString(input.description_en, "description_en", 4_096, true),
      description_zh: input.description_zh === undefined ? undefined : boundedString(input.description_zh, "description_zh", 4_096, true),
      reviewer: input.reviewer === undefined ? undefined : boundedString(input.reviewer, "reviewer", 256, true),
      snapshot: input.snapshot === undefined ? undefined : boundedString(input.snapshot, "snapshot", 128),
    }),
  },
  threads: {
    create: (input: Pick<AgentThread, "title" | "mode"> & { modelId?: string }) => invoke(IPC.threadsCreate, input),
    list: () => invoke(IPC.threadsList),
    get: (threadId: string) => invoke(IPC.threadsGet, boundedString(threadId, "threadId", 128)),
    update: (threadId, patch) => invoke(IPC.threadsUpdate, boundedString(threadId, "threadId", 128), patch),
    send: (threadId: string, content: string, expectedPreflightDigest: string, attachments?: ChatAttachment[]) =>
      invoke(
        IPC.threadsSend,
        boundedString(threadId, "threadId", 128),
        boundedString(content, "message", 131_072),
        sha256Digest(expectedPreflightDigest, "expectedPreflightDigest"),
        attachments,
      ),
    cancel: (threadId: string) => invoke(IPC.threadsCancel, boundedString(threadId, "threadId", 128)),
    subscribe: (listener: (event: StreamEvent) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, streamEvent: StreamEvent) => listener(streamEvent);
      ipcRenderer.on(IPC.threadStream, wrapped);
      return () => ipcRenderer.removeListener(IPC.threadStream, wrapped);
    },
  },
  files: {
    pickAttachments: () => invoke(IPC.filesPickAttachments),
    pickWorkspace: () => invoke(IPC.filesPickWorkspace),
    pickModelRoot: () => invoke(IPC.filesPickModelRoot),
    pickRuntime: () => invoke(IPC.filesPickRuntime),
    list: () => invoke(IPC.filesList),
    open: (path: string) => invoke(IPC.filesOpen, boundedString(path, "path", 4_096)),
    reveal: (path: string) => invoke(IPC.filesReveal, boundedString(path, "path", 4_096)),
    read: (path: string) => invoke(IPC.filesRead, boundedString(path, "path", 4_096)),
    search: (query: string, glob?: string) => invoke(
      IPC.filesSearch,
      boundedString(query, "query", 512),
      glob === undefined ? undefined : boundedString(glob, "extension", 64, true),
    ),
    proposePatch: (input: Omit<PatchProposal, "id" | "baseSha256" | "baseExists" | "before" | "afterExists" | "unifiedDiff" | "status" | "revision" | "createdAt">) =>
      invoke(IPC.filesProposePatch, input),
    applyApprovedPatch: (patchId: string, expectedRevision: number) =>
      invoke(IPC.filesApplyPatch, boundedString(patchId, "patchId", 128), expectedRevision),
    rejectPatch: (patchId: string, expectedRevision: number) =>
      invoke(IPC.filesRejectPatch, boundedString(patchId, "patchId", 128), expectedRevision),
    reconcilePatchOperation: (operationId: string, expectedRevision: number) =>
      invoke(IPC.filesReconcilePatchOperation, boundedString(operationId, "operationId", 128), expectedRevision),
    resumePatchValidation: (operationId: string, expectedRevision: number) =>
      invoke(IPC.filesResumePatchValidation, boundedString(operationId, "operationId", 128), expectedRevision),
    prepareCheckpointRestore: (checkpointId: string, expectedRevision: number) =>
      invoke(IPC.filesPrepareCheckpointRestore, boundedString(checkpointId, "checkpointId", 128), expectedRevision),
  },
  runs: {
    list: (includeArchived?: boolean) => invoke(IPC.runsList, includeArchived),
    cockpit: () => invoke(IPC.runsCockpit),
    searchEvidence: (input: GlobalEvidenceSearchRequest) => invoke(IPC.runsSearchEvidence, {
      ...input,
      query: input.query === undefined ? undefined : boundedString(input.query, "query", 160, true),
      exactRunId: input.exactRunId === undefined ? undefined : boundedString(input.exactRunId, "exactRunId", 128),
      cursor: input.cursor === undefined ? undefined : boundedString(input.cursor, "cursor", 512),
      limit: input.limit === undefined ? undefined : Math.max(1, Math.min(50, Math.trunc(input.limit))),
    }),
    get: (runId: string) => invoke(IPC.runsGet, boundedString(runId, "runId", 128)),
    getDetail: (runId: string) => invoke(IPC.runsGetDetail, boundedString(runId, "runId", 128)),
    createCheckpoint: (runId: string) => invoke(
      IPC.runsCreateCheckpoint,
      boundedString(runId, "runId", 128),
    ),
    previewResume: (checkpointId: string) => invoke(
      IPC.runsPreviewResume,
      boundedString(checkpointId, "checkpointId", 128),
    ),
    forkCheckpoint: (input: RunCheckpointForkRequest) => invoke(IPC.runsForkCheckpoint, {
      checkpointId: boundedString(input.checkpointId, "checkpointId", 128),
      expectedSnapshotDigest: sha256Digest(input.expectedSnapshotDigest, "expectedSnapshotDigest"),
      expectedResumeContractDigest: sha256Digest(input.expectedResumeContractDigest, "expectedResumeContractDigest"),
      idempotencyKey: idempotencyKey(input.idempotencyKey),
      title: input.title === undefined ? undefined : boundedString(input.title, "title", 200, true),
    }),
    archive: (runId: string, archived: boolean) => invoke(IPC.runsArchive, boundedString(runId, "runId", 128), archived),
  },
  reviews: {
    get: (runId: string) => invoke(IPC.reviewsGet, boundedString(runId, "runId", 128)),
    updateChecklist: (runId: string, itemId: string, status: ReviewChecklistItem["status"]) =>
      invoke(IPC.reviewsUpdateChecklist, boundedString(runId, "runId", 128), boundedString(itemId, "itemId", 128), status),
    addComment: (runId: string, comment: string) => invoke(
      IPC.reviewsAddComment,
      boundedString(runId, "runId", 128),
      boundedString(comment, "comment", 16_384),
    ),
    listComments: (runId: string) => invoke(IPC.reviewsListComments, boundedString(runId, "runId", 128)),
    approve: (runId: string) => invoke(IPC.reviewsApprove, boundedString(runId, "runId", 128)),
  },
  approvals: {
    list: (runId?: string) => invoke(IPC.approvalsList, runId),
    resolve: (approvalId: string, decision: "approved" | "rejected") =>
      invoke(IPC.approvalsResolve, boundedString(approvalId, "approvalId", 128), decision),
  },
};

contextBridge.exposeInMainWorld("workbench", api);
