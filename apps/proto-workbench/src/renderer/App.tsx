import { DiffEditor, Editor, type BeforeMount } from "@monaco-editor/react";
import { diffLines } from "diff";
import {
  Archive,
  Atom,
  BookOpen,
  Database,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleHelp,
  ClipboardCheck,
  Code2,
  Columns2,
  Dna,
  FileCheck2,
  FileCode2,
  Files,
  Fingerprint,
  FlaskConical,
  FolderKanban,
  GitCompare,
  History,
  LayoutList,
  LoaderCircle,
  Maximize2,
  MessageSquareText,
  Minimize2,
  Paperclip,
  PencilLine,
  Pin,
  PinOff,
  Play,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Target,
  Unplug,
  Workflow,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { AgentRunEvent, ModelDescriptor, PatchProposal, RunDetail, RunLifecycleProjection } from "../shared/contracts.ts";
import { OperationalPage } from "./OperationalPages.tsx";
import { GlobalEvidenceSearch } from "./GlobalEvidenceSearch.tsx";
import { DecisionLab } from "./DecisionLab.tsx";
import { DecisionBundleVerificationCenter } from "./DecisionBundleVerificationCenter.tsx";
import { RunEvidenceViews } from "./RunEvidenceViews.tsx";
import { workbenchDataMode } from "./mock-api.ts";
import { deriveWorkbenchReadiness } from "./readiness.ts";
import { deriveRunStageStates, RUN_STAGES } from "./stage-state.ts";
import { useWorkbenchStore, type BootstrapPhase } from "./store.ts";

const GIB = 1024 ** 3;

export function App() {
  const bootstrap = useWorkbenchStore((state) => state.bootstrap);
  const ready = useWorkbenchStore((state) => state.ready);
  const bootstrapPhase = useWorkbenchStore((state) => state.bootstrapPhase);
  const modelsOpen = useWorkbenchStore((state) => state.modelsOpen);
  const fullEditor = useWorkbenchStore((state) => state.fullEditor);
  const currentView = useWorkbenchStore((state) => state.currentView);
  const toast = useWorkbenchStore((state) => state.toast);
  const clearToast = useWorkbenchStore((state) => state.clearToast);
  const [bootstrapError, setBootstrapError] = useState<string>();
  const [commandOpen, setCommandOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [decisionLabOpen, setDecisionLabOpen] = useState(false);
  const [verificationOpen, setVerificationOpen] = useState(false);
  const closeCommands = () => {
    setCommandOpen(false);
    window.requestAnimationFrame(() => document.getElementById("mission-command-trigger")?.focus());
  };
  const closeEvidence = () => {
    setEvidenceOpen(false);
    window.requestAnimationFrame(() => document.getElementById("global-evidence-trigger")?.focus());
  };
  const closeDecisionLab = () => {
    setDecisionLabOpen(false);
    window.requestAnimationFrame(() => document.getElementById("decision-lab-trigger")?.focus());
  };
  const closeVerification = () => {
    setVerificationOpen(false);
    window.requestAnimationFrame(() => document.getElementById("verification-center-trigger")?.focus());
  };

  useEffect(() => {
    void bootstrap().then(() => setBootstrapError(undefined)).catch((error) => setBootstrapError(String(error)));
  }, [bootstrap]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(clearToast, 4200);
    return () => window.clearTimeout(timer);
  }, [toast, clearToast]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setEvidenceOpen(false);
        setDecisionLabOpen(false);
        setVerificationOpen(false);
        setCommandOpen((open) => {
          if (open) window.requestAnimationFrame(() => document.getElementById("mission-command-trigger")?.focus());
          return !open;
        });
      } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        setCommandOpen(false);
        setDecisionLabOpen(false);
        setVerificationOpen(false);
        setEvidenceOpen((open) => {
          if (open) window.requestAnimationFrame(() => document.getElementById("global-evidence-trigger")?.focus());
          return !open;
        });
      } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLocaleLowerCase() === "l") {
        event.preventDefault();
        setCommandOpen(false);
        setEvidenceOpen(false);
        setVerificationOpen(false);
        setDecisionLabOpen((open) => {
          if (open) window.requestAnimationFrame(() => document.getElementById("decision-lab-trigger")?.focus());
          return !open;
        });
      } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLocaleLowerCase() === "v") {
        event.preventDefault();
        setCommandOpen(false);
        setEvidenceOpen(false);
        setDecisionLabOpen(false);
        setVerificationOpen((open) => {
          if (open) window.requestAnimationFrame(() => document.getElementById("verification-center-trigger")?.focus());
          return !open;
        });
      } else if (event.key === "Escape") {
        setCommandOpen((open) => {
          if (open) window.requestAnimationFrame(() => document.getElementById("mission-command-trigger")?.focus());
          return false;
        });
        setEvidenceOpen((open) => {
          if (open) window.requestAnimationFrame(() => document.getElementById("global-evidence-trigger")?.focus());
          return false;
        });
        setDecisionLabOpen((open) => {
          if (open) window.requestAnimationFrame(() => document.getElementById("decision-lab-trigger")?.focus());
          return false;
        });
        setVerificationOpen((open) => {
          if (open) window.requestAnimationFrame(() => document.getElementById("verification-center-trigger")?.focus());
          return false;
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    const onCommandRequest = () => {
      setEvidenceOpen(false);
      setDecisionLabOpen(false);
      setVerificationOpen(false);
      setCommandOpen(true);
    };
    const onEvidenceRequest = () => {
      setCommandOpen(false);
      setDecisionLabOpen(false);
      setVerificationOpen(false);
      setEvidenceOpen(true);
    };
    const onDecisionLabRequest = () => {
      setCommandOpen(false);
      setEvidenceOpen(false);
      setVerificationOpen(false);
      setDecisionLabOpen(true);
    };
    const onVerificationRequest = () => {
      setCommandOpen(false);
      setEvidenceOpen(false);
      setDecisionLabOpen(false);
      setVerificationOpen(true);
    };
    window.addEventListener("proto:commands", onCommandRequest);
    window.addEventListener("proto:evidence", onEvidenceRequest);
    window.addEventListener("proto:decision-lab", onDecisionLabRequest);
    window.addEventListener("proto:verification", onVerificationRequest);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("proto:commands", onCommandRequest);
      window.removeEventListener("proto:evidence", onEvidenceRequest);
      window.removeEventListener("proto:decision-lab", onDecisionLabRequest);
      window.removeEventListener("proto:verification", onVerificationRequest);
    };
  }, []);

  if (bootstrapError) {
    return <StartupSurface phase={bootstrapPhase} error={bootstrapError} onRetry={() => void bootstrap().then(() => setBootstrapError(undefined)).catch((error) => setBootstrapError(String(error)))} />;
  }

  if (!ready) {
    return <StartupSurface phase={bootstrapPhase} />;
  }

  return (
    <div className="app-shell">
      <TopBar />
      <div className={`app-body ${currentView !== "runs" ? "is-page" : ""}`}>
        <Sidebar />
        {currentView === "runs" ? <>
          <main className={`run-workspace ${fullEditor ? "is-full-editor" : ""}`}>
            {!fullEditor && <RunHeader />}
            {!fullEditor && <RunAttentionStrip />}
            {!fullEditor && <StageTracker />}
            {!fullEditor && <RunEvidenceViews />}
            <CodeDrawer />
            {!fullEditor && <ToolApprovalBar />}
            {!fullEditor && <Composer />}
          </main>
          <ReviewPanel />
        </> : <main className="page-workspace"><OperationalPage view={currentView} /></main>}
      </div>
      {modelsOpen && <ModelPopover />}
      {commandOpen && <CommandPalette onClose={closeCommands} />}
      {evidenceOpen && <GlobalEvidenceSearch onClose={closeEvidence} />}
      {decisionLabOpen && <DecisionLab onClose={closeDecisionLab} />}
      {verificationOpen && <DecisionBundleVerificationCenter onClose={closeVerification} />}
      {toast && (
        <div className="toast" role="status">
          <CircleAlert size={16} />
          <span>{toast}</span>
        </div>
      )}
    </div>
  );
}

const BOOTSTRAP_STEPS: Array<{ id: Exclude<BootstrapPhase, "ready">; title: string; detail: string }> = [
  { id: "connecting", title: "Secure desktop bridge", detail: "Connect the sandboxed interface to the trusted main process." },
  { id: "environment", title: "Local environment", detail: "Read module integrity, runtime, workspace, and model state." },
  { id: "session", title: "Run session", detail: "Restore the local thread, approvals, run ledger, and review state." },
];

