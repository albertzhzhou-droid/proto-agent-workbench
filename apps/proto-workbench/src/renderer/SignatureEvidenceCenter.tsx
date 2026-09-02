import {
  ArrowLeft,
  BadgeCheck,
  CircleAlert,
  Clock3,
  FileArchive,
  FileKey2,
  Fingerprint,
  FolderInput,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Search,
  ShieldEllipsis,
  ShieldAlert,
  ShieldCheck,
  Waypoints,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type {
  SignatureEvidenceCatalog,
  SignatureEvidenceCheck,
  SignatureEvidenceEntry,
  SignatureEvidenceState,
} from "../shared/contracts.ts";
import { workbenchApi, workbenchDataMode } from "./mock-api.ts";

type EvidenceFilter = "all" | "verified" | "attention";

export function SignatureEvidenceCenter({ onBack, onClose, onRoots, onWitnesses }: { onBack: () => void; onClose: () => void; onRoots: () => void; onWitnesses: () => void }) {
  const [catalog, setCatalog] = useState<SignatureEvidenceCatalog>();
  const [selectedDirectory, setSelectedDirectory] = useState<string>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<EvidenceFilter>("all");
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const generationRef = useRef(0);

  const refresh = async (preferredEvidenceId?: string) => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await workbenchApi().harness.listSignatureEvidence();
      if (generation !== generationRef.current) return;
      setCatalog(next);
      setSelectedDirectory((current) => {
        const preferred = preferredEvidenceId ?? current;
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
  // Explicitly opening this read-only audit surface triggers one bounded scan.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleEntries = useMemo(() => {
    const normalized = query.normalize("NFKC").trim().toLocaleLowerCase();
    return (catalog?.entries ?? []).filter((entry) => {
      if (filter === "verified" && entry.state !== "verified") return false;
      if (filter === "attention" && entry.state === "verified") return false;
      if (!normalized) return true;
      const corpus = [
        entry.directoryName, entry.evidenceId, entry.bundleId, entry.policyId, entry.state,
        entry.identity?.authorityName, entry.identity?.certificateIssuer, entry.identity?.certificateIdentity,
        entry.identity?.publicKeySha256, ...entry.diagnostics.flatMap((item) => [item.code, item.title]),
      ].filter(Boolean).join(" ").toLocaleLowerCase();
      return normalized.split(/\s+/u).every((token) => corpus.includes(token));
    });
  }, [catalog, filter, query]);

  const selected = visibleEntries.find((entry) => entry.directoryName === selectedDirectory) ?? visibleEntries[0];

  const importPack = async () => {
    setImporting(true);
    setActionError(undefined);
    try {
      const receipt = await workbenchApi().harness.importSignatureEvidence();
      if (receipt) await refresh(receipt.evidenceId);
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
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const attention = (catalog?.summary.incomplete ?? 0) + (catalog?.summary.rejected ?? 0) + (catalog?.summary.invalid ?? 0);
  return <div className="verification-center-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} className="verification-center-dialog signature-evidence-dialog" role="dialog" aria-modal="true" aria-labelledby="signature-evidence-title" onKeyDown={handleKeyDown}>
      <header className="verification-center-heading signature-evidence-heading">
        <span className="verification-center-mark" aria-hidden="true"><FileKey2 size={17} /></span>
        <div><span className="eyebrow">Offline publisher proof</span><h2 id="signature-evidence-title">Signature Evidence Center</h2><p>Verify artifact, signature, trusted time, trust root, and exact authority as separate fail-closed stages.</p></div>
        <div className="verification-center-heading-meta">
          {workbenchDataMode() === "preview" && <b>Fixture catalog</b>}
          <code title={catalog?.digest}>{catalog ? shortHash(catalog.digest) : "Not scanned"}</code>
          <button className="secondary-button signature-witnesses-open" type="button" onClick={onWitnesses}><Waypoints size={13} />Log witnesses</button>
          <button className="secondary-button signature-roots-open" type="button" onClick={onRoots}><ShieldEllipsis size={13} />Root lifecycle</button>
          <button className="secondary-button trust-policy-back" type="button" onClick={onBack}><ArrowLeft size={13} />Policies</button>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close Signature Evidence Center"><X size={15} /></button>
        </div>
      </header>

      <div className="verification-center-toolbar signature-evidence-toolbar">
        <label className="verification-center-search">
          <Search size={14} />
          <input ref={searchRef} value={query} maxLength={160} onChange={(event) => setQuery(event.target.value)} aria-label="Search Signature Evidence" placeholder="Search evidence, authority, identity, or diagnostic…" />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear evidence search"><X size={13} /></button>}
        </label>
        <div className="verification-center-filters" role="group" aria-label="Signature Evidence filters">
          <FilterButton active={filter === "all"} onClick={() => setFilter("all")} label="All" count={catalog?.returnedCount ?? 0} />
          <FilterButton active={filter === "verified"} onClick={() => setFilter("verified")} label="Verified" count={catalog?.summary.verified ?? 0} />
          <FilterButton active={filter === "attention"} onClick={() => setFilter("attention")} label="Attention" count={attention} />
        </div>
        <button className="secondary-button signature-evidence-import" type="button" disabled={importing || loading} onClick={() => void importPack()}>
          {importing ? <LoaderCircle className="spin" size={13} /> : <FolderInput size={13} />}{importing ? "Importing…" : "Import pack"}
        </button>
        <button className="secondary-button verification-center-refresh" type="button" disabled={loading || importing} onClick={() => void refresh()}>
          {loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{loading ? "Verifying…" : "Refresh"}
        </button>
      </div>

      <section className="verification-center-summary signature-evidence-summary" aria-label="Signature Evidence summary">
        <SummaryStat icon={BadgeCheck} label="Fully verified" value={catalog?.summary.verified ?? 0} tone="verified" />
        <SummaryStat icon={Clock3} label="Incomplete" value={catalog?.summary.incomplete ?? 0} tone="incomplete" />
        <SummaryStat icon={ShieldAlert} label="Rejected" value={catalog?.summary.rejected ?? 0} tone="rejected" />
        <SummaryStat icon={XCircle} label="Invalid" value={catalog?.summary.invalid ?? 0} tone="invalid" />
        <div className="verification-center-snapshot"><span>Pinned root</span><strong>{catalog ? shortHash(catalog.trustRootSnapshot.sha256) : "—"}</strong><small>Manual reviewed rotation</small></div>
      </section>

      <div className="verification-center-body signature-evidence-body">
        <aside className="verification-center-list" aria-label="Signature Evidence results">
          <header><div><strong>Evidence packs</strong><span>Current workspace · immutable imports</span></div><b>{visibleEntries.length}</b></header>
          {loading && !catalog && <div className="verification-center-loading"><LoaderCircle className="spin" size={19} /><strong>Verifying offline evidence</strong><span>No network request is permitted.</span></div>}
          {!loading && error && <div className="verification-center-error" role="alert"><CircleAlert size={16} /><div><strong>Verification unavailable</strong><span>{error}</span></div><button type="button" onClick={() => void refresh()}><RefreshCw size={12} />Retry</button></div>}
          {!loading && !error && catalog && visibleEntries.length === 0 && <div className="verification-center-empty"><FileArchive size={20} /><strong>No matching evidence</strong><span>{catalog.returnedCount ? "Change the search or status filter." : "Import an exact evidence directory containing the artifact, policy, Sigstore bundle, and checksums."}</span></div>}
          {visibleEntries.length > 0 && <div className="verification-center-listbox" role="listbox" aria-label="Offline Signature Evidence">
            {visibleEntries.map((entry) => <EvidenceResult key={entry.directoryName} entry={entry} selected={entry.directoryName === selected?.directoryName} onSelect={() => setSelectedDirectory(entry.directoryName)} />)}
          </div>}
          <div className="verification-center-list-boundary"><LockKeyhole size={12} /><span>Import copies exact bytes only. Signing, key creation, and trust activation are unavailable.</span></div>
        </aside>
        <main className="verification-center-detail">
          {selected ? <EvidenceDetail entry={selected} actionError={actionError} onReveal={() => void reveal()} /> : !loading && !error && <div className="verification-center-detail-empty"><ShieldCheck size={23} /><strong>Select an evidence pack</strong><span>The five independent trust stages will appear here.</span></div>}
        </main>
      </div>

      <footer className="verification-center-footer signature-evidence-footer">
        <LockKeyhole size={13} /><span>{catalog?.boundary ?? "Offline only · complete trust requires every stage to pass."}</span>
        <span><kbd>Tab</kbd> move <kbd>Esc</kbd> close</span>
      </footer>
    </section>
  </div>;
}

function EvidenceResult({ entry, selected, onSelect }: { entry: SignatureEvidenceEntry; selected: boolean; onSelect: () => void }) {
  const Icon = stateIcon(entry.state);
  return <button type="button" role="option" aria-selected={selected} className={`verification-bundle-result signature-evidence-result is-${entry.state} ${selected ? "is-active" : ""}`} onClick={onSelect}>
    <span className="verification-bundle-result-icon"><Icon size={14} /></span>
    <span className="verification-bundle-result-copy">
      <span><strong>{entry.identity?.authorityName ?? entry.bundleId ?? "Unreadable evidence"}</strong><em>{stateLabel(entry.state)}</em></span>
      <code>{entry.evidenceId ?? entry.directoryName}</code>
      <small>{identitySummary(entry)}{entry.observedModifiedAt ? ` · ${formatTime(entry.observedModifiedAt)}` : ""}</small>
    </span>
  </button>;
}

function EvidenceDetail({ entry, actionError, onReveal }: { entry: SignatureEvidenceEntry; actionError?: string; onReveal: () => void }) {
  const Icon = stateIcon(entry.state);
  const stages = stageGroups(entry.checks);
  return <>
    <header className={`verification-detail-hero signature-evidence-hero is-${entry.state}`}>
      <span><Icon size={18} /></span>
      <div><small>{stateKicker(entry.state)}</small><h3>{stateTitle(entry.state)}</h3><p>{stateSummary(entry.state, stages)}</p></div>
      <div className="verification-identity-badge signature-identity-badge"><Fingerprint size={12} /><span><strong>{entry.identity?.authorityName ?? "No authority match"}</strong><small>{entry.identity?.kind === "keyless" ? "Exact issuer + SAN" : entry.identity?.kind === "public-key" ? "Exact SPKI digest" : "Identity unavailable"}</small></span></div>
    </header>
    <div className="verification-detail-scroll signature-evidence-scroll">
      <section className="signature-stage-chain" aria-label="Five-stage signature verification chain">
        <header><div><strong>Independent trust chain</strong><span>Artifact → signature → trusted time → trust root → identity</span></div><b>{stages.filter((stage) => stage.state === "passed").length}/5</b></header>
        <div>{stages.map((stage, index) => {
          const StageIcon = stage.icon;
          const StatusIcon = stage.state === "passed" ? BadgeCheck : stage.state === "missing" ? Clock3 : stage.state === "failed" ? XCircle : CircleAlert;
          return <article className={`is-${stage.state}`} key={stage.id}><span className="signature-stage-index">{index + 1}</span><StageIcon size={15} /><div><small>{stage.kicker}</small><strong>{stage.label}</strong><p>{stage.detail}</p></div><StatusIcon className="signature-stage-status" size={14} /></article>;
        })}</div>
      </section>

      <section className="verification-facts signature-evidence-facts" aria-label="Verified signature facts">
        <header><strong>Bound facts</strong><span>Values are shown separately from the final policy decision.</span></header>
        <div>
          <Fact label="Evidence ID" value={entry.evidenceId ?? entry.directoryName} mono />
          <Fact label="Decision Bundle" value={entry.bundleId ?? "Unavailable"} mono />
          <Fact label="Trust Policy" value={entry.policyId ?? "Unavailable"} mono />
          <Fact label="Artifact SHA-256" value={entry.artifactSha256 ? shortHash(entry.artifactSha256) : "Unavailable"} mono />
          <Fact label="Sigstore form" value={entry.signatureContent === "dsse-envelope" ? "DSSE envelope · one signature" : entry.signatureContent === "message-signature" ? "Message signature" : "Unavailable"} />
          <Fact label="Issuer" value={entry.identity?.certificateIssuer ?? "Not applicable"} mono={Boolean(entry.identity?.certificateIssuer)} />
          <Fact label="Certificate SAN" value={entry.identity?.certificateIdentity ?? "Not applicable"} mono={Boolean(entry.identity?.certificateIdentity)} />
          <Fact label="Public-key SPKI" value={entry.identity?.publicKeySha256 ? shortHash(entry.identity.publicKeySha256) : "Not applicable"} mono={Boolean(entry.identity?.publicKeySha256)} />
          <Fact label="Signed time" value={entry.signedTime?.status === "verified" ? `${entry.signedTime.source === "transparency-log" ? "Transparency log" : "Timestamp authority"}${entry.signedTime.observedAt ? ` · ${formatTime(entry.signedTime.observedAt)}` : ""}` : entry.signedTime?.status === "missing" ? "Missing · incomplete" : "Rejected"} />
          <Fact label="Trust root" value={entry.trustRoot ? `${entry.trustRoot.name} · ${shortHash(entry.trustRoot.sha256)}` : "Unavailable"} mono />
        </div>
      </section>

      <section className={`verification-diagnostics ${entry.diagnostics.length ? "has-findings" : ""}`} aria-label="Signature Evidence diagnostics">
        <header><strong>{entry.diagnostics.length ? "Verification diagnostics" : "No verification diagnostic"}</strong><span>{entry.diagnostics.length ? `${entry.diagnostics.length} finding${entry.diagnostics.length === 1 ? "" : "s"}` : "All required cryptographic and policy stages passed."}</span></header>
        {entry.diagnostics.map((item) => <article key={`${item.code}:${item.title}`}><XCircle size={13} /><div><code>{item.code}</code><strong>{item.title}</strong><p>{item.detail}</p></div></article>)}
      </section>

      <div className="verification-auth-boundary signature-auth-boundary"><LockKeyhole size={13} /><div><strong>Verification does not activate trust</strong><span>This snapshot cannot sign, generate a key, authorize an effect, or update the pinned root. Root rotation is a separate reviewed release change.</span></div></div>
    </div>
    <footer className="verification-detail-footer">
      <span><LockKeyhole size={12} />Offline snapshot · no network fallback.</span>
      {actionError && <em role="alert">{actionError}</em>}
      <button className="secondary-button" type="button" disabled={!entry.relativePath} onClick={onReveal}><FolderOpen size={13} />Reveal evidence</button>
    </footer>
  </>;
}

function stageGroups(checks: SignatureEvidenceCheck[]) {
  const stateFor = (...ids: SignatureEvidenceCheck["id"][]) => aggregate(ids.map((id) => checks.find((check) => check.id === id)?.state ?? "not-checked"));
  return [
    { id: "artifact", icon: FileArchive, kicker: "Exact bytes", label: "Artifact binding", state: stateFor("directory", "entries", "checksums", "decision-bundle", "module-manifest", "artifact-binding"), detail: detailFor(checks, "artifact-binding") },
    { id: "signature", icon: FileKey2, kicker: "Cryptography", label: "Signature", state: stateFor("sigstore-bundle", "cryptographic-signature"), detail: detailFor(checks, "cryptographic-signature") },
    { id: "time", icon: Clock3, kicker: "Independent clock", label: "Trusted time", state: stateFor("trusted-time"), detail: detailFor(checks, "trusted-time") },
    { id: "root", icon: ShieldCheck, kicker: "Pinned trust", label: "Trust root", state: stateFor("trust-root"), detail: detailFor(checks, "trust-root") },
    { id: "identity", icon: KeyRound, kicker: "Exact policy", label: "Authority identity", state: stateFor("trust-policy", "authority-identity"), detail: detailFor(checks, "authority-identity") },
  ];
}

function aggregate(states: SignatureEvidenceCheck["state"][]): SignatureEvidenceCheck["state"] {
  if (states.includes("failed")) return "failed";
  if (states.includes("missing")) return "missing";
  if (states.includes("not-checked")) return "not-checked";
  return "passed";
}

function detailFor(checks: SignatureEvidenceCheck[], id: SignatureEvidenceCheck["id"]): string { return checks.find((check) => check.id === id)?.detail ?? "Not checked."; }
function FilterButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) { return <button type="button" aria-pressed={active} onClick={onClick}><span>{label}</span><b>{count}</b></button>; }
function SummaryStat({ icon: Icon, label, value, tone }: { icon: typeof BadgeCheck; label: string; value: number; tone: string }) { return <div className={`verification-summary-stat is-${tone}`}><span><Icon size={13} />{label}</span><strong>{value}</strong></div>; }
function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div><span>{label}</span>{mono ? <code title={value}>{value}</code> : <strong>{value}</strong>}</div>; }
function stateIcon(state: SignatureEvidenceState) { return state === "verified" ? BadgeCheck : state === "incomplete" ? Clock3 : state === "rejected" ? ShieldAlert : XCircle; }
function stateLabel(state: SignatureEvidenceState) { return state === "verified" ? "Verified" : state === "incomplete" ? "Incomplete" : state === "rejected" ? "Rejected" : "Invalid"; }
function stateKicker(state: SignatureEvidenceState) { return state === "verified" ? "Complete offline verification" : state === "incomplete" ? "Evidence incomplete" : state === "rejected" ? "Trust decision rejected" : "Structural rejection"; }
function stateTitle(state: SignatureEvidenceState) { return state === "verified" ? "Publisher evidence verified" : state === "incomplete" ? "More evidence required" : state === "rejected" ? "Signature evidence rejected" : "Evidence pack invalid"; }
function stateSummary(state: SignatureEvidenceState, stages: ReturnType<typeof stageGroups>) {
  const passed = stages.filter((stage) => stage.state === "passed").length;
  if (state === "verified") return "All five independent stages passed against exact local bytes and pinned trust.";
  if (state === "incomplete") return `${passed}/5 stages passed; a required stage is missing, so trust is not complete.`;
  return `${passed}/5 stages passed; one or more stages failed closed.`;
}
function identitySummary(entry: SignatureEvidenceEntry) {
  if (entry.identity?.kind === "keyless") return entry.identity.certificateIdentity ?? "Keyless identity unavailable";
  if (entry.identity?.kind === "public-key") return entry.identity.publicKeySha256 ? `SPKI ${shortHash(entry.identity.publicKeySha256)}` : "Public key unavailable";
  return "Signer identity unavailable";
}
function shortHash(value: string): string { return value.length > 16 ? `${value.slice(0, 9)}…${value.slice(-7)}` : value; }
function formatTime(value: string): string { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Observed"; }
function friendlyError(error: unknown): string { const message = error instanceof Error ? error.message : String(error); return message.length > 240 ? `${message.slice(0, 239)}…` : message; }
