import {
  Archive,
  BookOpen,
  Boxes,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleAlert,
  Cpu,
  Database,
  ExternalLink,
  FileCode2,
  FileSearch,
  Fingerprint,
  FolderOpen,
  Gauge,
  HardDrive,
  HelpCircle,
  Inbox,
  LoaderCircle,
  LockKeyhole,
  MemoryStick,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  ShieldAlert,
  SlidersHorizontal,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type {
  FileCheckpoint,
  MaterialSummary,
  MaterialsFacets,
  MaterialsReviewInput,
  MaterialsStatus,
  ModelDescriptor,
  ModelLoadOptions,
  MissionLibraryEntry,
  OperatorAttentionItem,
  PatchOperation,
  PatchProposal,
  RunSummary,
  ValidationJournalSnapshot,
  VramEstimate,
} from "../shared/contracts.ts";
import {
  CORE_MODULES,
  modulesForProfile,
  OPTIONAL_MODULES,
  type ModuleIntegrityResult,
  type ModuleProfile,
  type OptionalModuleId,
  type WorkbenchModuleDescriptor,
} from "../shared/modules.ts";
import { workbenchApi } from "./mock-api.ts";
import { deriveWorkbenchReadiness, type ReadinessAction } from "./readiness.ts";
import { type AppView, useWorkbenchStore } from "./store.ts";

const DesignsPage = lazy(async () => {
  const module = await import("./DesignsPage.tsx");
  return { default: module.DesignsPage };
});

const GIB = 1024 ** 3;
const ATTENTION_FILTERS = [
  { id: "all", label: "All" },
  { id: "decisions", label: "Decisions" },
  { id: "recovery", label: "Recovery" },
  { id: "monitoring", label: "Monitoring" },
] as const;

export function OperationalPage({ view }: { view: Exclude<AppView, "runs"> }) {
  if (view === "launchpad") return <LaunchpadPage />;
  if (view === "workspaces") return <WorkspacesPage />;
  if (view === "designs") return <Suspense fallback={<div className="designs-page designs-loading" role="status"><LoaderCircle className="spin" size={22} /><div><strong>Opening Design Explorer</strong><span>Loading the local sequence renderer.</span></div></div>}><DesignsPage /></Suspense>;
  if (view === "models") return <LmStudioModelsPage />;
  if (view === "materials") return <MaterialsPage />;
  if (view === "sources") return <SourcesPage />;
  if (view === "reviews") return <ReviewsPage />;
  if (view === "settings") return <SettingsPage />;
  return <HelpPage />;
}

function LaunchpadPage() {
  const settings = useWorkbenchStore((state) => state.settings);
  const runtime = useWorkbenchStore((state) => state.runtime);
  const integrity = useWorkbenchStore((state) => state.moduleIntegrity);
  const models = useWorkbenchStore((state) => state.models);
  const thread = useWorkbenchStore((state) => state.thread);
  const entries = useWorkbenchStore((state) => state.workspaceEntries);
  const recovery = useWorkbenchStore((state) => state.startupRecovery);
  const cockpit = useWorkbenchStore((state) => state.operatorCockpit);
  const bootstrap = useWorkbenchStore((state) => state.bootstrap);
  const refreshOperatorCockpit = useWorkbenchStore((state) => state.refreshOperatorCockpit);
  const chooseWorkspace = useWorkbenchStore((state) => state.chooseWorkspace);
  const chooseModelRoot = useWorkbenchStore((state) => state.chooseModelRoot);
  const chooseRuntime = useWorkbenchStore((state) => state.chooseRuntime);
  const beginNewRun = useWorkbenchStore((state) => state.beginNewRun);
  const setPrompt = useWorkbenchStore((state) => state.setPrompt);
  const selectRun = useWorkbenchStore((state) => state.selectRun);
  const navigate = useWorkbenchStore((state) => state.navigate);
  const [rechecking, setRechecking] = useState(false);
  const [recheckError, setRecheckError] = useState<string>();
  const [attentionFilter, setAttentionFilter] = useState<"all" | "decisions" | "recovery" | "monitoring">("all");
  const [missionQuery, setMissionQuery] = useState("");
  const readiness = useMemo(
    () => deriveWorkbenchReadiness({
      settings,
      runtime,
      moduleIntegrity: integrity,
      models,
      workspaceEntries: entries,
      threadModelId: thread?.modelId,
    }),
    [settings, runtime, integrity, models, entries, thread?.modelId],
  );
  const activeModel = models.find((model) => model.id === thread?.modelId && model.loadState === "active")
    ?? (!thread?.modelId ? models.find((model) => model.loadState === "active") : undefined);

  const runAction = async (action: ReadinessAction) => {
    if (action === "choose-workspace") return chooseWorkspace();
    if (action === "choose-runtime") return chooseRuntime();
    if (action === "choose-model-root") return chooseModelRoot();
    navigate(action === "open-models" ? "models" : "settings");
  };
  const recheck = async () => {
    setRechecking(true);
    setRecheckError(undefined);
    try {
      await bootstrap();
    } catch (error) {
      setRecheckError(String(error).replace(/^Error:\s*/i, ""));
    } finally {
      setRechecking(false);
    }
  };
  const startRun = async (mode: "plan" | "act") => {
    await beginNewRun(mode);
  };
  const startMission = async (mission: MissionLibraryEntry) => {
    await beginNewRun(mission.mode);
    setPrompt(mission.goal);
  };
  const openAttention = async (item: OperatorAttentionItem) => {
    await selectRun(item.runId);
    if (item.target === "reviews") navigate("reviews");
  };
  const openRecovery = async () => {
    const affectedRunId = recovery.runIds[0];
    if (affectedRunId) await selectRun(affectedRunId);
    navigate("runs");
  };
  const reconciledValidationJournals = recovery.reconciledValidationJournals ?? 0;
  const validationStepsNeedingReplay = recovery.validationStepsNeedingReplay ?? 0;
  const hasRecoveryNotice = Boolean(
    recovery.workspaceFallback
    || recovery.recoveredRuns > 0
    || recovery.invalidatedApprovals > 0
    || recovery.reconciledPatchOperations > 0
    || recovery.conflictedPatchOperations > 0
    || reconciledValidationJournals > 0
    || validationStepsNeedingReplay > 0
  );
  const recoveryHeadline = recovery.conflictedPatchOperations > 0
    ? `${recovery.conflictedPatchOperations} file effect${recovery.conflictedPatchOperations === 1 ? "" : "s"} need reconciliation`
    : validationStepsNeedingReplay > 0
      ? `${validationStepsNeedingReplay} validation step${validationStepsNeedingReplay === 1 ? "" : "s"} need explicit resume`
    : recovery.workspaceFallback
      ? "Workspace recovery completed"
      : recovery.recoveredRuns > 0
        ? `${recovery.recoveredRuns} interrupted run${recovery.recoveredRuns === 1 ? "" : "s"} reconciled`
        : recovery.invalidatedApprovals > 0
          ? `${recovery.invalidatedApprovals} stale approval${recovery.invalidatedApprovals === 1 ? "" : "s"} invalidated`
          : reconciledValidationJournals > 0
            ? `${reconciledValidationJournals} validation journal${reconciledValidationJournals === 1 ? "" : "s"} reconciled`
            : `${recovery.reconciledPatchOperations} patch operation${recovery.reconciledPatchOperations === 1 ? "" : "s"} reconciled`;
  const filteredAttention = (cockpit?.attentionItems ?? []).filter((item) => {
    if (attentionFilter === "decisions") return ["tool-approval", "patch-review", "human-review"].includes(item.attention);
    if (attentionFilter === "recovery") return ["recovery", "failure"].includes(item.attention);
    if (attentionFilter === "monitoring") return ["patch-operation", "validation"].includes(item.attention);
    return true;
  });
  const normalizedMissionQuery = missionQuery.trim().toLocaleLowerCase();
  const visibleMissions = (cockpit?.missionLibrary ?? []).filter((mission) => !normalizedMissionQuery
    || `${mission.title} ${mission.summary} ${mission.mode}`.toLocaleLowerCase().includes(normalizedMissionQuery));

  return (
    <div className="operational-page launchpad-page">
      <PageHeader
        icon={Gauge}
        title="Launchpad"
        subtitle="A live readiness check for the local workspace, runtime, model, and safety harness."
        actions={<button className="secondary-button" type="button" onClick={() => void recheck()} disabled={rechecking}><RefreshCw className={rechecking ? "spin" : undefined} size={13} />Recheck</button>}
      />
      {hasRecoveryNotice && (
        <section className="recovery-banner" role="status">
          <span><RotateCcw size={18} /></span>
          <div>
            <strong>{recoveryHeadline}</strong>
            <p>{recovery.workspaceFallback ? `The saved workspace was unavailable, so Proto opened the safe default at ${recovery.workspaceFallback.activePath}. ` : ""}{recovery.recoveredEvents} unfinished ledger event{recovery.recoveredEvents === 1 ? " was" : "s were"} marked interrupted or effect unknown without replaying model, network, or write side effects. {recovery.invalidatedApprovals} stale approval{recovery.invalidatedApprovals === 1 ? " was" : "s were"} invalidated. {recovery.reconciledPatchOperations} patch operation{recovery.reconciledPatchOperations === 1 ? " was" : "s were"} matched to disk; {recovery.conflictedPatchOperations} still require explicit reconciliation. {reconciledValidationJournals} validation journal{reconciledValidationJournals === 1 ? " was" : "s were"} rebuilt from durable evidence; {validationStepsNeedingReplay} step{validationStepsNeedingReplay === 1 ? "" : "s"} require an explicit resume decision.</p>
          </div>
          <button className="secondary-button" type="button" onClick={() => recovery.workspaceFallback ? void chooseWorkspace() : void openRecovery()}>{recovery.workspaceFallback ? "Choose workspace" : recovery.runIds.length ? "Review affected run" : "Review runs"}</button>
        </section>
      )}
      <section className={`readiness-hero ${readiness.operational ? "is-ready" : "needs-action"}`}>
        <div className="readiness-score" aria-label={`${readiness.readyCount} of ${readiness.totalCount} readiness checks complete`}>
          <strong>{readiness.readyCount}/{readiness.totalCount}</strong><span>checks ready</span>
        </div>
        <div className="readiness-copy">
          <span className="eyebrow">Environment readiness</span>
          <h2>{readiness.operational ? "Ready for a controlled local run" : `${readiness.totalCount - readiness.readyCount} setup action${readiness.totalCount - readiness.readyCount === 1 ? "" : "s"} remaining`}</h2>
          <p>{readiness.operational ? "Proto will keep file writes, network calls, and code execution behind explicit review gates." : readiness.next?.detail}</p>
        </div>
        {readiness.next
          ? <button className="primary-button" type="button" onClick={() => void runAction(readiness.next!.action)}>{readiness.next.actionLabel}</button>
          : <button className="primary-button" type="button" onClick={() => void startRun("plan")}><SlidersHorizontal size={14} />New Plan draft</button>}
      </section>
      {recheckError && <div className="launchpad-inline-error" role="alert"><CircleAlert size={15} /><span>{recheckError}</span><button type="button" onClick={() => void recheck()}>Retry</button></div>}
      <ol className="readiness-grid" aria-label="Workbench readiness checklist">
        {readiness.steps.map((step, index) => (
          <li className={`readiness-card is-${step.state}`} key={step.id} aria-current={readiness.next?.id === step.id ? "step" : undefined}>
            <div className="readiness-card-top"><span className="readiness-step-index">{step.state === "ready" ? <Check size={14} /> : index + 1}</span><span className="readiness-state">{step.state === "ready" ? "Ready" : step.state === "blocked" ? "Blocked" : "Action needed"}</span></div>
            <h3>{step.title}</h3><p>{step.detail}</p>
            <button className="readiness-action" type="button" onClick={() => void runAction(step.action)}>{step.actionLabel}<ExternalLink size={12} /></button>
          </li>
        ))}
      </ol>
      <section className="operator-cockpit" aria-labelledby="operator-cockpit-title">
        <header className="operator-cockpit-heading">
          <span className="operator-cockpit-icon" aria-hidden="true"><Inbox size={18} /></span>
          <div><span className="eyebrow">Mission control</span><h2 id="operator-cockpit-title">Operator cockpit</h2><p>One trusted view of runs that need attention and reusable missions that only prepare a draft.</p></div>
          <div className="operator-cockpit-meta"><code title={cockpit?.digest}>{cockpit ? shortHash(cockpit.digest) : "Loading"}</code><button className="quiet-button compact-command" type="button" onClick={() => void refreshOperatorCockpit()}><RefreshCw size={12} />Refresh</button></div>
        </header>
        <dl className="operator-cockpit-metrics">
          <div><dt>Needs attention</dt><dd>{cockpit?.attentionCounts.total ?? 0}</dd></div>
          <div><dt>Human decisions</dt><dd>{cockpit?.attentionCounts.approvals ?? 0}</dd></div>
          <div><dt>Recovery</dt><dd>{cockpit?.attentionCounts.recovery ?? 0}</dd></div>
          <div><dt>Mission recipes</dt><dd>{cockpit?.missionLibrary.length ?? 0}</dd></div>
        </dl>
        <div className="operator-cockpit-grid">
          <section className="attention-inbox" aria-label="Cross-run attention inbox">
            <header><div><h3>Attention inbox</h3><p>Durable run state, ordered by urgency.</p></div><span>{filteredAttention.length}/{cockpit?.attentionCounts.total ?? 0}</span></header>
            <div className="attention-filters" role="group" aria-label="Filter attention inbox">
              {ATTENTION_FILTERS.map((filter) => <button className={attentionFilter === filter.id ? "is-selected" : ""} type="button" aria-pressed={attentionFilter === filter.id} onClick={() => setAttentionFilter(filter.id)} key={filter.id}>{filter.label}</button>)}
            </div>
            <ol className="attention-list">
              {filteredAttention.slice(0, 6).map((item) => <li className={`is-${item.priority}`} key={item.id}>
                <span className="attention-item-icon" aria-hidden="true">{item.priority === "critical" ? <CircleAlert size={14} /> : item.priority === "monitoring" ? <LoaderCircle size={14} /> : <ShieldAlert size={14} />}</span>
                <div><span className="attention-run"><strong>{item.runTitle}</strong><small>{formatDate(item.runCreatedAt)}</small></span><b>{item.label}</b><p>{item.detail}</p><small className="attention-revision" title={item.snapshotRevision}>Snapshot {shortHash(item.digest)}</small></div>
                <button className="secondary-button compact-command" type="button" onClick={() => void openAttention(item)}>{item.actionLabel}<ChevronRight size={12} /></button>
              </li>)}
              {cockpit && filteredAttention.length === 0 && <li className="attention-empty"><CheckCircle2 size={16} /><div><b>No matching attention</b><p>Nothing in this filter requires a decision.</p></div></li>}
              {!cockpit && <li className="attention-empty"><LoaderCircle className="spin" size={16} /><div><b>Building trusted projection</b><p>Reading durable run state without starting work.</p></div></li>}
            </ol>
          </section>
          <section className="mission-library" aria-label="Reusable mission library">
            <header><div><h3>Mission library</h3><p>Built-ins plus immutable checkpoint recipes.</p></div><span>{visibleMissions.length}</span></header>
            <label className="mission-library-search"><Search size={13} /><input value={missionQuery} onChange={(event) => setMissionQuery(event.target.value)} placeholder="Find a mission…" aria-label="Find a reusable mission" /></label>
            <div className="mission-library-list">
              {visibleMissions.slice(0, 5).map((mission) => <article key={mission.id}>
                <span className={`mission-library-icon is-${mission.source}`} aria-hidden="true">{mission.source === "checkpoint" ? <Fingerprint size={14} /> : mission.mode === "act" ? <FileCode2 size={14} /> : <BookOpen size={14} />}</span>
                <div><span className="mission-library-title"><strong>{mission.title}</strong><small>{mission.source === "checkpoint" ? "Saved recipe" : "Built-in"}</small></span><p>{mission.summary}</p><div className="mission-posture"><span>{mission.mode}</span>{mission.intent.network && <span>Network gated</span>}{mission.intent.writes && <span>Writes gated</span>}{mission.intent.execution && <span>Execution gated</span>}</div></div>
                <button className="quiet-button compact-command" type="button" disabled={!readiness.operational} onClick={() => void startMission(mission)}>Prepare draft<ChevronRight size={12} /></button>
              </article>)}
              {cockpit && visibleMissions.length === 0 && <div className="mission-library-empty">No reusable mission matches “{missionQuery}”.</div>}
            </div>
          </section>
        </div>
        <footer><ShieldCheck size={13} /><span>Inbox actions only navigate to durable evidence. Mission recipes create an unsent draft and always require a fresh Mission Preflight.</span></footer>
      </section>
      <section className="guided-run-section">
        <div><span className="eyebrow">Blank mission</span><h2>Start with an explicit permission posture</h2><p>These choices create a new empty draft and leave earlier runs untouched. Use the Mission Library above when you want a reusable goal as a starting point.</p></div>
        <div className="guided-run-actions">
          <button className="secondary-button guided-mode" type="button" disabled={!readiness.operational} onClick={() => void startRun("plan")}><LockKeyhole size={16} /><span><strong>Plan</strong><small>Explore and prepare without file writes</small></span></button>
          <button className="primary-button guided-mode" type="button" disabled={!readiness.operational} onClick={() => void startRun("act")}><ShieldCheck size={16} /><span><strong>Act with approvals</strong><small>Propose reviewable changes behind gates</small></span></button>
        </div>
        <dl className="readiness-facts"><div><dt>Workspace</dt><dd>{entries.length} indexed files</dd></div><div><dt>Runtime</dt><dd>{runtime.available ? runtime.backend?.toUpperCase() ?? "Available" : "Not ready"}</dd></div><div><dt>Model</dt><dd>{activeModel?.name ?? "Not loaded"}</dd></div><div><dt>Safety</dt><dd>Human review required</dd></div></dl>
      </section>
    </div>
  );
}

function PageHeader({ icon: Icon, title, subtitle, actions }: {
  icon: typeof FolderOpen;
  title: string;
  subtitle: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <span className="page-header-icon"><Icon size={19} /></span>
      <div><h1>{title}</h1><p>{subtitle}</p></div>
      <div className="page-header-actions">{actions}</div>
    </header>
  );
}

function WorkspacesPage() {
  const settings = useWorkbenchStore((state) => state.settings);
  const entries = useWorkbenchStore((state) => state.workspaceEntries);
  const chooseWorkspace = useWorkbenchStore((state) => state.chooseWorkspace);
  const refresh = useWorkbenchStore((state) => state.refreshWorkspaceEntries);
  const openFile = useWorkbenchStore((state) => state.openFile);
  const revealFile = useWorkbenchStore((state) => state.revealFile);
  const designs = entries.filter((entry) => entry.name.toLocaleLowerCase().endsWith(".proto"));
  const artifacts = entries.filter((entry) => /(^|[\\/])build[\\/]/i.test(entry.relativePath));

  return (
    <div className="operational-page">
      <PageHeader
        icon={FolderOpen}
        title="Workspace"
        subtitle={settings.workspacePath || "Choose a workspace to begin."}
        actions={<>
          <button className="secondary-button" type="button" onClick={() => void refresh()}><RefreshCw size={14} />Refresh</button>
          <button className="primary-button" type="button" onClick={() => void chooseWorkspace()}><FolderOpen size={14} />Choose folder</button>
        </>}
      />
      <section className="metric-strip" aria-label="Workspace summary">
        <Metric label="Indexed files" value={String(entries.length)} icon={FileSearch} />
        <Metric label="Proto designs" value={String(designs.length)} icon={FileCode2} />
        <Metric label="Build artifacts" value={String(artifacts.length)} icon={Archive} />
      </section>
      <section className="page-section">
        <div className="section-heading"><div><h2>Workspace files</h2><p>Reviewable source files and generated evidence under the selected root.</p></div></div>
        <div className="data-list">
          {entries.length === 0 && <EmptyState icon={FolderOpen} title="No reviewable files" detail="Choose a Proto workspace or add supported source files." />}
          {entries.slice(0, 200).map((entry) => (
            <div className="data-row file-data-row" key={entry.path}>
              <FileCode2 size={15} />
              <div className="data-row-copy"><strong>{entry.name}</strong><span>{entry.relativePath}</span></div>
              <span>{formatBytes(entry.sizeBytes)}</span>
              <time>{formatDate(entry.modifiedAt)}</time>
              <button className="icon-button" type="button" onClick={() => void revealFile(entry.path)} title="Show in folder" aria-label={`Show ${entry.name} in folder`}><FolderOpen size={14} /></button>
              <button className="secondary-button compact-command" type="button" onClick={() => void openFile(entry.path)}><ExternalLink size={13} />Open</button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function LmStudioModelsPage() {
  const models = useWorkbenchStore((state) => state.models);
  const settings = useWorkbenchStore((state) => state.settings);
  const runtime = useWorkbenchStore((state) => state.runtime);
  const isScanningModels = useWorkbenchStore((state) => state.isScanningModels);
  const refreshModels = useWorkbenchStore((state) => state.refreshModels);
  const loadModel = useWorkbenchStore((state) => state.loadModel);
  const unloadModel = useWorkbenchStore((state) => state.unloadModel);
  const busyModelId = useWorkbenchStore((state) => state.busyModelId);
  const isAgentRunning = useWorkbenchStore((state) => state.isAgentRunning);
  const llms = models.filter((model) => model.modelKind !== "embedding");
  const [selectedId, setSelectedId] = useState<string>();
  const selected = models.find((model) => model.id === selectedId) ?? llms[0] ?? models[0];
  const [contextLength, setContextLength] = useState(32_768);
  const [evalBatchSize, setEvalBatchSize] = useState(512);
  const [flashAttention, setFlashAttention] = useState(true);
  const [kvCachePlacement, setKvCachePlacement] = useState<"gpu" | "cpu">("gpu");
  const [numExperts, setNumExperts] = useState<number>();
  const [instanceId, setInstanceId] = useState<string>();

  useEffect(() => {
    if (!selected) return;
    setSelectedId(selected.id);
    const loaded = selected.loadedInstances?.find((instance) => instance.id === selected.workbenchInstance?.id)
      ?? selected.loadedInstances?.[0];
    setContextLength(loaded?.contextLength ?? Math.min(selected.contextLength, 32_768));
    setEvalBatchSize(loaded?.evalBatchSize ?? 512);
    setFlashAttention(loaded?.flashAttention ?? true);
    setKvCachePlacement(loaded?.offloadKvCacheToGpu === false ? "cpu" : "gpu");
    setNumExperts(loaded?.numExperts);
    setInstanceId(loaded?.id);
  }, [selected?.id]);

  const loadedCount = selected?.loadedInstances?.length ?? 0;
  const connected = Boolean(selected?.workbenchInstance && selected.loadState === "active");
  const busy = selected?.id === busyModelId;
  const modelOptions: Partial<ModelLoadOptions> = {
    contextLength,
    evalBatchSize,
    flashAttention,
    kvCachePlacement,
    ...(numExperts ? { numExperts } : {}),
    ...(loadedCount ? { instanceId } : {}),
  };
  const contextPresets = selected
    ? [8_192, 32_768, 131_072, 262_144, 524_288, 1_048_576]
      .filter((value) => value <= selected.contextLength)
    : [];

  return (
    <div className="operational-page">
      <PageHeader
        icon={Boxes}
        title="LM Studio models"
        subtitle={`Native discovery and explicit instance control at ${settings.inference.baseUrl}. Chat uses OpenAI-compatible SSE.`}
        actions={
          <button className="secondary-button" type="button" disabled={isScanningModels} onClick={() => void refreshModels()}>
            {isScanningModels ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
            {isScanningModels ? "Synchronizing" : "Refresh LM Studio"}
          </button>
        }
      />
      <section className="metric-strip" aria-label="LM Studio status">
        <Metric label="Endpoint" value={runtime.available ? "Reachable" : "Unavailable"} icon={runtime.available ? CheckCircle2 : CircleAlert} />
        <Metric label="Catalog models" value={String(runtime.modelCount ?? models.length)} icon={Boxes} />
        <Metric label="Loaded instances" value={String(runtime.loadedModelCount ?? models.reduce((sum, model) => sum + (model.loadedInstances?.length ?? 0), 0))} icon={Gauge} />
      </section>
      <div className="model-page-layout">
        <section className="model-catalog-panel">
          <div className="model-catalog-heading"><span>Model</span><span>Type</span><span>State</span></div>
          <div className="model-catalog-list">
            {models.length === 0 && isScanningModels && (
              <EmptyState busy icon={LoaderCircle} title="Synchronizing LM Studio" detail="Reading native model metadata and loaded_instances from /api/v1/models." />
            )}
            {models.length === 0 && !isScanningModels && (
              <EmptyState icon={Boxes} title="No LM Studio models discovered" detail={`Start LM Studio's local server at ${settings.inference.baseUrl}, then refresh.`} />
            )}
            {models.map((model) => {
              const instances = model.loadedInstances?.length ?? 0;
              const state = model.workbenchInstance
                ? "Connected"
                : instances
                  ? `${instances} loaded`
                  : "Available";
              return (
                <button
                  className={`catalog-model-row ${selected?.id === model.id ? "is-selected" : ""}`}
                  type="button"
                  key={model.id}
                  onClick={() => setSelectedId(model.id)}
                >
                  <span className={`model-dot is-${model.workbenchInstance ? "active" : instances ? "warm" : "unloaded"}`} />
                  <span className="catalog-model-copy">
                    <strong>{model.name}</strong>
                    <small>{model.publisher || "Local"} · {model.quantization} · {formatContext(model.contextLength)}</small>
                  </span>
                  <span>{model.modelKind ?? "llm"}</span>
                  <span className={`model-state is-${model.workbenchInstance ? "active" : instances ? "warm" : "unloaded"}`}>{state}</span>
                </button>
              );
            })}
          </div>
        </section>
        <section className="model-load-panel">
          {!selected ? <EmptyState icon={Gauge} title="Select a model" detail="LM Studio load controls will appear here." /> : <>
            <div className="model-detail-heading">
              <div>
                <h2>{selected.name}</h2>
                <p title={selected.providerModelId}>{selected.providerModelId}</p>
              </div>
              <span className={`runtime-status-line is-${runtime.available ? "cuda" : "missing"}`}><span />{runtime.available ? "LM Studio connected" : "LM Studio unavailable"}</span>
            </div>
            <div className="data-list">
              <div className="data-row"><strong>Architecture</strong><span>{selected.architecture}</span><strong>Format</strong><span>{selected.format ?? "unknown"}</span></div>
              <div className="data-row"><strong>Capabilities</strong><span>{[selected.vision ? "vision" : undefined, selected.toolCapability === "agent-ready" ? "tools" : undefined, selected.reasoning ? `reasoning:${selected.reasoning.default}` : undefined].filter(Boolean).join(" · ") || "chat"}</span></div>
              <div className="data-row"><strong>LM Studio instances</strong><span>{loadedCount || "None"}</span><strong>Workbench</strong><span>{selected.workbenchInstance ? `${selected.workbenchInstance.ownedByWorkbench ? "Owned" : "Attached"}: ${selected.workbenchInstance.id}` : "Not connected"}</span></div>
            </div>
            {selected.modelKind === "embedding" ? (
              <div className="model-load-error" role="status"><CircleAlert size={14} /><span>Embedding models are discoverable for inventory, but cannot be selected for Workbench chat.</span></div>
            ) : <>
              {loadedCount > 0 && !connected && (
                <div className="load-control-group">
                  <label><span>Exact loaded instance</span><output>{loadedCount} available</output></label>
                  <select value={instanceId ?? ""} onChange={(event) => setInstanceId(event.target.value)}>
                    {selected.loadedInstances?.map((instance) => <option key={instance.id} value={instance.id}>{instance.id} · {formatContext(instance.contextLength)}</option>)}
                  </select>
                </div>
              )}
              <div className="load-control-group">
                <label><span>Context length</span><output>{contextLength.toLocaleString()} tokens</output></label>
                <div className="context-preset-row" aria-label="Context presets">
                  {contextPresets.map((value) => <button className={contextLength === value ? "is-selected" : ""} type="button" key={value} onClick={() => setContextLength(value)}>{contextPresetLabel(value)}</button>)}
                </div>
                <input className="number-field" type="number" min={256} max={selected.contextLength} step={256} value={contextLength} onChange={(event) => setContextLength(Number(event.target.value))} />
              </div>
              <div className="load-control-group">
                <label><span>Evaluation batch size</span><output>{evalBatchSize.toLocaleString()} tokens</output></label>
                <input className="number-field" type="number" min={1} max={65_536} step={1} value={evalBatchSize} onChange={(event) => setEvalBatchSize(Number(event.target.value))} />
              </div>
              <div className="load-control-line">
                <span>Flash Attention</span>
                <div className="segmented-control compact"><button className={flashAttention ? "is-selected" : ""} type="button" onClick={() => setFlashAttention(true)}>On</button><button className={!flashAttention ? "is-selected" : ""} type="button" onClick={() => setFlashAttention(false)}>Off</button></div>
              </div>
              <div className="load-control-line">
                <span>KV cache location</span>
                <div className="segmented-control compact"><button className={kvCachePlacement === "gpu" ? "is-selected" : ""} type="button" onClick={() => setKvCachePlacement("gpu")}>GPU</button><button className={kvCachePlacement === "cpu" ? "is-selected" : ""} type="button" onClick={() => setKvCachePlacement("cpu")}>System RAM</button></div>
              </div>
              <div className="load-control-group">
                <label><span>MoE experts (optional)</span><output>{numExperts ?? "LM Studio default"}</output></label>
                <input className="number-field" type="number" min={1} max={1_024} placeholder="Default" value={numExperts ?? ""} onChange={(event) => setNumExperts(event.target.value ? Number(event.target.value) : undefined)} />
              </div>
              <p>Load is always explicit. Before every chat, Workbench re-reads loaded_instances and refuses inference if this exact instance is absent. Disconnect only unloads instances created by Workbench.</p>
              {selected.error && <div className="model-load-error" role="status"><CircleAlert size={14} /><span>{selected.error}</span></div>}
              <div className="model-load-actions">
                {connected && <button className="secondary-button danger" type="button" disabled={isAgentRunning || busy} onClick={() => void unloadModel(selected.id)}>{selected.workbenchInstance?.ownedByWorkbench ? "Unload owned instance" : "Disconnect"}</button>}
                {!connected && <button className="primary-button" type="button" disabled={isAgentRunning || busy || Boolean(loadedCount && !instanceId) || contextLength < 256 || contextLength > selected.contextLength} onClick={() => void loadModel(selected.id, modelOptions)}>{busy ? <LoaderCircle className="spin" size={14} /> : <Gauge size={14} />}{loadedCount ? "Connect loaded instance" : "Load in LM Studio"}</button>}
              </div>
            </>}
          </>}
        </section>
      </div>
    </div>
  );
}

function SourcesPage() {
  const entries = useWorkbenchStore((state) => state.workspaceEntries);
  const openFile = useWorkbenchStore((state) => state.openFile);
  const revealFile = useWorkbenchStore((state) => state.revealFile);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ path: string; line: number; preview: string }>>([]);
  const [searching, setSearching] = useState(false);
  const sources = entries.filter((entry) => /(^|[\\/])(literature|connectors|parts)[\\/]/i.test(entry.relativePath));
  const search = async () => {
    if (!query.trim()) { setResults([]); return; }
    setSearching(true);
    try { setResults(await workbenchApi().files.search(query.trim())); } finally { setSearching(false); }
  };
  return (
    <div className="operational-page">
      <PageHeader icon={BookOpen} title="Sources" subtitle="Search local literature notes, connector declarations, parts libraries, and review evidence." />
      <section className="source-search-band">
        <Search size={16} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} placeholder="Search workspace evidence" aria-label="Search workspace evidence" />
        <button className="primary-button" type="button" disabled={!query.trim() || searching} onClick={() => void search()}>{searching ? <LoaderCircle className="spin" size={14} /> : <Search size={14} />}Search</button>
      </section>
      {results.length > 0 && <section className="page-section"><div className="section-heading"><div><h2>Search results</h2><p>{results.length} matching lines</p></div></div><div className="data-list">{results.map((result) => <div className="data-row source-result-row" key={`${result.path}:${result.line}`}><FileSearch size={14} /><div className="data-row-copy"><strong>{shortPath(result.path)}:{result.line}</strong><span>{result.preview}</span></div><button className="secondary-button compact-command" type="button" onClick={() => void openFile(result.path)}><ExternalLink size={13} />Open</button></div>)}</div></section>}
      <section className="page-section">
        <div className="section-heading"><div><h2>Declared local sources</h2><p>Opening a file never grants it instruction authority.</p></div></div>
        <div className="data-list">
          {sources.length === 0 && <EmptyState icon={BookOpen} title="No source files indexed" detail="Add literature, connector, or parts files under the workspace." />}
          {sources.map((entry) => <div className="data-row file-data-row" key={entry.path}><BookOpen size={14} /><div className="data-row-copy"><strong>{entry.name}</strong><span>{entry.relativePath}</span></div><span>{formatBytes(entry.sizeBytes)}</span><button className="icon-button" type="button" onClick={() => void revealFile(entry.path)} title="Show in folder" aria-label={`Show ${entry.name} in folder`}><FolderOpen size={14} /></button><button className="secondary-button compact-command" type="button" onClick={() => void openFile(entry.path)}><ExternalLink size={13} />Open</button></div>)}
        </div>
      </section>
    </div>
  );
}

function MaterialsPage() {
  const [status, setStatus] = useState<MaterialsStatus>();
  const [facets, setFacets] = useState<MaterialsFacets>();
  const [matches, setMatches] = useState<MaterialSummary[]>([]);
  const [selected, setSelected] = useState<MaterialSummary>();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [source, setSource] = useState("");
  const [syncSource, setSyncSource] = useState<"uniprot" | "igem" | "rhea" | "biomodels">("uniprot");
  const [syncLimit, setSyncLimit] = useState(1000);
  const [snapshotInput, setSnapshotInput] = useState("");
  const [activationOperator, setActivationOperator] = useState("");
  const [activationApprovalReference, setActivationApprovalReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [diffLeft, setDiffLeft] = useState("");
  const [diffRight, setDiffRight] = useState("");
  const [diff, setDiff] = useState<Record<string, unknown>>();
  const [reviewResourceId, setReviewResourceId] = useState("");
  const [reviewDescriptionEn, setReviewDescriptionEn] = useState("");
  const [reviewDescriptionZh, setReviewDescriptionZh] = useState("");
  const [reviewer, setReviewer] = useState("human");

  const refresh = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const api = workbenchApi();
      const [nextStatus, nextFacets, nextSearch] = await Promise.all([
        api.materials.status(),
        api.materials.facets(),
        api.materials.search({ query, kind: kind || undefined, source: source || undefined, limit: 50 }),
      ]);
      setStatus(nextStatus);
      setFacets(nextFacets);
      setMatches(nextSearch.matches);
      setDiffLeft((current) => current || nextStatus.active_snapshot || nextStatus.snapshots[0]?.snapshot_id || "");
      setDiffRight((current) => current || nextStatus.snapshots[0]?.snapshot_id || nextStatus.active_snapshot || "");
      if (selected) {
        const current = nextSearch.matches.find((item) => item.resource_id === selected.resource_id);
        if (current) setSelected(current);
      }
    } catch (cause) {
      setError(String(cause).replace(/^Error:\s*/i, ""));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const runSearch = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await workbenchApi().materials.search({ query, kind: kind || undefined, source: source || undefined, limit: 50 });
      setMatches(result.matches);
      setSelected(undefined);
    } catch (cause) {
      setError(String(cause).replace(/^Error:\s*/i, ""));
    } finally {
      setBusy(false);
    }
  };

  const runAdminAction = async (action: () => Promise<Record<string, unknown>>, success: string) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await action();
      setNotice(success);
      await refresh();
    } catch (cause) {
      setError(String(cause).replace(/^Error:\s*/i, ""));
    } finally {
      setBusy(false);
    }
  };

  const runDiff = async () => {
    if (!diffLeft || !diffRight) return;
    setBusy(true);
    setError(undefined);
    try {
      setDiff(await workbenchApi().materials.diff(diffLeft, diffRight));
    } catch (cause) {
      setError(String(cause).replace(/^Error:\s*/i, ""));
    } finally {
      setBusy(false);
    }
  };

  const runReview = async (decision: MaterialsReviewInput["decision"]) => {
    if (!reviewResourceId.trim() || (!reviewDescriptionEn.trim() && !reviewDescriptionZh.trim())) return;
    await runAdminAction(
      () => workbenchApi().materials.review({
        resource_id: reviewResourceId.trim(),
        decision,
        description_en: reviewDescriptionEn.trim() || undefined,
        description_zh: reviewDescriptionZh.trim() || undefined,
        reviewer: reviewer.trim() || "human",
      }),
      `Saved ${decision} description overlay for ${reviewResourceId.trim()}. Source and eligibility remain immutable.`,
    );
  };

  const active = status?.active_snapshot;
  const snapshots = status?.snapshots ?? [];
  const activeSummary = status?.snapshots.find((item) => item.snapshot_id === active);
  const statusCounts = activeSummary?.status_counts ?? {};
  const activationEvidence = {
    operator: activationOperator.trim(),
    approval_reference: activationApprovalReference.trim(),
  };
  const activationEvidenceComplete = Boolean(activationEvidence.operator && activationEvidence.approval_reference);
  return (
    <div className="operational-page materials-page">
      <PageHeader icon={Database} title="Materials" subtitle="External, versioned biological materials with evidence, rights, and safety gates." actions={<button className="secondary-button" type="button" disabled={busy} onClick={() => void refresh()}><RefreshCw className={busy ? "spin" : undefined} size={14} />Refresh</button>} />
      <div className="materials-boundary-banner"><ShieldCheck size={16} /><div><strong>Model visibility is fail-closed</strong><span>Search and MCP expose only DESIGN_ELIGIBLE summaries. Quarantine is physically isolated, never model-readable, and does not become eligible through this UI.</span></div></div>
      {error && <div className="model-load-error" role="alert"><CircleAlert size={14} /><span>{error}</span></div>}
      {notice && <div className="materials-notice" role="status"><CheckCircle2 size={14} /><span>{notice}</span></div>}
      <section className="materials-status-grid">
        <div className="materials-status-card"><span className="eyebrow">Active snapshot</span><strong>{active ?? "Not initialized"}</strong><small>{activeSummary ? `${activeSummary.record_count.toLocaleString()} records · ${activeSummary.catalog_record_count?.toLocaleString() ?? "—"} model-visible catalog` : "Initialize the external seed or sync a source."}</small></div>
        {(["DESIGN_ELIGIBLE", "REVIEW_REQUIRED", "REFERENCE_ONLY", "QUARANTINED"] as const).map((state) => <div className={`materials-status-card is-${state.toLocaleLowerCase()}`} key={state}><span>{state.replaceAll("_", " ")}</span><strong>{(statusCounts[state] ?? 0).toLocaleString()}</strong><small>{state === "DESIGN_ELIGIBLE" ? "Eligible for model search" : state === "QUARANTINED" ? "Admin-only isolated store" : "Indexed, not model-selectable"}</small></div>)}
      </section>
      <section className="source-search-band materials-search-band">
        <Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void runSearch(); }} placeholder="Search eligible materials by name, organism, role, or source" aria-label="Search eligible materials" /><input className="materials-filter-field" value={kind} onChange={(event) => setKind(event.target.value)} placeholder="kind" aria-label="Filter by material kind" /><input className="materials-filter-field" value={source} onChange={(event) => setSource(event.target.value)} placeholder="source" aria-label="Filter by source" /><button className="primary-button" type="button" disabled={busy} onClick={() => void runSearch()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Search size={14} />}Search</button></section>
      <div className="materials-content-grid">
        <section className="page-section materials-results-section"><div className="section-heading"><div><h2>Design-eligible materials</h2><p>{matches.length} bounded summaries · full sequences stay out of search responses</p></div></div><div className="data-list materials-result-list">{matches.length === 0 && <EmptyState icon={Database} title="No eligible materials found" detail="The seed contains software templates only. Activate a reviewed source snapshot or import a record for review." />}{matches.map((item) => <button className={`data-row materials-result-row ${selected?.resource_id === item.resource_id ? "is-selected" : ""}`} type="button" key={item.resource_id} onClick={() => setSelected(item)}><Database size={14} /><span className="data-row-copy"><strong>{item.name}</strong><span>{item.resource_id} · {item.kind} · {item.sequence_kind || "no sequence"} {item.sequence_length ? `· ${item.sequence_length.toLocaleString()} bp/aa` : ""}</span></span><span className="materials-result-source">{String(item.source.provider ?? "unknown")}</span></button>)}</div></section>
        <section className="page-section materials-detail-section"><div className="section-heading"><div><h2>Record detail</h2><p>Source and rights stay attached to every material.</p></div></div>{selected ? <div className="materials-detail"><span className="eyebrow">{selected.review_status}</span><h3>{selected.name}</h3><code>{selected.resource_id}</code><p>{selected.description_en}</p><p className="materials-description-zh">{selected.description_zh}</p><dl><dt>Kind</dt><dd>{selected.kind}</dd><dt>Organism</dt><dd>{String(selected.organism.name ?? "—")}</dd><dt>Sequence</dt><dd>{selected.sequence_kind || "—"} · {selected.sequence_length.toLocaleString()} · {shortHash(selected.sequence_sha256)}</dd><dt>Source</dt><dd>{String(selected.source.provider ?? "—")} · {String(selected.source.release ?? selected.source.revision ?? "—")}</dd><dt>License</dt><dd>{String(selected.license.id ?? "—")} · {String(selected.license.redistribution_status ?? "—")}</dd><dt>Safety</dt><dd>{selected.safety_status}{selected.safety_flags.length ? ` · ${selected.safety_flags.join(", ")}` : ""}</dd></dl><a className="inline-link" href={String(selected.source.url ?? "#")} target="_blank" rel="noreferrer">Open source record <ExternalLink size={12} /></a></div> : <EmptyState icon={FileSearch} title="Select a material" detail="Choose a result to inspect bilingual descriptions, sequence hash, rights, source, and safety metadata." />}</section>
      </div>
      <section className="page-section materials-admin-section">
        <div className="section-heading"><div><h2>Snapshot administration</h2><p>Sync creates an inactive staging snapshot; activation and rollback require operator-supplied approval evidence.</p></div></div>
        <div className="materials-admin-controls">
          <select value={syncSource} onChange={(event) => setSyncSource(event.target.value as typeof syncSource)} aria-label="Source to sync"><option value="uniprot">UniProtKB/Swiss-Prot</option><option value="igem">iGEM Registry</option><option value="rhea">Rhea</option><option value="biomodels">BioModels</option></select>
          <input className="number-field" type="number" min={1} max={2_000_000} value={syncLimit} onChange={(event) => setSyncLimit(Number(event.target.value))} aria-label="Maximum records" />
          <button className="secondary-button" type="button" disabled={busy} onClick={() => void runAdminAction(() => workbenchApi().materials.sync(syncSource, syncLimit), `Created an inactive ${syncSource} staging snapshot. Review its diff before activation.`)}><RefreshCw size={14} />Sync to staging</button>
          <button className="secondary-button" type="button" disabled={busy} onClick={() => void workbenchApi().materials.importFile().then((result) => { if (result) { setNotice("Imported a review-required staging snapshot."); void refresh(); } })}><FolderOpen size={14} />Import local file</button>
        </div>
        <div className="materials-diff-controls"><span className="eyebrow">Diff preview</span><select value={diffLeft} onChange={(event) => setDiffLeft(event.target.value)} aria-label="Left snapshot"><option value="">Left snapshot</option>{snapshots.map((snapshot) => <option key={`left-${snapshot.snapshot_id}`} value={snapshot.snapshot_id}>{snapshot.snapshot_id}</option>)}</select><span aria-hidden="true">→</span><select value={diffRight} onChange={(event) => setDiffRight(event.target.value)} aria-label="Right snapshot"><option value="">Right snapshot</option>{snapshots.map((snapshot) => <option key={`right-${snapshot.snapshot_id}`} value={snapshot.snapshot_id}>{snapshot.snapshot_id}</option>)}</select><button className="secondary-button compact-command" type="button" disabled={busy || !diffLeft || !diffRight} onClick={() => void runDiff()}><FileSearch size={13} />Compare</button>{diff && <span className="materials-diff-summary">+{String(diff.added_count ?? 0)} · −{String(diff.removed_count ?? 0)} · Δ{String(diff.changed_count ?? 0)}</span>}</div>
        <div className="materials-activation-evidence">
          <span className="eyebrow">Activation evidence</span>
          <input value={activationOperator} maxLength={128} onChange={(event) => setActivationOperator(event.target.value)} placeholder="operator label" aria-label="Activation operator label" />
          <input value={activationApprovalReference} maxLength={512} onChange={(event) => setActivationApprovalReference(event.target.value)} placeholder="approval or change-record reference" aria-label="Activation approval reference" />
          <small>The operator label is self-declared and is not authenticated by Proto Workbench. Both fields are written to the local active pointer.</small>
        </div>
        <div className="materials-snapshot-list">{snapshots.map((snapshot) => <div className={`data-row ${snapshot.active ? "is-selected" : ""}`} key={snapshot.snapshot_id}><Database size={14} /><span className="data-row-copy"><strong>{snapshot.snapshot_id}</strong><span>{snapshot.record_count.toLocaleString()} records · {Object.entries(snapshot.status_counts).map(([key, value]) => `${key.replaceAll("_", " ")}: ${value}`).join(" · ")}</span></span>{snapshot.active ? <span className="module-status is-verified">Active</span> : <button className="secondary-button compact-command" type="button" disabled={busy || !activationEvidenceComplete} onClick={() => void runAdminAction(() => workbenchApi().materials.activate(snapshot.snapshot_id, activationEvidence), `Activated ${snapshot.snapshot_id} with the supplied approval reference; operator identity remains self-declared.`)}>Activate</button>}</div>)}</div>
        <div className="materials-rollback-row"><input value={snapshotInput} maxLength={128} onChange={(event) => setSnapshotInput(event.target.value)} placeholder="snapshot id for rollback" aria-label="Snapshot id for rollback" /><button className="secondary-button" type="button" disabled={busy || !snapshotInput.trim() || !activationEvidenceComplete} onClick={() => void runAdminAction(() => workbenchApi().materials.rollback(snapshotInput.trim(), activationEvidence), `Rolled back to ${snapshotInput.trim()} with the supplied approval reference; operator identity remains self-declared.`)}><RotateCcw size={14} />Rollback</button></div>
      </section>
      <section className="page-section materials-review-section"><div className="section-heading"><div><h2>Description review overlay</h2><p>Record a bilingual description decision without mutating source facts, safety, rights, or eligibility.</p></div></div><div className="materials-review-controls"><input value={reviewResourceId} onChange={(event) => setReviewResourceId(event.target.value)} placeholder="resource id (namespace:record)" aria-label="Resource id for review" /><input value={reviewer} onChange={(event) => setReviewer(event.target.value)} placeholder="reviewer" aria-label="Reviewer" /><textarea value={reviewDescriptionEn} onChange={(event) => setReviewDescriptionEn(event.target.value)} placeholder="English description draft" aria-label="English description draft" /><textarea value={reviewDescriptionZh} onChange={(event) => setReviewDescriptionZh(event.target.value)} placeholder="中文描述草稿" aria-label="中文描述草稿" /><div className="materials-review-buttons"><button className="secondary-button" type="button" disabled={busy} onClick={() => void runReview("hold")}>Hold</button><button className="secondary-button" type="button" disabled={busy} onClick={() => void runReview("reject")}>Reject</button><button className="primary-button" type="button" disabled={busy} onClick={() => void runReview("accept")}><Check size={14} />Accept text</button></div></div>{(status?.overlays?.length ?? 0) > 0 && <div className="materials-overlay-history"><span className="eyebrow">Audit history</span>{status?.overlays?.map((overlay) => <div className="materials-overlay-row" key={String(overlay.overlay_id)}><strong>{String(overlay.decision ?? "unknown")}</strong><span>{String(overlay.resource_id ?? "")} · {String(overlay.reviewer ?? "human")} · {String(overlay.created_at ?? "")}</span></div>)}</div>}</section>
      {facets && <p className="materials-facet-note">Eligible facets · kinds: {Object.entries(facets.kinds).map(([key, value]) => `${key} ${value}`).join(" · ") || "none"} · sources: {Object.entries(facets.sources).map(([key, value]) => `${key} ${value}`).join(" · ") || "none"}</p>}
    </div>
  );
}

