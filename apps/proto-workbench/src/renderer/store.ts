import { create } from "zustand";
import type {
  AgentRunEvent,
  AgentThread,
  AppSettings,
  AppSettingsUpdate,
  ChatAttachment,
  ChatMessage,
  GlobalEvidenceHit,
  ModelDescriptor,
  ModelLoadOptions,
  MissionPreflight,
  OperatorCockpitProjection,
  PatchProposal,
  ReviewComment,
  ReviewPacketView,
  ResumeContract,
  RunDetail,
  RunSummary,
  RuntimeStatus,
  StartupRecoveryReport,
  ToolApproval,
  WorkspaceEntry,
} from "../shared/contracts.ts";
import type { ModuleIntegrityReport } from "../shared/modules.ts";
import { CORE_MODULES, defaultModuleSettings, OPTIONAL_MODULES } from "../shared/modules.ts";
import { workbenchApi } from "./mock-api.ts";
import { deriveWorkbenchReadiness } from "./readiness.ts";
import { shouldFollowNewRun } from "./run-follow.ts";
import { emptyReview } from "../shared/run-lifecycle.ts";

export type AppView = "launchpad" | "workspaces" | "designs" | "runs" | "models" | "materials" | "sources" | "reviews" | "settings" | "help";
export type BootstrapPhase = "connecting" | "environment" | "session" | "ready";

interface WorkbenchState {
  ready: boolean;
  bootstrapPhase: BootstrapPhase;
  currentView: AppView;
  modelsOpen: boolean;
  modelTab: "quick-switch" | "auto-evict";
  settings: AppSettings;
  runtime: RuntimeStatus;
  startupRecovery: StartupRecoveryReport;
  moduleIntegrity: ModuleIntegrityReport;
  moduleAudits: ModuleIntegrityReport[];
  models: ModelDescriptor[];
  runs: RunSummary[];
  operatorCockpit?: OperatorCockpitProjection;
  showArchived: boolean;
  selectedRunId?: string;
  runDetail?: RunDetail;
  runDetailLoading: boolean;
  events: AgentRunEvent[];
  selectedEventId?: string;
  evidenceTab: "timeline" | "topology" | "artifacts";
  review: ReviewPacketView;
  comments: ReviewComment[];
  patch?: PatchProposal;
  activeDocument?: { path: string; content: string };
  thread?: AgentThread;
  messages: ChatMessage[];
  streamingText: string;
  isAgentRunning: boolean;
  agentStartedAt?: number;
  prompt: string;
  missionPreflight?: MissionPreflight;
  resumeContract?: ResumeContract;
  resumeCheckpointId?: string;
  preflighting: boolean;
  mode: "plan" | "act";
  attachments: ChatAttachment[];
  workspaceEntries: WorkspaceEntry[];
  codeMode: "code" | "diff" | "artifact";
  diffLayout: "unified" | "split";
  drawerCollapsed: boolean;
  fullEditor: boolean;
  drawerHeight: number;
  ledgerSearch: string;
  ledgerSearchOpen: boolean;
  isScanningModels: boolean;
  busyModelId?: string;
  resolvingApprovalId?: string;
  busyPatchAction?: "approve" | "reject" | "reconcile" | "validate" | "restore";
  busyTaskHistoryAction?: "checkpoint" | "resume-review" | "fork";
  pendingApprovals: ToolApproval[];
  toast?: string;
  bootstrap(): Promise<void>;
  navigate(view: AppView): void;
  toggleModels(open?: boolean): void;
  setModelTab(tab: "quick-switch" | "auto-evict"): Promise<void>;
  refreshModels(): Promise<void>;
  loadModel(modelId: string, options?: Partial<ModelLoadOptions>): Promise<void>;
  unloadModel(modelId: string): Promise<void>;
  pinModel(modelId: string, pinned: boolean): Promise<void>;
  chooseWorkspace(): Promise<void>;
  chooseModelRoot(): Promise<void>;
  chooseRuntime(): Promise<void>;
  refreshWorkspaceEntries(): Promise<void>;
  updateSettings(patch: AppSettingsUpdate): Promise<void>;
  refreshRuns(): Promise<void>;
  refreshOperatorCockpit(): Promise<void>;
  setShowArchived(value: boolean): Promise<void>;
  archiveRun(runId: string, archived: boolean): Promise<void>;
  selectRun(runId: string): Promise<void>;
  reconcileRunDetail(runId: string): Promise<void>;
  refreshCurrentRun(): Promise<void>;
  selectEvent(eventId: string): Promise<void>;
  selectEvidenceStep(stepId: string): void;
  setEvidenceTab(tab: "timeline" | "topology" | "artifacts"): void;
  openGlobalEvidenceHit(hit: GlobalEvidenceHit): Promise<void>;
  openEvidenceArtifact(locator: string): Promise<void>;
  createTaskCheckpoint(runId: string): Promise<void>;
  reviewTaskResume(checkpointId: string): Promise<void>;
  clearTaskResume(): void;
  forkTaskCheckpoint(checkpointId: string, expectedSnapshotDigest: string, expectedResumeContractDigest: string, title?: string): Promise<void>;
  setLedgerSearchOpen(value: boolean): void;
  setLedgerSearch(value: string): void;
  setCodeMode(mode: "code" | "diff" | "artifact"): void;
  setDiffLayout(layout: "unified" | "split"): void;
  setDrawerCollapsed(value: boolean): void;
  setFullEditor(value: boolean): void;
  setDrawerHeight(value: number): void;
  showPendingPatch(): void;
  approvePatch(): Promise<void>;
  rejectPatch(): Promise<void>;
  reconcilePatchEffect(): Promise<void>;
  resumePatchValidation(): Promise<void>;
  prepareCheckpointRestore(): Promise<void>;
  updateChecklist(itemId: string, checked: boolean): Promise<void>;
  addReviewComment(comment: string): Promise<void>;
  approveRun(): Promise<void>;
  openFile(path: string): Promise<void>;
  revealFile(path: string): Promise<void>;
  setPrompt(prompt: string): void;
  beginNewRun(mode: "plan" | "act"): Promise<void>;
  setMode(mode: "plan" | "act"): Promise<void>;
  pickAttachments(): Promise<void>;
  addReference(entry: WorkspaceEntry): void;
  removeAttachment(path: string): void;
  resolveToolApproval(approvalId: string, decision: "approved" | "rejected"): Promise<void>;
  refreshMissionPreflight(): Promise<void>;
  send(): Promise<void>;
  cancel(): Promise<void>;
  clearToast(): void;
}

