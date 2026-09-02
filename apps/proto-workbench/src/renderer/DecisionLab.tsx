import {
  ArrowRight,
  Check,
  CircleAlert,
  Code2,
  Download,
  Eye,
  FileCheck2,
  FileJson,
  FilePenLine,
  FlaskConical,
  FolderOpen,
  GitCompareArrows,
  LoaderCircle,
  LockKeyhole,
  Network,
  PackageCheck,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type {
  DecisionBundleExportReceipt,
  DecisionBundlePreview,
  DecisionBundleRedaction,
  MissionRequirementId,
  MissionRequirementState,
  PolicySimulationReport,
  PolicySimulationScenario,
  PolicySimulationScenarioId,
} from "../shared/contracts.ts";
import { workbenchApi } from "./mock-api.ts";
import { useWorkbenchStore } from "./store.ts";

const DEFAULT_GOAL = "Search PubMed for supporting evidence, run the local Python analysis, and prepare a reviewed workspace patch without applying it.";

const SCENARIOS: Array<{ id: Exclude<PolicySimulationScenarioId, "current">; label: string; detail: string }> = [
  { id: "plan-posture", label: "Plan posture", detail: "Defer writes and execution" },
  { id: "act-posture", label: "Act posture", detail: "Expose dedicated gates" },
  { id: "network-unavailable", label: "Network unavailable", detail: "Remove live lookup tools" },
  { id: "execution-unavailable", label: "Execution unavailable", detail: "Remove every provider" },
  { id: "isolated-execution-ready", label: "Pinned sandbox available", detail: "Hypothetical OCI boundary" },
  { id: "workspace-drift", label: "Workspace trust drift", detail: "Binding and atomicity change" },
  { id: "model-chat-only", label: "Chat-only model", detail: "Structured tools unavailable" },
  { id: "strict-lockdown", label: "Strict lockdown", detail: "Read-only inspection only" },
];

const DEFAULT_SCENARIOS = SCENARIOS.map((scenario) => scenario.id);

const EFFECT_REQUIREMENTS: Array<{ id: MissionRequirementId; label: string; icon: typeof Network }> = [
  { id: "network", label: "Network", icon: Network },
  { id: "writes", label: "Workspace", icon: FilePenLine },
  { id: "execution", label: "Execution", icon: Code2 },
];

export function DecisionLab({ onClose }: { onClose: () => void }) {
  const thread = useWorkbenchStore((state) => state.thread);
  const prompt = useWorkbenchStore((state) => state.prompt);
  const attachments = useWorkbenchStore((state) => state.attachments);
  const [goal, setGoal] = useState(() => prompt.trim() || DEFAULT_GOAL);
  const [scenarioIds, setScenarioIds] = useState<PolicySimulationScenarioId[]>(DEFAULT_SCENARIOS);
  const [report, setReport] = useState<PolicySimulationReport>();
  const [activeScenarioId, setActiveScenarioId] = useState<PolicySimulationScenarioId>("current");
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string>();
  const [bundleOpen, setBundleOpen] = useState(false);
  const [bundleRedaction, setBundleRedaction] = useState<DecisionBundleRedaction>("metadata-only");
  const [bundle, setBundle] = useState<DecisionBundlePreview>();
  const [bundleReceipt, setBundleReceipt] = useState<DecisionBundleExportReceipt>();
  const [bundleLoading, setBundleLoading] = useState(false);
  const [bundleExporting, setBundleExporting] = useState(false);
  const [bundleError, setBundleError] = useState<string>();
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const requestGeneration = useRef(0);
  const bundleGeneration = useRef(0);

  const invalidateBundle = () => {
    bundleGeneration.current += 1;
    setBundle(undefined);
    setBundleReceipt(undefined);
    setBundleError(undefined);
    setBundleLoading(false);
    setBundleExporting(false);
  };

  const compare = async () => {
    if (!thread || !goal.trim() || loading) return;
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await workbenchApi().harness.simulatePolicy({
        threadId: thread.id,
        content: goal.trim(),
        attachments,
        scenarioIds,
      });
      if (generation !== requestGeneration.current) return;
      setReport(next);
      setDirty(false);
      setBundleOpen(false);
      invalidateBundle();
      setActiveScenarioId((current) => next.scenarios.some((scenario) => scenario.id === current) ? current : "current");
    } catch (simulationError) {
      if (generation !== requestGeneration.current) return;
      setError(friendlyError(simulationError));
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  };

  useEffect(() => {
    inputRef.current?.focus();
    void compare();
  // Initial comparison intentionally captures the opening draft and trusted environment once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeScenario = useMemo(
    () => report?.scenarios.find((scenario) => scenario.id === activeScenarioId) ?? report?.scenarios[0],
    [activeScenarioId, report],
  );

  const toggleScenario = (id: PolicySimulationScenarioId) => {
    setScenarioIds((current) => current.includes(id) ? current.filter((scenarioId) => scenarioId !== id) : [...current, id]);
    setDirty(true);
    invalidateBundle();
  };

  const previewBundle = async (redaction = bundleRedaction) => {
    if (!thread || !report || !activeScenario || dirty) return;
    const generation = ++bundleGeneration.current;
    setBundleLoading(true);
    setBundleError(undefined);
    setBundleReceipt(undefined);
    try {
      const next = await workbenchApi().harness.previewDecisionBundle({
        threadId: thread.id,
        content: goal.trim(),
        attachments,
        scenarioIds,
        selectedScenarioId: activeScenario.id,
        redaction,
        expectedSimulationDigest: report.digest,
      });
      if (generation !== bundleGeneration.current) return;
      setBundle(next);
    } catch (bundlePreviewError) {
      if (generation !== bundleGeneration.current) return;
      setBundleError(friendlyError(bundlePreviewError));
    } finally {
      if (generation === bundleGeneration.current) setBundleLoading(false);
    }
  };

  const openBundle = () => {
    setBundleOpen(true);
    setBundleReceipt(undefined);
    void previewBundle();
  };

  const changeBundleRedaction = (redaction: DecisionBundleRedaction) => {
    setBundleRedaction(redaction);
    setBundle(undefined);
    setBundleReceipt(undefined);
    void previewBundle(redaction);
  };

  const exportBundle = async () => {
    if (!thread || !report || !bundle || dirty || bundleExporting) return;
    setBundleExporting(true);
    setBundleError(undefined);
    try {
      const receipt = await workbenchApi().harness.exportDecisionBundle({
        threadId: thread.id,
        content: goal.trim(),
        attachments,
        scenarioIds,
        selectedScenarioId: bundle.attestation.predicate.selectedScenario.id,
        redaction: bundle.redaction.profile,
        expectedSimulationDigest: report.digest,
        expectedBundleDigest: bundle.bundleDigest,
      });
      setBundleReceipt(receipt);
    } catch (bundleExportError) {
      setBundleError(friendlyError(bundleExportError));
    } finally {
      setBundleExporting(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), textarea:not([disabled]), input:not([disabled])") ?? [])];
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

  return (
    <div className="decision-lab-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="decision-lab-dialog" role="dialog" aria-modal="true" aria-labelledby="decision-lab-title" onKeyDown={handleKeyDown}>
        <header className="decision-lab-heading">
          <span className="decision-lab-mark" aria-hidden="true"><FlaskConical size={17} /></span>
          <div><span className="eyebrow">Policy simulation</span><h2 id="decision-lab-title">Decision Lab</h2><p>Compare trusted mission postures before any model, tool, approval, or effect can start.</p></div>
          <div className="decision-lab-heading-meta">
            <code title={report?.digest}>{report ? shortHash(report.digest) : "Not evaluated"}</code>
            <button className="icon-button" type="button" onClick={onClose} aria-label="Close Decision Lab"><X size={15} /></button>
          </div>
        </header>

        <div className="decision-lab-mission">
          <label htmlFor="decision-lab-goal"><span>Mission assumption</span><small>Nothing here changes the current draft or environment.</small></label>
          <textarea
            id="decision-lab-goal"
            ref={inputRef}
            value={goal}
            maxLength={8_192}
            onChange={(event) => { setGoal(event.target.value); setDirty(true); invalidateBundle(); }}
            aria-label="Mission assumption"
          />
          <button className="primary-button decision-lab-compare" type="button" disabled={!thread || !goal.trim() || loading || (!dirty && Boolean(report))} onClick={() => void compare()}>
            {loading ? <LoaderCircle className="spin" size={14} /> : <GitCompareArrows size={14} />}
            {loading ? "Recomputing…" : report && !dirty ? "Comparison current" : `Compare ${scenarioIds.length + 1} postures`}
          </button>
        </div>

        <div className="decision-lab-body">
          <aside className="decision-lab-scenario-library" aria-label="Policy scenarios">
            <header><div><strong>Scenario set</strong><span>Current controls are always the baseline.</span></div><b>{scenarioIds.length + 1}/9</b></header>
            <label className="decision-scenario-option is-baseline">
              <input type="checkbox" checked disabled /><span><strong>Current controls</strong><small>Authoritative baseline</small></span><Check size={13} />
            </label>
            {SCENARIOS.map((scenario) => (
              <label className={`decision-scenario-option ${scenarioIds.includes(scenario.id) ? "is-selected" : ""}`} key={scenario.id}>
                <input type="checkbox" checked={scenarioIds.includes(scenario.id)} onChange={() => toggleScenario(scenario.id)} />
                <span><strong>{scenario.label}</strong><small>{scenario.detail}</small></span>
              </label>
            ))}
            <div className="decision-lab-source-note"><LockKeyhole size={13} /><span>Enumerated scenarios only. Arbitrary policy or capability payloads are rejected.</span></div>
          </aside>

          <main className="decision-lab-results">
            {loading && !report && <div className="decision-lab-loading"><LoaderCircle className="spin" size={20} /><strong>Evaluating trusted controls</strong><span>The main process is reading current capability metadata only.</span></div>}
            {!loading && error && <div className="decision-lab-error" role="alert"><CircleAlert size={18} /><div><strong>Comparison could not be issued</strong><span>{error}</span></div><button type="button" onClick={() => void compare()}><RefreshCw size={13} />Retry</button></div>}
            {report && <>
              <div className="decision-lab-result-head">
                <div><span>Decision ID</span><code>{report.decisionId}</code></div>
                <div><span>Goal digest</span><code>{shortHash(report.goalSha256)}</code></div>
                <div><span>Effects executed</span><strong>0</strong></div>
                <div className="decision-lab-result-actions">
                  <button className="decision-bundle-trigger" type="button" disabled={dirty || !activeScenario} onClick={openBundle}><PackageCheck size={13} />Bundle</button>
                  {dirty && <em>Draft changed · recompute</em>}
                </div>
              </div>

              <div className="decision-lab-tabs" role="tablist" aria-label="Evaluated policy scenarios">
                {report.scenarios.map((scenario) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={scenario.id === activeScenario?.id}
                    className={scenario.id === activeScenario?.id ? "is-active" : ""}
                    key={scenario.id}
                    onClick={() => { setActiveScenarioId(scenario.id); invalidateBundle(); }}
                  >
                    <ScenarioStateIcon state={scenario.state} />{scenario.label}<small>{changedCount(scenario)} changes</small>
                  </button>
                ))}
              </div>

              {activeScenario && <ScenarioDetail scenario={activeScenario} />}
              {bundleOpen && <DecisionBundlePanel
                report={report}
                bundle={bundle}
                receipt={bundleReceipt}
                redaction={bundleRedaction}
                loading={bundleLoading}
                exporting={bundleExporting}
                dirty={dirty}
                error={bundleError}
                onClose={() => setBundleOpen(false)}
                onRedactionChange={changeBundleRedaction}
                onRetry={() => void previewBundle()}
                onExport={() => void exportBundle()}
              />}
            </>}
          </main>
        </div>

        <footer className="decision-lab-footer">
          <ShieldCheck size={13} /><span>{report?.boundary ?? "Simulation only · no launch contract is created."}</span>
          <span><kbd>Tab</kbd> move <kbd>Esc</kbd> close</span>
        </footer>
      </section>
    </div>
  );
}

function DecisionBundlePanel({
  report,
  bundle,
  receipt,
  redaction,
  loading,
  exporting,
  dirty,
  error,
  onClose,
  onRedactionChange,
  onRetry,
  onExport,
}: {
  report: PolicySimulationReport;
  bundle?: DecisionBundlePreview;
  receipt?: DecisionBundleExportReceipt;
  redaction: DecisionBundleRedaction;
  loading: boolean;
  exporting: boolean;
  dirty: boolean;
  error?: string;
  onClose: () => void;
  onRedactionChange: (redaction: DecisionBundleRedaction) => void;
  onRetry: () => void;
  onExport: () => void;
}) {
  return (
    <aside className="decision-bundle-panel" aria-label="Decision Bundle preview">
      <header className="decision-bundle-heading">
        <span aria-hidden="true"><PackageCheck size={16} /></span>
        <div><small>Audit artifact</small><strong>Decision Bundle</strong><p>Preview the exact redaction and content binding before one explicit workspace export.</p></div>
        <b><ShieldAlert size={11} />Unsigned</b>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close Decision Bundle preview"><X size={14} /></button>
      </header>

      <div className="decision-bundle-content">
        <section className="decision-bundle-redaction" aria-label="Decision Bundle redaction profile">
          <div><strong>Redaction profile</strong><span>Paths, attachment names, model paths, and runtime paths are always removed.</span></div>
          <div role="group" aria-label="Redaction profile options">
            <button type="button" aria-pressed={redaction === "metadata-only"} disabled={dirty || loading || exporting} onClick={() => onRedactionChange("metadata-only")}><ShieldCheck size={13} /><span><strong>Metadata only</strong><small>Hide goal and policy detail</small></span></button>
            <button type="button" aria-pressed={redaction === "include-goal-preview"} disabled={dirty || loading || exporting} onClick={() => onRedactionChange("include-goal-preview")}><Eye size={13} /><span><strong>Include goal preview</strong><small>Keep bounded policy detail</small></span></button>
          </div>
        </section>

        {dirty && <div className="decision-bundle-blocked"><RefreshCw size={16} /><div><strong>Simulation changed</strong><span>Recompute the scenario matrix before preparing another bundle.</span></div></div>}
        {!dirty && loading && <div className="decision-bundle-loading"><LoaderCircle className="spin" size={19} /><strong>Preparing the redacted statement</strong><span>No file is created during preview.</span></div>}
        {!dirty && !loading && error && <div className="decision-bundle-error" role="alert"><CircleAlert size={16} /><div><strong>Bundle could not be prepared</strong><span>{error}</span></div><button type="button" onClick={onRetry}><RefreshCw size={12} />Retry</button></div>}

        {!dirty && bundle && <>
          <section className="decision-bundle-identity">
            <div><span>Bundle ID</span><code>{bundle.bundleId}</code></div>
            <div><span>Content digest</span><code title={bundle.bundleDigest}>{shortHash(bundle.bundleDigest)}</code></div>
            <div><span>Source simulation</span><code title={report.digest}>{shortHash(report.digest)}</code></div>
          </section>

          <section className="decision-bundle-assurance">
            <article><span><FileJson size={14} /></span><div><small>Statement</small><strong>in-toto v1 shape</strong><p>One digest-bound simulation subject and a typed Proto predicate.</p></div></article>
            <article><span><ShieldCheck size={14} /></span><div><small>Redaction</small><strong>{bundle.redaction.profile === "metadata-only" ? "Metadata only" : "Goal preview included"}</strong><p>{bundle.redaction.removed.length} JSON pointer classes removed.</p></div></article>
            <article className="is-unsigned"><span><ShieldAlert size={14} /></span><div><small>Authentication</small><strong>Unsigned</strong><p>Content binding only; publisher identity is not established.</p></div></article>
          </section>

          <section className="decision-bundle-scenario">
            <header><div><small>Selected decision</small><strong>{bundle.attestation.predicate.selectedScenario.label}</strong></div><b className={`is-${bundle.attestation.predicate.selectedScenario.state}`}>{scenarioLabel(bundle.attestation.predicate.selectedScenario.state)}</b></header>
            <div>
              <span><small>Scenarios bound</small><strong>{bundle.attestation.predicate.simulation.scenarioCount}</strong></span>
              <span><small>Goal preview</small><strong>{bundle.attestation.predicate.goal.preview ? "Included" : "Redacted"}</strong></span>
              <span><small>Attachments</small><strong>{bundle.attestation.predicate.context.attachmentCount} metadata-redacted</strong></span>
              <span><small>Effects executed</small><strong>0</strong></span>
            </div>
          </section>

          <div className="decision-bundle-boundary"><LockKeyhole size={13} /><span>{bundle.boundary}</span></div>

          {receipt && <section className="decision-bundle-receipt" role="status">
            <span><PackageCheck size={18} /></span>
            <div><small>{receipt.reused ? "Exact bundle reused" : "Audit artifact exported"}</small><strong>{receipt.relativePath}</strong><code title={receipt.bundleSha256}>{shortHash(receipt.bundleSha256)} · {formatBytes(receipt.bytes)}</code></div>
            <div className="decision-bundle-receipt-actions">
              <button type="button" onClick={() => void workbenchApi().files.reveal(receipt.relativePath)}><FolderOpen size={13} />Reveal</button>
              <button type="button" onClick={() => window.dispatchEvent(new Event("proto:verification"))}><FileCheck2 size={13} />Verify exports</button>
            </div>
          </section>}
        </>}
      </div>

      <footer className="decision-bundle-footer">
        <span><LockKeyhole size={12} />Preview is effect-free. Export writes only the immutable audit folder under <code>build/decision-bundles</code>.</span>
        <button className="primary-button" type="button" disabled={!bundle || dirty || loading || exporting} onClick={onExport}>
          {exporting ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />}
          {exporting ? "Rechecking & exporting…" : receipt ? "Export exact bundle again" : "Export audit artifact"}
        </button>
      </footer>
    </aside>
  );
}

function ScenarioStateIcon({ state }: { state: PolicySimulationScenario["state"] }) {
  const Icon = state === "ready" ? Check : state === "approval-required" ? CircleAlert : LockKeyhole;
  return <span className={`decision-tab-icon is-${state}`} aria-hidden="true"><Icon size={11} /></span>;
}

function ScenarioDetail({ scenario }: { scenario: PolicySimulationScenario }) {
  const changed = scenario.deltas.filter((delta) => delta.direction !== "unchanged");
  return (
    <div className="decision-scenario-detail" role="tabpanel">
      <section className={`decision-scenario-summary is-${scenario.state}`}>
        <div><span>{scenario.hypothetical ? "Hypothetical posture" : "Trusted baseline"}</span><strong>{scenario.label}</strong><p>{scenario.summary}</p></div>
        <div className="decision-scenario-outcome"><b>{scenarioLabel(scenario.state)}</b><span>{scenario.wouldBeLaunchable ? "Would pass preflight" : "Would stop before launch"}</span><code>{shortHash(scenario.decisionDigest)}</code></div>
      </section>

      <section className="decision-effect-grid" aria-label="Effect policy outcomes">
        {EFFECT_REQUIREMENTS.map(({ id, label, icon: Icon }) => {
          const requirement = scenario.requirements.find((item) => item.id === id)!;
          return <article className={`is-${requirement.state}`} key={id}><span><Icon size={14} /></span><div><small>{label}</small><strong>{requirementStateLabel(requirement.state)}</strong><p>{requirement.detail}</p></div></article>;
        })}
      </section>

      <section className="decision-delta-table">
        <header><div><strong>Why this decision changed</strong><span>{changed.length ? `${changed.length} requirement${changed.length === 1 ? "" : "s"} differ from current controls.` : "No requirement changed from the current baseline."}</span></div><b>{scenario.determiningRequirements.length} determining</b></header>
        <div className="decision-delta-columns"><span>Control</span><span>Current</span><span>Scenario</span><span>Impact</span></div>
        <div className="decision-delta-rows">
          {(changed.length ? changed : scenario.deltas.slice(0, 4)).map((delta) => (
            <article key={delta.requirementId}>
              <div><strong>{delta.title}</strong><small>{delta.detail}</small></div>
              <span className={`requirement-state is-${delta.baselineState}`}>{requirementStateLabel(delta.baselineState)}</span>
              <ArrowRight size={13} />
              <span className={`requirement-state is-${delta.scenarioState}`}>{requirementStateLabel(delta.scenarioState)}</span>
              <em className={`is-${delta.direction}`}>{directionLabel(delta.direction)}</em>
            </article>
          ))}
        </div>
      </section>

      {scenario.warnings.length > 0 && <div className="decision-warning"><CircleAlert size={13} /><span>{scenario.warnings.join(" ")}</span></div>}
    </div>
  );
}

function changedCount(scenario: PolicySimulationScenario): number {
  return scenario.deltas.filter((delta) => delta.direction !== "unchanged").length;
}

function scenarioLabel(state: PolicySimulationScenario["state"]): string {
  return state === "ready" ? "Ready" : state === "approval-required" ? "Gated" : "Blocked";
}

function requirementStateLabel(state: MissionRequirementState): string {
  return { ready: "Ready", "approval-required": "Approval", blocked: "Blocked", deferred: "Deferred" }[state];
}

function directionLabel(direction: PolicySimulationScenario["deltas"][number]["direction"]): string {
  return { unchanged: "Same", "more-restrictive": "Tighter", "less-restrictive": "Looser", "posture-shift": "Changed" }[direction];
}

function shortHash(value: string): string {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`;
}

function friendlyError(error: unknown): string {
  return String(error).replace(/^Error:\s+Error invoking remote method '[^']+':\s*/i, "").replace(/^Error:\s*/i, "").trim();
}