function ReviewsPage() {
  const runs = useWorkbenchStore((state) => state.runs);
  const selectedRunId = useWorkbenchStore((state) => state.selectedRunId);
  const review = useWorkbenchStore((state) => state.review);
  const runDetail = useWorkbenchStore((state) => state.runDetail);
  const runDetailLoading = useWorkbenchStore((state) => state.runDetailLoading);
  const comments = useWorkbenchStore((state) => state.comments);
  const selectRun = useWorkbenchStore((state) => state.selectRun);
  const navigate = useWorkbenchStore((state) => state.navigate);
  const updateChecklist = useWorkbenchStore((state) => state.updateChecklist);
  const approveRun = useWorkbenchStore((state) => state.approveRun);
  const showPendingPatch = useWorkbenchStore((state) => state.showPendingPatch);
  const busyPatchAction = useWorkbenchStore((state) => state.busyPatchAction);
  const reconcilePatchEffect = useWorkbenchStore((state) => state.reconcilePatchEffect);
  const resumePatchValidation = useWorkbenchStore((state) => state.resumePatchValidation);
  const prepareCheckpointRestore = useWorkbenchStore((state) => state.prepareCheckpointRestore);
  const openFile = useWorkbenchStore((state) => state.openFile);
  const [comment, setComment] = useState("");
  const addComment = useWorkbenchStore((state) => state.addReviewComment);
  const lifecycle = runDetail?.summary.lifecycle;
  const lifecycleTone = lifecycle?.attention === "patch-operation" ? "validation" : lifecycle?.attention;
  const operation = runDetail?.activePatchOperation ?? runDetail?.patchOperations[0];
  const checkpoint = operation
    ? runDetail?.checkpoints.find((candidate) => candidate.id === operation.checkpointId)
    : runDetail?.checkpoints[0];
  const operationPatch = runDetail?.activePatch ?? (operation
    ? runDetail?.patches.find((candidate) => candidate.id === operation.patchId)
    : undefined);
  const validationJournal = operation
    ? runDetail?.validationJournals?.find((candidate) => candidate.operationId === operation.id)
    : undefined;
  const lifecycleCommand = runDetail?.allowedActions.reviewPatch
    ? {
        label: "Review patch",
        busy: false,
        run: () => {
          showPendingPatch();
          navigate("runs");
        },
      }
    : runDetail?.allowedActions.reconcilePatchEffect
      ? { label: busyPatchAction === "reconcile" ? "Reconciling…" : "Reconcile file effect", busy: busyPatchAction === "reconcile", run: () => void reconcilePatchEffect() }
      : runDetail?.allowedActions.resumePatchValidation
        ? { label: busyPatchAction === "validate" ? "Validating…" : "Resume validation", busy: busyPatchAction === "validate", run: () => void resumePatchValidation() }
        : undefined;
  const reviewCurrent = Boolean(lifecycle && ["review-required", "ready-for-approval", "approved"].includes(lifecycle.state));
  const remainingChecklist = review.checklist.filter((item) => item.status !== "done").length;
  return (
    <div className="operational-page">
      <PageHeader icon={CheckCircle2} title="Reviews" subtitle="Human gates, evidence traceability, decisions, and comments across runs." />
      <div className="reviews-page-layout">
        <aside className="review-run-list">
          {runs.map((run) => <button className={selectedRunId === run.runId ? "is-selected" : ""} type="button" key={run.runId} aria-current={selectedRunId === run.runId ? "true" : undefined} onClick={() => void selectRun(run.runId).then(() => navigate("reviews"))}><span><strong>{run.title}</strong><small>{formatDate(run.createdAt)}</small></span><ReviewRunBadge run={run} /></button>)}
        </aside>
        <section className="review-detail-page" aria-busy={runDetailLoading || Boolean(busyPatchAction)}>
          {!selectedRunId ? <EmptyState icon={CheckCircle2} title="No review selected" detail={runs.length ? "Select a run from the review queue to inspect its current gate and durable evidence." : "Complete a run to generate a review packet."} /> : <>
            {lifecycle && <div className={`review-lifecycle-context is-${lifecycleTone}`} role="status" aria-live="polite"><span><ShieldAlert size={16} /></span><div><strong>{lifecycle.label}</strong><p>{lifecycle.detail}</p></div>{lifecycleCommand && <button className="secondary-button compact-command" type="button" disabled={Boolean(busyPatchAction)} onClick={lifecycleCommand.run}>{lifecycleCommand.busy && <LoaderCircle className="spin" size={13} />}{lifecycleCommand.label}</button>}</div>}
            {operation && <ReviewPatchOperationRail operation={operation} checkpoint={checkpoint} patch={operationPatch} journal={validationJournal} />}
            <div className={`review-page-gate is-${reviewCurrent ? review.gate : "pending"}`}><span><ShieldCheck size={19} /></span><div><strong>{!reviewCurrent ? "Existing review packet is not current" : review.gate === "approved" ? "Approved" : review.gate === "ready" ? "Ready for approval" : review.gate === "blocked" ? "Blocked" : "Human review required"}</strong><p>{!reviewCurrent && lifecycle ? `${lifecycle.detail} The existing packet remains available for audit but cannot sign off the unresolved action.` : review.summary}</p>{review.operationId && <small className="review-packet-binding" title={review.packetSha256}>Bound to operation {review.operationId.slice(0, 8)}{review.validationPlanSha256 ? ` · plan ${shortHash(review.validationPlanSha256)}` : ""}{review.validationJournalRevision !== undefined ? ` · journal v${review.validationJournalRevision}` : ""}</small>}</div></div>
            {(operation || checkpoint) && <section className="review-supporting-context" aria-label="Durable patch recovery summary">
              <div>
                <h2>Patch operation</h2>
                {operation ? <>
                  <p><FileCode2 size={12} /><span><strong>{patchOperationLabel(operation)}</strong> · {shortPath(operation.targetPath)}</span></p>
                  <p title={`Base ${operation.baseExists ? operation.baseSha256 : "missing"}; result ${operation.resultExists ? operation.resultSha256 : "deleted"}`}><Fingerprint size={12} /><span>{operation.baseExists ? shortHash(operation.baseSha256) : "Missing"} → {operation.resultExists ? shortHash(operation.resultSha256) : "Deleted"}</span></p>
                  {operation.observedSha256 && <p title={`Observed ${operation.observedSha256}`}><Search size={12} /><span>Observed {shortHash(operation.observedSha256)}</span></p>}
                  {operation.error && <p role="alert"><CircleAlert size={12} /><span>{operation.error}</span></p>}
                  <button className="section-link" type="button" onClick={() => void openFile(operation.targetPath)}>Open current file <ExternalLink size={12} /></button>
                </> : <p>No durable patch operation is recorded.</p>}
              </div>
              <div>
                <h2>File checkpoint</h2>
                {checkpoint ? <>
                  <p><RotateCcw size={12} /><span>{checkpointLabel(checkpoint)} · {checkpointSnapshotSize(checkpoint)}</span></p>
                  <p title={checkpoint.sha256}><Fingerprint size={12} /><span>{shortHash(checkpoint.sha256)} · {formatDate(checkpoint.createdAt)}</span></p>
                  {checkpoint.conflictReason && <p role="alert"><CircleAlert size={12} /><span>{checkpoint.conflictReason}</span></p>}
                  {runDetail?.allowedActions.prepareCheckpointRestore && <><span className="legacy-recovery-label">Legacy recovery/audit only</span><button className="secondary-button compact-command" type="button" disabled={Boolean(busyPatchAction)} onClick={() => void prepareCheckpointRestore()}>{busyPatchAction === "restore" ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />}{busyPatchAction === "restore" ? "Preparing restore diff…" : "Prepare restore diff"}</button></>}
                </> : <p>The patch has no recoverable file checkpoint.</p>}
              </div>
            </section>}
            <div className="review-page-columns">
              <section><h2>Evidence claims</h2>{review.claims.length === 0 && <p className="review-empty-note">No evidence claims have been generated for this run.</p>}{review.claims.map((claim) => <div className="review-line evidence-review-line" key={claim.id}><strong>{claim.id}</strong><span>{claim.claim}</span><button className="inline-link" type="button" disabled={!claim.evidence[0]} onClick={() => claim.evidence[0] && void openFile(claim.evidence[0])}>{claim.evidence[0] ? shortPath(claim.evidence[0]) : "No evidence"}<ExternalLink size={11} /></button><small>{claim.status}</small></div>)}</section>
              <section><h2>Human checklist</h2>{review.checklist.map((item) => <label className="review-line check-line" key={item.id}><input type="checkbox" checked={item.status === "done"} disabled={!reviewCurrent || item.status === "blocked" || review.gate === "approved"} onChange={(event) => void updateChecklist(item.id, event.target.checked)} /><span>{item.label}</span><small>{item.status}</small></label>)}</section>
            </div>
            <section className="review-supporting-context"><div><h2>Open questions</h2>{review.unresolvedQuestions.length ? review.unresolvedQuestions.map((question) => <p key={question}><CircleAlert size={12} />{question}</p>) : <p>No unresolved questions recorded.</p>}</div><div><h2>Safety boundary</h2><p><ShieldCheck size={12} />{review.safetyBoundary}</p>{review.packetPath && <button className="section-link" type="button" onClick={() => void openFile(review.packetPath as string)}>Open review packet <ExternalLink size={12} /></button>}</div></section>
            <section className="review-comments"><h2>Review comments</h2>{comments.map((item) => <div className="comment-record" key={item.id}><span>{item.comment}</span><time>{formatDate(item.createdAt)}</time></div>)}<div className="comment-entry"><textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Add an auditable review comment" /><button className="secondary-button" type="button" disabled={!comment.trim()} onClick={() => void addComment(comment).then(() => setComment(""))}>Add comment</button></div></section>
            <div className="review-page-actions"><span>{!reviewCurrent ? "Resolve the current run attention before changing this checklist." : review.gate === "ready" ? "All checklist items are complete." : remainingChecklist ? `${remainingChecklist} checklist item${remainingChecklist === 1 ? "" : "s"} still require a decision.` : "Validation must make this packet ready before approval."}</span><button className="primary-button success" type="button" disabled={!runDetail?.allowedActions.approveRun} onClick={() => void approveRun()}><Check size={14} />Approve run</button></div>
          </>}
        </section>
      </div>
    </div>
  );
}

