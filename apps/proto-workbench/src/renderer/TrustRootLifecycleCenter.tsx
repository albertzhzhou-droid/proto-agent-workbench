import {
  ArrowLeft,
  BadgeCheck,
  CircleAlert,
  Clock3,
  FileArchive,
  FileCheck2,
  FolderInput,
  FolderOpen,
  GitCompareArrows,
  KeyRound,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type {
  TrustRootLifecycleCatalog,
  TrustRootLifecycleCheck,
  TrustRootLifecycleEntry,
  TrustRootLifecycleRoleSnapshot,
  TrustRootLifecycleState,
} from "../shared/contracts.ts";
import { workbenchApi, workbenchDataMode } from "./mock-api.ts";

type LifecycleFilter = "all" | "reviewable" | "attention";

export function TrustRootLifecycleCenter({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const [catalog, setCatalog] = useState<TrustRootLifecycleCatalog>();
  const [selectedDirectory, setSelectedDirectory] = useState<string>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LifecycleFilter>("all");
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const generationRef = useRef(0);

  const refresh = async (preferredCandidateId?: string) => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await workbenchApi().harness.listTrustRootCandidates();
      if (generation !== generationRef.current) return;
      setCatalog(next);
      setSelectedDirectory((current) => {
        const preferred = preferredCandidateId ?? current;
        return next.entries.some((entry) => entry.directoryName === preferred) ? preferred : next.entries[0]?.directoryName;
      });
    } catch (catalogError) {
      if (generation !== generationRef.current) return;
      setError(friendlyError(catalogError));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    searchRef.current?.focus();
    void refresh();
  // Opening the lifecycle center performs one bounded, read-only local scan.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleEntries = useMemo(() => {
    const normalized = query.normalize("NFKC").trim().toLocaleLowerCase();
    return (catalog?.entries ?? []).filter((entry) => {
      if (filter === "reviewable" && entry.state !== "reviewable") return false;
      if (filter === "attention" && !["rejected", "invalid"].includes(entry.state)) return false;
      if (!normalized) return true;
      const corpus = [
        entry.directoryName, entry.candidateId, entry.state, entry.mode, entry.source, entry.sourceCommit,
        entry.root?.currentVersion, entry.root?.candidateVersion,
        ...entry.diagnostics, ...entry.checks.flatMap((check) => [check.id, check.label, check.detail]),
      ].filter((value) => value !== undefined).join(" ").toLocaleLowerCase();
      return normalized.split(/\s+/u).every((token) => corpus.includes(token));
    });
  }, [catalog, filter, query]);

  const selected = visibleEntries.find((entry) => entry.directoryName === selectedDirectory) ?? visibleEntries[0];

  const importPack = async () => {
    setImporting(true);
    setActionError(undefined);
    try {
      const receipt = await workbenchApi().harness.importTrustRootCandidate();
      if (receipt) await refresh(receipt.candidateId);
    } catch (importError) {
      setActionError(friendlyError(importError));
    } finally {
      setImporting(false);
    }
  };

  const reveal = async () => {
    if (!selected?.relativePath) return;
    setActionError(undefined);
    try {
      await workbenchApi().files.reveal(selected.relativePath);
    } catch (revealError) {
      setActionError(friendlyError(revealError));
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])") ?? [])];
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const attention = (catalog?.summary.rejected ?? 0) + (catalog?.summary.invalid ?? 0);
  return <div className="verification-center-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} className="verification-center-dialog signature-evidence-dialog trust-root-lifecycle-dialog" role="dialog" aria-modal="true" aria-labelledby="trust-root-lifecycle-title" onKeyDown={handleKeyDown}>
      <header className="verification-center-heading trust-root-lifecycle-heading">
        <span className="verification-center-mark" aria-hidden="true"><KeyRound size={17} /></span>
        <div><span className="eyebrow">Offline trust root lifecycle</span><h2 id="trust-root-lifecycle-title">Trust Root Lifecycle Center</h2><p>Review sequential TUF root rotation, role freshness, rollback protection, and exact Sigstore trust material before any release change.</p></div>
        <div className="verification-center-heading-meta">
          {workbenchDataMode() === "preview" && <b>Fixture catalog</b>}
          <code title={catalog?.digest}>{catalog ? shortHash(catalog.digest) : "Not scanned"}</code>
          <button className="secondary-button trust-policy-back" type="button" onClick={onBack}><ArrowLeft size={13} />Signatures</button>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close Trust Root Lifecycle Center"><X size={15} /></button>
        </div>
      </header>

      <div className="verification-center-toolbar signature-evidence-toolbar trust-root-lifecycle-toolbar">
        <label className="verification-center-search">
          <Search size={14} />
          <input ref={searchRef} value={query} maxLength={160} onChange={(event) => setQuery(event.target.value)} aria-label="Search Trust Root candidates" placeholder="Search candidate, version, source commit, or diagnostic…" />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear candidate search"><X size={13} /></button>}
        </label>
        <div className="verification-center-filters" role="group" aria-label="Trust Root lifecycle filters">
          <FilterButton active={filter === "all"} onClick={() => setFilter("all")} label="All" count={catalog?.returnedCount ?? 0} />
          <FilterButton active={filter === "reviewable"} onClick={() => setFilter("reviewable")} label="Reviewable" count={catalog?.summary.reviewable ?? 0} />
          <FilterButton active={filter === "attention"} onClick={() => setFilter("attention")} label="Attention" count={attention} />
        </div>
        <button className="secondary-button signature-evidence-import" type="button" disabled={importing || loading} onClick={() => void importPack()}>
          {importing ? <LoaderCircle className="spin" size={13} /> : <FolderInput size={13} />}{importing ? "Importing…" : "Import candidate"}
        </button>
        <button className="secondary-button verification-center-refresh" type="button" disabled={loading || importing} onClick={() => void refresh()}>
          {loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{loading ? "Checking…" : "Refresh"}
        </button>
      </div>

      <section className="verification-center-summary signature-evidence-summary trust-root-lifecycle-summary" aria-label="Trust Root lifecycle summary">
        <SummaryStat icon={GitCompareArrows} label="Reviewable" value={catalog?.summary.reviewable ?? 0} tone="reviewable" />
        <SummaryStat icon={BadgeCheck} label="Current" value={catalog?.summary.current ?? 0} tone="current" />
        <SummaryStat icon={ShieldAlert} label="Rejected" value={catalog?.summary.rejected ?? 0} tone="rejected" />
        <SummaryStat icon={XCircle} label="Invalid" value={catalog?.summary.invalid ?? 0} tone="invalid" />
        <div className="verification-center-snapshot"><span>Pinned TUF anchor</span><strong>{catalog ? `root v${catalog.anchor.rootVersion} · ${catalog.anchor.rootThreshold}-of-${rootKeyCount(catalog.anchor.rootThreshold)}` : "—"}</strong><small>{catalog ? `${shortHash(catalog.anchor.rootSha256)} · offline review only` : "Loading checkpoint"}</small></div>
      </section>

      <div className="verification-center-body signature-evidence-body trust-root-lifecycle-body">
        <aside className="verification-center-list" aria-label="Trust Root candidate results">
          <header><div><strong>Candidate packs</strong><span>Content-addressed · immutable imports</span></div><b>{visibleEntries.length}</b></header>
          {loading && !catalog && <div className="verification-center-loading"><LoaderCircle className="spin" size={19} /><strong>Checking signed metadata</strong><span>No network request or trust replacement is permitted.</span></div>}
          {!loading && error && <div className="verification-center-error" role="alert"><CircleAlert size={16} /><div><strong>Lifecycle catalog unavailable</strong><span>{error}</span></div><button type="button" onClick={() => void refresh()}><RefreshCw size={12} />Retry</button></div>}
          {!loading && !error && catalog && visibleEntries.length === 0 && <div className="verification-center-empty"><FileArchive size={20} /><strong>No matching candidate</strong><span>{catalog.returnedCount ? "Change the search or lifecycle filter." : "Import an exact seven-file offline candidate pack for review."}</span></div>}
          {visibleEntries.length > 0 && <div className="verification-center-listbox" role="listbox" aria-label="Offline Trust Root candidates">
            {visibleEntries.map((entry) => <CandidateResult key={entry.directoryName} entry={entry} selected={entry.directoryName === selected?.directoryName} onSelect={() => setSelectedDirectory(entry.directoryName)} />)}
          </div>}
          <div className="verification-center-list-boundary"><LockKeyhole size={12} /><span>Import copies exact bytes. Download, signing, key generation, and root activation are unavailable.</span></div>
        </aside>
        <main className="verification-center-detail">
          {selected ? <LifecycleDetail entry={selected} actionError={actionError} onReveal={() => void reveal()} /> : !loading && !error && <div className="verification-center-detail-empty"><ShieldCheck size={23} /><strong>Select a candidate pack</strong><span>The dual-threshold transition and signed metadata chain will appear here.</span></div>}
        </main>
      </div>

      <footer className="verification-center-footer signature-evidence-footer trust-root-lifecycle-footer">
        <LockKeyhole size={13} /><span>{catalog?.boundary ?? "Read-only review · no online refresh and no activation path."}</span>
        <span><kbd>Tab</kbd> move <kbd>Esc</kbd> close</span>
      </footer>
    </section>
  </div>;
}

function CandidateResult({ entry, selected, onSelect }: { entry: TrustRootLifecycleEntry; selected: boolean; onSelect: () => void }) {
  const Icon = stateIcon(entry.state);
  return <button type="button" role="option" aria-selected={selected} className={`verification-bundle-result trust-root-candidate-result is-${entry.state} ${selected ? "is-active" : ""}`} onClick={onSelect}>
    <span className="verification-bundle-result-icon"><Icon size={14} /></span>
    <span className="verification-bundle-result-copy">
      <span><strong>{entry.mode === "root-rotation" ? "Sequential root rotation" : entry.mode === "metadata-refresh" ? "Signed metadata refresh" : "Unreadable candidate"}</strong><em>{stateLabel(entry.state)}</em></span>
      <code>{entry.root ? `root v${entry.root.currentVersion} → v${entry.root.candidateVersion}` : entry.candidateId ?? entry.directoryName}</code>
      <small>{entry.sourceCommit ? `source ${shortHash(entry.sourceCommit)}` : "Source unavailable"}{entry.observedModifiedAt ? ` · ${formatTime(entry.observedModifiedAt)}` : ""}</small>
    </span>
  </button>;
}

function LifecycleDetail({ entry, actionError, onReveal }: { entry: TrustRootLifecycleEntry; actionError?: string; onReveal: () => void }) {
  const Icon = stateIcon(entry.state);
  const stages = lifecycleStages(entry.checks);
  const passed = stages.filter((stage) => stage.state === "passed").length;
  return <>
    <header className={`verification-detail-hero signature-evidence-hero trust-root-lifecycle-hero is-${entry.state}`}>
      <span><Icon size={18} /></span>
      <div><small>{stateKicker(entry.state)}</small><h3>{stateTitle(entry.state)}</h3><p>{stateSummary(entry.state, passed)}</p></div>
      <div className="verification-identity-badge signature-identity-badge trust-root-transition-badge"><GitCompareArrows size={12} /><span><strong>{entry.root ? `root v${entry.root.currentVersion} → v${entry.root.candidateVersion}` : "Root unavailable"}</strong><small>{entry.root ? `${entry.root.currentThreshold}-of-${rootKeyCount(entry.root.currentThreshold)} old · ${entry.root.candidateThreshold}-of-${rootKeyCount(entry.root.candidateThreshold)} new` : "Thresholds unavailable"}</small></span></div>
    </header>
    <div className="verification-detail-scroll signature-evidence-scroll trust-root-lifecycle-scroll">
      <section className="signature-stage-chain trust-root-stage-chain" aria-label="Five-stage trust root transition chain">
        <header><div><strong>Root transition chain</strong><span>Anchor → old threshold → new threshold → metadata chain → trust material</span></div><b>{passed}/5</b></header>
        <div>{stages.map((stage, index) => {
          const StageIcon = stage.icon;
          const StatusIcon = stage.state === "passed" ? BadgeCheck : stage.state === "warning" ? Clock3 : stage.state === "failed" ? XCircle : CircleAlert;
          return <article className={`is-${stage.state}`} key={stage.id}><span className="signature-stage-index">0{index + 1}</span><StageIcon size={15} /><div><small>{stage.kicker}</small><strong>{stage.label}</strong><p>{stage.detail}</p></div><StatusIcon className="signature-stage-status" size={14} /></article>;
        })}</div>
      </section>

      <section className="trust-root-role-table" aria-label="Signed TUF role metadata">
        <header><div><strong>Signed role checkpoint</strong><span>Exact version, expiry, and SHA-256 are evaluated independently.</span></div><b>{entry.mode === "root-rotation" ? "ROOT ROTATION" : "METADATA REFRESH"}</b></header>
        <div className="trust-root-role-head"><span>Role</span><span>Version</span><span>Expires</span><span>Digest</span><span>State</span></div>
        <RoleRow name="root" snapshot={entry.root ? { version: entry.root.candidateVersion, expires: entry.root.expires, sha256: entry.root.sha256 } : undefined} checks={entry.checks} checkIds={["root-version", "root-expiry"]} />
        <RoleRow name="timestamp" snapshot={entry.timestamp} checks={entry.checks} checkIds={["timestamp-signature", "timestamp-freshness"]} />
        <RoleRow name="snapshot" snapshot={entry.snapshot} checks={entry.checks} checkIds={["snapshot-binding", "snapshot-signature", "snapshot-freshness"]} />
        <RoleRow name="targets" snapshot={entry.targets} checks={entry.checks} checkIds={["targets-binding", "targets-signature", "targets-freshness"]} />
      </section>

      <section className="verification-facts signature-evidence-facts trust-root-lifecycle-facts" aria-label="Trust Root candidate facts">
        <header><strong>Bound candidate facts</strong><span>Reviewable means cryptographically admissible, never automatically active.</span></header>
        <div>
          <Fact label="Candidate ID" value={entry.candidateId ?? entry.directoryName} mono />
          <Fact label="Source commit" value={entry.sourceCommit ? shortHash(entry.sourceCommit) : "Unavailable"} mono />
          <Fact label="Root digest" value={entry.root ? shortHash(entry.root.sha256) : "Unavailable"} mono />
          <Fact label="Trusted-root digest" value={entry.trustedRoot ? shortHash(entry.trustedRoot.sha256) : "Unavailable"} mono />
          <Fact label="Trust material change" value={entry.trustedRoot?.changed ? "Changed · human review required" : "Semantically unchanged"} />
          <Fact label="Authorities" value={entry.trustedRoot ? `${entry.trustedRoot.certificateAuthorityCount} CA · ${entry.trustedRoot.timestampAuthorityCount} TSA · ${entry.trustedRoot.tlogCount} tlog · ${entry.trustedRoot.ctlogCount} CT log` : "Unavailable"} />
        </div>
      </section>

      <section className={`verification-diagnostics ${entry.diagnostics.length ? "has-findings" : ""}`} aria-label="Trust Root lifecycle diagnostics">
        <header><strong>{entry.diagnostics.length ? "Lifecycle diagnostics" : "No lifecycle diagnostic"}</strong><span>{entry.diagnostics.length ? `${entry.diagnostics.length} fail-closed finding${entry.diagnostics.length === 1 ? "" : "s"}` : "All required offline transition checks passed."}</span></header>
        {entry.diagnostics.map((item) => {
          const [code, ...detail] = item.split(":");
          return <article key={item}><XCircle size={13} /><div><code>{code}</code><strong>Candidate rejected</strong><p>{detail.join(":").trim() || item}</p></div></article>;
        })}
      </section>

      <div className="verification-auth-boundary signature-auth-boundary trust-root-auth-boundary"><LockKeyhole size={13} /><div><strong>Review is deliberately separate from activation</strong><span>This center has no network updater, signing key, root replacement, exception override, or effect authorization path. A reviewable pack still requires a separately reviewed release change.</span></div></div>
    </div>
    <footer className="verification-detail-footer">
      <span><LockKeyhole size={12} />Offline snapshot · exactly seven files · no fallback.</span>
      {actionError && <em role="alert">{actionError}</em>}
      <button className="secondary-button" type="button" disabled={!entry.relativePath} onClick={onReveal}><FolderOpen size={13} />Reveal candidate</button>
    </footer>
  </>;
}

function lifecycleStages(checks: TrustRootLifecycleCheck[]) {
  return [
    { id: "anchor", icon: ShieldCheck, kicker: "Pinned start", label: "Anchor root", state: aggregate(checks, ["directory", "entries", "checksums", "source-record", "anchor-root", "root-version"]), detail: detailFor(checks, "anchor-root") },
    { id: "old-threshold", icon: KeyRound, kicker: "Continuity", label: "Old-root threshold", state: aggregate(checks, ["old-root-threshold"]), detail: detailFor(checks, "old-root-threshold") },
    { id: "new-threshold", icon: GitCompareArrows, kicker: "New authority", label: "New-root threshold", state: aggregate(checks, ["new-root-threshold", "root-expiry"]), detail: detailFor(checks, "new-root-threshold") },
    { id: "metadata", icon: Layers3, kicker: "Versioned roles", label: "Metadata chain", state: aggregate(checks, ["timestamp-signature", "timestamp-freshness", "snapshot-binding", "snapshot-signature", "snapshot-freshness", "targets-binding", "targets-signature", "targets-freshness", "rollback-protection"]), detail: detailFor(checks, "rollback-protection") },
    { id: "material", icon: FileCheck2, kicker: "Exact target", label: "Trust material", state: aggregate(checks, ["trusted-root-binding", "trusted-root-structure", "change-classification"]), detail: detailFor(checks, "trusted-root-binding") },
  ];
}

function RoleRow({ name, snapshot, checks, checkIds }: { name: string; snapshot?: TrustRootLifecycleRoleSnapshot; checks: TrustRootLifecycleCheck[]; checkIds: TrustRootLifecycleCheck["id"][] }) {
  const state = aggregate(checks, checkIds);
  const Icon = state === "passed" ? BadgeCheck : state === "warning" ? Clock3 : state === "failed" ? XCircle : CircleAlert;
  return <div className={`trust-root-role-row is-${state}`}><strong>{name}</strong><code>{snapshot ? `v${snapshot.version}` : "—"}</code><span>{snapshot ? formatExpiry(snapshot.expires) : "Unavailable"}</span><code title={snapshot?.sha256}>{snapshot ? shortHash(snapshot.sha256) : "Unavailable"}</code><em><Icon size={11} />{stateLabelForCheck(state)}</em></div>;
}

function aggregate(checks: TrustRootLifecycleCheck[], ids: TrustRootLifecycleCheck["id"][]): TrustRootLifecycleCheck["state"] {
  const states = ids.map((id) => checks.find((check) => check.id === id)?.state ?? "not-checked");
  if (states.includes("failed")) return "failed";
  if (states.includes("warning")) return "warning";
  if (states.includes("not-checked")) return "not-checked";
  return "passed";
}

function detailFor(checks: TrustRootLifecycleCheck[], id: TrustRootLifecycleCheck["id"]): string { return checks.find((check) => check.id === id)?.detail ?? "Not checked."; }
function FilterButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) { return <button type="button" aria-pressed={active} onClick={onClick}><span>{label}</span><b>{count}</b></button>; }
function SummaryStat({ icon: Icon, label, value, tone }: { icon: typeof BadgeCheck; label: string; value: number; tone: string }) { return <div className={`verification-summary-stat is-${tone}`}><span><Icon size={13} />{label}</span><strong>{value}</strong></div>; }
function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div><span>{label}</span>{mono ? <code title={value}>{value}</code> : <strong>{value}</strong>}</div>; }
function stateIcon(state: TrustRootLifecycleState) { return state === "reviewable" ? GitCompareArrows : state === "current" ? BadgeCheck : state === "rejected" ? ShieldAlert : XCircle; }
function stateLabel(state: TrustRootLifecycleState) { return state === "reviewable" ? "Reviewable" : state === "current" ? "Current" : state === "rejected" ? "Rejected" : "Invalid"; }
function stateKicker(state: TrustRootLifecycleState) { return state === "reviewable" ? "Cryptographically admissible" : state === "current" ? "Pinned checkpoint match" : state === "rejected" ? "Transition rejected" : "Structural rejection"; }
function stateTitle(state: TrustRootLifecycleState) { return state === "reviewable" ? "Candidate ready for human review" : state === "current" ? "Pinned checkpoint is current" : state === "rejected" ? "Candidate transition rejected" : "Candidate pack invalid"; }
function stateSummary(state: TrustRootLifecycleState, passed: number) {
  if (state === "reviewable") return "Both root thresholds and the complete signed metadata chain passed. Activation remains unavailable.";
  if (state === "current") return "Candidate root and trust material match the pinned checkpoint; no release change is needed.";
  return `${passed}/5 lifecycle stages passed; the candidate failed closed and cannot be reviewed as a valid transition.`;
}
function stateLabelForCheck(state: TrustRootLifecycleCheck["state"]) { return state === "passed" ? "Passed" : state === "failed" ? "Failed" : state === "warning" ? "Review" : "Blocked"; }
function rootKeyCount(threshold: number): number { return threshold === 3 ? 5 : Math.max(threshold, 1); }
function shortHash(value: string): string { return value.length > 16 ? `${value.slice(0, 9)}…${value.slice(-7)}` : value; }
function formatTime(value: string): string { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Observed"; }
function formatExpiry(value: string): string { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) : "Invalid expiry"; }
function friendlyError(error: unknown): string { const message = error instanceof Error ? error.message : String(error); return message.length > 240 ? `${message.slice(0, 239)}…` : message; }