const GIB = 1024 ** 3;
const EMPTY_SETTINGS: AppSettings = {
  modelRoot: "",
  workspacePath: "",
  residencyPolicy: { mode: "quick-switch", budgetBytes: 20 * GIB, warmTtlMinutes: 30, pinnedModelIds: [] },
  modules: defaultModuleSettings(),
};
const EMPTY_MODULE_INTEGRITY: ModuleIntegrityReport = {
  ok: true,
  enforced: false,
  manifestPath: "",
  checkedAt: "",
  modules: [...CORE_MODULES, ...OPTIONAL_MODULES].map((module) => ({
    moduleId: module.id,
    version: module.version,
    core: module.core,
    status: "not-audited",
    disposition: "not-audited",
    checkedArtifacts: 0,
    diagnostics: [],
  })),
};
const EMPTY_STARTUP_RECOVERY: StartupRecoveryReport = {
  checkedAt: "",
  recoveredRuns: 0,
  recoveredEvents: 0,
  invalidatedApprovals: 0,
  reconciledPatchOperations: 0,
  conflictedPatchOperations: 0,
  reconciledValidationJournals: 0,
  validationStepsNeedingReplay: 0,
  runIds: [],
};
let subscriptionsReady = false;
let runSelectionGeneration = 0;

export const useWorkbenchStore = create<WorkbenchState>((set, get) => ({
  ready: false,
  bootstrapPhase: "connecting",
  currentView: "launchpad",
  modelsOpen: false,
  modelTab: "quick-switch",
  settings: structuredClone(EMPTY_SETTINGS),
  runtime: { available: false, detail: "Checking independent runtime..." },
  startupRecovery: structuredClone(EMPTY_STARTUP_RECOVERY),
  moduleIntegrity: structuredClone(EMPTY_MODULE_INTEGRITY),
  moduleAudits: [],
  models: [],
  runs: [],
  operatorCockpit: undefined,
  showArchived: false,
  runDetailLoading: false,
  events: [],
  evidenceTab: "timeline",
  review: emptyReview(),
  comments: [],
  messages: [],
  streamingText: "",
  isAgentRunning: false,
  agentStartedAt: undefined,
  prompt: "",
  missionPreflight: undefined,
  resumeContract: undefined,
  resumeCheckpointId: undefined,
  preflighting: false,
  mode: "act",
  attachments: [],
  workspaceEntries: [],
  codeMode: "diff",
  diffLayout: "split",
  drawerCollapsed: false,
  fullEditor: false,
  drawerHeight: 318,
  ledgerSearch: "",
  ledgerSearchOpen: false,
  isScanningModels: false,
  pendingApprovals: [],

  async bootstrap() {
    const wasReady = get().ready;
    set({ bootstrapPhase: "environment", ...(wasReady ? {} : { ready: false }) });
    const api = workbenchApi();
    if (!subscriptionsReady) {
      subscriptionsReady = true;
      api.models.subscribe((models) => set({ models, missionPreflight: undefined }));
      api.threads.subscribe((event) => {
        const targetsCurrentThread = event.threadId === get().thread?.id;
        if (event.type === "message-start" && targetsCurrentThread) {
          set((state) => ({
            streamingText: "",
            isAgentRunning: true,
            agentStartedAt: state.agentStartedAt ?? Date.now(),
          }));
        }
        if (event.type === "message-delta" && targetsCurrentThread) {
          set((state) => ({ streamingText: state.streamingText + (event.delta ?? "") }));
        }
        if (event.type === "message-complete" && event.message && targetsCurrentThread) {
          set((state) => ({
            messages: state.messages.some((message) => message.id === event.message?.id)
              ? state.messages
              : [...state.messages, event.message as ChatMessage],
            streamingText: "",
            isAgentRunning: false,
            agentStartedAt: undefined,
          }));
          void get().refreshRuns();
          if (get().selectedRunId) void get().reconcileRunDetail(get().selectedRunId as string);
        }
        if (event.type === "run-event" && event.runEvent) {
          const runEvent = event.runEvent as AgentRunEvent;
          let followedNewRun = false;
          set((state) => {
            followedNewRun = shouldFollowNewRun(state.selectedRunId, runEvent);
            if (followedNewRun) {
              return {
                currentView: "runs",
                selectedRunId: runEvent.runId,
                runDetail: undefined,
                events: [runEvent],
                selectedEventId: runEvent.id,
                review: emptyReview(runEvent.runId),
                comments: [],
                patch: undefined,
                pendingApprovals: [],
                activeDocument: undefined,
              };
            }
            const selectedRunId = state.selectedRunId ?? runEvent.runId;
            if (selectedRunId !== runEvent.runId) return {};
            const exists = state.events.some((item) => item.id === runEvent.id);
            return {
              selectedRunId,
              events: exists
                ? state.events.map((item) => (item.id === runEvent.id ? runEvent : item))
                : [...state.events, runEvent],
            };
          });
          if (followedNewRun) void get().refreshRuns();
          if (runEvent.status !== "running") void get().reconcileRunDetail(runEvent.runId);
        }
        if (event.type === "patch-proposal" && event.patch && targetsCurrentThread) {
          if (event.patch.runId === get().selectedRunId) {
            set((state) => ({
              patch: event.patch,
              activeDocument: undefined,
              selectedEventId: pendingPatchEventId(state.events, event.patch as PatchProposal),
              codeMode: "diff",
              drawerCollapsed: false,
            }));
          }
          void get().refreshRuns();
          void get().reconcileRunDetail(event.patch.runId);
        }
        if (event.type === "approval-required" && event.approval && targetsCurrentThread) {
          if (event.approval.runId === get().selectedRunId) {
            set((state) => ({
              pendingApprovals: state.pendingApprovals.some((item) => item.id === event.approval?.id)
                ? state.pendingApprovals
                : [...state.pendingApprovals, event.approval as ToolApproval],
              toast: "An action is waiting for your approval.",
            }));
          }
          void get().refreshRuns();
          void get().reconcileRunDetail(event.approval.runId);
        }
        if (event.type === "cancelled" && targetsCurrentThread) {
          set((state) => ({
            streamingText: "",
            isAgentRunning: false,
            agentStartedAt: undefined,
            pendingApprovals: state.pendingApprovals.filter((approval) => approval.runId !== state.selectedRunId),
          }));
        }
        if (event.type === "error" && targetsCurrentThread) {
          set({ streamingText: "", isAgentRunning: false, agentStartedAt: undefined, toast: event.error || "The local model request failed." });
        }
      });
    }

    const [settings, runtime, startupRecovery, moduleIntegrity, moduleAudits, listedModels, listedRuns, operatorCockpit, threads, workspaceEntries] = await Promise.all([
      api.app.getSettings(),
      api.app.getRuntimeStatus(),
      api.app.getStartupRecovery(),
      api.app.getModuleIntegrity(),
      api.app.listModuleAudits(10),
      api.models.list(),
      api.runs.list(false),
      api.runs.cockpit(),
      api.threads.list(),
      api.files.list(),
    ]);
    set({ bootstrapPhase: "session" });
    const models = listedModels;
    const selectedRunId = listedRuns[0]?.runId;
    const detail = selectedRunId ? await api.runs.getDetail(selectedRunId) : undefined;
    let thread = detail?.thread ?? threads.find((item) => item.workspacePath === settings.workspacePath);
    if (!thread) {
      thread = await api.threads.create({
        title: "Proto research run",
        mode: "act",
        modelId: models.find((model) => model.loadState === "active")?.id ?? models[0]?.id,
      });
    }
    const threadData = detail?.thread?.id === thread.id
      ? { thread: detail.thread, messages: detail.messages }
      : await api.threads.get(thread.id);
    const readiness = deriveWorkbenchReadiness({ settings, runtime, moduleIntegrity, models, workspaceEntries, threadModelId: threadData.thread.modelId });
    const currentView = wasReady
      ? get().currentView
      : (!readiness.operational || listedRuns.length === 0 || startupRecovery.recoveredRuns > 0 || startupRecovery.invalidatedApprovals > 0 || Boolean(startupRecovery.workspaceFallback) ? "launchpad" : "runs");
    const events = detail?.events ?? [];
    const runs = detail ? mergeRunSummary(listedRuns, detail.summary) : listedRuns;
    set({
      ready: true,
      bootstrapPhase: "ready",
      currentView,
      settings,
      runtime,
      startupRecovery,
      moduleIntegrity,
      moduleAudits,
      models,
      runs,
      operatorCockpit,
      selectedRunId,
      runDetail: detail,
      runDetailLoading: false,
      events,
      selectedEventId: detail ? selectedEventForDetail(detail) : events.at(-1)?.id,
      review: detail?.review ?? emptyReview(),
      comments: detail?.comments ?? [],
      patch: detail ? visiblePatch(detail) : undefined,
      modelTab: settings.residencyPolicy.mode,
      thread: threadData.thread,
      mode: threadData.thread.mode,
      messages: threadData.messages,
      workspaceEntries,
      pendingApprovals: detail?.approvals.filter((approval) => approval.status === "pending") ?? [],
      toast: detail?.contextWarning,
    });
    void get().refreshModels();
  },

  navigate(currentView) {
    set({ currentView, modelsOpen: false, fullEditor: false });
  },
  toggleModels(open) {
    set((state) => ({ modelsOpen: open ?? !state.modelsOpen }));
  },

  async setModelTab(modelTab) {
    const policy = { ...get().settings.residencyPolicy, mode: modelTab };
    await workbenchApi().models.setPolicy(policy);
    set((state) => ({ modelTab, settings: { ...state.settings, residencyPolicy: policy } }));
  },
  async refreshModels() {
    if (get().isScanningModels) return;
    set({ isScanningModels: true, toast: "Scanning the read-only GGUF model library..." });
    try {
      const models = await workbenchApi().models.scan();
      set({ models, toast: `Scanned ${models.length} local GGUF model${models.length === 1 ? "" : "s"}.` });
    } catch (error) {
      set({ toast: friendlyError(error) });
    } finally {
      set({ isScanningModels: false });
    }
  },
  async loadModel(modelId, options) {
    if (get().isAgentRunning) {
      set({ toast: "Wait for or cancel the active run before changing model residency." });
      return;
    }
    set({ busyModelId: modelId });
    try {
      await workbenchApi().models.load(modelId, options);
      const thread = get().thread;
      if (thread) set({ thread: await workbenchApi().threads.update(thread.id, { modelId }) });
      const runtime = await workbenchApi().app.getRuntimeStatus();
      set({ runtime, toast: "Model is ready and live VRAM measurement has started." });
    } catch (error) {
      set({ toast: friendlyError(error) });
    } finally {
      set({ busyModelId: undefined });
    }
  },
  async unloadModel(modelId) {
    if (get().isAgentRunning) {
      set({ toast: "Wait for or cancel the active run before changing model residency." });
      return;
    }
    try {
      await workbenchApi().models.unload(modelId);
      const runtime = await workbenchApi().app.getRuntimeStatus();
      set({ runtime, toast: "Model unloaded." });
    } catch (error) {
      set({ toast: friendlyError(error) });
    }
  },
  async pinModel(modelId, pinned) {
    await workbenchApi().models.pin(modelId, pinned);
  },

  async chooseWorkspace() {
    const settings = await workbenchApi().files.pickWorkspace();
    if (!settings) return;
    try {
      const workspaceEntries = await workbenchApi().files.list();
      const thread = await workbenchApi().threads.create({
        title: "Proto research run",
        mode: get().mode,
        modelId: get().models.find((model) => model.loadState === "active")?.id ?? get().models[0]?.id,
      });
      set({
        settings,
        workspaceEntries,
        thread,
        messages: [],
        streamingText: "",
        isAgentRunning: false,
        selectedRunId: undefined,
        events: [],
        review: emptyReview(),
        comments: [],
        patch: undefined,
        activeDocument: undefined,
        toast: "Workspace changed. Existing files were left untouched.",
      });
    } catch (error) {
      // The main process has already switched its capability root. Never keep
      // rendering the previous workspace as though it were still active when
      // indexing the newly selected root fails.
      set({
        settings,
        workspaceEntries: [],
        thread: undefined,
        messages: [],
        streamingText: "",
        isAgentRunning: false,
        selectedRunId: undefined,
        events: [],
        review: emptyReview(),
        comments: [],
        patch: undefined,
        activeDocument: undefined,
        toast: `Workspace changed, but its index was not loaded: ${friendlyError(error)}`,
      });
    }
  },
  async chooseModelRoot() {
    const settings = await workbenchApi().files.pickModelRoot();
    if (!settings) return;
    set({ settings });
    await get().refreshModels();
  },
  async chooseRuntime() {
    const settings = await workbenchApi().files.pickRuntime();
    if (!settings) return;
    const runtime = await workbenchApi().app.getRuntimeStatus();
    set({ settings, runtime, toast: runtime.detail });
  },
  async refreshWorkspaceEntries() {
    try {
      const workspaceEntries = await workbenchApi().files.list();
      set({ workspaceEntries, toast: "Workspace index refreshed." });
    } catch (error) {
      set({ toast: friendlyError(error) });
    }
  },
  async updateSettings(patch) {
    try {
      const settings = await workbenchApi().app.updateSettings(patch);
      set({ settings, modelTab: settings.residencyPolicy.mode, toast: "Settings saved." });
    } catch (error) {
      set({ toast: friendlyError(error) });
    }
  },

  async refreshRuns() {
    const [runs, operatorCockpit] = await Promise.all([
      workbenchApi().runs.list(get().showArchived),
      workbenchApi().runs.cockpit(),
    ]);
    set({ runs, operatorCockpit });
  },
  async refreshOperatorCockpit() {
    const operatorCockpit = await workbenchApi().runs.cockpit();
    set({ operatorCockpit });
  },
  async setShowArchived(showArchived) {
    set({ showArchived });
    const runs = await workbenchApi().runs.list(showArchived);
    set({ runs });
  },
  async archiveRun(runId, archived) {
    await workbenchApi().runs.archive(runId, archived);
    await get().refreshRuns();
    if (archived && !get().showArchived && get().selectedRunId === runId) {
      const next = get().runs[0];
      if (next) await get().selectRun(next.runId);
      else set({ selectedRunId: undefined, runDetail: undefined, events: [], review: emptyReview(), comments: [], patch: undefined, pendingApprovals: [] });
    }
    set({ toast: archived ? "Run archived." : "Run restored." });
  },
  async selectRun(runId) {
    const generation = ++runSelectionGeneration;
    set({ currentView: "runs", runDetailLoading: true, evidenceTab: "timeline" });
    try {
      const detail = await workbenchApi().runs.getDetail(runId);
      if (generation !== runSelectionGeneration) return;
      set((state) => ({
        ...runDetailState(detail),
        runs: mergeRunSummary(state.runs, detail.summary),
        currentView: "runs",
        runDetailLoading: false,
        activeDocument: undefined,
        toast: detail.contextWarning,
      }));
    } catch (error) {
      if (generation !== runSelectionGeneration) return;
      set({ runDetailLoading: false, toast: friendlyError(error) });
    }
  },
  async reconcileRunDetail(runId) {
    if (get().selectedRunId !== runId) return;
    try {
      const detail = await workbenchApi().runs.getDetail(runId);
      if (get().selectedRunId !== runId) return;
      set((state) => ({
        ...runDetailState(detail),
        currentView: state.currentView,
        activeDocument: state.activeDocument,
        patch: detail.activePatch ?? (state.activeDocument ? undefined : visiblePatch(detail)),
        selectedEventId: state.selectedEventId && detail.events.some((event) => event.id === state.selectedEventId)
          ? state.selectedEventId
          : selectedEventForDetail(detail),
        runs: mergeRunSummary(state.runs, detail.summary),
      }));
    } catch {
      // A stream event is only a refresh hint; explicit refresh surfaces any durable read error.
    }
  },
  async refreshCurrentRun() {
    const runId = get().selectedRunId;
    await get().refreshRuns();
    if (runId) await get().selectRun(runId);
    set({ toast: "Run data refreshed." });
  },
  async selectEvent(selectedEventId) {
    const event = get().events.find((item) => item.id === selectedEventId);
    const pendingPatch = get().runDetail?.activePatch;
    const selectsPendingPatch = Boolean(pendingPatch && event && event.id === pendingPatchEventId(get().events, pendingPatch));
    const artifact = event?.outputArtifacts[0] ?? "";
    set({
      selectedEventId,
      drawerCollapsed: false,
      patch: selectsPendingPatch ? pendingPatch : get().patch,
      activeDocument: selectsPendingPatch ? undefined : get().activeDocument,
      codeMode: selectsPendingPatch || event?.title.toLocaleLowerCase().includes("diff")
        ? "diff"
        : artifact.endsWith(".json")
          ? "artifact"
          : "code",
    });
    if (selectsPendingPatch) return;
    if (!artifact) {
      set({ activeDocument: undefined, patch: undefined });
      return;
    }
    try {
      const document = await workbenchApi().files.read(artifact);
      set({ activeDocument: { path: document.path, content: document.content }, patch: undefined });
    } catch {
      set({ activeDocument: undefined });
    }
  },
  selectEvidenceStep(selectedEventId) {
    if (!get().events.some((event) => event.id === selectedEventId)) return;
    set({ selectedEventId });
  },
  setEvidenceTab(evidenceTab) {
    set({ evidenceTab });
  },
  async openGlobalEvidenceHit(hit) {
    await get().selectRun(hit.runId);
    if (get().selectedRunId !== hit.runId) return;
    if (hit.target.eventId) get().selectEvidenceStep(hit.target.eventId);
    set({
      currentView: hit.target.view,
      evidenceTab: hit.target.evidenceTab ?? "timeline",
      toast: `Opened ${hit.kind} evidence from ${hit.runTitle}. No effect was executed.`,
    });
    if (hit.target.artifactLocator) await get().openEvidenceArtifact(hit.target.artifactLocator);
  },
  async openEvidenceArtifact(locator) {
    try {
      const document = await workbenchApi().files.read(locator);
      set({ activeDocument: { path: document.path, content: document.content }, patch: undefined, drawerCollapsed: false, codeMode: "artifact" });
    } catch (error) {
      set({ toast: friendlyError(error) });
    }
  },
  async createTaskCheckpoint(runId) {
    if (get().busyTaskHistoryAction || get().isAgentRunning || get().selectedRunId !== runId) return;
    set({ busyTaskHistoryAction: "checkpoint" });
    try {
      const checkpoint = await workbenchApi().runs.createCheckpoint(runId);
      set((state) => ({
        runDetail: state.runDetail?.summary.runId === runId
          ? {
              ...state.runDetail,
              taskCheckpoints: [
                ...state.runDetail.taskCheckpoints.filter((candidate) => candidate.id !== checkpoint.id),
                checkpoint,
              ].sort((left, right) => left.historyHead.sequence - right.historyHead.sequence || left.createdAt.localeCompare(right.createdAt)),
            }
          : state.runDetail,
        busyTaskHistoryAction: undefined,
        toast: `Immutable task checkpoint created at history sequence ${checkpoint.historyHead.sequence}. Current workspace files were not changed.`,
      }));
      void get().refreshOperatorCockpit();
    } catch (error) {
      set({ busyTaskHistoryAction: undefined, toast: friendlyError(error) });
    }
  },
  async reviewTaskResume(checkpointId) {
    if (get().busyTaskHistoryAction || get().isAgentRunning) return;
    set({ busyTaskHistoryAction: "resume-review", resumeContract: undefined, resumeCheckpointId: checkpointId });
    try {
      const contract = await workbenchApi().runs.previewResume(checkpointId);
      if (get().resumeCheckpointId !== checkpointId) return;
      set({ resumeContract: contract, busyTaskHistoryAction: undefined });
    } catch (error) {
      if (get().resumeCheckpointId !== checkpointId) return;
      set({ busyTaskHistoryAction: undefined, resumeContract: undefined, toast: friendlyError(error) });
    }
  },
  clearTaskResume() {
    set({ resumeContract: undefined, resumeCheckpointId: undefined });
  },
  async forkTaskCheckpoint(checkpointId, expectedSnapshotDigest, expectedResumeContractDigest, title) {
    if (get().busyTaskHistoryAction || get().isAgentRunning) return;
    set({ busyTaskHistoryAction: "fork" });
    try {
      const result = await workbenchApi().runs.forkCheckpoint({
        checkpointId,
        expectedSnapshotDigest,
        expectedResumeContractDigest,
        idempotencyKey: crypto.randomUUID(),
        title: title?.trim() || undefined,
      });
      set({
        currentView: "runs",
        selectedRunId: undefined,
        runDetail: undefined,
        runDetailLoading: false,
        events: [],
        selectedEventId: undefined,
        evidenceTab: "timeline",
        review: emptyReview(),
        comments: [],
        patch: undefined,
        activeDocument: undefined,
        pendingApprovals: [],
        resolvingApprovalId: undefined,
        busyPatchAction: undefined,
        busyTaskHistoryAction: undefined,
        thread: result.thread,
        messages: result.messages,
        mode: result.thread.mode,
        streamingText: "",
        isAgentRunning: false,
        agentStartedAt: undefined,
        prompt: "",
        attachments: [],
        missionPreflight: undefined,
        resumeContract: undefined,
        resumeCheckpointId: undefined,
        codeMode: "code",
        drawerCollapsed: false,
        fullEditor: false,
        ledgerSearch: "",
        ledgerSearchOpen: false,
        toast: "Task-only fork created. The parent run and current workspace files remain unchanged.",
      });
    } catch (error) {
      set({ busyTaskHistoryAction: undefined, toast: friendlyError(error) });
    }
  },
  setLedgerSearchOpen(ledgerSearchOpen) {
    set({ ledgerSearchOpen, ledgerSearch: ledgerSearchOpen ? get().ledgerSearch : "" });
  },
  setLedgerSearch(ledgerSearch) {
    set({ ledgerSearch });
  },
  setCodeMode(codeMode) {
    set({ codeMode });
  },
  setDiffLayout(diffLayout) {
    set({ diffLayout });
  },
  setDrawerCollapsed(drawerCollapsed) {
    set({ drawerCollapsed });
  },
  setFullEditor(fullEditor) {
    set({ fullEditor, drawerCollapsed: false });
  },
  setDrawerHeight(drawerHeight) {
    set({ drawerHeight: Math.min(520, Math.max(260, drawerHeight)) });
  },
  showPendingPatch() {
    const patch = get().runDetail?.activePatch;
    if (!patch) return;
    set((state) => ({
      patch,
      activeDocument: undefined,
      selectedEventId: pendingPatchEventId(state.events, patch),
      codeMode: "diff",
      drawerCollapsed: false,
      fullEditor: false,
    }));
  },

  async approvePatch() {
    const patch = get().patch;
    const detail = get().runDetail;
    if (!patch || patch.status !== "pending" || get().busyPatchAction || !detail?.allowedActions.approvePatch) return;
    set({ busyPatchAction: "approve" });
    try {
      const result = await workbenchApi().files.applyApprovedPatch(patch.id, patch.revision);
      const [nextDetail, runs, workspaceEntries] = await Promise.all([
        workbenchApi().runs.getDetail(patch.runId),
        workbenchApi().runs.list(get().showArchived),
        workbenchApi().files.list(),
      ]);
      set({
        ...runDetailState(nextDetail),
        patch: nextDetail.activePatch ?? result.patch,
        runs: mergeRunSummary(runs, nextDetail.summary),
        workspaceEntries,
        toast: patchOutcomeToast(nextDetail),
      });
    } catch (error) {
      set({ toast: friendlyError(error) });
    } finally {
      set({ busyPatchAction: undefined });
    }
  },
  async rejectPatch() {
    const patch = get().patch;
    const detail = get().runDetail;
    if (!patch || patch.status !== "pending" || get().busyPatchAction || !detail?.allowedActions.rejectPatch) return;
    set({ busyPatchAction: "reject" });
    try {
      await workbenchApi().files.rejectPatch(patch.id, patch.revision);
      const [nextDetail, runs] = await Promise.all([
        workbenchApi().runs.getDetail(patch.runId),
        workbenchApi().runs.list(get().showArchived),
      ]);
      set({
        ...runDetailState(nextDetail),
        runs: mergeRunSummary(runs, nextDetail.summary),
        toast: "Change rejected. No file was written.",
      });
    } catch (error) {
      set({ toast: friendlyError(error) });
    } finally {
      set({ busyPatchAction: undefined });
    }
  },
  async reconcilePatchEffect() {
    const detail = get().runDetail;
    const operation = detail?.activePatchOperation;
    if (!detail || !operation || get().busyPatchAction || !detail.allowedActions.reconcilePatchEffect) return;
    set({ busyPatchAction: "reconcile" });
    try {
      const reconciled = await workbenchApi().files.reconcilePatchOperation(operation.id, operation.revision);
      await get().reconcileRunDetail(operation.runId);
      set({
        toast: reconciled.state === "applied"
          ? "The intended file result is present. Validation can resume."
          : reconciled.state === "prepared"
            ? "No file effect was found. The reviewed operation can be retried."
            : "The file conflicts with both reviewed hashes. No content was overwritten.",
      });
    } catch (error) {
      set({ toast: friendlyError(error) });
    } finally {
      set({ busyPatchAction: undefined });
    }
  },
  async resumePatchValidation() {
    const detail = get().runDetail;
    const operation = detail?.activePatchOperation;
    if (!detail || !operation || get().busyPatchAction || !detail.allowedActions.resumePatchValidation) return;
    set({ busyPatchAction: "validate" });
    try {
      await workbenchApi().files.resumePatchValidation(operation.id, operation.revision);
      await get().reconcileRunDetail(operation.runId);
      set({ toast: "Deterministic validation resumed from the confirmed file result." });
    } catch (error) {
      await get().reconcileRunDetail(operation.runId).catch(() => undefined);
      set({ toast: friendlyError(error) });
    } finally {
      set({ busyPatchAction: undefined });
    }
  },
  async prepareCheckpointRestore() {
    const detail = get().runDetail;
    const operation = detail?.activePatchOperation;
    const checkpoint = operation
      ? detail?.checkpoints.find((candidate) => candidate.id === operation.checkpointId)
      : undefined;
    if (!detail || !operation || !checkpoint || get().busyPatchAction || !detail.allowedActions.prepareCheckpointRestore) return;
    set({ busyPatchAction: "restore" });
    try {
      await workbenchApi().files.prepareCheckpointRestore(checkpoint.id, checkpoint.revision);
      await get().reconcileRunDetail(operation.runId);
      get().showPendingPatch();
      set({ toast: "A checkpoint restore diff is ready for review. No file was overwritten." });
    } catch (error) {
      await get().reconcileRunDetail(operation.runId).catch(() => undefined);
      set({ toast: friendlyError(error) });
    } finally {
      set({ busyPatchAction: undefined });
    }
  },
  async updateChecklist(itemId, checked) {
    const runId = get().selectedRunId;
    if (!runId) return;
    await workbenchApi().reviews.updateChecklist(runId, itemId, checked ? "done" : "pending");
    await get().reconcileRunDetail(runId);
  },
  async addReviewComment(comment) {
    const runId = get().selectedRunId;
    if (!runId || !comment.trim()) return;
    await workbenchApi().reviews.addComment(runId, comment.trim());
    await get().reconcileRunDetail(runId);
    set({ toast: "Comment added to the audit trail." });
  },
  async approveRun() {
    const runId = get().selectedRunId;
    if (!runId) return;
    try {
      await workbenchApi().reviews.approve(runId);
      await get().reconcileRunDetail(runId);
      set({ toast: "Run approved and timestamped." });
    } catch (error) {
      set({ toast: friendlyError(error) });
    }
  },
  async openFile(path) {
    try {
      await workbenchApi().files.open(path);
    } catch (error) {
      set({ toast: friendlyError(error) });
    }
  },
  async revealFile(path) {
    try {
      await workbenchApi().files.reveal(path);
    } catch (error) {
      set({ toast: friendlyError(error) });
    }
  },

  setPrompt(prompt) {
    set({ prompt, missionPreflight: undefined });
  },
  async beginNewRun(mode) {
    if (get().isAgentRunning) {
      set({ toast: "Wait for or cancel the active run before starting a new draft." });
      return;
    }
    try {
      const activeModel = get().models.find((model) => model.loadState === "active")
        ?? get().models.find((model) => model.id === get().thread?.modelId)
        ?? get().models[0];
      const thread = await workbenchApi().threads.create({
        title: mode === "plan" ? "New planning run" : "New controlled run",
        mode,
        modelId: activeModel?.id,
      });
      set({
        currentView: "runs",
        thread,
        mode,
        selectedRunId: undefined,
        runDetail: undefined,
        runDetailLoading: false,
        events: [],
        selectedEventId: undefined,
        review: emptyReview(),
        comments: [],
        patch: undefined,
        activeDocument: undefined,
        messages: [],
        streamingText: "",
        pendingApprovals: [],
        prompt: "",
        missionPreflight: undefined,
        preflighting: false,
        attachments: [],
        codeMode: "code",
        drawerCollapsed: false,
        fullEditor: false,
        toast: mode === "plan"
          ? "New Plan draft ready. Describe the outcome you want to investigate."
          : "New Act draft ready. Every external side effect still requires review.",
      });
    } catch (error) {
      set({ toast: friendlyError(error) });
    }
  },
  async setMode(mode) {
    const thread = get().thread;
    if (!thread) {
      set({ mode, missionPreflight: undefined });
      return;
    }
    try {
      const next = await workbenchApi().threads.update(thread.id, { mode });
      set({ mode, thread: next, missionPreflight: undefined });
    } catch (error) {
      set({ toast: friendlyError(error) });
    }
  },
  async pickAttachments() {
    const attachments = await workbenchApi().files.pickAttachments();
    set((state) => ({
      attachments: dedupeAttachments([...state.attachments, ...attachments]),
      missionPreflight: undefined,
    }));
  },
  addReference(entry) {
    const attachment: ChatAttachment = {
      path: entry.path,
      name: entry.name,
      mediaType: entry.mediaType,
      sizeBytes: entry.sizeBytes,
    };
    set((state) => ({ attachments: dedupeAttachments([...state.attachments, attachment]), missionPreflight: undefined }));
  },
  removeAttachment(path) {
    set((state) => ({ attachments: state.attachments.filter((item) => item.path !== path), missionPreflight: undefined }));
  },
  async resolveToolApproval(approvalId, decision) {
    set({ resolvingApprovalId: approvalId });
    try {
      const approval = await workbenchApi().approvals.resolve(approvalId, decision);
      await get().reconcileRunDetail(approval.runId);
      set({
        toast: decision === "approved"
          ? "Approved once. The agent is continuing."
          : "Action rejected. The agent is continuing without it.",
      });
    } catch (error) {
      set({ toast: friendlyError(error) });
    } finally {
      set({ resolvingApprovalId: undefined });
    }
  },
  async send() {
    const { prompt, attachments, thread, settings, runtime, moduleIntegrity, models, workspaceEntries, isAgentRunning, missionPreflight, preflighting } = get();
    if (!thread || !prompt.trim() || isAgentRunning || preflighting) return;
    const readiness = deriveWorkbenchReadiness({ settings, runtime, moduleIntegrity, models, workspaceEntries, threadModelId: thread.modelId });
    if (!readiness.operational) {
      set({
        currentView: "launchpad",
        toast: readiness.next
          ? `${readiness.next.title} needs attention before starting a run.`
          : "Finish environment setup before starting a run.",
      });
      return;
    }
    if (!missionPreflight || missionPreflight.threadId !== thread.id) {
      const reviewedGoal = prompt.trim();
      const reviewedAttachments = attachmentIdentity(attachments);
      set({ preflighting: true, missionPreflight: undefined });
      try {
        const report = await workbenchApi().harness.preflight({
          threadId: thread.id,
          content: reviewedGoal,
          attachments,
        });
        const current = get();
        if (
          current.thread?.id !== thread.id
          || current.mode !== report.mode
          || current.prompt.trim() !== reviewedGoal
          || attachmentIdentity(current.attachments) !== reviewedAttachments
        ) {
          set({ preflighting: false, missionPreflight: undefined, toast: "The draft changed during preflight. Review the updated mission when ready." });
          return;
        }
        set({
          missionPreflight: report,
          preflighting: false,
          toast: report.launchable
            ? "Mission preflight is ready for your review. No task has started yet."
            : "Mission preflight found a blocker. No task was started.",
        });
      } catch (error) {
        set({ preflighting: false, toast: friendlyError(error) });
      }
      return;
    }
    if (!missionPreflight.launchable) {
      set({ toast: "Resolve the blocked preflight requirement, then refresh the review." });
      return;
    }
    const user: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt.trim(),
      attachments,
      createdAt: new Date().toISOString(),
    };
    set((state) => ({
      messages: [...state.messages, user],
      prompt: "",
      attachments: [],
      missionPreflight: undefined,
      streamingText: "",
      isAgentRunning: true,
      agentStartedAt: Date.now(),
    }));
    try {
      await workbenchApi().threads.send(thread.id, user.content, missionPreflight.digest, attachments);
    } catch (error) {
      set((state) => ({
        messages: state.messages.filter((message) => message.id !== user.id),
        prompt: state.prompt || user.content,
        attachments: dedupeAttachments([...attachments, ...state.attachments]),
        missionPreflight: undefined,
        isAgentRunning: false,
        agentStartedAt: undefined,
        toast: friendlyError(error),
      }));
    }
  },
  async refreshMissionPreflight() {
    if (get().preflighting || get().isAgentRunning) return;
    set({ missionPreflight: undefined });
    await get().send();
  },
  async cancel() {
    const thread = get().thread;
    if (!thread) return;
    await workbenchApi().threads.cancel(thread.id);
    set((state) => ({
      streamingText: "",
      isAgentRunning: false,
      agentStartedAt: undefined,
      pendingApprovals: state.pendingApprovals.filter((approval) => approval.runId !== state.selectedRunId),
      toast: "Agent request cancelled.",
    }));
  },
  clearToast() {
    set({ toast: undefined });
  },
}));