function SettingsPage() {
  const settings = useWorkbenchStore((state) => state.settings);
  const runtime = useWorkbenchStore((state) => state.runtime);
  const integrity = useWorkbenchStore((state) => state.moduleIntegrity);
  const moduleAudits = useWorkbenchStore((state) => state.moduleAudits);
  const chooseWorkspace = useWorkbenchStore((state) => state.chooseWorkspace);
  const updateSettings = useWorkbenchStore((state) => state.updateSettings);
  const [ttl, setTtl] = useState(settings.residencyPolicy.warmTtlMinutes);
  const [mode, setMode] = useState(settings.residencyPolicy.mode);
  const [moduleProfile, setModuleProfile] = useState<ModuleProfile>(settings.modules.profile);
  const [enabledOptional, setEnabledOptional] = useState<OptionalModuleId[]>(settings.modules.enabledOptional);
  useEffect(() => {
    setTtl(settings.residencyPolicy.warmTtlMinutes);
    setMode(settings.residencyPolicy.mode);
    setModuleProfile(settings.modules.profile);
    setEnabledOptional(settings.modules.enabledOptional);
  }, [settings]);
  const integrityById = useMemo(
    () => new Map(integrity.modules.map((module) => [module.moduleId, module])),
    [integrity.modules],
  );
  const quarantined = integrity.modules.filter((module) => module.disposition === "quarantined");
  const availableOptional = new Set(
    integrity.modules
      .filter((module) => !module.core && (module.status === "verified" || module.status === "not-audited"))
      .map((module) => module.moduleId),
  );
  const chooseProfile = (profile: Exclude<ModuleProfile, "custom">) => {
    setModuleProfile(profile);
    setEnabledOptional(modulesForProfile(profile).filter((moduleId) => availableOptional.has(moduleId)));
  };
  const toggleModule = (moduleId: OptionalModuleId, enabled: boolean) => {
    setModuleProfile("custom");
    setEnabledOptional((current) => enabled
      ? [...new Set([...current, moduleId])]
      : current.filter((candidate) => candidate !== moduleId));
  };
  const save = () => updateSettings({
    residencyPolicy: {
      ...settings.residencyPolicy,
      mode,
      warmTtlMinutes: ttl,
    },
    modules: { profile: moduleProfile, enabledOptional },
  });
  return (
    <div className="operational-page settings-page">
      <PageHeader icon={Settings} title="Settings" subtitle="Fixed local inference, workspace policy, module load profile, and integrity audit." actions={<button className="primary-button" type="button" onClick={() => void save()}><Save size={14} />Save settings</button>} />
      <section className="settings-section"><div className="settings-section-title"><HardDrive size={17} /><div><h2>Storage</h2><p>LM Studio owns model weights; generated artifacts remain inside the selected workspace.</p></div></div><SettingPath label="Workspace" value={settings.workspacePath} onBrowse={() => void chooseWorkspace()} /></section>
      <section className="settings-section"><div className="settings-section-title"><Cpu size={17} /><div><h2>LM Studio inference</h2><p>{runtime.detail}</p></div></div><div className="settings-field"><label>Fixed endpoint</label><code>{settings.inference.baseUrl}</code><output>Native v1 + OpenAI SSE</output></div><div className="settings-field"><label>Optional bearer token</label><code>{settings.inference.tokenEnvNames.join(" → ")}</code><output>Environment only; never persisted</output></div><div className={`runtime-status-line is-${runtime.available ? "cuda" : "missing"}`}><span />{runtime.available ? `${runtime.modelCount ?? 0} models · ${runtime.loadedModelCount ?? 0} loaded instances` : "LM Studio unavailable"}</div></section>
      <section className="settings-section"><div className="settings-section-title"><MemoryStick size={17} /><div><h2>Workbench connections</h2><p>Controls Workbench's explicit instance bindings; LM Studio remains authoritative for allocation and engine policy.</p></div></div><div className="settings-field"><label>Policy</label><div className="segmented-control"><button className={mode === "quick-switch" ? "is-selected" : ""} type="button" onClick={() => setMode("quick-switch")}>One connection</button><button className={mode === "auto-evict" ? "is-selected" : ""} type="button" onClick={() => setMode("auto-evict")}>Managed warm pool</button></div></div><div className="settings-field"><label htmlFor="warm-ttl">Warm connection TTL</label><input id="warm-ttl" className="number-field" type="number" min={1} max={240} value={ttl} onChange={(event) => setTtl(Number(event.target.value))} /><output>minutes; only owned instances unload</output></div></section>
      <section className="settings-section module-settings-section">
        <div className="settings-section-title">
          <Fingerprint size={17} />
          <div>
            <h2>Modules and integrity</h2>
            <p>Core modules are mandatory. Optional modules can be omitted on lower-resource systems without weakening core workflow gates.</p>
          </div>
        </div>
        <div className={`integrity-summary ${integrity.ok ? "is-verified" : "is-blocked"}`}>
          {integrity.ok ? <ShieldCheck size={18} /> : <ShieldAlert size={18} />}
          <div>
            <strong>{integrity.ok ? "Core integrity verified" : "Core integrity failure"}</strong>
            <span>
              {integrity.enforced ? "Packaged startup enforcement" : "Development audit"}
              {quarantined.length ? ` · ${quarantined.length} optional quarantined` : " · no optional quarantine"}
            </span>
          </div>
          <dl>
            <div><dt>Audit ID</dt><dd title={integrity.auditId}>{shortHash(integrity.auditId)}</dd></div>
            <div><dt>Manifest</dt><dd title={integrity.manifestSha256}>{shortHash(integrity.manifestSha256)}</dd></div>
            <div><dt>Checked</dt><dd>{integrity.checkedAt ? formatDate(integrity.checkedAt) : "Pending"}</dd></div>
          </dl>
        </div>
        <div className="settings-field module-profile-field">
          <label>Load profile</label>
          <div className="segmented-control module-profile-control" aria-label="Module load profile">
            <button className={moduleProfile === "core-only" ? "is-selected" : ""} type="button" onClick={() => chooseProfile("core-only")}>Core only</button>
            <button className={moduleProfile === "research" ? "is-selected" : ""} type="button" onClick={() => chooseProfile("research")}>Research</button>
            <button className={moduleProfile === "full" ? "is-selected" : ""} type="button" onClick={() => chooseProfile("full")}>Full</button>
          </div>
          <output>{moduleProfile === "custom" ? "Custom" : `${enabledOptional.length} optional`}</output>
        </div>
        <div className="module-list-heading"><span>Required core</span><small>Cannot be disabled</small></div>
        <div className="module-control-list">
          {CORE_MODULES.map((module) => (
            <ModuleControlRow
              key={module.id}
              module={module}
              integrity={integrityById.get(module.id)}
              checked
              locked
            />
          ))}
        </div>
        <div className="module-list-heading"><span>Optional capabilities</span><small>Disable to reduce startup and memory pressure</small></div>
        <div className="module-control-list">
          {OPTIONAL_MODULES.map((module) => {
            const result = integrityById.get(module.id);
            const disabled = result?.disposition === "quarantined";
            return (
              <ModuleControlRow
                key={module.id}
                module={module}
                integrity={result}
                checked={enabledOptional.includes(module.id as OptionalModuleId) && !disabled}
                disabled={disabled}
                onChange={(checked) => toggleModule(module.id as OptionalModuleId, checked)}
              />
            );
          })}
        </div>
        <details className="audit-history">
          <summary>Startup audit history ({moduleAudits.length})</summary>
          <div className="audit-history-list">
            {moduleAudits.map((audit) => (
              <div key={audit.auditId ?? audit.checkedAt}>
                <span className={`module-status is-${audit.ok ? "verified" : "tampered"}`}>{audit.ok ? "passed" : "blocked"}</span>
                <code title={audit.auditId}>{shortHash(audit.auditId)}</code>
                <time>{formatDate(audit.checkedAt)}</time>
                <small>{audit.modules.filter((module) => module.disposition === "quarantined").length} quarantined</small>
              </div>
            ))}
          </div>
        </details>
      </section>
    </div>
  );
}

