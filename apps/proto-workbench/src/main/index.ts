import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { app, BrowserWindow, dialog, ipcMain, nativeImage, session, shell, type IpcMainInvokeEvent, type OpenDialogOptions } from "electron";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AgentService } from "./services/agent-service.ts";
import { AppDatabase } from "./services/database.ts";
import { LmStudioProvider, LM_STUDIO_BASE_URL, LM_STUDIO_TOKEN_ENV_NAMES } from "./services/lm-studio-provider.ts";
import { McpClient } from "./services/mcp-client.ts";
import { buildMissionPreflight } from "./services/mission-preflight.ts";
import { buildPolicySimulation } from "./services/policy-simulation.ts";
import {
  buildMissionCapabilitySnapshot,
  buildMissionRecipe,
  buildResumeContract,
} from "./services/resume-contract.ts";
import { workspaceBindingIdentity } from "./services/run-checkpoints.ts";
import { buildOperatorCockpit, OPERATOR_COCKPIT_LIMITS } from "./services/operator-cockpit.ts";
import { buildGlobalEvidenceSearch, GLOBAL_EVIDENCE_LIMITS } from "./services/global-evidence.ts";
import { ModelService } from "./services/model-service.ts";
import { verifyModuleIntegrity } from "./services/module-integrity.ts";
import { WorkspaceFiles } from "./services/workspace-files.ts";
import { patchValidationOutcome } from "./services/patch-validation.ts";
import { buildDecisionBundle, exportDecisionBundle } from "./services/decision-bundle.ts";
import { scanDecisionBundles } from "./services/decision-bundle-verification.ts";
import { buildTrustPolicy, exportTrustPolicy } from "./services/trust-policy.ts";
import { scanTrustPolicies } from "./services/trust-policy-catalog.ts";
import { importSignatureEvidence, scanSignatureEvidence } from "./services/signature-evidence.ts";
import { importTrustRootCandidate, scanTrustRootCandidates } from "./services/trust-root-lifecycle.ts";
import { importTransparencyWitnessPack, scanTransparencyWitnessPacks } from "./services/transparency-log-witness.ts";
import { exportVerifiedMap, validatedMapCaptureScale, type DecodedMapEvidence } from "./services/map-export.ts";
import { validateSelectedAttachments, type AttachmentGrant } from "./services/attachment-validation.ts";
import { packagedMaterialsCliPath, resolveMaterialsRootPath } from "./services/materials-admin.ts";
import { minimalChildEnvironment } from "./services/process-security.ts";
import { activateStartupWorkspace, seedWorkspace } from "./services/workspace-bootstrap.ts";
import {
  assertSafeExternalOpenPath,
  canonicalSelectedDirectory,
} from "./services/path-security.ts";
import { assertPrivilegedIpcSender, resolveRendererTarget, validateIpcArguments } from "./ipc-security.ts";
import type {
  AppSettingsUpdate,
  AppSettings,
  ChatAttachment,
  GlobalEvidenceSearchRequest,
  MissionPreflight,
  MissionPreflightRequest,
  MaterialsActivationEvidence,
  MaterialsReviewInput,
  MapExportRequest,
  DecisionBundleExportRequest,
  DecisionBundleRequest,
  PolicySimulationReport,
  PolicySimulationRequest,
  ModelLoadOptions,
  PatchOperation,
  PatchProposal,
  ResidencyPolicy,
  ReviewPacketView,
  RunCheckpointForkRequest,
  ResumeContract,
  StartupRecoveryReport,
  StreamEvent,
  TrustPolicyExportRequest,
  TrustPolicyRequest,
} from "../shared/contracts.ts";
import {
  defaultModuleSettings,
  normalizeModuleSettings,
  type ModuleIntegrityReport,
  type ModuleSettings,
  type OptionalModuleId,
} from "../shared/modules.ts";
import { IPC } from "../shared/ipc.ts";

let mainWindow: BrowserWindow | null = null;
let database: AppDatabase;
let inferenceProvider: LmStudioProvider;
let modelService: ModelService;
let workspaceFiles: WorkspaceFiles;
let mcpClient: McpClient;
let agentService: AgentService;
let moduleIntegrityReport: ModuleIntegrityReport;
let startupRecoveryReport: StartupRecoveryReport = {
  checkedAt: "",
  recoveredRuns: 0,
  recoveredEvents: 0,
  invalidatedApprovals: 0,
  reconciledPatchOperations: 0,
  conflictedPatchOperations: 0,
  runIds: [],
};
let shutdownStarted = false;
let expectedRendererUrl: string | undefined;
let activeWorkspacePath = "";
let workspaceTransition: Promise<void> = Promise.resolve();
let filePickerActive = false;
const attachmentGrants = new Map<string, AttachmentGrant>();
const validationOperationsInFlight = new Set<string>();

process.on("uncaughtException", (error) => reportMainProcessError(error));
process.on("unhandledRejection", (reason) => reportMainProcessError(reason));

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

const projectRoot = app.isPackaged ? app.getAppPath() : resolve(app.getAppPath());
const repoRoot = app.isPackaged ? projectRoot : resolve(projectRoot, "..", "..");
const moduleDirectory = fileURLToPath(new URL(".", import.meta.url));
let defaultWorkspacePath = repoRoot;

function defaultSettings(): AppSettings {
  return {
    inference: {
      provider: "lmstudio",
      baseUrl: LM_STUDIO_BASE_URL,
      tokenEnvNames: [...LM_STUDIO_TOKEN_ENV_NAMES],
      explicitLoadOnly: true,
    },
    workspacePath: defaultWorkspacePath,
    residencyPolicy: modelService?.getPolicy() ?? {
      mode: "quick-switch",
      budgetBytes: 20 * 1024 ** 3,
      warmTtlMinutes: 30,
      pinnedModelIds: [],
    },
    modules: defaultModuleSettings(),
  };
}

function effectiveModuleSettings(settings: ModuleSettings): ModuleSettings {
  if (!moduleIntegrityReport) return settings;
  const unavailable = new Set(
    moduleIntegrityReport.modules
      .filter((module) => !module.core && module.status !== "verified" && module.status !== "not-audited")
      .map((module) => module.moduleId as OptionalModuleId),
  );
  return {
    ...settings,
    enabledOptional: settings.enabledOptional.filter((moduleId) => !unavailable.has(moduleId)),
  };
}