function dedupeAttachments(attachments: ChatAttachment[]): ChatAttachment[] {
  return [...new Map(attachments.map((attachment) => [attachment.path, attachment])).values()];
}

function attachmentIdentity(attachments: ChatAttachment[]): string {
  return attachments
    .map((attachment) => `${attachment.path}\u0000${attachment.mediaType}\u0000${attachment.sizeBytes}`)
    .sort()
    .join("\u0001");
}

function friendlyError(error: unknown): string {
  return String(error)
    .replace(/^Error:\s+Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
}

function runDetailState(detail: RunDetail) {
  return {
    selectedRunId: detail.summary.runId,
    runDetail: detail,
    events: detail.events,
    selectedEventId: selectedEventForDetail(detail),
    review: detail.review,
    comments: detail.comments,
    patch: visiblePatch(detail),
    pendingApprovals: detail.approvals.filter((approval) => approval.status === "pending"),
    thread: detail.thread,
    messages: detail.messages,
    mode: detail.thread?.mode ?? "act" as const,
  };
}

function visiblePatch(detail: RunDetail): PatchProposal | undefined {
  return detail.activePatch ?? detail.patches.find((patch) => Boolean(patch.targetPath));
}

function selectedEventForDetail(detail: RunDetail): string | undefined {
  return detail.activePatch
    ? pendingPatchEventId(detail.events, detail.activePatch)
    : detail.events.at(-1)?.id;
}

function pendingPatchEventId(events: AgentRunEvent[], patch: PatchProposal): string | undefined {
  const targetName = patch.targetPath.split(/[\\/]/).filter(Boolean).at(-1)?.toLocaleLowerCase();
  return [...events].reverse().find((event) =>
    event.stage === "design"
    && (event.status === "approval-required"
      || event.outputArtifacts.some((artifact) => !targetName || artifact.toLocaleLowerCase().includes(targetName))))?.id
    ?? events.at(-1)?.id;
}

function mergeRunSummary(runs: RunSummary[], summary: RunSummary): RunSummary[] {
  const exists = runs.some((run) => run.runId === summary.runId);
  const merged = exists
    ? runs.map((run) => run.runId === summary.runId ? summary : run)
    : [summary, ...runs];
  return merged.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function patchOutcomeToast(detail: RunDetail): string {
  switch (detail.summary.lifecycle.state) {
    case "failed":
      return "Change applied, but validation blocked human review.";
    case "validating":
      return "Change applied. Validation is still in progress.";
    case "review-required":
    case "ready-for-approval":
      return "Change applied. Evidence is ready for human review.";
    case "effect-unknown":
      return "Change state needs reconciliation before another action.";
    default:
      return "Change approved and applied.";
  }
}