function StartupSurface({ phase, error, onRetry }: { phase: BootstrapPhase; error?: string; onRetry?: () => void }) {
  const activeIndex = Math.max(0, BOOTSTRAP_STEPS.findIndex((step) => step.id === phase));
  return (
    <main className={`startup-surface ${error ? "has-error" : ""}`} role={error ? "alert" : "status"} aria-live={error ? "assertive" : "polite"}>
      <section className="startup-card">
        <div className="startup-brand"><span className="brand-mark" aria-hidden="true"><Dna size={19} /></span><div><strong>Proto Workbench</strong><span>Local, auditable research workspace</span></div></div>
        <div className="startup-heading">
          {error ? <CircleAlert size={25} /> : <LoaderCircle className="spin" size={25} />}
          <div><h1>{error ? "Startup needs attention" : "Preparing your workbench"}</h1><p>{error ? "No run or model load was started. Fix the blocked step, then retry." : "Checking only the declared local application resources."}</p></div>
        </div>
        <ol className="startup-checklist">
          {BOOTSTRAP_STEPS.map((step, index) => {
            const state = error && index === activeIndex ? "failed" : index < activeIndex || phase === "ready" ? "complete" : index === activeIndex ? "active" : "pending";
            return <li className={`is-${state}`} key={step.id}><span>{state === "complete" ? <Check size={14} /> : state === "failed" ? <X size={14} /> : state === "active" ? <LoaderCircle className="spin" size={14} /> : index + 1}</span><div><strong>{step.title}</strong><small>{step.detail}</small></div><em>{state}</em></li>;
          })}
        </ol>
        {error && <div className="startup-diagnostic"><strong>Diagnostic detail</strong><code>{error}</code></div>}
        {error && onRetry && <div className="startup-actions"><button className="primary-button" type="button" onClick={onRetry}><RefreshCw size={14} />Retry startup</button></div>}
      </section>
    </main>
  );
}

function TopBar() {
  const runtime = useWorkbenchStore((state) => state.runtime);
  const settings = useWorkbenchStore((state) => state.settings);
  const toggleModels = useWorkbenchStore((state) => state.toggleModels);
  const modelsOpen = useWorkbenchStore((state) => state.modelsOpen);
  const chooseWorkspace = useWorkbenchStore((state) => state.chooseWorkspace);
  const navigate = useWorkbenchStore((state) => state.navigate);
  const dataMode = workbenchDataMode();

  return (
    <header className="topbar">
      <div className="brand-block">
        <span className="brand-mark" aria-hidden="true">
          <Dna size={18} />
        </span>
        <span className="brand-name">Proto Workbench</span>
        {dataMode === "preview" && <span className="global-preview-badge" title="Development fixtures are active; actions do not change a real workspace.">Preview · fixture only</span>}
      </div>
      <div className="topbar-divider" />
      <button className="workspace-picker topbar-control" type="button" onClick={() => void chooseWorkspace()}>
        <span className="control-label">Workspace</span>
        <span title={settings.workspacePath}>{workspaceName(settings.workspacePath)}</span>
        <ChevronDown size={14} />
      </button>
      <div className="topbar-spacer" />
      <button id="mission-command-trigger" className="topbar-control command-trigger" type="button" onClick={() => window.dispatchEvent(new Event("proto:commands"))} title="Open mission commands (Ctrl+K)">
        <Search size={14} /><span>Commands</span><kbd>Ctrl K</kbd>
      </button>
      <button id="global-evidence-trigger" className="topbar-control evidence-trigger" type="button" onClick={() => window.dispatchEvent(new Event("proto:evidence"))} title="Search global evidence (Ctrl+Shift+F)">
        <Fingerprint size={14} /><span>Evidence</span>
      </button>
      <button id="decision-lab-trigger" className="topbar-control decision-lab-trigger" type="button" onClick={() => window.dispatchEvent(new Event("proto:decision-lab"))} title="Open Decision Lab (Ctrl+Shift+L)">
        <FlaskConical size={14} /><span>Lab</span>
      </button>
      <button id="verification-center-trigger" className="topbar-control verification-trigger" type="button" onClick={() => window.dispatchEvent(new Event("proto:verification"))} title="Verify Decision Bundles (Ctrl+Shift+V)">
        <ShieldCheck size={14} /><span>Verify</span>
      </button>
      <button
        className={`topbar-control model-trigger ${modelsOpen ? "is-open" : ""}`}
        type="button"
        onClick={() => toggleModels()}
        aria-expanded={modelsOpen}
      >
        <Boxes size={15} />
        <span>Models</span>
        <ChevronDown size={14} />
      </button>
      <div className="runtime-inline" title={runtime.detail}>
        <Circle size={8} fill={runtime.backend === "cuda" ? "#35a45d" : "#d59615"} stroke="none" />
        <span>{runtime.backend === "cuda" ? "CUDA ready" : runtime.available ? "CPU fallback" : "Runtime setup"}</span>
      </div>
      <button className="topbar-control runtime-picker" type="button" onClick={() => navigate("settings")}>
        <Atom size={15} />
        <span>llama.cpp (independent)</span>
        <ChevronDown size={14} />
      </button>
      <button className="icon-button topbar-icon" type="button" title="Settings" aria-label="Settings" onClick={() => navigate("settings")}>
        <Settings size={17} />
      </button>
      <button className="icon-button topbar-icon" type="button" title="Help" aria-label="Help" onClick={() => navigate("help")}>
        <CircleHelp size={17} />
      </button>
      <span className="window-overlay-space" aria-hidden="true" />
    </header>
  );
}