function readSettings(): AppSettings {
  const defaults = defaultSettings();
  return {
    inference: defaults.inference,
    workspacePath: database.getSetting("workspacePath", defaults.workspacePath),
    residencyPolicy: modelService.getPolicy(),
    modules: effectiveModuleSettings(
      normalizeModuleSettings(database.getSetting<Partial<ModuleSettings>>("modules", defaults.modules)),
    ),
  };
}

function broadcast(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function reportMainProcessError(reason: unknown): void {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error("Proto Workbench main-process error:", reason);
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(IPC.threadStream, {
      threadId: "system",
      type: "error",
      error: message || "The desktop process encountered an unexpected error.",
    } satisfies StreamEvent);
    return;
  }
  if (app.isReady()) dialog.showErrorBox("Proto Workbench error", message || "The desktop process encountered an unexpected error.");
}

function createWorkspaceServices(workspacePath: string): Promise<void> {
  const transition = workspaceTransition.catch(() => undefined).then(async () => {
    const canonicalWorkspace = await canonicalSelectedDirectory(workspacePath);
    activeWorkspacePath = canonicalWorkspace;
    attachmentGrants.clear();
    const previousAgent = agentService;
    const previousMcp = mcpClient;
    if (previousAgent) {
      previousAgent.invalidatePendingApprovals("The workspace service was replaced.");
      await previousAgent.cancelAll();
    }
    if (previousMcp) await previousMcp.stop();
    database.invalidatePendingApprovals("The approval is not bound to the current workspace service.");
    workspaceFiles = new WorkspaceFiles(canonicalWorkspace, database);
    const patchRecovery = await workspaceFiles.reconcilePatchOperations();
    startupRecoveryReport.reconciledPatchOperations += patchRecovery.reconciled;
    startupRecoveryReport.conflictedPatchOperations += patchRecovery.conflicted;
    mcpClient = new McpClient({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      repoRoot,
      workspacePath: canonicalWorkspace,
      materialsRoot: materialsRootPath(),
      workspaceCapability: randomBytes(32).toString("hex"),
    });
    agentService = new AgentService(
      database,
      modelService,
      workspaceFiles,
      mcpClient,
      (event: StreamEvent) => broadcast(IPC.threadStream, event),
      () => readSettings().modules,
      canonicalWorkspace,
    );
  });
  workspaceTransition = transition;
  return transition;
}

const MATERIALS_ADMIN_OUTPUT_LIMIT = 4 * 1024 * 1024;

function materialsRootPath(): string {
  return resolveMaterialsRootPath({
    configuredRoot: process.env.PROTO_AGENT_MATERIALS_ROOT,
    isPackaged: app.isPackaged,
    documentsPath: app.getPath("documents"),
    repoRoot,
  });
}

async function runMaterialsCli(arguments_: string[]): Promise<Record<string, unknown>> {
  const materialsRoot = materialsRootPath();
  const pythonPath = process.env.PROTO_AGENT_PYTHON || "python";
  const command = app.isPackaged
    ? packagedMaterialsCliPath(process.resourcesPath)
    : pythonPath;
  const args = app.isPackaged
    ? ["--materials-root", materialsRoot, ...arguments_]
    : ["-m", "proto_agent.cli", "--materials-root", materialsRoot, ...arguments_];
  const childEnv = minimalChildEnvironment({
    PROTO_WORKBENCH_WORKSPACE_ROOT: activeWorkspacePath,
    PROTO_AGENT_MATERIALS_ROOT: materialsRoot,
    ...(app.isPackaged ? {} : { PYTHONPATH: join(repoRoot, "src") }),
  });
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: activeWorkspacePath || repoRoot, env: childEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-MATERIALS_ADMIN_OUTPUT_LIMIT);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-16 * 1024);
    });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code !== 0) {
        rejectPromise(new Error(stderr.trim() || `Materials command exited with code ${code}.`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
        resolvePromise(parsed);
      } catch {
        rejectPromise(new Error("Materials command returned invalid JSON."));
      }
    });
  });
}

type PrivilegedHandler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown;

function handlePrivileged(channel: string, handler: PrivilegedHandler): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertPrivilegedIpcSender(event, mainWindow, expectedRendererUrl);
    return handler(event, ...validateIpcArguments(channel, args));
  });
}