function HelpPage() {
  const navigate = useWorkbenchStore((state) => state.navigate);
  const runtime = useWorkbenchStore((state) => state.runtime);
  return (
    <div className="operational-page">
      <PageHeader icon={HelpCircle} title="Help & diagnostics" subtitle="Operational guidance for the local, approval-gated Proto workflow." />
      <section className="help-route-grid">
        <button type="button" onClick={() => navigate("workspaces")}><FolderOpen size={18} /><span><strong>Choose a workspace</strong><small>Inspect source and generated evidence.</small></span></button>
        <button type="button" onClick={() => navigate("models")}><Boxes size={18} /><span><strong>Connect an LM Studio model</strong><small>Review native metadata, then load or attach explicitly.</small></span></button>
        <button type="button" onClick={() => navigate("runs")}><SlidersHorizontal size={18} /><span><strong>Run the agent</strong><small>Use Plan or Act with explicit approvals.</small></span></button>
        <button type="button" onClick={() => navigate("reviews")}><CheckCircle2 size={18} /><span><strong>Review evidence</strong><small>Complete the human gate and decision log.</small></span></button>
      </section>
      <section className="page-section diagnostics-section"><div className="section-heading"><div><h2>Runtime diagnostics</h2><p>LM Studio is the single model catalog, residency manager, and inference provider.</p></div></div><div className="diagnostic-row"><Cpu size={15} /><span>Provider</span><strong>{runtime.provider === "lmstudio" ? "LM Studio" : "Unavailable"}</strong></div><div className="diagnostic-row"><Gauge size={15} /><span>Status</span><strong>{runtime.detail}</strong></div><div className="diagnostic-row"><ShieldCheck size={15} /><span>Security</span><strong>Sandboxed renderer · fixed loopback origin · environment-only token · explicit load</strong></div></section>
      <section className="page-section"><div className="section-heading"><div><h2>Safety boundary</h2><p>Proto Workbench validates software artifacts and evidence. It does not certify wet-lab readiness, orderability, biosafety, regulatory compliance, or experimental performance.</p></div></div></section>
    </div>
  );
}