function CommandPalette({ onClose }: { onClose: () => void }) {
  const beginNewRun = useWorkbenchStore((state) => state.beginNewRun);
  const setPrompt = useWorkbenchStore((state) => state.setPrompt);
  const navigate = useWorkbenchStore((state) => state.navigate);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const commands = [
    {
      id: "plan-evidence",
      title: "Plan an evidence-gap review",
      detail: "Create a read-only planning draft with a structured starting goal.",
      run: async () => {
        await beginNewRun("plan");
        setPrompt("Map the evidence gaps for this workspace goal, identify assumptions, and propose a review plan without changing files or running code.");
      },
    },
    {
      id: "act-change",
      title: "Draft a controlled workspace change",
      detail: "Create an Act draft that must pass Mission Preflight before it can start.",
      run: async () => {
        await beginNewRun("act");
        setPrompt("Review the requested workspace change, explain the intended diff and validation path, then propose only reviewable changes behind explicit approval gates.");
      },
    },
    {
      id: "plan-recovery",
      title: "Open recovery and run evidence",
      detail: "Navigate to durable run state without resuming or executing anything.",
      run: async () => navigate("runs"),
    },
    {
      id: "decision-lab",
      title: "Compare mission policy postures",
      detail: "Open the read-only Decision Lab without changing the current draft or environment.",
      run: async () => window.dispatchEvent(new Event("proto:decision-lab")),
    },
    {
      id: "verify-decision-bundles",
      title: "Verify exported Decision Bundles",
      detail: "Re-check local checksums, content addresses, and simulation bindings without executing an artifact.",
      run: async () => window.dispatchEvent(new Event("proto:verification")),
    },
    {
      id: "launchpad",
      title: "Open environment Launchpad",
      detail: "Review runtime, model, modules, and workspace readiness.",
      run: async () => navigate("launchpad"),
    },
    {
      id: "materials",
      title: "Open biological Materials",
      detail: "Search the external, versioned catalogue and inspect rights and safety gates.",
      run: async () => navigate("materials"),
    },
  ];
  const visible = commands.filter((command) => `${command.title} ${command.detail}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  useEffect(() => inputRef.current?.focus(), []);

  return (
    <div className="command-palette-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-labelledby="command-palette-title">
        <div className="command-palette-search"><Search size={16} /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a mission command…" aria-label="Find a mission command" /><kbd>Esc</kbd></div>
        <div className="command-palette-heading"><div><span className="eyebrow">Mission control</span><h2 id="command-palette-title">Start with an explicit posture</h2></div><span>Navigation + draft only</span></div>
        <div className="command-palette-list" role="listbox" aria-label="Mission commands">
          {visible.map((command) => (
            <button key={command.id} type="button" role="option" aria-selected="false" onClick={() => void command.run().then(onClose)}>
              <span><strong>{command.title}</strong><small>{command.detail}</small></span><ChevronRight size={15} />
            </button>
          ))}
          {visible.length === 0 && <div className="command-empty">No command matches “{query}”.</div>}
        </div>
        <footer><ShieldCheck size={13} /><span>Commands never send a prompt, call a tool, or approve a side effect.</span></footer>
      </section>
    </div>
  );
}

function Sidebar() {
  const runs = useWorkbenchStore((state) => state.runs);
  const selectedRunId = useWorkbenchStore((state) => state.selectedRunId);
  const selectRun = useWorkbenchStore((state) => state.selectRun);
  const currentView = useWorkbenchStore((state) => state.currentView);
  const navigate = useWorkbenchStore((state) => state.navigate);
  const showArchived = useWorkbenchStore((state) => state.showArchived);
  const setShowArchived = useWorkbenchStore((state) => state.setShowArchived);
  const navigation = [
    { label: "Launchpad", view: "launchpad" as const, icon: Workflow },
    { label: "Workspaces", view: "workspaces" as const, icon: FolderKanban },
    { label: "Designs", view: "designs" as const, icon: Dna },
    { label: "Runs", view: "runs" as const, icon: History },
    { label: "Models", view: "models" as const, icon: Boxes },
    { label: "Materials", view: "materials" as const, icon: Database },
    { label: "Sources", view: "sources" as const, icon: BookOpen },
    { label: "Reviews", view: "reviews" as const, icon: ClipboardCheck },
  ];

  return (
    <aside className="sidebar">
      <nav className="primary-nav" aria-label="Primary">
        {navigation.map((item) => {
          const Icon = item.icon;
          return (
            <button className={`nav-item ${currentView === item.view ? "is-active" : ""}`} type="button" key={item.label} onClick={() => navigate(item.view)} aria-current={currentView === item.view ? "page" : undefined}>
              <Icon size={17} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="sidebar-section-title">Recent runs</div>
      <div className="recent-runs">
        {runs.slice(0, 8).map((run) => (
          <button
            className={`recent-run ${selectedRunId === run.runId ? "is-selected" : ""}`}
            type="button"
            key={run.runId}
            onClick={() => void selectRun(run.runId)}
            aria-current={selectedRunId === run.runId ? "true" : undefined}
          >
            <span className="recent-run-copy">
              <strong>{run.title}</strong>
              <small>{formatRunDate(run.createdAt)}</small>
            </span>
            <RunStateBadge lifecycle={run.lifecycle} />
          </button>
        ))}
      </div>
      <button className={`archive-button ${showArchived ? "is-active" : ""}`} type="button" onClick={() => void setShowArchived(!showArchived)}>
        {showArchived ? <History size={16} /> : <Archive size={16} />}
        <span>{showArchived ? "Hide archived runs" : "Show archived runs"}</span>
      </button>
    </aside>
  );
}

function RunHeader() {
  const runs = useWorkbenchStore((state) => state.runs);
  const selectedRunId = useWorkbenchStore((state) => state.selectedRunId);
  const thread = useWorkbenchStore((state) => state.thread);
  const current = selectedRunId ? runs.find((run) => run.runId === selectedRunId) : undefined;
  const refreshCurrentRun = useWorkbenchStore((state) => state.refreshCurrentRun);
  const archiveRun = useWorkbenchStore((state) => state.archiveRun);
  return (
    <section className="run-header">
      <div>
        <h1>{current?.title ?? thread?.title ?? "New Proto research run"}</h1>
        {selectedRunId ? <div className="run-id-line">
          <Circle className={`run-state-dot is-${current?.lifecycle.attention ?? "none"}`} size={8} fill="currentColor" stroke="none" />
          <span>Run ID:</span>
          <button type="button" className="inline-link" onClick={() => void navigator.clipboard.writeText(selectedRunId)} title="Copy run ID">
            {selectedRunId.slice(0, 22)}
            <Files size={14} />
          </button>
        </div> : <div className="run-id-line"><Circle size={8} fill="#9aa6a2" stroke="none" /><span>Send a goal to create the first run.</span></div>}
      </div>
      <div className="run-header-actions">
        {selectedRunId && current && <button className="quiet-button" type="button" onClick={() => void archiveRun(current.runId, !current.archived)}><Archive size={14} />{current.archived ? "Restore" : "Archive"}</button>}
        <button className="quiet-button" type="button" disabled={!selectedRunId} onClick={() => void refreshCurrentRun()}><RefreshCw size={14} />Refresh</button>
      </div>
    </section>
  );
}

function RunAttentionStrip() {
  const detail = useWorkbenchStore((state) => state.runDetail);
  const loading = useWorkbenchStore((state) => state.runDetailLoading);
  const showPendingPatch = useWorkbenchStore((state) => state.showPendingPatch);
  const navigate = useWorkbenchStore((state) => state.navigate);
  const selectEvent = useWorkbenchStore((state) => state.selectEvent);
  const reconcilePatchEffect = useWorkbenchStore((state) => state.reconcilePatchEffect);
  const resumePatchValidation = useWorkbenchStore((state) => state.resumePatchValidation);
  const lifecycle = detail?.summary.lifecycle;
  if (!lifecycle && !loading) return null;

  const attention = lifecycle?.attention ?? "none";
  const action = attention === "patch-review"
    ? { label: "Review patch", run: showPendingPatch }
    : detail?.allowedActions.reconcilePatchEffect
      ? { label: "Reconcile file effect", run: () => void reconcilePatchEffect() }
      : detail?.allowedActions.resumePatchValidation
        ? { label: "Resume validation", run: () => void resumePatchValidation() }
    : attention === "human-review"
      ? { label: "Open human review", run: () => navigate("reviews") }
      : attention === "tool-approval"
        ? { label: "Review tool action", run: focusToolApproval }
        : ["failure", "recovery"].includes(attention)
          ? { label: "Inspect last event", run: () => detail?.events.at(-1) && void selectEvent(detail.events.at(-1)!.id) }
          : undefined;
  return (
    <section className={`run-attention is-${attention} ${loading ? "is-loading" : ""}`} role="status" aria-live="polite" aria-busy={loading}>
      <span className="run-attention-icon" aria-hidden="true">
        {loading || attention === "validation" || attention === "patch-operation" ? <LoaderCircle className="spin" size={17} /> : attention === "none" ? <CheckCircle2 size={17} /> : attention === "failure" || attention === "recovery" ? <CircleAlert size={17} /> : <ShieldCheck size={17} />}
      </span>
      <div>
        <strong>{loading ? "Loading durable run snapshot" : lifecycle?.label}</strong>
        <p>{loading ? "Events, approvals, patches, review, and conversation are loading as one revision." : lifecycle?.detail}</p>
        {detail?.contextWarning && <small>{detail.contextWarning}</small>}
      </div>
      {action && !loading && <button className="secondary-button compact-command" type="button" onClick={action.run}>{action.label}<ChevronRight size={13} /></button>}
    </section>
  );
}

function StageTracker() {
  const events = useWorkbenchStore((state) => state.events);
  const lifecycle = useWorkbenchStore((state) => state.runDetail?.summary.lifecycle);
  const states = deriveRunStageStates(events, lifecycle);
  return (
    <section className="stage-tracker" aria-label="Run stages">
      {RUN_STAGES.map((stage, index) => {
        const stageEvents = events.filter((event) => event.stage === stage.id);
        const state = states[stage.id];
        const last = stageEvents.at(-1);
        return (
          <div className={`stage-item is-${state}`} key={stage.id}>
            <div className="stage-progress-row">
              <span className="stage-node">
                {state === "completed" ? <Check size={13} /> : ["failed", "cancelled", "interrupted"].includes(state) ? <X size={13} /> : state === "effect-unknown" ? <CircleAlert size={13} /> : index + 1}
              </span>
              {index < RUN_STAGES.length - 1 && <span className="stage-line" />}
            </div>
            <strong>{stage.label}</strong>
            <small>{state === "waiting" ? "Needs approval" : state === "blocked" && lifecycle?.state === "waiting-patch-review" ? "After patch decision" : state === "blocked" ? "Not reached" : stage.id === "review" && state === "completed" && lifecycle?.attention === "human-review" ? "Packet ready" : state === "effect-unknown" ? "Effect unknown" : capitalize(state)}</small>
            <time>{last ? formatTime(last.createdAt) : "—"}</time>
          </div>
        );
      })}
    </section>
  );
}

function RunLedger() {
  const events = useWorkbenchStore((state) => state.events);
  const selectedEventId = useWorkbenchStore((state) => state.selectedEventId);
  const selectEvent = useWorkbenchStore((state) => state.selectEvent);
  const ledgerSearch = useWorkbenchStore((state) => state.ledgerSearch);
  const ledgerSearchOpen = useWorkbenchStore((state) => state.ledgerSearchOpen);
  const setLedgerSearch = useWorkbenchStore((state) => state.setLedgerSearch);
  const setLedgerSearchOpen = useWorkbenchStore((state) => state.setLedgerSearchOpen);
  const visibleEvents = ledgerSearch.trim()
    ? events.filter((event) => JSON.stringify(event).toLocaleLowerCase().includes(ledgerSearch.trim().toLocaleLowerCase()))
    : events;

  return (
    <section className="ledger-section">
      <div className="ledger-heading">
        {ledgerSearchOpen ? <input className="ledger-search-input" value={ledgerSearch} onChange={(event) => setLedgerSearch(event.target.value)} autoFocus placeholder="Search this ledger" aria-label="Search this ledger" /> : <h2>Run ledger <span>(chronological)</span></h2>}
        <button type="button" className="icon-button" title={ledgerSearchOpen ? "Close ledger search" : "Search ledger"} aria-label={ledgerSearchOpen ? "Close ledger search" : "Search ledger"} onClick={() => setLedgerSearchOpen(!ledgerSearchOpen)}>
          <Search size={15} />
        </button>
      </div>
      <div className="ledger-table-header" aria-hidden="true">
        <span>Time</span>
        <span>Actor</span>
        <span>Event</span>
        <span>Input / output provenance</span>
        <span>Status</span>
      </div>
      <div className="ledger-scroll">
        {visibleEvents.length === 0 && <div className="ledger-empty">{events.length ? "No events match this search." : "No run events yet. Send a goal to the local agent."}</div>}
        {visibleEvents.map((event, index) => (
          <LedgerEvent
            event={event}
            last={index === visibleEvents.length - 1}
            selected={selectedEventId === event.id}
            onSelect={() => selectEvent(event.id)}
            key={event.id}
          />
        ))}
      </div>
    </section>
  );
}

function LedgerEvent({
  event,
  last,
  selected,
  onSelect,
}: {
  event: AgentRunEvent;
  last: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = event.stage === "goal"
    ? Target
    : event.stage === "plan"
      ? LayoutList
      : event.stage === "design"
        ? PencilLine
        : event.stage === "validate"
          ? ShieldCheck
          : FileCheck2;
  return (
    <button className={`ledger-row ${selected ? "is-selected" : ""}`} type="button" onClick={onSelect}>
      <div className="ledger-time-cell">
        <span className="timeline-icon"><Icon size={14} /></span>
        {!last && <span className="timeline-line" />}
        <time>{formatTime(event.createdAt)}</time>
      </div>
      <div className="actor-cell">
        <span className={`actor-mark actor-${event.actor}`}><Atom size={13} /></span>
        <span>{capitalize(event.actor)}</span>
      </div>
      <div className="event-copy">
        <strong>{event.title}</strong>
        <span>{event.summary}</span>
      </div>
      <div className="provenance-cell">
        {event.inputProvenance.slice(0, 1).map((input) => (
          <span className="file-link" key={input}><FileCode2 size={12} />{shortPath(input)}</span>
        ))}
        {event.outputArtifacts.slice(0, 1).map((output) => (
          <span className="file-link output" key={output}><ChevronRight size={12} />{shortPath(output)}</span>
        ))}
        {!event.inputProvenance.length && !event.outputArtifacts.length && <span className="muted-dash">—</span>}
      </div>
      <EventStatus status={event.status} />
    </button>
  );
}

function CodeDrawer() {
  const dataMode = workbenchDataMode();
  const patch = useWorkbenchStore((state) => state.patch);
  const activeDocument = useWorkbenchStore((state) => state.activeDocument);
  const codeMode = useWorkbenchStore((state) => state.codeMode);
  const diffLayout = useWorkbenchStore((state) => state.diffLayout);
  const drawerCollapsed = useWorkbenchStore((state) => state.drawerCollapsed);
  const fullEditor = useWorkbenchStore((state) => state.fullEditor);
  const drawerHeight = useWorkbenchStore((state) => state.drawerHeight);
  const runDetail = useWorkbenchStore((state) => state.runDetail);
  const busyPatchAction = useWorkbenchStore((state) => state.busyPatchAction);
  const setCodeMode = useWorkbenchStore((state) => state.setCodeMode);
  const setDiffLayout = useWorkbenchStore((state) => state.setDiffLayout);
  const setDrawerCollapsed = useWorkbenchStore((state) => state.setDrawerCollapsed);
  const setFullEditor = useWorkbenchStore((state) => state.setFullEditor);
  const setDrawerHeight = useWorkbenchStore((state) => state.setDrawerHeight);
  const approvePatch = useWorkbenchStore((state) => state.approvePatch);
  const rejectPatch = useWorkbenchStore((state) => state.rejectPatch);
  const reconcilePatchEffect = useWorkbenchStore((state) => state.reconcilePatchEffect);
  const resumePatchValidation = useWorkbenchStore((state) => state.resumePatchValidation);
  const prepareCheckpointRestore = useWorkbenchStore((state) => state.prepareCheckpointRestore);
  const navigate = useWorkbenchStore((state) => state.navigate);
  const openFile = useWorkbenchStore((state) => state.openFile);
  const revealFile = useWorkbenchStore((state) => state.revealFile);
  const dragStart = useRef<{ y: number; height: number } | undefined>(undefined);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!dragStart.current) return;
      setDrawerHeight(dragStart.current.height + dragStart.current.y - event.clientY);
    };
    const stop = () => (dragStart.current = undefined);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, [setDrawerHeight]);

  const changeStats = useMemo(() => patch ? countChangedLines(patch.before, patch.after) : { added: 0, removed: 0 }, [patch]);

  if (!patch && activeDocument) {
    if (drawerCollapsed) {
      return <section className="code-drawer is-collapsed"><button className="collapsed-code-button" type="button" onClick={() => setDrawerCollapsed(false)}><Code2 size={15} /><strong>Code & artifacts</strong><span>{shortPath(activeDocument.path)}</span><ChevronDown size={15} /></button></section>;
    }
    return (
      <section className={`code-drawer ${fullEditor ? "is-full" : ""}`} style={fullEditor ? undefined : ({ "--drawer-height": `${drawerHeight}px` } as CSSProperties)}>
        {!fullEditor && <button className="drawer-resizer" type="button" aria-label="Resize code panel" onPointerDown={(event) => { dragStart.current = { y: event.clientY, height: drawerHeight }; event.currentTarget.setPointerCapture(event.pointerId); }} />}
        <div className="code-toolbar">
          <div className="code-file-title"><FileCode2 size={15} /><strong>{shortPath(activeDocument.path)}</strong><span className="patch-state is-approved">Read only</span></div>
          <div className="code-toolbar-spacer" />
          <button className="icon-button" type="button" onClick={() => void revealFile(activeDocument.path)} title="Show in folder" aria-label="Show artifact in folder"><FolderKanban size={15} /></button>
          <button className="icon-button" type="button" onClick={() => setFullEditor(!fullEditor)} title={fullEditor ? "Exit full editor" : "Open full editor"} aria-label={fullEditor ? "Exit full editor" : "Open full editor"}>{fullEditor ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
          {!fullEditor && <button className="icon-button" type="button" onClick={() => setDrawerCollapsed(true)} title="Collapse code panel" aria-label="Collapse code panel"><ChevronDown size={15} /></button>}
        </div>
        <div className="editor-surface"><Editor value={activeDocument.content} language={languageForPath(activeDocument.path)} beforeMount={configureMonaco} theme="proto-light" options={{ automaticLayout: true, minimap: { enabled: false }, readOnly: true, fontSize: 12, lineHeight: 19, fontFamily: "Cascadia Code, Consolas, monospace", scrollBeyondLastLine: false, overviewRulerLanes: 0, lineNumbersMinChars: 3, padding: { top: 10, bottom: 10 } }} /></div>
        <div className="code-actionbar"><span className="change-summary"><FileCheck2 size={14} />Run artifact</span><span className="code-rationale">Selected from the auditable run ledger.</span><button className="secondary-button" type="button" onClick={() => void openFile(activeDocument.path)}><Files size={13} />Open externally</button></div>
      </section>
    );
  }

  if (!patch) {
    return (
      <section className="code-drawer is-empty">
        <div className="empty-code-layer"><Code2 size={18} /><div><strong>Code & artifacts</strong><span>A proposed edit or selected run artifact will open here.</span></div><button className="secondary-button" type="button" onClick={() => navigate("workspaces")}><Files size={13} />Browse workspace</button></div>
      </section>
    );
  }

  if (drawerCollapsed) {
    return (
      <section className="code-drawer is-collapsed">
        <button className="collapsed-code-button" type="button" onClick={() => setDrawerCollapsed(false)}>
          <Code2 size={15} />
          <strong>Code & artifacts</strong>
          <span>{shortPath(patch.targetPath)}</span>
          <ChevronDown size={15} />
        </button>
      </section>
    );
  }

  return (
    <section
      className={`code-drawer ${fullEditor ? "is-full" : ""}`}
      style={fullEditor ? undefined : ({ "--drawer-height": `${drawerHeight}px` } as CSSProperties)}
      aria-busy={Boolean(busyPatchAction)}
    >
      {!fullEditor && (
        <button
          className="drawer-resizer"
          type="button"
          aria-label="Resize code panel"
          onPointerDown={(event) => {
            dragStart.current = { y: event.clientY, height: drawerHeight };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
        />
      )}
      <div className="code-toolbar">
        <div className="code-file-title">
          <FileCode2 size={15} />
          <strong>{shortPath(patch.targetPath)}</strong>
          <span className={`patch-state is-${patch.status}`}>{capitalize(patch.status)}</span>
        </div>
        <div className="segmented-control compact" aria-label="Code view">
          <button className={codeMode === "code" ? "is-selected" : ""} type="button" onClick={() => setCodeMode("code")}>
            <Code2 size={14} />Code
          </button>
          <button className={codeMode === "diff" ? "is-selected" : ""} type="button" onClick={() => setCodeMode("diff")}>
            <GitCompare size={14} />Diff
          </button>
        </div>
        <div className="code-toolbar-spacer" />
        {codeMode === "diff" && (
          <div className="segmented-control compact icon-segment" aria-label="Diff layout">
            <button className={diffLayout === "unified" ? "is-selected" : ""} type="button" onClick={() => setDiffLayout("unified")} title="Unified diff">
              <LayoutList size={14} />
            </button>
            <button className={diffLayout === "split" ? "is-selected" : ""} type="button" onClick={() => setDiffLayout("split")} title="Split diff">
              <Columns2 size={14} />
            </button>
          </div>
        )}
        <button className="icon-button" type="button" onClick={() => setFullEditor(!fullEditor)} title={fullEditor ? "Exit full editor" : "Open full editor"} aria-label={fullEditor ? "Exit full editor" : "Open full editor"}>
          {fullEditor ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        {!fullEditor && (
          <button className="icon-button" type="button" onClick={() => setDrawerCollapsed(true)} title="Collapse code panel" aria-label="Collapse code panel">
            <ChevronDown size={15} />
          </button>
        )}
      </div>
      <PatchOperationRail detail={runDetail} patch={patch} busyAction={busyPatchAction} />
      <div className="editor-surface">
        {codeMode === "diff" ? (
          <DiffEditor
            original={patch.before}
            modified={patch.after}
            originalModelPath="inmemory://proto-workbench/patch/original.proto"
            modifiedModelPath="inmemory://proto-workbench/patch/modified.proto"
            keepCurrentOriginalModel
            keepCurrentModifiedModel
            language="proto"
            beforeMount={configureMonaco}
            theme="proto-light"
            options={{
              automaticLayout: true,
              minimap: { enabled: false },
              renderSideBySide: diffLayout === "split",
              readOnly: true,
              originalEditable: false,
              fontSize: 12,
              lineHeight: 19,
              fontFamily: "Cascadia Code, Consolas, monospace",
              scrollBeyondLastLine: false,
              overviewRulerLanes: 0,
              folding: false,
              lineNumbersMinChars: 3,
              padding: { top: 10, bottom: 10 },
            }}
          />
        ) : (
          <Editor
            value={patch.after}
            language={languageForPath(patch.targetPath)}
            beforeMount={configureMonaco}
            theme="proto-light"
            options={{
              automaticLayout: true,
              minimap: { enabled: false },
              readOnly: true,
              fontSize: 12,
              lineHeight: 19,
              fontFamily: "Cascadia Code, Consolas, monospace",
              scrollBeyondLastLine: false,
              overviewRulerLanes: 0,
              lineNumbersMinChars: 3,
              padding: { top: 10, bottom: 10 },
            }}
          />
        )}
      </div>
      <div className="code-actionbar">
        <span className="change-summary">
          <GitCompare size={14} />
          Controlled change <strong>+{changeStats.added}</strong> <span>−{changeStats.removed}</span>
        </span>
        <span className="code-rationale">{patch.rationale}</span>
        {dataMode === "preview" && <span className="preview-effect-note">Preview only · no workspace effect</span>}
        {runDetail?.allowedActions.reconcilePatchEffect && <button className="secondary-button recovery-command" type="button" disabled={Boolean(busyPatchAction)} onClick={() => void reconcilePatchEffect()}>
          {busyPatchAction === "reconcile" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{busyPatchAction === "reconcile" ? "Reconciling…" : "Reconcile effect"}
        </button>}
        {runDetail?.allowedActions.resumePatchValidation && <button className="primary-button" type="button" disabled={Boolean(busyPatchAction)} onClick={() => void resumePatchValidation()}>
          {busyPatchAction === "validate" ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}{busyPatchAction === "validate" ? "Validating…" : "Resume validation"}
        </button>}
        {runDetail?.allowedActions.prepareCheckpointRestore && <><span className="legacy-recovery-label">Legacy recovery/audit only</span><button className="secondary-button" type="button" disabled={Boolean(busyPatchAction)} onClick={() => void prepareCheckpointRestore()}>
          {busyPatchAction === "restore" ? <LoaderCircle className="spin" size={14} /> : <History size={14} />}{busyPatchAction === "restore" ? "Preparing…" : "Prepare restore diff"}
        </button></>}
        {patch.status === "pending" && <button className="secondary-button danger" type="button" disabled={Boolean(busyPatchAction) || !runDetail?.allowedActions.rejectPatch} onClick={() => void rejectPatch()}>
          {busyPatchAction === "reject" ? <LoaderCircle className="spin" size={14} /> : <XCircle size={14} />}{busyPatchAction === "reject" ? "Rejecting…" : "Reject"}
        </button>}
        {patch.status === "pending" && <button className="primary-button success" type="button" disabled={Boolean(busyPatchAction) || !runDetail?.allowedActions.approvePatch} onClick={() => void approvePatch()}>
          {busyPatchAction === "approve" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{busyPatchAction === "approve" ? "Checkpointing & applying…" : runDetail?.activePatchOperation?.state === "prepared" ? "Retry controlled apply" : "Approve & validate"}
        </button>}
      </div>
    </section>
  );
}

function PatchOperationRail({ detail, patch, busyAction }: { detail?: RunDetail; patch: PatchProposal; busyAction?: "approve" | "reject" | "reconcile" | "validate" | "restore" }) {
  const operation = detail?.activePatchOperation;
  const checkpoint = operation ? detail?.checkpoints.find((candidate) => candidate.id === operation.checkpointId) : undefined;
  const journal = operation ? detail?.validationJournals?.find((candidate) => candidate.operationId === operation.id) : undefined;
  const restorePending = patch.status === "pending" && Boolean(patch.restoresCheckpointId);
  const writeComplete = !restorePending && Boolean(operation && ["applied", "validating", "verified", "validation-failed", "rolled-back"].includes(operation.state));
  const writeFailed = !restorePending && Boolean(operation && ["effect-unknown", "conflict"].includes(operation.state));
  const validating = !restorePending && (operation?.state === "validating" || busyAction === "validate");
  const validationComplete = !restorePending && operation?.state === "verified";
  const validationFailed = !restorePending && operation?.state === "validation-failed";
  const steps = [
    { label: "Review", detail: restorePending ? "Restore decision ready" : patch.status === "pending" ? "Decision ready" : "Approved", state: "complete" },
    { label: "Checkpoint", detail: checkpoint ? `${restorePending ? "Restore source · " : ""}${formatBytes(checkpoint.sizeBytes)} · ${shortHash(checkpoint.sha256)}` : busyAction === "approve" ? "Saving snapshot" : "On approval", state: checkpoint ? "complete" : busyAction === "approve" ? "current" : "pending" },
    { label: "Write", detail: writeFailed ? "Needs reconciliation" : writeComplete ? shortHash(operation?.resultSha256) : operation?.state === "applying" || busyAction === "approve" ? "Controlled write" : "Not started", state: writeFailed ? "failed" : writeComplete ? "complete" : operation?.state === "applying" || busyAction === "approve" ? "current" : "pending" },
    { label: "Validate", detail: validationFailed ? "Resume available" : validationComplete ? "Recorded" : validating ? "Running checks" : writeComplete ? "Queued" : "After write", state: validationFailed ? "failed" : validationComplete ? "complete" : validating ? "current" : "pending" },
  ];
  return (
    <div className={`patch-operation-rail ${writeFailed || validationFailed ? "has-attention" : ""}`}>
      <ol aria-label="Patch transaction status">
        {steps.map((step) => <li className={`is-${step.state}`} key={step.label} aria-current={step.state === "current" ? "step" : undefined}><span aria-hidden="true">{step.state === "complete" ? <Check size={12} /> : step.state === "failed" ? <CircleAlert size={12} /> : <Circle size={8} />}</span><div><strong>{step.label}</strong><small>{step.detail}</small></div></li>)}
      </ol>
      {operation && <div className="patch-operation-meta"><span>Operation {operation.id.slice(0, 8)}</span><span>v{operation.revision}</span>{checkpoint && <span>{checkpoint.restoreState === "available" ? "Checkpoint available" : capitalize(checkpoint.restoreState)}</span>}</div>}
      {journal && <ValidationJournalRail journal={journal} />}
    </div>
  );
}

function ValidationJournalRail({ journal }: { journal: NonNullable<RunDetail["validationJournals"]>[number] }) {
  const completed = journal.steps.filter((step) => step.state === "completed").length;
  const needsRecovery = journal.state === "recovery-required" || journal.steps.some((step) => step.state === "interrupted" || step.state === "effect-unknown");
  return (
    <section className={`validation-journal ${needsRecovery ? "has-attention" : ""}`} aria-label="Durable validation journal">
      <header>
        <div>
          <span className="validation-journal-eyebrow">Validation journal</span>
          <strong>{completed}/{journal.steps.length} durable steps complete</strong>
        </div>
        <span className={`validation-journal-state is-${journal.state}`}>{journal.state.replaceAll("-", " ")}</span>
      </header>
      <ol>
        {journal.steps.map((step) => {
          const attention = step.state === "failed" || step.state === "interrupted" || step.state === "effect-unknown";
          return <li className={`is-${step.state}`} key={step.key} title={step.error ?? `Input ${step.inputSha256}${step.outputSha256 ? `; output ${step.outputSha256}` : ""}`}>
            <span className="validation-step-marker" aria-hidden="true">{step.state === "completed" ? <Check size={11} /> : attention ? <CircleAlert size={11} /> : step.state === "running" ? <LoaderCircle className="spin" size={11} /> : <Circle size={7} />}</span>
            <div><strong>{step.title}</strong><small>{step.effect.replaceAll("-", " ")} · attempt {step.attempt}{step.outputArtifacts.length ? ` · ${step.outputArtifacts.length} artifact${step.outputArtifacts.length === 1 ? "" : "s"}` : ""}</small><small className="validation-step-digest">in {shortHash(step.inputSha256)} → {step.outputSha256 ? shortHash(step.outputSha256) : "pending"}</small></div>
            <span className="validation-step-state">{step.state.replaceAll("-", " ")}</span>
          </li>;
        })}
      </ol>
      <footer>
        <span title={journal.planSha256}>Plan {shortHash(journal.planSha256)} · journal v{journal.revision}</span>
        {journal.nextStepKey && <span>Next: {journal.steps.find((step) => step.key === journal.nextStepKey)?.title ?? journal.nextStepKey}</span>}
        {journal.steps.find((step) => step.error)?.error && <span className="validation-journal-error">{journal.steps.find((step) => step.error)?.error}</span>}
        {needsRecovery && <strong>No write or network side effect was replayed automatically.</strong>}
      </footer>
    </section>
  );
}

function ToolApprovalBar() {
  const dataMode = workbenchDataMode();
  const approvals = useWorkbenchStore((state) => state.pendingApprovals);
  const selectedRunId = useWorkbenchStore((state) => state.selectedRunId);
  const runDetail = useWorkbenchStore((state) => state.runDetail);
  const resolvingApprovalId = useWorkbenchStore((state) => state.resolvingApprovalId);
  const resolveToolApproval = useWorkbenchStore((state) => state.resolveToolApproval);
  const reconcileRunDetail = useWorkbenchStore((state) => state.reconcileRunDetail);
  const visibleApprovals = approvals.filter((item) => item.runId === selectedRunId);
  const approval = visibleApprovals[0];
  const countdown = useApprovalCountdown(approval?.expiresAt);

  useEffect(() => {
    if (!approval || !countdown.expired) return;
    void reconcileRunDetail(approval.runId);
  }, [approval, countdown.expired, reconcileRunDetail]);

  if (!approval) return null;
  const resolving = resolvingApprovalId === approval.id;
  const argumentSummary = approvalArgumentSummary(approval.arguments);
  const actionable = !resolving && !countdown.expired && Boolean(runDetail?.allowedActions.resolveToolApproval);

  return (
    <section id="tool-approval" className="tool-approval-bar" aria-label="Tool approval required" tabIndex={-1}>
      <span className={`approval-risk-icon is-${approval.risk}`} aria-hidden="true">
        <ShieldCheck size={16} />
      </span>
      <div className="approval-copy">
        <div className="approval-title-line">
          <strong>{readableToolName(approval.tool)}</strong>
          <span>{riskLabel(approval.risk)}</span>
          {visibleApprovals.length > 1 && <small>{visibleApprovals.length} waiting</small>}
          <time className={`approval-expiry is-${countdown.urgency}`} dateTime={approval.expiresAt} title={`Expires ${new Date(approval.expiresAt).toLocaleString()}`}>
            {countdown.expired ? "Expired — no action executed" : `Expires in ${countdown.label}`}
          </time>
          <span className="sr-only" aria-live="polite">{countdown.announcement}</span>
        </div>
        <p title={argumentSummary}>{riskDescription(approval.risk)} · {argumentSummary}</p>
        {dataMode === "preview" && <small className="preview-effect-note">Fixture decision only · no external effect</small>}
      </div>
      <div className="approval-actions" role="group" aria-label="Tool approval decision">
        <button
          className="secondary-button danger approval-decision"
          type="button"
          disabled={!actionable}
          onClick={() => void resolveToolApproval(approval.id, "rejected")}
        >
          <XCircle size={14} />Reject
        </button>
        <button
          className="primary-button approval-decision"
          type="button"
          disabled={!actionable}
          onClick={() => void resolveToolApproval(approval.id, "approved")}
        >
          {resolving ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
          Allow once
        </button>
      </div>
    </section>
  );
}

function useApprovalCountdown(expiresAt?: string): { expired: boolean; label: string; urgency: "normal" | "soon" | "critical" | "expired"; announcement: string } {
  const [now, setNow] = useState(Date.now());
  const [announcement, setAnnouncement] = useState("");
  const announced = useRef<string | undefined>(undefined);
  useEffect(() => {
    setNow(Date.now());
    if (!expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  const expiry = expiresAt ? Date.parse(expiresAt) : Number.POSITIVE_INFINITY;
  const remaining = Number.isFinite(expiry) ? Math.max(0, expiry - now) : 0;
  const expired = Boolean(expiresAt) && (!Number.isFinite(expiry) || remaining <= 0);
  const urgency = expired ? "expired" : remaining <= 10_000 ? "critical" : remaining <= 60_000 ? "soon" : "normal";
  useEffect(() => {
    const bucket = expired ? "expired" : remaining <= 10_000 ? "ten" : remaining <= 60_000 ? "minute" : "";
    if (!bucket || announced.current === bucket) return;
    announced.current = bucket;
    setAnnouncement(bucket === "expired" ? "Approval expired. No action was executed." : bucket === "ten" ? "Approval expires in ten seconds." : "Approval expires in one minute.");
  }, [expired, remaining]);
  return { expired, label: formatApprovalCountdown(remaining), urgency, announcement };
}

function Composer() {
  const prompt = useWorkbenchStore((state) => state.prompt);
  const selectedRunId = useWorkbenchStore((state) => state.selectedRunId);
  const setPrompt = useWorkbenchStore((state) => state.setPrompt);
  const mode = useWorkbenchStore((state) => state.mode);
  const setMode = useWorkbenchStore((state) => state.setMode);
  const pickAttachments = useWorkbenchStore((state) => state.pickAttachments);
  const attachments = useWorkbenchStore((state) => state.attachments);
  const removeAttachment = useWorkbenchStore((state) => state.removeAttachment);
  const send = useWorkbenchStore((state) => state.send);
  const refreshMissionPreflight = useWorkbenchStore((state) => state.refreshMissionPreflight);
  const missionPreflight = useWorkbenchStore((state) => state.missionPreflight);
  const preflighting = useWorkbenchStore((state) => state.preflighting);
  const streamingText = useWorkbenchStore((state) => state.streamingText);
  const isAgentRunning = useWorkbenchStore((state) => state.isAgentRunning);
  const agentStartedAt = useWorkbenchStore((state) => state.agentStartedAt);
  const events = useWorkbenchStore((state) => state.events);
  const messages = useWorkbenchStore((state) => state.messages);
  const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const workspaceEntries = useWorkbenchStore((state) => state.workspaceEntries);
  const settings = useWorkbenchStore((state) => state.settings);
  const runtime = useWorkbenchStore((state) => state.runtime);
  const moduleIntegrity = useWorkbenchStore((state) => state.moduleIntegrity);
  const models = useWorkbenchStore((state) => state.models);
  const thread = useWorkbenchStore((state) => state.thread);
  const addReference = useWorkbenchStore((state) => state.addReference);
  const cancel = useWorkbenchStore((state) => state.cancel);
  const navigate = useWorkbenchStore((state) => state.navigate);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const activeEvent = [...events].reverse().find((event) => event.status === "running");
  const readiness = deriveWorkbenchReadiness({ settings, runtime, moduleIntegrity, models, workspaceEntries, threadModelId: thread?.modelId });
  const runningSummary = activeEvent
    ? `${activeEvent.title}: ${activeEvent.summary}`
    : streamingText
      ? `Drafting response: ${streamingText.length.toLocaleString("en-US")} characters received.`
      : "Working through the plan and controlled tools...";

  useEffect(() => {
    if (!isAgentRunning) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [isAgentRunning]);

  useEffect(() => {
    if (selectedRunId || isAgentRunning) return;
    promptRef.current?.focus();
  }, [selectedRunId, isAgentRunning, thread?.id]);

  return (
    <section className="composer-wrap">
      {(isAgentRunning || streamingText || latestAssistant) && (
        <div className="assistant-reply">
          <Atom size={14} />
          <div className="assistant-reply-copy">
            <span>{isAgentRunning ? runningSummary : latestAssistant?.content}</span>
            {isAgentRunning && agentStartedAt && <time>{formatElapsed(clock - agentStartedAt)}</time>}
          </div>
          {isAgentRunning && <LoaderCircle className="spin" size={13} />}
        </div>
      )}
      {!isAgentRunning && !readiness.operational && (
        <button className="composer-readiness" type="button" onClick={() => navigate("launchpad")}>
          <CircleAlert size={14} /><span><strong>{readiness.next?.title ?? "Environment setup"} needs attention</strong><small>Open Launchpad to finish setup before starting a run.</small></span><ChevronRight size={14} />
        </button>
      )}
      {!isAgentRunning && missionPreflight && (
        <MissionPreflightCard report={missionPreflight} onRefresh={() => void refreshMissionPreflight()} refreshing={preflighting} />
      )}
      <div className="composer">
        <textarea
          ref={promptRef}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !isAgentRunning && !preflighting && readiness.operational) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="Ask the local research agent…"
          aria-label="Ask the local research agent"
        />
        <div className="composer-top-controls">
          <div className="segmented-control mode-control">
            <button className={mode === "plan" ? "is-selected" : ""} type="button" onClick={() => void setMode("plan")} aria-pressed={mode === "plan"}>Plan</button>
            <button className={mode === "act" ? "is-selected" : ""} type="button" onClick={() => void setMode("act")} aria-pressed={mode === "act"}>Act</button>
          </div>
        </div>
        {attachments.length > 0 && (
          <div className="attachment-row">
            {attachments.map((attachment) => (
              <span className="attachment-chip" key={attachment.path}>
                <Paperclip size={12} />{attachment.name}
                <button type="button" onClick={() => removeAttachment(attachment.path)} aria-label={`Remove ${attachment.name}`}><X size={11} /></button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-actions">
          <button className="composer-tool" type="button" onClick={() => void pickAttachments()}>
            <Paperclip size={16} />Attach<ChevronDown size={13} />
          </button>
          <button className={`composer-tool ${referenceOpen ? "is-open" : ""}`} type="button" onClick={() => setReferenceOpen(!referenceOpen)} aria-expanded={referenceOpen}>
            <span className="at-symbol">@</span>Use<ChevronDown size={13} />
          </button>
          <span className="composer-action-spacer" />
          <button className={`send-button ${isAgentRunning ? "is-cancel" : ""}`} type="button" onClick={() => void (isAgentRunning ? cancel() : send())} disabled={!isAgentRunning && (!prompt.trim() || !readiness.operational || preflighting || missionPreflight?.launchable === false)} title={!isAgentRunning && !readiness.operational ? "Finish Launchpad setup before starting a run" : missionPreflight?.launchable === false ? "Resolve the blocked preflight requirement" : undefined}>
            {isAgentRunning ? <Square size={14} /> : preflighting ? <LoaderCircle className="spin" size={14} /> : missionPreflight ? <Play size={14} /> : <ShieldCheck size={15} />}{isAgentRunning ? "Cancel" : preflighting ? "Checking…" : missionPreflight?.launchable === false ? "Blocked" : missionPreflight ? "Start mission" : "Review mission"}
          </button>
        </div>
        {referenceOpen && <div className="reference-menu">
          <strong>Reference workspace file</strong>
          {workspaceEntries.length === 0 && <span>No indexed files</span>}
          {workspaceEntries.slice(0, 12).map((entry) => <button type="button" key={entry.path} onClick={() => { addReference(entry); setReferenceOpen(false); }}><FileCode2 size={13} /><span>{entry.relativePath}</span></button>)}
        </div>}
      </div>
    </section>
  );
}

function MissionPreflightCard({ report, onRefresh, refreshing }: {
  report: NonNullable<ReturnType<typeof useWorkbenchStore.getState>["missionPreflight"]>;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const attention = report.requirements.filter((requirement) => requirement.state !== "ready");
  const readyCount = report.requirements.length - attention.length;
  const stateLabel = report.state === "approval-required" ? "Gated" : report.state === "blocked" ? "Blocked" : "Ready";
  return (
    <section className={`mission-preflight-card is-${report.state}`} aria-label="Trusted mission preflight" aria-live="polite">
      <header>
        <span className="mission-preflight-icon">{report.state === "blocked" ? <CircleAlert size={16} /> : <ShieldCheck size={16} />}</span>
        <div><span className="eyebrow">Main-process preflight</span><strong>{stateLabel} · {readyCount}/{report.requirements.length} requirements ready</strong></div>
        <code title={report.digest}>{report.digest.slice(0, 8)}</code>
        <button className="quiet-button compact-command" type="button" onClick={onRefresh} disabled={refreshing}><RefreshCw className={refreshing ? "spin" : undefined} size={12} />Refresh</button>
      </header>
      <div className="mission-preflight-body">
        {attention.length === 0
          ? <div className="mission-requirement is-ready"><CheckCircle2 size={13} /><span><strong>Exact launch contract ready</strong><small>{report.nextAction}</small></span></div>
          : attention.map((requirement) => (
            <div className={`mission-requirement is-${requirement.state}`} key={requirement.id}>
              {requirement.state === "blocked" ? <XCircle size={13} /> : requirement.state === "deferred" ? <Circle size={11} /> : <CircleAlert size={13} />}
              <span><strong>{requirement.title} · {requirement.state.replace("-", " ")}</strong><small>{requirement.detail}</small></span>
            </div>
          ))}
      </div>
      <footer><span>Goal {report.goalSha256.slice(0, 8)}</span><span>{report.mode === "plan" ? "Plan keeps writes and execution deferred" : "Act exposes effects before execution"}</span><span>Launch confirmation never approves later effects</span></footer>
    </section>
  );
}

function ReviewPanel() {
  const review = useWorkbenchStore((state) => state.review);
  const runDetail = useWorkbenchStore((state) => state.runDetail);
  const updateChecklist = useWorkbenchStore((state) => state.updateChecklist);
  const comments = useWorkbenchStore((state) => state.comments);
  const addReviewComment = useWorkbenchStore((state) => state.addReviewComment);
  const approveRun = useWorkbenchStore((state) => state.approveRun);
  const openFile = useWorkbenchStore((state) => state.openFile);
  const navigate = useWorkbenchStore((state) => state.navigate);
  const [comment, setComment] = useState("");
  const lifecycle = runDetail?.summary.lifecycle;
  const reviewCurrent = Boolean(lifecycle && ["review-required", "ready-for-approval", "approved"].includes(lifecycle.state));
  const ready = review.gate === "ready" && Boolean(runDetail?.allowedActions.approveRun);
  const hasPacket = Boolean(review.packetPath);

  return (
    <aside className="review-panel">
      <div className="review-titlebar">
        <ClipboardCheck size={16} />
        <strong>Review</strong>
        <span>{review.packetPath ? shortPath(review.packetPath) : "No packet"}</span>
        <button className="icon-button" type="button" title="Expand review" aria-label="Expand review" onClick={() => navigate("reviews")}><Maximize2 size={14} /></button>
      </div>
      <div className="review-scroll">
        <section className="review-section gate-section">
          <h2>Gate</h2>
          <div className={`review-gate ${hasPacket && reviewCurrent ? `is-${review.gate}` : "is-pending"}`}>
            {!hasPacket ? <LoaderCircle size={20} /> : !reviewCurrent || review.gate === "blocked" ? <CircleAlert size={20} /> : <CheckCircle2 size={20} />}
            <div>
              <strong>{!hasPacket ? "No review packet yet" : !reviewCurrent ? "Review waits for the current run action" : review.gate === "approved" ? "Run approved" : review.gate === "blocked" ? "Validation blocked" : ready ? "Ready for human sign-off" : "Ready for human review"}</strong>
              <p>{!reviewCurrent && lifecycle ? lifecycle.detail : review.summary}</p>
            </div>
          </div>
        </section>

        <section className="review-section">
          <h2>Claim → Evidence traceability</h2>
          <div className="claims-table">
            <div className="claim-row claim-header"><span>ID</span><span>Claim</span><span>Evidence</span><span>Status</span></div>
            {review.claims.slice(0, 6).map((claim) => (
              <div className="claim-row" key={claim.id}>
                <strong>{claim.id}</strong>
                <span>{claim.claim}</span>
                <button className="inline-link evidence-link" type="button" disabled={!claim.evidence[0]} onClick={() => claim.evidence[0] && void openFile(claim.evidence[0])}>{shortPath(claim.evidence[0] ?? "Needs source")}</button>
                <span className={`claim-status is-${claim.status}`} title={claim.status}>
                  {claim.status === "supported" ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}
                </span>
              </div>
            ))}
          </div>
          <button className="section-link" type="button" disabled={!review.packetPath} onClick={() => review.packetPath && void openFile(review.packetPath)}>Open review packet <ChevronRight size={13} /></button>
        </section>

        <section className="review-section">
          <h2>Human checklist</h2>
          <div className="review-checklist">
            {review.checklist.map((item) => (
              <label className={`checklist-item is-${item.status}`} key={item.id}>
                <input
                  type="checkbox"
                  checked={item.status === "done"}
                  disabled={!reviewCurrent || item.status === "blocked" || review.gate === "approved"}
                  onChange={(event) => void updateChecklist(item.id, event.target.checked)}
                />
                <span>{item.label}</span>
                <small>{capitalize(item.status)}</small>
              </label>
            ))}
          </div>
        </section>

        <section className="review-section">
          <h2>Unresolved questions</h2>
          <div className="question-list">
            {review.unresolvedQuestions.map((question) => (
              <div className="question" key={question}><CircleHelp size={14} /><span>{question}</span></div>
            ))}
          </div>
        </section>

        <section className="review-section comment-section">
          <h2>Add review comment</h2>
          <div className="comment-box">
            <textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Comment…" aria-label="Review comment" />
            <button
              className="secondary-button"
              type="button"
              disabled={!comment.trim()}
              onClick={() => {
                void addReviewComment(comment).then(() => setComment(""));
              }}
            >
              Add
            </button>
          </div>
          {comments.slice(-2).map((item) => <span className="comment-success" key={item.id}><Check size={12} /> {item.comment}</span>)}
        </section>
      </div>
      <button className="approve-run-button" type="button" disabled={!ready} onClick={() => void approveRun()}>
        <Check size={15} />{review.gate === "approved" ? "Run approved" : "Approve run"}
      </button>
      <div className="safety-note" title={review.safetyBoundary}><ShieldCheck size={13} />Software review boundary</div>
    </aside>
  );
}

function ModelPopover() {
  const toggleModels = useWorkbenchStore((state) => state.toggleModels);
  const models = useWorkbenchStore((state) => state.models);
  const settings = useWorkbenchStore((state) => state.settings);
  const runtime = useWorkbenchStore((state) => state.runtime);
  const modelTab = useWorkbenchStore((state) => state.modelTab);
  const setModelTab = useWorkbenchStore((state) => state.setModelTab);
  const loadModel = useWorkbenchStore((state) => state.loadModel);
  const unloadModel = useWorkbenchStore((state) => state.unloadModel);
  const pinModel = useWorkbenchStore((state) => state.pinModel);
  const busyModelId = useWorkbenchStore((state) => state.busyModelId);
  const isAgentRunning = useWorkbenchStore((state) => state.isAgentRunning);
  const navigate = useWorkbenchStore((state) => state.navigate);
  const budget = settings.residencyPolicy.budgetBytes;
  const used = models
    .filter((model) => ["active", "warm", "loading"].includes(model.loadState))
    .reduce((sum, model) => sum + (model.measuredVramBytes ?? model.estimatedVramBytes), 0);
  const visible = modelTab === "quick-switch" ? models.slice().sort(sortModels) : models;

  return (
    <section className="model-popover" aria-label="Model loader">
      <div className="popover-tabs">
        <button className={modelTab === "quick-switch" ? "is-selected" : ""} type="button" onClick={() => void setModelTab("quick-switch")}>Quick switch</button>
        <button className={modelTab === "auto-evict" ? "is-selected" : ""} type="button" onClick={() => void setModelTab("auto-evict")}>Auto-evict pool</button>
        <button className="icon-button popover-close" type="button" onClick={() => toggleModels(false)} title="Close model loader" aria-label="Close model loader"><X size={14} /></button>
      </div>
      <div className="vram-block">
        <div className="vram-heading">
          <strong>VRAM budget</strong>
          <span>{formatGb(budget)} budget</span>
        </div>
        <div className="vram-meter"><span style={{ width: `${Math.min(100, (used / budget) * 100)}%` }} /></div>
        <div className="vram-labels"><span>{formatGb(used)} resident</span><span>{formatGb(Math.max(0, budget - used))} free</span></div>
      </div>
      <div className="model-table-head"><span>Model</span><span>Status</span><span>VRAM</span><span>Action</span></div>
      <div className="model-list">
        {visible.map((model) => (
          <ModelRow
            key={model.id}
            model={model}
            busy={busyModelId === model.id}
            disabled={isAgentRunning}
            onLoad={() => void loadModel(model.id)}
            onUnload={() => void unloadModel(model.id)}
            onPin={() => void pinModel(model.id, !model.pinned)}
          />
        ))}
      </div>
      <div className="eviction-policy">
        <strong>{modelTab === "quick-switch" ? "Switching policy" : "Eviction policy"}</strong>
        <p>
          {modelTab === "quick-switch"
            ? "Keep exactly one model resident. Per-model context and sampling presets are restored on return."
            : "Evict unpinned least-recently-used models before the VRAM budget is exceeded. Warm TTL: 30 min."}
        </p>
      </div>
      <button className="model-configure-button" type="button" onClick={() => navigate("models")}><SlidersHorizontal size={14} />Configure context, offload & VRAM</button>
      <footer className="model-popover-footer">
        <span title={settings.modelRoot}>Model directory: {shortDirectory(settings.modelRoot)} <em>read-only</em></span>
        <span className={runtime.available ? "runtime-ok" : "runtime-missing"}>
          {runtime.available ? <CheckCircle2 size={12} /> : <Unplug size={12} />}
          {runtime.backend === "cuda" ? "llama.cpp CUDA" : runtime.available ? "llama.cpp CPU fallback" : "llama.cpp unavailable"}
        </span>
      </footer>
    </section>
  );
}

function ModelRow({
  model,
  busy,
  disabled,
  onLoad,
  onUnload,
  onPin,
}: {
  model: ModelDescriptor;
  busy: boolean;
  disabled: boolean;
  onLoad: () => void;
  onUnload: () => void;
  onPin: () => void;
}) {
  const resident = model.loadState === "active" || model.loadState === "warm";
  return (
    <div className="model-row">
      <div className="model-name-cell">
        <StatusDot status={model.loadState} />
        <span><strong>{model.name}</strong><small>{model.quantization} · {formatContext(model.contextLength)} ctx</small></span>
      </div>
      <span className={`model-state is-${model.loadState}`}>{model.loadState === "warm" ? "Warm standby" : capitalize(model.loadState)}</span>
      <span title={model.measuredVramBytes ? "Live process VRAM" : "Calculated load estimate"}>{model.measuredVramBytes ? "" : "≈"}{formatGb(model.measuredVramBytes ?? model.estimatedVramBytes)}</span>
      <div className="model-actions">
        <button className="icon-button" type="button" onClick={onPin} title={model.pinned ? "Unpin model" : "Pin model"} aria-label={model.pinned ? "Unpin model" : "Pin model"}>
          {model.pinned ? <PinOff size={13} /> : <Pin size={13} />}
        </button>
        <button className="text-action" type="button" onClick={resident ? onUnload : onLoad} disabled={disabled || busy || model.loadState === "queued"}>
          {busy ? <LoaderCircle className="spin" size={13} /> : resident ? "Evict" : "Load"}
        </button>
      </div>
    </div>
  );
}

function EventStatus({ status }: { status: AgentRunEvent["status"] }) {
  const complete = status === "completed" || status === "approved";
  return (
    <span className={`event-status is-${status}`}>
      {complete ? <CheckCircle2 size={13} /> : status === "failed" ? <XCircle size={13} /> : status === "running" ? <LoaderCircle className="spin" size={13} /> : <CircleAlert size={13} />}
      {status === "approval-required" ? "Review" : status === "effect-unknown" ? "Effect unknown" : capitalize(status)}
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  const color = status === "failed" || status === "error"
    ? "#cc3b38"
    : status === "approval-required" || status === "queued" || status === "waiting" || status === "interrupted" || status === "effect-unknown"
      ? "#d59615"
      : status === "unloaded" || status === "pending"
        ? "#9aa6a2"
        : status === "active"
          ? "#087f78"
          : "#2f9b55";
  return <Circle className="status-dot" size={8} fill={color} stroke="none" aria-hidden="true" />;
}

function RunStateBadge({ lifecycle }: { lifecycle: RunLifecycleProjection }) {
  const label = lifecycle.state === "waiting-patch-review"
    ? "Patch"
    : lifecycle.state === "waiting-tool-approval"
      ? "Approve"
      : lifecycle.state === "review-required" || lifecycle.state === "ready-for-approval"
        ? "Review"
        : lifecycle.state === "effect-unknown"
          ? "Reconcile"
          : lifecycle.state === "completed"
            ? "Done"
            : capitalize(lifecycle.state);
  return <span className={`run-state-badge is-${lifecycle.attention}`} title={`${lifecycle.label}: ${lifecycle.detail}`}>{label}</span>;
}

const configureMonaco: BeforeMount = (monaco) => {
  if (!monaco.languages.getLanguages().some((language: { id: string }) => language.id === "proto")) {
    monaco.languages.register({ id: "proto" });
    monaco.languages.setMonarchTokensProvider("proto", {
      keywords: ["design", "chassis", "construct", "constraint", "promoter", "rbs", "cds", "terminator"],
      tokenizer: {
        root: [
          [/[a-zA-Z_][\w]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
          [/\b\d+(?:\.\d+)?\b/, "number"],
          [/#.*$/, "comment"],
          [/[=:]/, "delimiter"],
        ],
      },
    });
    monaco.editor.defineTheme("proto-light", {
      base: "vs",
      inherit: true,
      rules: [
        { token: "keyword", foreground: "006f69", fontStyle: "bold" },
        { token: "identifier", foreground: "25312e" },
        { token: "number", foreground: "915c00" },
        { token: "comment", foreground: "7b8783", fontStyle: "italic" },
      ],
      colors: {
        "editor.background": "#fbfcfc",
        "editorLineNumber.foreground": "#9aa6a2",
        "editorLineNumber.activeForeground": "#4f5c58",
        "editor.selectionBackground": "#cfe8e4",
        "editor.lineHighlightBackground": "#f3f7f5",
        "diffEditor.insertedTextBackground": "#bfe4cc88",
        "diffEditor.removedTextBackground": "#f1c9c688",
        "diffEditor.insertedLineBackground": "#e9f7ee",
        "diffEditor.removedLineBackground": "#fbeeed",
        "editorGutter.addedBackground": "#2f9b55",
        "editorGutter.deletedBackground": "#cc3b38",
      },
    });
  }
};

function formatGb(bytes: number): string {
  return `${(bytes / GIB).toFixed(bytes < 10 * GIB ? 1 : 1)} GB`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function shortHash(value?: string): string {
  return value ? `sha ${value.slice(0, 8)}` : "sha unavailable";
}

function formatContext(context: number): string {
  if (context >= 1_000_000) return `${(context / 1_000_000).toFixed(1)}M`;
  return `${Math.round(context / 1024)}K`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatApprovalCountdown(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function formatRunDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function shortPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  return parts.slice(-2).join("/");
}

function countChangedLines(before: string, after: string): { added: number; removed: number } {
  return diffLines(before, after).reduce((total, change) => {
    const count = change.count ?? changedLineCount(change.value);
    if (change.added) total.added += count;
    if (change.removed) total.removed += count;
    return total;
  }, { added: 0, removed: 0 });
}

function changedLineCount(value: string): number {
  if (!value) return 0;
  const lines = value.split(/\r?\n/).length;
  return value.endsWith("\n") ? Math.max(0, lines - 1) : lines;
}

function focusToolApproval(): void {
  const element = document.getElementById("tool-approval");
  element?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  element?.focus({ preventScroll: true });
}

function languageForPath(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLocaleLowerCase();
  return ({ proto: "proto", json: "json", md: "markdown", py: "python", r: "r", ts: "typescript", tsx: "typescript", js: "javascript", mjs: "javascript", csv: "plaintext", txt: "plaintext" } as Record<string, string>)[extension] ?? "plaintext";
}

function shortDirectory(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  return parts.length > 4 ? `…/${parts.slice(-3).join("/")}` : normalized;
}

function workspaceName(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
  return normalized.split("/").pop() || "Workspace";
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1).replaceAll("-", " ") : value;
}

function sortModels(left: ModelDescriptor, right: ModelDescriptor): number {
  const rank = (state: ModelDescriptor["loadState"]) => (state === "active" ? 0 : state === "warm" ? 1 : state === "queued" ? 2 : 3);
  return rank(left.loadState) - rank(right.loadState);
}

function readableToolName(tool: string): string {
  return tool
    .replace(/^proto_/, "")
    .split("_")
    .map(capitalize)
    .join(" ");
}

function riskLabel(risk: "write" | "network" | "code-execution"): string {
  if (risk === "network") return "External network";
  if (risk === "write") return "Workspace write";
  return "Local code";
}

function riskDescription(risk: "write" | "network" | "code-execution"): string {
  if (risk === "network") return "Sends this query to the declared literature service";
  if (risk === "write") return "Changes one reviewed workspace file";
  return "Runs the declared analysis tool inside the workspace";
}

function approvalArgumentSummary(arguments_: Record<string, unknown>): string {
  const values = Object.entries(arguments_)
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  const summary = values.join(" · ") || "No arguments";
  return summary.length > 220 ? `${summary.slice(0, 217)}...` : summary;
}