async function verifyExportedMapImage(
  format: MapExportRequest["format"],
  bytes: Buffer,
  expected: { readonly width: number; readonly height: number },
): Promise<DecodedMapEvidence> {
  if (format === "png") {
    const image = nativeImage.createFromBuffer(bytes);
    return decodedMapEvidence(image, expected, "electron-native-image");
  }

  const partition = `map-export-verifier-${randomBytes(12).toString("hex")}`;
  const verifierSession = session.fromPartition(partition, { cache: false });
  verifierSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  verifierSession.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "file://*/*", "ftp://*/*"] },
    (_details, callback) => callback({ cancel: true }),
  );
  const verifierWindow = new BrowserWindow({
    show: false,
    width: expected.width,
    height: expected.height,
    useContentSize: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      partition,
    },
  });
  try {
    const svgDataUrl = `data:image/svg+xml;base64,${bytes.toString("base64")}`;
    const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fff}img{display:block;width:${expected.width}px;height:${expected.height}px}</style><img id="map" alt="" src="${svgDataUrl}">`;
    await verifierWindow.loadURL(`data:text/html;base64,${Buffer.from(html, "utf8").toString("base64")}`);
    const decoded = await verifierWindow.webContents.executeJavaScript(`(async () => { const image = document.getElementById("map"); if (!image) return { complete: false, width: 0, height: 0 }; await image.decode(); return { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight }; })()`); // isolated static image probe
    if (!decoded?.complete || decoded.width !== expected.width || decoded.height !== expected.height) {
      throw new Error(`Map SVG could not be independently decoded at ${expected.width}x${expected.height}.`);
    }
    const capturedImage = await verifierWindow.webContents.capturePage({ x: 0, y: 0, width: expected.width, height: expected.height });
    const capturedSize = capturedImage.getSize();
    const captureScale = validatedMapCaptureScale(capturedSize, expected);
    const logicalImage = captureScale === 1
      ? capturedImage
      : capturedImage.resize({ width: expected.width, height: expected.height, quality: "best" });
    return decodedMapEvidence(logicalImage, expected, "chromium-isolated-image");
  } finally {
    if (!verifierWindow.isDestroyed()) verifierWindow.destroy();
    await verifierSession.clearStorageData().catch(() => undefined);
  }
}

function decodedMapEvidence(
  image: ReturnType<typeof nativeImage.createFromBuffer>,
  expected: { readonly width: number; readonly height: number },
  decoder: DecodedMapEvidence["decoder"],
): DecodedMapEvidence {
  if (image.isEmpty()) throw new Error("Map export reopened as an empty image.");
  const size = image.getSize();
  if (size.width !== expected.width || size.height !== expected.height) {
    throw new Error(`Map export decoder reported ${size.width}x${size.height}; expected ${expected.width}x${expected.height}.`);
  }
  const sample = image.resize({
    width: Math.min(128, size.width),
    height: Math.min(128, size.height),
    quality: "best",
  }).toBitmap();
  const colors = new Set<string>();
  for (let index = 0; index + 3 < sample.byteLength && colors.size < 256; index += 4) {
    colors.add(sample.subarray(index, index + 4).toString("hex"));
  }
  return {
    decoder,
    width: size.width,
    height: size.height,
    pixelSha256: createHash("sha256").update(sample).digest("hex"),
    sampledColorCount: colors.size,
  };
}

async function issueMissionPreflight(
  threadId: string,
  content: string,
  attachments: ChatAttachment[],
): Promise<MissionPreflight> {
  const { thread, model, runtime, capabilities, tools } = await captureMissionEnvironment(threadId);
  return buildMissionPreflight({
    thread,
    content,
    attachments,
    model,
    runtime,
    moduleIntegrity: moduleIntegrityReport,
    visionModuleEnabled: readSettings().modules.enabledOptional.includes("media.vision"),
    workspaceUri: pathToFileURL(activeWorkspacePath).href,
    capabilities,
    toolNames: tools.map((tool) => tool.name),
  });
}

async function issuePolicySimulation(
  input: PolicySimulationRequest,
  attachments: ChatAttachment[],
): Promise<PolicySimulationReport> {
  const { thread, model, runtime, capabilities, tools } = await captureMissionEnvironment(input.threadId);
  return buildPolicySimulation({
    thread,
    content: input.content,
    attachments,
    model,
    runtime,
    moduleIntegrity: moduleIntegrityReport,
    visionModuleEnabled: readSettings().modules.enabledOptional.includes("media.vision"),
    workspaceUri: pathToFileURL(activeWorkspacePath).href,
    capabilities,
    toolNames: tools.map((tool) => tool.name),
  }, input.scenarioIds);
}

async function captureMissionEnvironment(threadId: string) {
  const { thread } = agentService.getThread(threadId);
  const model = thread.modelId ? modelService.get(thread.modelId) : modelService.getActiveModel();
  const [runtime, capabilities, tools] = await Promise.all([
    inferenceProvider.runtimeStatus(),
    mcpClient.capabilities(true),
    mcpClient.tools(true),
  ]);
  return { thread, model, runtime, capabilities, tools };
}

async function issueResumeContract(checkpointId: string): Promise<ResumeContract> {
  const checkpoint = database.getRunCheckpoint(checkpointId);
  if (!checkpoint) throw new Error("Run checkpoint was not found.");
  agentService.assertRunInWorkspace(checkpoint.runId);
  const { model, runtime, capabilities, tools } = await captureMissionEnvironment(checkpoint.sourceThreadId);
  const currentCapabilities = buildMissionCapabilitySnapshot({
    workspaceIdentity: workspaceBindingIdentity(activeWorkspacePath),
    model,
    runtime,
    moduleIntegrity: moduleIntegrityReport,
    capabilities,
    toolNames: tools.map((tool) => tool.name),
  });
  return buildResumeContract(checkpoint, currentCapabilities);
}

function registerIpc(): void {
  handlePrivileged(IPC.settingsGet, () => readSettings());
  handlePrivileged(IPC.settingsUpdate, async (_event, patch: AppSettingsUpdate) => {
    if (patch.residencyPolicy) await modelService.setPolicy(patch.residencyPolicy);
    if (patch.modules) database.setSetting("modules", normalizeModuleSettings(patch.modules));
    return readSettings();
  });
  handlePrivileged(IPC.runtimeStatus, () => inferenceProvider.runtimeStatus());
  handlePrivileged(IPC.startupRecovery, () => startupRecoveryReport);
  handlePrivileged(IPC.modulesIntegrity, () => moduleIntegrityReport);
  handlePrivileged(IPC.modulesAuditHistory, (_event, limit?: number) => database.listModuleAudits(limit));

  handlePrivileged(IPC.modelsScan, async () => {
    return modelService.scan(LM_STUDIO_BASE_URL);
  });
  handlePrivileged(IPC.modelsList, () => modelService.list());
  handlePrivileged(IPC.modelsEstimate, (_event, modelId: string, options: ModelLoadOptions) =>
    modelService.estimate(modelId, options),
  );
  handlePrivileged(IPC.modelsLoad, (_event, modelId: string, options?: Partial<ModelLoadOptions>) => {
    if (agentService.hasActiveRuns()) throw new Error("Wait for or cancel the active run before changing model residency.");
    return modelService.load(modelId, options);
  });
  handlePrivileged(IPC.modelsUnload, (_event, modelId: string) => {
    if (agentService.hasActiveRuns()) throw new Error("Wait for or cancel the active run before changing model residency.");
    return modelService.unload(modelId);
  });
  handlePrivileged(IPC.modelsPolicy, (_event, policy: ResidencyPolicy) => modelService.setPolicy(policy));
  handlePrivileged(IPC.modelsPin, (_event, modelId: string, pinned: boolean) => modelService.pin(modelId, pinned));

  handlePrivileged(IPC.harnessPreflight, async (_event, input: MissionPreflightRequest) => {
    const selected = await validateSelectedAttachments(
      input.attachments ?? [],
      attachmentGrants,
      (path) => workspaceFiles.resolveReadable(path),
      mediaTypeFor,
    );
    return issueMissionPreflight(input.threadId, input.content, selected.attachments);
  });
  handlePrivileged(IPC.harnessPolicySimulation, async (_event, input: PolicySimulationRequest) => {
    const selected = await validateSelectedAttachments(
      input.attachments ?? [],
      attachmentGrants,
      (path) => workspaceFiles.resolveReadable(path),
      mediaTypeFor,
    );
    return issuePolicySimulation(input, selected.attachments);
  });
  handlePrivileged(IPC.harnessDecisionBundlePreview, async (_event, input: DecisionBundleRequest) => {
    const selected = await validateSelectedAttachments(
      input.attachments ?? [],
      attachmentGrants,
      (path) => workspaceFiles.resolveReadable(path),
      mediaTypeFor,
    );
    const report = await issuePolicySimulation({ ...input, attachments: selected.attachments }, selected.attachments);
    if (report.digest !== input.expectedSimulationDigest) throw new Error("Decision Bundle simulation digest is stale; recompute the policy simulation.");
    if (!moduleIntegrityReport.manifestSha256) throw new Error("Decision Bundle requires a verified module manifest digest.");
    return buildDecisionBundle(report, {
      selectedScenarioId: input.selectedScenarioId,
      redaction: input.redaction,
      attachmentCount: selected.attachments.length,
      producerVersion: moduleIntegrityReport.manifestAppVersion ?? app.getVersion(),
      moduleManifestSha256: moduleIntegrityReport.manifestSha256,
    });
  });
  handlePrivileged(IPC.harnessDecisionBundleExport, async (_event, input: DecisionBundleExportRequest) => {
    const selected = await validateSelectedAttachments(
      input.attachments ?? [],
      attachmentGrants,
      (path) => workspaceFiles.resolveReadable(path),
      mediaTypeFor,
    );
    const report = await issuePolicySimulation({ ...input, attachments: selected.attachments }, selected.attachments);
    if (report.digest !== input.expectedSimulationDigest) throw new Error("Decision Bundle simulation digest is stale; recompute the policy simulation.");
    if (!moduleIntegrityReport.manifestSha256) throw new Error("Decision Bundle requires a verified module manifest digest.");
    const bundle = buildDecisionBundle(report, {
      selectedScenarioId: input.selectedScenarioId,
      redaction: input.redaction,
      attachmentCount: selected.attachments.length,
      producerVersion: moduleIntegrityReport.manifestAppVersion ?? app.getVersion(),
      moduleManifestSha256: moduleIntegrityReport.manifestSha256,
    });
    if (bundle.bundleDigest !== input.expectedBundleDigest) throw new Error("Decision Bundle digest is stale; preview it again before export.");
    return exportDecisionBundle(activeWorkspacePath, bundle);
  });
  handlePrivileged(IPC.harnessDecisionBundleVerify, () => scanDecisionBundles(activeWorkspacePath));
  handlePrivileged(IPC.harnessTrustPolicyPreview, (_event, input: TrustPolicyRequest) => {
    if (input.pinCurrentModuleManifest && !moduleIntegrityReport.manifestSha256) {
      throw new Error("Trust Policy cannot pin an unavailable module manifest digest.");
    }
    return buildTrustPolicy({
      name: input.name,
      description: input.description,
      authorities: input.authorities,
      moduleManifestSha256: input.pinCurrentModuleManifest ? moduleIntegrityReport.manifestSha256 : undefined,
    });
  });
  handlePrivileged(IPC.harnessTrustPolicyExport, async (_event, input: TrustPolicyExportRequest) => {
    if (input.pinCurrentModuleManifest && !moduleIntegrityReport.manifestSha256) {
      throw new Error("Trust Policy cannot pin an unavailable module manifest digest.");
    }
    const policy = buildTrustPolicy({
      name: input.name,
      description: input.description,
      authorities: input.authorities,
      moduleManifestSha256: input.pinCurrentModuleManifest ? moduleIntegrityReport.manifestSha256 : undefined,
    });
    if (policy.policyDigest !== input.expectedPolicyDigest) {
      throw new Error("Trust Policy digest is stale; preview it again before export.");
    }
    return exportTrustPolicy(activeWorkspacePath, policy);
  });
  handlePrivileged(IPC.harnessTrustPolicyList, () => scanTrustPolicies(activeWorkspacePath));
  handlePrivileged(IPC.harnessSignatureEvidenceImport, async () => {
    const selected = await pickDirectory("Select a Signature Evidence pack", activeWorkspacePath);
    if (!selected) return undefined;
    return importSignatureEvidence(activeWorkspacePath, selected, sigstoreTrustRootPath());
  });
  handlePrivileged(IPC.harnessSignatureEvidenceList, () => scanSignatureEvidence(activeWorkspacePath, sigstoreTrustRootPath()));
  handlePrivileged(IPC.harnessTrustRootCandidateImport, async () => {
    const selected = await pickDirectory("Select an offline TUF trust-root candidate pack", activeWorkspacePath);
    if (!selected) return undefined;
    const paths = sigstoreTrustLifecyclePaths();
    return importTrustRootCandidate(activeWorkspacePath, selected, paths.anchorRoot, paths.checkpoint, paths.installedTrustedRoot);
  });
  handlePrivileged(IPC.harnessTrustRootCandidateList, () => {
    const paths = sigstoreTrustLifecyclePaths();
    return scanTrustRootCandidates(activeWorkspacePath, paths.anchorRoot, paths.checkpoint, paths.installedTrustedRoot);
  });
  handlePrivileged(IPC.harnessTransparencyWitnessImport, async () => {
    const selected = await pickDirectory("Select an offline transparency witness pack", activeWorkspacePath);
    if (!selected) return undefined;
    const paths = transparencyWitnessPaths();
    return importTransparencyWitnessPack(activeWorkspacePath, selected, paths.policy, paths.trustedRoot);
  });
  handlePrivileged(IPC.harnessTransparencyWitnessList, () => {
    const paths = transparencyWitnessPaths();
    return scanTransparencyWitnessPacks(activeWorkspacePath, paths.policy, paths.trustedRoot);
  });
  handlePrivileged(IPC.visualizationMapExport, (_event, input: MapExportRequest) =>
    exportVerifiedMap(activeWorkspacePath, input, verifyExportedMapImage));

  handlePrivileged(IPC.materialsStatus, () => runMaterialsCli(["materials", "status", "--json"]));
  handlePrivileged(IPC.materialsSearch, (_event, input: Record<string, unknown>) => mcpClient.call("proto_materials_search", input));
  handlePrivileged(IPC.materialsGet, (_event, resourceId: string, includeSequence: boolean) =>
    mcpClient.call("proto_materials_get", { resource_id: resourceId, include_sequence: Boolean(includeSequence) }),
  );
  handlePrivileged(IPC.materialsFacets, () => mcpClient.call("proto_materials_facets", {}));
  handlePrivileged(IPC.materialsActivate, (_event, snapshotId: string, evidence: MaterialsActivationEvidence) => runMaterialsCli([
    "materials", "activate", snapshotId,
    `--operator=${evidence.operator}`,
    `--approval-reference=${evidence.approval_reference}`,
  ]));
  handlePrivileged(IPC.materialsRollback, (_event, snapshotId: string, evidence: MaterialsActivationEvidence) => runMaterialsCli([
    "materials", "rollback", snapshotId,
    `--operator=${evidence.operator}`,
    `--approval-reference=${evidence.approval_reference}`,
  ]));
  handlePrivileged(IPC.materialsSync, (_event, source: string, maxRecords: number) => {
    if (!["uniprot", "igem", "rhea", "biomodels"].includes(source)) throw new Error("Unknown materials source.");
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 2_000_000) throw new Error("Materials sync limit is outside the supported range.");
    return runMaterialsCli(["materials", "sync", source, "--max-records", String(maxRecords)]);
  });
  handlePrivileged(IPC.materialsImport, async () => {
    const result = await showPrivilegedOpenDialog({
      title: "Import materials into a review-required staging snapshot",
      defaultPath: activeWorkspacePath,
      properties: ["openFile"],
      filters: [{ name: "Materials", extensions: ["json", "fasta", "fa", "fas", "ttl", "rdf", "gb", "gbk", "genbank"] }],
    });
    if (result.canceled || !result.filePaths[0]) return undefined;
    const selected = await workspaceFiles.resolveReadable(result.filePaths[0]);
    const relativePath = relative(activeWorkspacePath, selected).replaceAll("\\", "/");
    if (!relativePath || relativePath.startsWith("..")) throw new Error("Materials import must be inside the active workspace.");
    return runMaterialsCli(["materials", "import", relativePath]);
  });
  handlePrivileged(IPC.materialsDiff, (_event, leftSnapshot: string, rightSnapshot: string) =>
    runMaterialsCli(["materials", "diff", leftSnapshot, rightSnapshot]),
  );
  handlePrivileged(IPC.materialsReview, (_event, input: MaterialsReviewInput) => {
    if (!input.description_en && !input.description_zh) throw new Error("A description is required for a materials review overlay.");
    const args = ["materials", "review", input.resource_id, "--decision", input.decision] as string[];
    if (input.description_en) args.push("--description-en", input.description_en);
    if (input.description_zh) args.push("--description-zh", input.description_zh);
    if (input.reviewer) args.push("--reviewer", input.reviewer);
    if (input.snapshot) args.push("--snapshot", input.snapshot);
    return runMaterialsCli(args);
  });

  handlePrivileged(IPC.threadsCreate, (_event, input) => agentService.createThread({
    ...input,
    workspacePath: readSettings().workspacePath,
  }));
  handlePrivileged(IPC.threadsList, () => agentService.listThreads());
  handlePrivileged(IPC.threadsGet, (_event, threadId: string) => agentService.getThread(threadId));
  handlePrivileged(IPC.threadsUpdate, (_event, threadId: string, patch) => agentService.updateThread(threadId, patch));
  handlePrivileged(IPC.threadsSend, async (
    _event,
    threadId: string,
    content: string,
    expectedPreflightDigest: string,
    attachments?: ChatAttachment[],
  ) => {
    const selected = await validateSelectedAttachments(
      attachments ?? [],
      attachmentGrants,
      (path) => workspaceFiles.resolveReadable(path),
      mediaTypeFor,
    );
    const preflight = await issueMissionPreflight(threadId, content, selected.attachments);
    if (preflight.digest !== expectedPreflightDigest) {
      throw new Error("Mission preflight is stale. Review the refreshed requirements before starting this mission.");
    }
    if (!preflight.launchable) {
      throw new Error("Mission preflight is blocked. Resolve the blocked requirement before starting this mission.");
    }
    await agentService.send(threadId, content, selected.attachments, preflight);
    for (const path of selected.consumedGrantPaths) attachmentGrants.delete(path);
  });
  handlePrivileged(IPC.threadsCancel, (_event, threadId: string) => agentService.cancel(threadId));

  handlePrivileged(IPC.filesPickAttachments, async (): Promise<ChatAttachment[]> => {
    const extensions = ["proto", "md", "txt", "json", "csv", "py", "r", "ipynb", "pdf"];
    if (readSettings().modules.enabledOptional.includes("media.vision")) {
      extensions.push("png", "jpg", "jpeg", "webp");
    }
    const options: OpenDialogOptions = {
      title: "Attach research files",
      defaultPath: readSettings().workspacePath,
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Supported research files",
          extensions,
        },
      ],
    };
    const result = await showPrivilegedOpenDialog(options);
    if (result.canceled) return [];
    if (result.filePaths.length > 16) throw new Error("Select at most 16 attachments at a time.");
    const attachments = await Promise.all(result.filePaths.map(async (path) => {
      const original = await lstat(path);
      if (original.isSymbolicLink() || !original.isFile() || original.size > 1024 ** 3) {
        throw new Error("Attachments must be regular, non-linked files no larger than 1 GiB.");
      }
      const canonical = await realpath(path);
      return {
        path: canonical,
        name: basename(canonical),
        mediaType: mediaTypeFor(canonical),
        sizeBytes: (await stat(canonical)).size,
      };
    }));
    const expiresAt = Date.now() + 10 * 60_000;
    for (const [path, grant] of attachmentGrants) {
      if (grant.expiresAt <= Date.now()) attachmentGrants.delete(path);
    }
    if (attachmentGrants.size + attachments.length > 128) {
      throw new Error("Too many unconsumed attachment selections are pending.");
    }
    for (const attachment of attachments) attachmentGrants.set(attachment.path, { attachment, expiresAt });
    return attachments;
  });
  handlePrivileged(IPC.filesPickWorkspace, async () => {
    const options: OpenDialogOptions = {
      title: "Choose a Proto workspace",
      defaultPath: readSettings().workspacePath,
      properties: ["openDirectory"],
    };
    const result = await showPrivilegedOpenDialog(options);
    if (result.canceled) return undefined;
    const workspacePath = await canonicalSelectedDirectory(result.filePaths[0]);
    await createWorkspaceServices(workspacePath);
    database.setSetting("workspacePath", workspacePath);
    return readSettings();
  });
  handlePrivileged(IPC.filesPickModelRoot, async () => {
    throw new Error("Model directory selection is disabled. Proto Workbench discovers models from LM Studio only.");
  });
  handlePrivileged(IPC.filesPickRuntime, async () => {
    throw new Error("Runtime selection is disabled. Start LM Studio's local server at http://127.0.0.1:1234.");
  });
  handlePrivileged(IPC.filesList, () => workspaceFiles.list());
  handlePrivileged(IPC.filesOpen, async (_event, path: string) => {
    let resolvedPath = await workspaceFiles.resolveReadable(path);
    assertSafeExternalOpenPath(resolvedPath);
    resolvedPath = await workspaceFiles.resolveReadable(resolvedPath);
    assertSafeExternalOpenPath(resolvedPath);
    const error = await shell.openPath(resolvedPath);
    if (error) throw new Error(error);
  });
  handlePrivileged(IPC.filesReveal, async (_event, path: string) => {
    const resolvedPath = await workspaceFiles.resolveReadable(path);
    shell.showItemInFolder(resolvedPath);
  });
  handlePrivileged(IPC.filesRead, (_event, path: string) => workspaceFiles.read(path));
  handlePrivileged(IPC.filesSearch, (_event, query: string, glob?: string) => workspaceFiles.search(query, glob));
  handlePrivileged(IPC.filesProposePatch, (_event, input: { runId: string; targetPath: string; after: string; rationale: string }) => {
    agentService.assertRunInWorkspace(input.runId);
    return workspaceFiles.proposePatch(input);
  });
  handlePrivileged(IPC.filesApplyPatch, async (_event, patchId: string, expectedRevision: number) => {
    agentService.assertPatchReadyForApproval(patchId);
    const applied = await workspaceFiles.applyApprovedPatch(patchId, expectedRevision);
    const validated = await validatePatchOperation(applied.patch, applied.operation);
    return { patch: applied.patch, operation: validated.operation, checkpoint: applied.checkpoint, events: validated.events };
  });
  handlePrivileged(IPC.filesRejectPatch, (_event, patchId: string, expectedRevision: number) => {
    const patch = database.getPatch(patchId);
    if (!patch) throw new Error("Patch proposal was not found.");
    agentService.assertRunInWorkspace(patch.runId);
    return workspaceFiles.rejectPatch(patchId, expectedRevision);
  });
  handlePrivileged(IPC.filesReconcilePatchOperation, async (_event, operationId: string, expectedRevision: number) => {
    const operation = database.getPatchOperation(operationId);
    if (!operation) throw new Error("Patch operation was not found.");
    agentService.assertRunInWorkspace(operation.runId);
    if (operation.state === "validating" || validationOperationsInFlight.has(operation.id)) {
      throw new Error("Wait for the active validation attempt to finish before reconciling this patch operation.");
    }
    return workspaceFiles.reconcilePatchOperation(operationId, expectedRevision);
  });
  handlePrivileged(IPC.filesResumePatchValidation, async (_event, operationId: string, expectedRevision: number) => {
    const operation = database.getPatchOperation(operationId);
    if (!operation) throw new Error("Patch operation was not found.");
    agentService.assertRunInWorkspace(operation.runId);
    if (operation.revision !== expectedRevision) throw new Error("The patch operation changed. Refresh before resuming validation.");
    const current = await workspaceFiles.assertOperationResultCurrent(operationId);
    if (!["applied", "validation-failed"].includes(current.state)) {
      throw new Error(`Patch operation is ${current.state}; reconcile the file effect before validating.`);
    }
    const patch = database.getPatch(current.patchId);
    if (!patch) throw new Error("Patch proposal was not found.");
    const validated = await validatePatchOperation(patch, current);
    return validated;
  });
  handlePrivileged(IPC.filesPrepareCheckpointRestore, async (_event, checkpointId: string, expectedRevision: number) => {
    const checkpoint = database.getFileCheckpoint(checkpointId);
    if (!checkpoint) throw new Error("File checkpoint was not found.");
    agentService.assertRunInWorkspace(checkpoint.runId);
    return workspaceFiles.prepareCheckpointRestore(checkpointId, expectedRevision);
  });

  handlePrivileged(IPC.runsList, (_event, includeArchived?: boolean) =>
    database.listRuns(Boolean(includeArchived)).filter((run) => agentService.canAccessRun(run.runId)),
  );
  handlePrivileged(IPC.runsCockpit, () => {
    const details = database.listRuns(false)
      .filter((run) => agentService.canAccessRun(run.runId))
      .slice(0, OPERATOR_COCKPIT_LIMITS.runScan)
      .map((run) => database.getRunDetail(run.runId));
    return buildOperatorCockpit(details);
  });
  handlePrivileged(IPC.runsSearchEvidence, (_event, input: GlobalEvidenceSearchRequest) => {
    const details = database.listRuns(Boolean(input.includeArchived))
      .filter((run) => agentService.canAccessRun(run.runId))
      .slice(0, GLOBAL_EVIDENCE_LIMITS.runScan)
      .map((run) => database.getRunDetail(run.runId));
    return buildGlobalEvidenceSearch(details, input);
  });
  handlePrivileged(IPC.runsGet, (_event, runId: string) => {
    agentService.assertRunInWorkspace(runId);
    return database.getRunEvents(runId);
  });
  handlePrivileged(IPC.runsGetDetail, (_event, runId: string) => {
    agentService.assertRunInWorkspace(runId);
    return database.getRunDetail(runId);
  });
  handlePrivileged(IPC.runsCreateCheckpoint, async (_event, runId: string) => {
    agentService.assertRunInWorkspace(runId);
    if (database.getRunEvents(runId).some((runEvent) => ["pending", "running"].includes(runEvent.status))) {
      throw new Error("Wait for the current run step to finish before creating a task checkpoint.");
    }
    const context = database.getRunContext(runId);
    if (!context?.threadId) throw new Error("The run is not bound to a task thread.");
    const { thread, model, runtime, capabilities, tools } = await captureMissionEnvironment(context.threadId);
    const goal = [...database.getMessages(thread.id)].reverse().find((message) => message.role === "user")?.content;
    if (!goal) throw new Error("The run has no trusted user goal to save as a Mission Recipe.");
    const createdAt = new Date().toISOString();
    const missionRecipe = buildMissionRecipe({
      thread,
      goal,
      createdAt,
      workspaceIdentity: workspaceBindingIdentity(activeWorkspacePath),
      model,
      runtime,
      moduleIntegrity: moduleIntegrityReport,
      capabilities,
      toolNames: tools.map((tool) => tool.name),
    });
    if (database.getRunEvents(runId).some((runEvent) => ["pending", "running"].includes(runEvent.status))) {
      throw new Error("The run changed while its Mission Recipe was being captured. Wait for the current step and try again.");
    }
    return database.createRunCheckpoint({ runId, missionRecipe, createdAt });
  });
  handlePrivileged(IPC.runsPreviewResume, (_event, checkpointId: string) => issueResumeContract(checkpointId));
  handlePrivileged(IPC.runsForkCheckpoint, async (_event, input: RunCheckpointForkRequest) => {
    const checkpoint = database.getRunCheckpoint(input.checkpointId);
    if (!checkpoint) throw new Error("Run checkpoint was not found.");
    agentService.assertRunInWorkspace(checkpoint.runId);
    const resumeContract = await issueResumeContract(checkpoint.id);
    if (resumeContract.digest !== input.expectedResumeContractDigest) {
      throw new Error("Resume capabilities changed after review. Review the refreshed resume contract before creating a child task.");
    }
    if (!resumeContract.launchable) {
      throw new Error("Resume is blocked by the current trust boundary. Resolve the blocked capability and review again.");
    }
    return database.forkRunCheckpoint({
      ...input,
      expectedWorkspacePath: readSettings().workspacePath,
    });
  });
  handlePrivileged(IPC.runsArchive, (_event, runId: string, archived: boolean) => {
    agentService.assertRunInWorkspace(runId);
    return database.setRunArchived(runId, archived);
  });
  handlePrivileged(IPC.reviewsGet, (_event, runId: string) => {
    agentService.assertRunInWorkspace(runId);
    return database.getReview(runId) ?? emptyReview(runId);
  });
  handlePrivileged(IPC.reviewsUpdateChecklist, (_event, runId: string, itemId: string, status) => {
    agentService.assertRunInWorkspace(runId);
    if (!database.getRunDetail(runId).allowedActions.updateReviewChecklist) {
      throw new Error("Resolve the current run attention before changing the human review checklist.");
    }
    const review = database.getReview(runId) ?? emptyReview(runId);
    review.checklist = review.checklist.map((item) => (item.id === itemId ? { ...item, status } : item));
    review.gate = review.checklist.length && review.checklist.every((item) => item.status === "done")
      ? "ready"
      : "review-required";
    database.saveReview(review);
    return review;
  });
  handlePrivileged(IPC.reviewsAddComment, (_event, runId: string, comment: string) => {
    agentService.assertRunInWorkspace(runId);
    return database.addReviewComment(runId, comment);
  });
  handlePrivileged(IPC.reviewsListComments, (_event, runId: string) => {
    agentService.assertRunInWorkspace(runId);
    return database.listReviewComments(runId);
  });
  handlePrivileged(IPC.reviewsApprove, (_event, runId: string) => {
    agentService.assertRunInWorkspace(runId);
    if (!database.getRunDetail(runId).allowedActions.approveRun) {
      throw new Error("This run is not ready for final human approval.");
    }
    const review = database.getReview(runId) ?? emptyReview(runId);
    if (review.gate !== "ready") throw new Error("Complete the human checklist before approving this run.");
    review.gate = "approved";
    review.approvedAt = new Date().toISOString();
    database.saveReview(review);
    return review;
  });
  handlePrivileged(IPC.approvalsList, (_event, runId?: string) => agentService.listApprovals(runId));
  handlePrivileged(IPC.approvalsResolve, (_event, approvalId: string, decision: "approved" | "rejected") =>
    agentService.resolveApproval(approvalId, decision),
  );
}

async function validatePatchOperation(
  patch: PatchProposal,
  operation: PatchOperation,
): Promise<{ operation: PatchOperation; events: Awaited<ReturnType<AgentService["afterPatchApplied"]>> }> {
  if (validationOperationsInFlight.has(operation.id)) {
    throw new Error("Validation is already running for this patch operation.");
  }
  validationOperationsInFlight.add(operation.id);
  let validating: PatchOperation | undefined;
  try {
    validating = database.beginPatchValidation(operation.id, operation.revision);
    const events = await agentService.afterPatchApplied(patch, validating.id);
    const outcome = patchValidationOutcome(events);
    const current = await workspaceFiles.assertOperationResultCurrent(validating.id);
    if (current.state !== "validating" || current.revision !== validating.revision) {
      throw new Error("The reviewed target changed or the patch operation was reconciled during validation. Validation evidence was not marked verified.");
    }
    return {
      operation: database.finishPatchValidation(
        validating.id,
        validating.revision,
        outcome.ok,
        outcome.error,
      ),
      events,
    };
  } catch (error) {
    const latest = validating ? database.getPatchOperation(validating.id) : undefined;
    if (validating && latest?.state === "validating" && latest.revision === validating.revision) {
      database.finishPatchValidation(
        validating.id,
        validating.revision,
        false,
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  } finally {
    validationOperationsInFlight.delete(operation.id);
  }
}

async function pickDirectory(title: string, defaultPath: string): Promise<string | undefined> {
  const options: OpenDialogOptions = { title, defaultPath, properties: ["openDirectory"] };
  const result = await showPrivilegedOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}

function sigstoreTrustRootPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "runtime", "trust", "sigstore-public-good", "trusted_root.json")
    : join(projectRoot, "runtime", "trust", "sigstore-public-good", "trusted_root.json");
}

function sigstoreTrustLifecyclePaths(): { anchorRoot: string; checkpoint: string; installedTrustedRoot: string } {
  const base = app.isPackaged
    ? join(process.resourcesPath, "runtime", "trust", "sigstore-public-good")
    : join(projectRoot, "runtime", "trust", "sigstore-public-good");
  return {
    anchorRoot: join(base, "tuf", "15.root.json"),
    checkpoint: join(base, "tuf", "CHECKPOINT.json"),
    installedTrustedRoot: join(base, "trusted_root.json"),
  };
}

function transparencyWitnessPaths(): { policy: string; trustedRoot: string } {
  const base = app.isPackaged
    ? join(process.resourcesPath, "runtime", "trust", "sigstore-public-good")
    : join(projectRoot, "runtime", "trust", "sigstore-public-good");
  return {
    policy: join(base, "transparency", "WITNESS_POLICY.json"),
    trustedRoot: join(base, "trusted_root.json"),
  };
}

async function showPrivilegedOpenDialog(options: OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
  if (filePickerActive) throw new Error("Finish the current file selection before opening another picker.");
  filePickerActive = true;
  try {
    return mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
  } finally {
    filePickerActive = false;
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1488,
    height: 1024,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: "#f7f9f8",
    show: false,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#f8faf9", symbolColor: "#27312e", height: 46 },
    webPreferences: {
      preload: join(moduleDirectory, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const showLoadedWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return;
    mainWindow.show();
  };
  // `ready-to-show` can be missed by a hidden Windows/Electron development
  // window even after the main frame has finished loading. Keep the hidden
  // startup (no blank flash), but let the completed main-frame load release the
  // window as a deterministic fallback.
  mainWindow.once("ready-to-show", showLoadedWindow);
  mainWindow.webContents.once("did-finish-load", showLoadedWindow);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  const rendererFile = join(moduleDirectory, "../renderer/index.html");
  const rendererTarget = resolveRendererTarget(app.isPackaged, process.env.ELECTRON_RENDERER_URL, rendererFile);
  expectedRendererUrl = rendererTarget.expectedUrl;
  if (rendererTarget.kind === "url") void mainWindow.loadURL(rendererTarget.value);
  else void mainWindow.loadFile(rendererTarget.value);
}

async function prepareDefaultWorkspace(): Promise<void> {
  if (!app.isPackaged) return;
  const workspacePath = join(app.getPath("documents"), "Proto Workbench Workspace");
  const templatePath = join(process.resourcesPath, "runtime", "workspace-template");
  await seedWorkspace(templatePath, workspacePath);
  defaultWorkspacePath = workspacePath;
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  database = new AppDatabase(join(app.getPath("userData"), "proto-workbench.sqlite"));
  startupRecoveryReport = database.reconcileStartupState(
    "The application restarted before the run reached a terminal state.",
    "The application restarted before this approval was resolved; no side effect was replayed.",
  );
  moduleIntegrityReport = database.appendModuleAudit(await verifyModuleIntegrity({
    appRoot: projectRoot,
    resourceRoot: app.isPackaged ? process.resourcesPath : projectRoot,
    enforce: app.isPackaged,
    expectedAppVersion: app.getVersion(),
  }));
  if (app.isPackaged && !moduleIntegrityReport.ok) {
    const failures = moduleIntegrityReport.modules
      .filter((module) => module.core && module.status !== "verified")
      .map((module) => `${module.moduleId}: ${module.status}`)
      .join(", ");
    throw new Error(`Core module integrity verification failed. Startup is blocked. ${failures}`);
  }
  await prepareDefaultWorkspace();
  inferenceProvider = new LmStudioProvider();
  modelService = new ModelService(database, inferenceProvider, inferenceProvider);
  modelService.subscribe((models) => broadcast(IPC.modelsChanged, models));
  const settings = readSettings();
  const workspaceActivation = await activateStartupWorkspace(
    settings.workspacePath,
    defaultWorkspacePath,
    createWorkspaceServices,
  );
  if (workspaceActivation.fallback) {
    database.setSetting("workspacePath", workspaceActivation.activePath);
    startupRecoveryReport.workspaceFallback = {
      requestedPath: workspaceActivation.fallback.requestedPath,
      activePath: workspaceActivation.activePath,
      reason: workspaceActivation.fallback.reason,
    };
  }
  registerIpc();
  createWindow();
  void modelService.scan(LM_STUDIO_BASE_URL).catch((error) =>
    broadcast(IPC.threadStream, { threadId: "system", type: "error", error: String(error) } satisfies StreamEvent),
  );
}).catch((error) => {
  dialog.showErrorBox("Proto Workbench could not start", String(error));
  app.quit();
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  void shutdown().finally(() => app.quit());
});

async function shutdown(): Promise<void> {
  await agentService?.cancelAll();
  await Promise.all([mcpClient?.stop(), modelService?.shutdown()]);
  database?.close();
}

function mediaTypeFor(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLocaleLowerCase();
  return (
    {
      proto: "text/x-proto",
      md: "text/markdown",
      txt: "text/plain",
      json: "application/json",
      csv: "text/csv",
      py: "text/x-python",
      r: "text/x-r",
      ipynb: "application/x-ipynb+json",
      pdf: "application/pdf",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
    } as Record<string, string>
  )[extension] ?? "application/octet-stream";
}

function emptyReview(runId: string): ReviewPacketView {
  return {
    runId,
    gate: "review-required",
    summary: "Run validation to create an evidence-backed review packet.",
    claims: [],
    checklist: [],
    unresolvedQuestions: [],
    safetyBoundary:
      "Software validation only; this review does not certify wet-lab readiness, orderability, biosafety, or regulatory compliance.",
  };
}