function Metric({ label, value, icon: Icon }: { label: string; value: string; icon: typeof FileSearch }) {
  return <div className="metric-item"><Icon size={16} /><span>{label}</span><strong>{value}</strong></div>;
}

function Breakdown({ label, value }: { label: string; value?: number }) {
  return <div className="breakdown-row"><span>{label}</span><strong>{value === undefined ? "Calculating" : formatGb(value)}</strong></div>;
}

function EmptyState({ icon: Icon, title, detail, busy = false }: { icon: typeof FolderOpen; title: string; detail: string; busy?: boolean }) {
  return <div className="empty-state"><Icon className={busy ? "spin" : undefined} size={22} /><strong>{title}</strong><span>{detail}</span></div>;
}

function SettingPath({ label, value, onBrowse }: { label: string; value: string; onBrowse: () => void }) {
  return <div className="setting-path"><label>{label}</label><span title={value}>{value}</span><button className="secondary-button" type="button" onClick={onBrowse}><FolderOpen size={13} />Browse</button></div>;
}

function ModuleControlRow({ module, integrity, checked, locked = false, disabled = false, onChange }: {
  module: WorkbenchModuleDescriptor;
  integrity?: ModuleIntegrityResult;
  checked: boolean;
  locked?: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  const status = integrity?.status ?? "missing";
  const statusLabel = status === "not-audited" ? "dev only" : status;
  const diagnostic = integrity?.diagnostics.join("\n") || module.description;
  return (
    <label className={`module-control-row ${disabled ? "is-disabled" : ""}`} title={diagnostic}>
      <span className="module-check">
        <input
          type="checkbox"
          checked={checked}
          disabled={locked || disabled}
          onChange={(event) => onChange?.(event.target.checked)}
        />
        {locked ? <LockKeyhole size={13} aria-label="Required module" /> : null}
      </span>
      <span className="module-identity">
        <strong>{module.label}</strong>
        <small>{module.description}</small>
      </span>
      <span className="module-code">
        <code>{module.id}</code>
        <small>v{module.version} · {module.resourceTier}</small>
      </span>
      <code className="module-hash" title={integrity?.moduleSha256}>{shortHash(integrity?.moduleSha256)}</code>
      <span className={`module-status is-${status}`}>{statusLabel}</span>
    </label>
  );
}

function ReviewRunBadge({ run }: { run: RunSummary }) {
  const label = run.lifecycle.state === "waiting-patch-review"
    ? "Patch"
    : run.lifecycle.state === "waiting-tool-approval"
      ? "Approve"
      : run.lifecycle.state === "applying-patch"
        ? "Applying"
        : run.lifecycle.state === "validating"
          ? "Validate"
      : run.lifecycle.state === "review-required" || run.lifecycle.state === "ready-for-approval"
        ? "Review"
        : run.lifecycle.state === "completed"
          ? "Done"
          : run.lifecycle.state === "effect-unknown"
            ? "Reconcile"
            : run.lifecycle.state === "interrupted" && run.lifecycle.attention === "recovery"
              ? "Recover"
            : run.lifecycle.state === "failed"
              ? "Failed"
              : run.lifecycle.state.replaceAll("-", " ");
  const tone = run.lifecycle.attention === "patch-operation" ? "validation" : run.lifecycle.attention;
  return <span className={`review-run-state is-${tone}`} title={`${run.lifecycle.label}: ${run.lifecycle.detail}`}>{label}</span>;
}

function ReviewPatchOperationRail({ operation, checkpoint, patch, journal }: {
  operation: PatchOperation;
  checkpoint?: FileCheckpoint;
  patch?: PatchProposal;
  journal?: ValidationJournalSnapshot;
}) {
  const restorePending = patch?.status === "pending" && Boolean(patch.restoresCheckpointId);
  const writeComplete = !restorePending && ["applied", "validating", "verified", "validation-failed", "rolled-back"].includes(operation.state);
  const writeFailed = !restorePending && ["effect-unknown", "conflict"].includes(operation.state);
  const validationComplete = !restorePending && (operation.state === "verified" || operation.state === "rolled-back");
  const validationFailed = !restorePending && operation.state === "validation-failed";
  const validating = !restorePending && (operation.state === "validating" || operation.state === "applied");
  const steps = [
    { label: "Review", detail: restorePending ? "Restore decision ready" : patch?.restoresCheckpointId ? "Restore reviewed" : "Decision recorded", state: "complete" },
    { label: "Checkpoint", detail: checkpoint ? `${restorePending ? "Restore source · " : ""}${checkpointSnapshotSize(checkpoint)} · ${shortHash(checkpoint.sha256)}` : "Unavailable", state: checkpoint ? "complete" : "failed" },
    { label: "Write", detail: writeFailed ? "Needs reconciliation" : writeComplete ? shortHash(operation.resultSha256) : operation.state === "applying" ? "Controlled write" : "Ready to retry", state: writeFailed ? "failed" : writeComplete ? "complete" : operation.state === "applying" ? "current" : "pending" },
    { label: "Validate", detail: validationFailed ? "Resume available" : validationComplete ? operation.state === "rolled-back" ? "Superseded" : "Recorded" : validating ? operation.state === "applied" ? "Queued" : "Running checks" : "After write", state: validationFailed ? "failed" : validationComplete ? "complete" : validating ? "current" : "pending" },
  ];
  return <section className={`patch-operation-rail ${writeFailed || validationFailed ? "has-attention" : ""}`} aria-label="Durable patch transaction status">
    <ol>
      {steps.map((step) => <li className={`is-${step.state}`} key={step.label} aria-current={step.state === "current" ? "step" : undefined}><span aria-hidden="true">{step.state === "complete" ? <Check size={12} /> : step.state === "failed" ? <CircleAlert size={12} /> : <Circle size={8} />}</span><div><strong>{step.label}</strong><small>{step.detail}</small></div></li>)}
    </ol>
    <div className="patch-operation-meta"><span>Operation {operation.id.slice(0, 8)}</span><span>v{operation.revision}</span><span>{patchOperationLabel(operation)}</span></div>
    {journal && <ReviewValidationJournal journal={journal} />}
  </section>;
}

function ReviewValidationJournal({ journal }: { journal: ValidationJournalSnapshot }) {
  const completed = journal.steps.filter((step) => step.state === "completed").length;
  const needsRecovery = journal.state === "recovery-required" || journal.steps.some((step) => step.state === "interrupted" || step.state === "effect-unknown");
  return <section className={`validation-journal review-validation-journal ${needsRecovery ? "has-attention" : ""}`} aria-label="Validation journal evidence">
    <header><div><span className="validation-journal-eyebrow">Durable validation evidence</span><strong>{completed}/{journal.steps.length} steps complete</strong></div><span className={`validation-journal-state is-${journal.state}`}>{journal.state.replaceAll("-", " ")}</span></header>
    <ol>{journal.steps.map((step) => {
      const attention = ["failed", "interrupted", "effect-unknown"].includes(step.state);
      return <li className={`is-${step.state}`} key={step.key} title={step.error ?? `Input ${step.inputSha256}${step.outputSha256 ? `; output ${step.outputSha256}` : ""}`}><span className="validation-step-marker" aria-hidden="true">{step.state === "completed" ? <Check size={11} /> : attention ? <CircleAlert size={11} /> : step.state === "running" ? <LoaderCircle className="spin" size={11} /> : <Circle size={7} />}</span><div><strong>{step.title}</strong><small>{step.effect.replaceAll("-", " ")} · attempt {step.attempt}</small><small className="validation-step-digest">in {shortHash(step.inputSha256)} → {step.outputSha256 ? shortHash(step.outputSha256) : "pending"}</small></div><span className="validation-step-state">{step.state.replaceAll("-", " ")}</span></li>;
    })}</ol>
    <footer><span title={journal.planSha256}>Plan {shortHash(journal.planSha256)} · journal v{journal.revision}</span>{journal.nextStepKey && <span>Next: {journal.steps.find((step) => step.key === journal.nextStepKey)?.title ?? journal.nextStepKey}</span>}{journal.steps.find((step) => step.error)?.error && <span className="validation-journal-error">{journal.steps.find((step) => step.error)?.error}</span>}{needsRecovery && <strong>Explicit resume required; side effects were not replayed.</strong>}</footer>
  </section>;
}

function patchOperationLabel(operation: PatchOperation): string {
  return ({
    prepared: "Ready to retry",
    applying: "Applying",
    applied: "Applied; validation queued",
    validating: "Validating",
    verified: "Verified",
    "validation-failed": "Validation needs attention",
    "effect-unknown": "Effect unknown",
    conflict: "Workspace conflict",
    "rolled-back": "Rolled back",
  } as Record<PatchOperation["state"], string>)[operation.state];
}

function checkpointLabel(checkpoint: FileCheckpoint): string {
  return ({
    available: "Checkpoint available",
    "restore-proposed": "Restore diff awaiting review",
    restored: "Checkpoint restored",
    conflict: "Restore conflict",
  } as Record<FileCheckpoint["restoreState"], string>)[checkpoint.restoreState];
}

function checkpointSnapshotSize(checkpoint: FileCheckpoint): string {
  if (!checkpoint.existed) return "Original file absent";
  if (checkpoint.sizeBytes === 0) return "0 B";
  return formatBytes(checkpoint.sizeBytes);
}

function formatGb(bytes?: number): string {
  if (bytes === undefined) return "Calculating";
  return `${(bytes / GIB).toFixed(1)} GB`;
}

function formatBytes(bytes: number): string {
  if (bytes >= GIB) return formatGb(bytes);
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatContext(context: number): string {
  if (context >= 1_000_000) return `${(context / 1_000_000).toFixed(1)}M ctx`;
  return `${Math.round(context / 1024)}K ctx`;
}

function contextPresetLabel(context: number): string {
  if (context >= 1_048_576) return "1M";
  return `${Math.round(context / 1024)}K`;
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function shortPath(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/");
  return parts.slice(-2).join("/");
}

function shortHash(value?: string): string {
  if (!value) return "unavailable";
  return value.length > 15 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}
