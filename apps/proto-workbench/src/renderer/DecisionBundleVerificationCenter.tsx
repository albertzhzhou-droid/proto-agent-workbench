import {
  BadgeCheck,
  CircleAlert,
  FileCheck2,
  FileJson,
  Fingerprint,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  ScanSearch,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type {
  DecisionBundleVerificationCatalog,
  DecisionBundleVerificationEntry,
  DecisionBundleVerificationState,
} from "../shared/contracts.ts";
import { workbenchApi, workbenchDataMode } from "./mock-api.ts";
import { TrustPolicyCenter } from "./TrustPolicyCenter.tsx";
import { SignatureEvidenceCenter } from "./SignatureEvidenceCenter.tsx";
import { TrustRootLifecycleCenter } from "./TrustRootLifecycleCenter.tsx";
import { TransparencyLogWitnessCenter } from "./TransparencyLogWitnessCenter.tsx";

type VerificationFilter = "all" | "content-verified" | "attention";

export function DecisionBundleVerificationCenter({ onClose }: { onClose: () => void }) {
  const [catalog, setCatalog] = useState<DecisionBundleVerificationCatalog>();
  const [selectedDirectory, setSelectedDirectory] = useState<string>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<VerificationFilter>("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [revealError, setRevealError] = useState<string>();
  const [trustPolicyOpen, setTrustPolicyOpen] = useState(false);
  const [signatureEvidenceOpen, setSignatureEvidenceOpen] = useState(false);
  const [trustRootLifecycleOpen, setTrustRootLifecycleOpen] = useState(false);
  const [transparencyWitnessOpen, setTransparencyWitnessOpen] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const generationRef = useRef(0);

  const refresh = async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(undefined);
    setRevealError(undefined);
    try {
      const next = await workbenchApi().harness.verifyDecisionBundles();
      if (generation !== generationRef.current) return;
      setCatalog(next);
      setSelectedDirectory((current) => next.entries.some((entry) => entry.directoryName === current)
        ? current
        : next.entries[0]?.directoryName);
    } catch (verificationError) {
      if (generation !== generationRef.current) return;
      setError(friendlyError(verificationError));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    searchRef.current?.focus();
    void refresh();
  // The first read is an explicit user-opened, read-only workspace snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleEntries = useMemo(() => {
    const normalized = query.normalize("NFKC").trim().toLocaleLowerCase();
    return (catalog?.entries ?? []).filter((entry) => {
      if (filter === "content-verified" && entry.state !== "content-verified") return false;
      if (filter === "attention" && entry.state === "content-verified") return false;
      if (!normalized) return true;
      const corpus = [
        entry.directoryName,
        entry.bundleId,
        entry.selectedScenario?.label,
        entry.selectedScenario?.state,
        entry.state,
        entry.redaction,
        entry.producer?.version,
        ...entry.diagnostics.flatMap((item) => [item.code, item.title]),
      ].filter(Boolean).join(" ").toLocaleLowerCase();
      return normalized.split(/\s+/u).every((token) => corpus.includes(token));
    });
  }, [catalog, filter, query]);

  const selected = visibleEntries.find((entry) => entry.directoryName === selectedDirectory) ?? visibleEntries[0];

  const reveal = async () => {
    if (!selected?.relativePath) return;
    setRevealError(undefined);
    try {
      await workbenchApi().files.reveal(selected.relativePath);
    } catch (openError) {
      setRevealError(friendlyError(openError));
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])") ?? [])];
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

  if (transparencyWitnessOpen) {
    return <TransparencyLogWitnessCenter onBack={() => { setTransparencyWitnessOpen(false); setSignatureEvidenceOpen(true); }} onClose={onClose} />;
  }

  if (trustRootLifecycleOpen) {
    return <TrustRootLifecycleCenter onBack={() => { setTrustRootLifecycleOpen(false); setSignatureEvidenceOpen(true); }} onClose={onClose} />;
  }

  if (signatureEvidenceOpen) {
    return <SignatureEvidenceCenter onBack={() => { setSignatureEvidenceOpen(false); setTrustPolicyOpen(true); }} onClose={onClose} onRoots={() => { setSignatureEvidenceOpen(false); setTrustRootLifecycleOpen(true); }} onWitnesses={() => { setSignatureEvidenceOpen(false); setTransparencyWitnessOpen(true); }} />;
  }

  if (trustPolicyOpen) {
    return <TrustPolicyCenter onBack={() => setTrustPolicyOpen(false)} onClose={onClose} onEvidence={() => { setTrustPolicyOpen(false); setSignatureEvidenceOpen(true); }} />;
  }

  return (
    <div className="verification-center-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="verification-center-dialog" role="dialog" aria-modal="true" aria-labelledby="verification-center-title" onKeyDown={handleKeyDown}>
        <header className="verification-center-heading">
          <span className="verification-center-mark" aria-hidden="true"><FileCheck2 size={17} /></span>
          <div><span className="eyebrow">Audit verification</span><h2 id="verification-center-title">Verification Center</h2><p>Re-check exported Decision Bundles without executing, importing, approving, or trusting publisher identity.</p></div>
          <div className="verification-center-heading-meta">
            {workbenchDataMode() === "preview" && <b>Fixture catalog</b>}
            <code title={catalog?.digest}>{catalog ? shortHash(catalog.digest) : "Not scanned"}</code>
            <button className="secondary-button verification-signatures-open" type="button" onClick={() => setSignatureEvidenceOpen(true)}><ScanSearch size={13} />Signatures</button>
            <button className="secondary-button verification-policy-open" type="button" onClick={() => setTrustPolicyOpen(true)}><KeyRound size={13} />Trust policies</button>
            <button className="icon-button" type="button" onClick={onClose} aria-label="Close Verification Center"><X size={15} /></button>
          </div>
        </header>

        <div className="verification-center-toolbar">
          <label className="verification-center-search">
            <Search size={14} />
            <input ref={searchRef} value={query} maxLength={160} onChange={(event) => setQuery(event.target.value)} aria-label="Search verified bundles" placeholder="Search bundle, scenario, status, or diagnostic…" />
            {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear bundle search"><X size={13} /></button>}
          </label>
          <div className="verification-center-filters" role="group" aria-label="Verification result filters">
            <FilterButton active={filter === "all"} onClick={() => setFilter("all")} label="All" count={catalog?.returnedCount ?? 0} />
            <FilterButton active={filter === "content-verified"} onClick={() => setFilter("content-verified")} label="Content intact" count={catalog?.summary.contentVerified ?? 0} />
            <FilterButton active={filter === "attention"} onClick={() => setFilter("attention")} label="Attention" count={(catalog?.summary.tampered ?? 0) + (catalog?.summary.invalid ?? 0)} />
          </div>
          <button className="secondary-button verification-center-refresh" type="button" disabled={loading} onClick={() => void refresh()}>
            {loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{loading ? "Scanning…" : "Refresh snapshot"}
          </button>
        </div>

        <section className="verification-center-summary" aria-label="Verification summary">
          <SummaryStat icon={BadgeCheck} label="Content intact" value={catalog?.summary.contentVerified ?? 0} tone="verified" />
          <SummaryStat icon={ShieldAlert} label="Tampered" value={catalog?.summary.tampered ?? 0} tone="tampered" />
          <SummaryStat icon={XCircle} label="Invalid" value={catalog?.summary.invalid ?? 0} tone="invalid" />
          <SummaryStat icon={Fingerprint} label="Unsigned" value={catalog?.summary.unsigned ?? 0} tone="unsigned" />
          <div className="verification-center-snapshot"><span>Snapshot scope</span><strong>{catalog ? `${catalog.returnedCount}/${catalog.scannedDirectoryCount}` : "—"}</strong><small>{catalog?.truncated ? `Bounded at ${catalog.limits.maxDirectories}` : "All matching directories"}</small></div>
        </section>

        <div className="verification-center-body">
          <aside className="verification-center-list" aria-label="Decision Bundle verification results">
            <header><div><strong>Exported bundles</strong><span>Current workspace · read-only scan</span></div><b>{visibleEntries.length}</b></header>
            {loading && !catalog && <div className="verification-center-loading"><LoaderCircle className="spin" size={19} /><strong>Verifying current bytes</strong><span>No file is created or changed.</span></div>}
            {!loading && error && <div className="verification-center-error" role="alert"><CircleAlert size={16} /><div><strong>Verification unavailable</strong><span>{error}</span></div><button type="button" onClick={() => void refresh()}><RefreshCw size={12} />Retry</button></div>}
            {!loading && !error && catalog && visibleEntries.length === 0 && <div className="verification-center-empty"><FileJson size={20} /><strong>No matching bundle</strong><span>{catalog.returnedCount ? "Change the search or status filter." : "Export a Decision Bundle to build/decision-bundles first."}</span></div>}
            {visibleEntries.length > 0 && <div className="verification-center-listbox" role="listbox" aria-label="Verified Decision Bundles">
              {visibleEntries.map((entry) => <BundleResult key={entry.directoryName} entry={entry} selected={entry.directoryName === selected?.directoryName} onSelect={() => setSelectedDirectory(entry.directoryName)} />)}
            </div>}
            <div className="verification-center-list-boundary"><LockKeyhole size={12} /><span>Locators are workspace-relative. Linked or unexpected entries fail closed.</span></div>
          </aside>

          <main className="verification-center-detail">
            {selected ? <VerificationDetail entry={selected} revealError={revealError} onReveal={() => void reveal()} /> : !loading && !error && <div className="verification-center-detail-empty"><ShieldCheck size={23} /><strong>Select an exported bundle</strong><span>Checks and diagnostics will appear here without opening or executing its contents.</span></div>}
          </main>
        </div>

        <footer className="verification-center-footer">
          <LockKeyhole size={13} /><span>{catalog?.boundary ?? "Read-only verification · publisher identity is never inferred from a checksum."}</span>
          <span><kbd>Tab</kbd> move <kbd>Esc</kbd> close</span>
        </footer>
      </section>
    </div>
  );
}

function FilterButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return <button type="button" aria-pressed={active} onClick={onClick}><span>{label}</span><b>{count}</b></button>;
}

function SummaryStat({ icon: Icon, label, value, tone }: { icon: typeof BadgeCheck; label: string; value: number; tone: string }) {
  return <div className={`verification-summary-stat is-${tone}`}><span><Icon size={13} />{label}</span><strong>{value}</strong></div>;
}

function BundleResult({ entry, selected, onSelect }: { entry: DecisionBundleVerificationEntry; selected: boolean; onSelect: () => void }) {
  const Icon = stateIcon(entry.state);
  return (
    <button type="button" role="option" aria-selected={selected} className={`verification-bundle-result is-${entry.state} ${selected ? "is-active" : ""}`} onClick={onSelect}>
      <span className="verification-bundle-result-icon"><Icon size={14} /></span>
      <span className="verification-bundle-result-copy">
        <span><strong>{entry.selectedScenario?.label ?? "Unreadable bundle"}</strong><em>{stateLabel(entry.state)}</em></span>
        <code>{entry.bundleId ?? entry.directoryName}</code>
        <small>{entry.signatureStatus === "unsigned" ? "Unsigned · identity not verified" : "Authentication unavailable"}{entry.observedModifiedAt ? ` · ${formatTime(entry.observedModifiedAt)}` : ""}</small>
      </span>
    </button>
  );
}

function VerificationDetail({ entry, revealError, onReveal }: { entry: DecisionBundleVerificationEntry; revealError?: string; onReveal: () => void }) {
  const Icon = stateIcon(entry.state);
  const passed = entry.checks.filter((check) => check.state === "passed").length;
  return <>
    <header className={`verification-detail-hero is-${entry.state}`}>
      <span><Icon size={18} /></span>
      <div><small>{stateKicker(entry.state)}</small><h3>{stateTitle(entry.state)}</h3><p>{stateSummary(entry.state, passed, entry.checks.length)}</p></div>
      <div className="verification-identity-badge"><ShieldAlert size={12} /><span><strong>{entry.signatureStatus === "unsigned" ? "Unsigned" : "Unknown signer"}</strong><small>Identity not verified</small></span></div>
    </header>

    <div className="verification-detail-scroll">
      <section className="verification-checks" aria-label="Verification checks">
        <header><div><strong>Local verification chain</strong><span>Directory → bytes → checksum → schema → content address → subject</span></div><b>{passed}/{entry.checks.length}</b></header>
        <div>{entry.checks.map((check) => {
          const CheckIcon = check.state === "passed" ? BadgeCheck : check.state === "failed" ? XCircle : CircleAlert;
          return <article className={`is-${check.state}`} key={check.id}><CheckIcon size={13} /><span><strong>{check.label}</strong><small>{check.detail}</small></span></article>;
        })}</div>
      </section>

      <section className="verification-facts" aria-label="Decision Bundle facts">
        <header><strong>Bound facts</strong><span>Only fields from a successfully parsed canonical bundle are shown.</span></header>
        <div>
          <Fact label="Bundle ID" value={entry.bundleId ?? entry.directoryName} mono />
          <Fact label="Content digest" value={entry.bundleDigest ? shortHash(entry.bundleDigest) : "Unavailable"} mono />
          <Fact label="Current JSON SHA-256" value={entry.bundleSha256 ? shortHash(entry.bundleSha256) : "Unavailable"} mono />
          <Fact label="Expected JSON SHA-256" value={entry.expectedBundleSha256 ? shortHash(entry.expectedBundleSha256) : "Unavailable"} mono />
          <Fact label="Source simulation" value={entry.sourceSimulationSha256 ? shortHash(entry.sourceSimulationSha256) : "Unavailable"} mono />
          <Fact label="Selected decision" value={entry.selectedScenario ? `${entry.selectedScenario.label} · ${stateWord(entry.selectedScenario.state)}` : "Unavailable"} />
          <Fact label="Redaction" value={entry.redaction === "metadata-only" ? "Metadata only" : entry.redaction === "include-goal-preview" ? "Goal preview included" : "Unavailable"} />
          <Fact label="Scenario matrix" value={entry.scenarioCount === undefined ? "Unavailable" : `${entry.scenarioCount} scenarios · 0 effects`} />
          <Fact label="Producer" value={entry.producer ? `${entry.producer.name} ${entry.producer.version}` : "Unavailable"} />
        </div>
      </section>

      <section className={`verification-diagnostics ${entry.diagnostics.length ? "has-findings" : ""}`} aria-label="Verification diagnostics">
        <header><strong>{entry.diagnostics.length ? "Integrity diagnostics" : "No integrity diagnostic"}</strong><span>{entry.diagnostics.length ? `${entry.diagnostics.length} fail-closed finding${entry.diagnostics.length === 1 ? "" : "s"}` : "Every supported local content check passed."}</span></header>
        {entry.diagnostics.map((item) => <article key={`${item.code}:${item.title}`}><XCircle size={13} /><div><code>{item.code}</code><strong>{item.title}</strong><p>{item.detail}</p></div></article>)}
      </section>

      <div className="verification-auth-boundary"><Fingerprint size={13} /><div><strong>Content integrity is not publisher identity</strong><span>No DSSE signature, Sigstore verification material, certificate identity, transparency proof, or trusted key is present. A green content result remains unsigned.</span></div></div>
    </div>

    <footer className="verification-detail-footer">
      <span><LockKeyhole size={12} />Snapshot only · current bytes can change after this check.</span>
      {revealError && <em role="alert">{revealError}</em>}
      <button className="secondary-button" type="button" disabled={!entry.relativePath} onClick={onReveal}><FolderOpen size={13} />Reveal artifact</button>
    </footer>
  </>;
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><span>{label}</span>{mono ? <code title={value}>{value}</code> : <strong>{value}</strong>}</div>;
}

function stateIcon(state: DecisionBundleVerificationState) {
  return state === "content-verified" ? BadgeCheck : state === "tampered" ? ShieldAlert : XCircle;
}

function stateLabel(state: DecisionBundleVerificationState): string {
  return state === "content-verified" ? "Content intact" : state === "tampered" ? "Tampered" : "Invalid";
}

function stateKicker(state: DecisionBundleVerificationState): string {
  return state === "content-verified" ? "Local content verification" : state === "tampered" ? "Integrity failure" : "Structural failure";
}

function stateTitle(state: DecisionBundleVerificationState): string {
  return state === "content-verified" ? "Content intact" : state === "tampered" ? "Tampering detected" : "Bundle rejected";
}

function stateSummary(state: DecisionBundleVerificationState, passed: number, total: number): string {
  if (state === "content-verified") return `All ${total} supported local checks passed. Publisher identity remains unverified.`;
  if (state === "tampered") return `${passed}/${total} checks passed; one or more content bindings no longer match.`;
  return `${passed}/${total} checks passed; the directory or artifact structure cannot be trusted.`;
}

function stateWord(state: string): string {
  return state.replaceAll("-", " ");
}

function shortHash(value: string): string {
  return value.length > 16 ? `${value.slice(0, 9)}…${value.slice(-7)}` : value;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Observed";
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 240 ? `${message.slice(0, 239)}…` : message;
}
