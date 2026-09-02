import {
  ArrowRight,
  Boxes,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FileCode2,
  FileKey2,
  Fingerprint,
  FolderOpen,
  GitFork,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Network,
  ShieldAlert,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  projectRunExecution,
  type RunArtifactRef,
  type RunStepView,
} from "../shared/run-execution.ts";
import { previewRunEvidenceFixture, workbenchDataMode } from "./mock-api.ts";
import { useWorkbenchStore } from "./store.ts";

type EvidenceTab = "timeline" | "topology" | "artifacts";
type EvidenceArtifact = RunArtifactRef & { sha256?: string; sizeBytes?: number };

const EVIDENCE_TABS: Array<{ id: EvidenceTab; label: string; icon: typeof Clock3 }> = [
  { id: "timeline", label: "Timeline", icon: Clock3 },
  { id: "topology", label: "Topology", icon: Network },
  { id: "artifacts", label: "Artifacts", icon: Boxes },
];

const STAGE_LANES: Array<RunStepView["stage"]> = ["goal", "plan", "design", "validate", "review"];

/**
 * Stage 5 is a renderer-only evidence explorer. Durable lineage still comes from
 * projectRunExecution; preview metadata is never substituted in desktop mode.
 */
export function RunEvidenceViews() {
  const events = useWorkbenchStore((state) => state.events);
  const runDetail = useWorkbenchStore((state) => state.runDetail);
  const selectedStepId = useWorkbenchStore((state) => state.selectedEventId);
  const activeTab = useWorkbenchStore((state) => state.evidenceTab);
  const selectEvidenceStep = useWorkbenchStore((state) => state.selectEvidenceStep);
  const setActiveTab = useWorkbenchStore((state) => state.setEvidenceTab);
  const openEvidenceArtifact = useWorkbenchStore((state) => state.openEvidenceArtifact);
  const createTaskCheckpoint = useWorkbenchStore((state) => state.createTaskCheckpoint);
  const reviewTaskResume = useWorkbenchStore((state) => state.reviewTaskResume);
  const clearTaskResume = useWorkbenchStore((state) => state.clearTaskResume);
  const forkTaskCheckpoint = useWorkbenchStore((state) => state.forkTaskCheckpoint);
  const resumeContract = useWorkbenchStore((state) => state.resumeContract);
  const busyTaskHistoryAction = useWorkbenchStore((state) => state.busyTaskHistoryAction);
  const busyPatchAction = useWorkbenchStore((state) => state.busyPatchAction);
  const isAgentRunning = useWorkbenchStore((state) => state.isAgentRunning);
  const workspaceEntries = useWorkbenchStore((state) => state.workspaceEntries);
  const settings = useWorkbenchStore((state) => state.settings);
  const [forkPreviewOpen, setForkPreviewOpen] = useState(false);
  const [forkTitle, setForkTitle] = useState("");
  const resumeTriggerRef = useRef<HTMLButtonElement>(null);
  const resumeDialogRef = useRef<HTMLDivElement>(null);
  const dataMode = workbenchDataMode();
  const fixture = dataMode === "preview" && runDetail
    ? previewRunEvidenceFixture(runDetail.summary.runId)
    : undefined;
  const projection = useMemo(
    () => projectRunExecution(events, fixture?.execution),
    [events, fixture],
  );
  const selectedStep = projection.steps.find((step) => step.id === selectedStepId) ?? projection.steps[0];
  const selectedArtifacts = projection.artifacts.filter((artifact) => artifact.stepId === selectedStep?.id) as EvidenceArtifact[];
  const selectedHistoryRevision = [...(runDetail?.eventHistory ?? [])]
    .reverse()
    .find((revision) => revision.eventId === selectedStep?.eventId);
  const selectedHistoryHead = selectedHistoryRevision
    ? { sequence: selectedHistoryRevision.sequence, entrySha256: selectedHistoryRevision.entrySha256 }
    : undefined;
  const checkpointCandidates = [...(runDetail?.taskCheckpoints ?? [])]
    .filter((checkpoint) => selectedHistoryHead && checkpoint.historyHead.sequence <= selectedHistoryHead.sequence)
    .sort((left, right) => right.historyHead.sequence - left.historyHead.sequence || right.createdAt.localeCompare(left.createdAt));
  const taskCheckpoint = checkpointCandidates.find((checkpoint) => checkpoint.historyHead.sequence === selectedHistoryHead?.sequence
    && checkpoint.historyHead.entrySha256 === selectedHistoryHead.entrySha256) ?? checkpointCandidates[0];
  const checkpointMatchesSelection = Boolean(taskCheckpoint && selectedHistoryHead
    && taskCheckpoint.historyHead.sequence === selectedHistoryHead.sequence
    && taskCheckpoint.historyHead.entrySha256 === selectedHistoryHead.entrySha256);
  const selectionIsCurrentHead = Boolean(selectedHistoryHead && runDetail
    && selectedHistoryHead.sequence === runDetail.historyHead.sequence
    && selectedHistoryHead.entrySha256 === runDetail.historyHead.entrySha256);
  const lifecycleMoving = ["running", "applying-patch", "validating"].includes(runDetail?.summary.lifecycle.state ?? "");
  const canCreateCheckpoint = Boolean(runDetail && selectionIsCurrentHead && !checkpointMatchesSelection
    && !isAgentRunning && !busyPatchAction && !busyTaskHistoryAction && !lifecycleMoving);

  useEffect(() => {
    if (!selectedStepId && projection.steps[0]) selectEvidenceStep(projection.steps[0].id);
  }, [projection.steps, selectEvidenceStep, selectedStepId]);

  useEffect(() => {
    setForkPreviewOpen(false);
    setForkTitle("");
    clearTaskResume();
  }, [clearTaskResume, selectedStep?.id]);

  useEffect(() => {
    if (!forkPreviewOpen) return;
    window.requestAnimationFrame(() => resumeDialogRef.current?.querySelector<HTMLElement>("button.primary-button")?.focus());
  }, [forkPreviewOpen, resumeContract]);

  const closeResumeDialog = () => {
    setForkPreviewOpen(false);
    clearTaskResume();
    window.requestAnimationFrame(() => resumeTriggerRef.current?.focus());
  };

  const handleResumeDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeResumeDialog();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(resumeDialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])") ?? [])];
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const selectTabFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>, tab: EvidenceTab) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = EVIDENCE_TABS.findIndex((candidate) => candidate.id === tab);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? EVIDENCE_TABS.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + EVIDENCE_TABS.length) % EVIDENCE_TABS.length;
    const nextTab = EVIDENCE_TABS[next]!.id;
    setActiveTab(nextTab);
    document.getElementById(`run-evidence-tab-${nextTab}`)?.focus();
  };

  return (
    <section className="run-evidence" aria-label="Run execution evidence">
      <section className="workspace-trust-banner" role="note" aria-label="Current workspace files trust boundary">
        <span className="workspace-trust-icon" aria-hidden="true"><ShieldAlert size={16} /></span>
        <div>
          <strong>Current files · workspace trust boundary</strong>
          <p>Run locators describe recorded evidence. Current workspace bytes may have changed; trust them only when the recorded SHA-256 and byte size still bind.</p>
        </div>
        <span title={settings.workspacePath}><FolderOpen size={12} />{workspaceEntries.length} current files</span>
      </section>

      <div className="run-evidence-toolbar">
        <div className="run-evidence-tabs" role="tablist" aria-label="Run evidence views">
          {EVIDENCE_TABS.map(({ id, label, icon: Icon }) => (
            <button
              id={`run-evidence-tab-${id}`}
              className={activeTab === id ? "is-selected" : ""}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              aria-controls={`run-evidence-panel-${id}`}
              tabIndex={activeTab === id ? 0 : -1}
              onKeyDown={(event) => selectTabFromKeyboard(event, id)}
              onClick={() => setActiveTab(id)}
              key={id}
            >
              <Icon size={13} />{label}
            </button>
          ))}
        </div>
        <span className="run-evidence-selection"><Fingerprint size={12} />Selected step <strong>{selectedStep ? selectedStep.ordinal + 1 : "—"}</strong></span>
      </div>

      <StepSelector
        steps={projection.steps}
        selectedStepId={selectedStep?.id}
        onSelect={selectEvidenceStep}
      />

      <div className="run-evidence-content">
        {activeTab === "timeline" && (
          <TimelineView
            steps={projection.steps}
            selectedStepId={selectedStep?.id}
            onSelect={selectEvidenceStep}
          />
        )}
        {activeTab === "topology" && (
          <TopologyView
            steps={projection.steps}
            edges={projection.topologyEdges}
            quarantined={projection.quarantined}
            selectedStepId={selectedStep?.id}
            onSelect={selectEvidenceStep}
          />
        )}
        {activeTab === "artifacts" && (
          <ArtifactsView
            step={selectedStep}
            artifacts={selectedArtifacts}
            onOpen={(locator) => void openEvidenceArtifact(locator)}
          />
        )}

        <aside className="immutable-checkpoint-card" aria-label="Immutable task checkpoint">
          <header><span aria-hidden="true"><LockKeyhole size={14} /></span><div><strong>Task checkpoint</strong><small>Immutable task context · workspace unchanged</small></div></header>
          {taskCheckpoint ? (
            <dl>
              <div><dt>Boundary</dt><dd>{checkpointMatchesSelection ? `Selected history · ${taskCheckpoint.historyHead.sequence}` : `Latest available · ${taskCheckpoint.historyHead.sequence}`}</dd></div>
              <div><dt>Snapshot digest</dt><dd title={taskCheckpoint.snapshotDigest}>{shortHash(taskCheckpoint.snapshotDigest)}</dd></div>
              <div><dt>Task context</dt><dd>{taskCheckpoint.messages.length} messages · {taskCheckpoint.artifactRefs.length} artifact refs</dd></div>
              <div><dt>Mission recipe</dt><dd title={taskCheckpoint.missionRecipe?.digest}>{taskCheckpoint.missionRecipe ? `${capitalize(taskCheckpoint.missionRecipe.mode)} · ${shortHash(taskCheckpoint.missionRecipe.digest)}` : "Legacy checkpoint"}</dd></div>
              <div><dt>Created</dt><dd>{formatTime(taskCheckpoint.createdAt)}</dd></div>
            </dl>
          ) : (
            <p className="checkpoint-unavailable"><CircleAlert size={13} />No immutable task checkpoint is available at or before this selected history boundary.</p>
          )}
          {!selectionIsCurrentHead && !taskCheckpoint && <p className="checkpoint-boundary-note">Select the current history head to create a checkpoint. Historical boundaries are never synthesized.</p>}
          {selectionIsCurrentHead && !checkpointMatchesSelection && <button className="secondary-button compact-command checkpoint-command" type="button" disabled={!canCreateCheckpoint} onClick={() => runDetail && void createTaskCheckpoint(runDetail.summary.runId)}>
            {busyTaskHistoryAction === "checkpoint" ? <LoaderCircle className="spin" size={13} /> : <LockKeyhole size={13} />}{busyTaskHistoryAction === "checkpoint" ? "Creating checkpoint…" : "Create task checkpoint"}
          </button>}
          {taskCheckpoint && <button ref={resumeTriggerRef} id="safe-resume-trigger" className="secondary-button compact-command checkpoint-command" type="button" disabled={Boolean(busyTaskHistoryAction) || isAgentRunning} aria-expanded={forkPreviewOpen} onClick={() => {
            setForkPreviewOpen((open) => {
              if (open) clearTaskResume();
              return !open;
            });
          }}>
            <GitFork size={13} />Review safe resume
          </button>}
          {forkPreviewOpen && taskCheckpoint && (
            <div ref={resumeDialogRef} className="fork-preview-notice resume-contract" role="dialog" aria-modal="true" aria-labelledby="resume-contract-title" onKeyDown={handleResumeDialogKeyDown}>
              <header className="resume-contract-heading">
                <span className={`resume-state-icon is-${resumeContract?.state ?? "pending"}`} aria-hidden="true">
                  {busyTaskHistoryAction === "resume-review" ? <LoaderCircle className="spin" size={14} /> : resumeContract?.state === "blocked" ? <CircleAlert size={14} /> : resumeContract ? <Fingerprint size={14} /> : <LockKeyhole size={14} />}
                </span>
                <div><strong id="resume-contract-title">{resumeContract ? resumeContract.state === "ready" ? "Resume contract ready" : resumeContract.state === "blocked" ? "Resume blocked" : "Capability drift needs review" : "Review current resume boundary"}</strong><small>{taskCheckpoint.missionRecipe ? `Saved recipe · ${shortHash(taskCheckpoint.missionRecipe.digest)}` : "Legacy checkpoint · full review required"}</small></div>
                {resumeContract && <code title={resumeContract.digest}>{shortHash(resumeContract.digest)}</code>}
              </header>
              {!resumeContract && <div className="resume-intro"><p>The parent run and current workspace files remain unchanged.</p><span>Proto will compare the saved recipe with the current model, runtime, modules, tools, network, filesystem, and execution boundaries before a child task can be created.</span><div className="resume-intro-actions"><button className="quiet-button compact-command" type="button" disabled={Boolean(busyTaskHistoryAction)} onClick={closeResumeDialog}>Cancel</button><button className="primary-button compact-command" type="button" disabled={Boolean(busyTaskHistoryAction)} onClick={() => void reviewTaskResume(taskCheckpoint.id)}>{busyTaskHistoryAction === "resume-review" ? <LoaderCircle className="spin" size={13} /> : <Fingerprint size={13} />}{busyTaskHistoryAction === "resume-review" ? "Checking capabilities…" : "Review resume contract"}</button></div></div>}
              {resumeContract && <>
                <div className="resume-drift-summary"><strong>{resumeContract.drift.filter((item) => item.state === "stable").length}/{resumeContract.drift.length} boundaries unchanged</strong><span>{resumeContract.state === "review-required" ? "Changed capabilities do not inherit trust." : resumeContract.state === "blocked" ? "Resolve the blocked boundary before continuing." : "The saved recipe matches the current environment."}</span></div>
                <div className="resume-drift-list">
                  {resumeContract.drift.map((item) => <article className={`is-${item.state}`} key={item.id}>
                    <span aria-hidden="true">{item.state === "stable" ? <CheckCircle2 size={13} /> : item.state === "blocked" ? <CircleAlert size={13} /> : <ShieldAlert size={13} />}</span>
                    <div><strong>{item.title}</strong><small>{item.detail}</small><p><em>Saved</em>{item.before}<ArrowRight size={11} /><em>Now</em>{item.now}</p></div>
                    <b>{item.state === "stable" ? "Stable" : item.state === "blocked" ? "Blocked" : item.state === "unavailable" ? "Review" : "Changed"}</b>
                  </article>)}
                </div>
                {resumeContract.warnings.map((warning) => <p className="resume-warning" key={warning}><CircleAlert size={13} />{warning}</p>)}
                <p className="resume-next-action">{resumeContract.nextAction}</p>
                <label htmlFor="fork-task-title">Child task title <span>optional</span></label>
                <input id="fork-task-title" value={forkTitle} onChange={(event) => setForkTitle(event.target.value)} placeholder="Continue from reviewed recipe" />
                <p className="resume-effect-note"><LockKeyhole size={12} />Creating a child task does not start the model, restore files, or approve later effects.</p>
                <div className="fork-preview-actions"><button className="quiet-button compact-command" type="button" disabled={Boolean(busyTaskHistoryAction)} onClick={closeResumeDialog}>Cancel</button><button className="primary-button compact-command" type="button" disabled={Boolean(busyTaskHistoryAction) || !resumeContract.launchable} onClick={() => void forkTaskCheckpoint(taskCheckpoint.id, taskCheckpoint.snapshotDigest, resumeContract.digest, forkTitle)}>{busyTaskHistoryAction === "fork" ? <LoaderCircle className="spin" size={13} /> : <GitFork size={13} />}{busyTaskHistoryAction === "fork" ? "Creating child…" : dataMode === "preview" ? "Simulate reviewed child" : "Create reviewed child"}</button></div>
              </>}
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

function StepSelector({ steps, selectedStepId, onSelect }: {
  steps: RunStepView[];
  selectedStepId?: string;
  onSelect: (stepId: string) => void;
}) {
  return (
    <div className="evidence-step-selector" role="listbox" aria-label="Shared selected run step" aria-orientation="horizontal">
      {steps.map((step) => (
        <button
          className={selectedStepId === step.id ? "is-selected" : ""}
          type="button"
          role="option"
          aria-selected={selectedStepId === step.id}
          aria-current={selectedStepId === step.id ? "step" : undefined}
          onClick={() => onSelect(step.id)}
          key={step.id}
        >
          <span>{step.ordinal + 1}</span><strong>{step.title}</strong><small>{capitalize(step.stage)}</small>
        </button>
      ))}
    </div>
  );
}

function TimelineView({ steps, selectedStepId, onSelect }: {
  steps: RunStepView[];
  selectedStepId?: string;
  onSelect: (stepId: string) => void;
}) {
  return (
    <section id="run-evidence-panel-timeline" className="evidence-panel timeline-evidence-panel" role="tabpanel" aria-labelledby="run-evidence-tab-timeline">
      <header className="evidence-table-header" aria-hidden="true"><span>Time</span><span>Actor</span><span>Step</span><span>Stage</span><span>Status</span></header>
      <div className="evidence-timeline-list" role="listbox" aria-label="Chronological run steps">
        {steps.map((step) => (
          <button
            className={selectedStepId === step.id ? "is-selected" : ""}
            type="button"
            role="option"
            aria-selected={selectedStepId === step.id}
            aria-current={selectedStepId === step.id ? "step" : undefined}
            onClick={() => onSelect(step.id)}
            key={step.id}
          >
            <time>{formatTime(step.createdAt)}</time>
            <span>{capitalize(step.actor)}</span>
            <span><strong>{step.title}</strong><small>{step.summary}</small></span>
            <span>{capitalize(step.stage)}</span>
            <span className={`evidence-state is-${step.status}`}>{step.status === "completed" ? <CheckCircle2 size={12} /> : <CircleAlert size={12} />}{step.status.replaceAll("-", " ")}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function TopologyView({ steps, edges, quarantined, selectedStepId, onSelect }: {
  steps: RunStepView[];
  edges: ReturnType<typeof projectRunExecution>["topologyEdges"];
  quarantined: ReturnType<typeof projectRunExecution>["quarantined"];
  selectedStepId?: string;
  onSelect: (stepId: string) => void;
}) {
  const stepsById = new Map(steps.map((step) => [step.id, step]));
  return (
    <section id="run-evidence-panel-topology" className="evidence-panel topology-evidence-panel" role="tabpanel" aria-labelledby="run-evidence-tab-topology">
      <div className="topology-boundary"><Link2 size={13} /><span>Only persisted explicit lineage is shown. Matching locators never create an edge.</span></div>
      {quarantined.length > 0 && <div className="topology-quarantine" role="alert"><CircleAlert size={13} /><span>{quarantined.length} malformed projection record{quarantined.length === 1 ? " was" : "s were"} quarantined and cannot drive selection or lineage.</span></div>}
      <div className="topology-lanes" aria-label="Execution topology lanes">
        {STAGE_LANES.map((stage) => {
          const laneSteps = steps.filter((step) => step.stage === stage);
          return (
            <section className="topology-lane" aria-label={`${capitalize(stage)} lane`} key={stage}>
              <h3>{capitalize(stage)}</h3>
              <ol role="listbox" aria-label={`${capitalize(stage)} steps`}>
                {laneSteps.map((step) => <li key={step.id}><button className={selectedStepId === step.id ? "is-selected" : ""} type="button" role="option" aria-selected={selectedStepId === step.id} aria-current={selectedStepId === step.id ? "step" : undefined} onClick={() => onSelect(step.id)}><span>{step.ordinal + 1}</span><strong>{step.title}</strong><small>{step.status.replaceAll("-", " ")}</small></button></li>)}
                {!laneSteps.length && <li className="topology-empty">Not reached</li>}
              </ol>
            </section>
          );
        })}
      </div>
      <div className="explicit-edge-list" aria-label="Persisted explicit topology edges">
        <strong>Explicit edges</strong>
        {edges.map((edge) => (
          <button type="button" onClick={() => onSelect(edge.targetStepId)} key={edge.id}>
            <span>{stepsById.get(edge.sourceStepId)?.title ?? `${edge.sourceRunId ?? "parent"} / ${shortHash(edge.sourceStepId)}`}</span>
            <ArrowRight size={13} />
            <span>{stepsById.get(edge.targetStepId)?.title ?? shortHash(edge.targetStepId)}</span>
            <em>{edge.kind === "fork" ? "task fork" : shortPath(edge.locator ?? "bound artifact")}</em>
          </button>
        ))}
        {!edges.length && <p>No persisted edge metadata is available for this run. The lane order is chronological only.</p>}
      </div>
    </section>
  );
}

function ArtifactsView({ step, artifacts, onOpen }: {
  step?: RunStepView;
  artifacts: EvidenceArtifact[];
  onOpen: (locator: string) => void;
}) {
  return (
    <section id="run-evidence-panel-artifacts" className="evidence-panel artifacts-evidence-panel" role="tabpanel" aria-labelledby="run-evidence-tab-artifacts">
      <header><div><FileKey2 size={15} /><span><strong>{step?.title ?? "No step selected"}</strong><small>{artifacts.length} recorded artifact reference{artifacts.length === 1 ? "" : "s"}</small></span></div><span>Artifacts open only on explicit request.</span></header>
      <div className="artifact-evidence-list">
        {artifacts.map((artifact) => {
          const hasDigest = Boolean(artifact.sha256 && artifact.sizeBytes !== undefined);
          return (
            <article className={`artifact-evidence-card is-${artifact.binding}`} key={artifact.id}>
              <span className="artifact-role">{capitalize(artifact.role)}</span>
              <div className="artifact-locator"><FileCode2 size={13} /><strong title={artifact.locator}>{artifact.locator}</strong></div>
              <dl>
                <div><dt>Binding</dt><dd>{bindingLabel(artifact.binding)}</dd></div>
                <div><dt>Digest state</dt><dd className={hasDigest ? "is-verified" : "is-unbound"}>{hasDigest ? "SHA-256 + size recorded" : "No byte binding"}</dd></div>
              </dl>
              {artifact.sha256 && <code title={artifact.sha256}>{shortHash(artifact.sha256)} · {artifact.sizeBytes?.toLocaleString() ?? "?"} bytes</code>}
              {isInspectableLocator(artifact.locator) && <button className="secondary-button compact-command" type="button" onClick={() => onOpen(artifact.locator)}><FileCode2 size={12} />Inspect artifact</button>}
            </article>
          );
        })}
        {!artifacts.length && <div className="artifact-evidence-empty"><Boxes size={18} /><strong>No artifacts recorded for this step</strong><span>Select another step; no artifact is opened automatically.</span></div>}
      </div>
    </section>
  );
}

function bindingLabel(binding: RunArtifactRef["binding"]): string {
  const state = String(binding);
  if (state === "digest-bound") return "Digest-bound · SHA-256 + size";
  if (state === "declared") return "Explicit lineage · no byte binding";
  if (state === "unbound") return "Unbound legacy reference";
  return "Recorded lineage";
}

function isInspectableLocator(locator: string): boolean {
  return /\.(?:json|ya?ml|proto|md|txt)$/i.test(locator.trim());
}

function shortPath(path: string): string {
  return path.replaceAll("\\", "/").split("/").slice(-2).join("/");
}

function shortHash(value?: string): string {
  if (!value) return "unavailable";
  return value.length > 15 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function capitalize(value: string): string {
  return value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}
