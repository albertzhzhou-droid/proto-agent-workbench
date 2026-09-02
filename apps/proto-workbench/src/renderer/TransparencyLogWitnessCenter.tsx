import {
  ArrowLeft,
  BadgeCheck,
  CircleAlert,
  FileArchive,
  FileCheck2,
  FolderInput,
  FolderOpen,
  GitCompareArrows,
  GitFork,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Network,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  TreePine,
  Waypoints,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type {
  TransparencyWitnessCatalog,
  TransparencyWitnessCheck,
  TransparencyWitnessEntry,
  TransparencyWitnessState,
} from "../shared/contracts.ts";
import { workbenchApi, workbenchDataMode } from "./mock-api.ts";

type WitnessFilter = "all" | "witnessed" | "attention";

export function TransparencyLogWitnessCenter({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const [catalog, setCatalog] = useState<TransparencyWitnessCatalog>();
  const [selectedDirectory, setSelectedDirectory] = useState<string>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<WitnessFilter>("all");
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const generationRef = useRef(0);

  const refresh = async (preferredPackId?: string) => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await workbenchApi().harness.listTransparencyWitnessPacks();
      if (generation !== generationRef.current) return;
      setCatalog(next);
      setSelectedDirectory((current) => {
        const preferred = preferredPackId ?? current;
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
  // Opening this center performs one bounded, local-only scan.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleEntries = useMemo(() => {
    const normalized = query.normalize("NFKC").trim().toLocaleLowerCase();
    return (catalog?.entries ?? []).filter((entry) => {
      if (filter === "witnessed" && entry.state !== "witnessed") return false;
      if (filter === "attention" && !["rejected", "invalid"].includes(entry.state)) return false;
      if (!normalized) return true;
      const corpus = [
        entry.directoryName, entry.packId, entry.state, entry.source, entry.checkpoint?.origin, entry.checkpoint?.treeSize,
        entry.logKeyId, ...entry.diagnostics, ...(entry.witnesses ?? []).flatMap((item) => [item.name, item.keyId, item.state, item.detail]),
        ...entry.checks.flatMap((check) => [check.id, check.label, check.detail]),
      ].filter((value) => value !== undefined).join(" ").toLocaleLowerCase();
      return normalized.split(/\s+/u).every((token) => corpus.includes(token));
    });
  }, [catalog, filter, query]);

  const selected = visibleEntries.find((entry) => entry.directoryName === selectedDirectory) ?? visibleEntries[0];

  const importPack = async () => {
    setImporting(true);
    setActionError(undefined);
    try {
      const receipt = await workbenchApi().harness.importTransparencyWitnessPack();
      if (receipt) await refresh(receipt.packId);
    } catch (importError) {
      setActionError(friendlyError(importError));
    } finally {
      setImporting(false);
    }
  };

  const reveal = async () => {
    if (!selected?.relativePath) return;
    setActionError(undefined);
    try { await workbenchApi().files.reveal(selected.relativePath); }
    catch (revealError) { setActionError(friendlyError(revealError)); }
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
    <section ref={dialogRef} className="verification-center-dialog signature-evidence-dialog transparency-witness-dialog" role="dialog" aria-modal="true" aria-labelledby="transparency-witness-title" onKeyDown={handleKeyDown}>
      <header className="verification-center-heading transparency-witness-heading">
        <span className="verification-center-mark" aria-hidden="true"><Waypoints size={17} /></span>
        <div><span className="eyebrow">Offline append-only proof</span><h2 id="transparency-witness-title">Transparency Log Witness Center</h2><p>Verify signed checkpoints, witness quorum, Merkle inclusion, append-only consistency, rollback, and split-view evidence without contacting the log.</p></div>
        <div className="verification-center-heading-meta">
          {workbenchDataMode() === "preview" && <b>Fixture catalog</b>}
          <code title={catalog?.digest}>{catalog ? shortHash(catalog.digest) : "Not scanned"}</code>
          <button className="secondary-button trust-policy-back" type="button" onClick={onBack}><ArrowLeft size={13} />Signatures</button>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close Transparency Log Witness Center"><X size={15} /></button>
        </div>
      </header>

      <div className="verification-center-toolbar signature-evidence-toolbar transparency-witness-toolbar">
        <label className="verification-center-search">
          <Search size={14} />
          <input ref={searchRef} value={query} maxLength={160} onChange={(event) => setQuery(event.target.value)} aria-label="Search transparency witness packs" placeholder="Search checkpoint, witness, tree size, or diagnostic…" />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear witness search"><X size={13} /></button>}
        </label>
        <div className="verification-center-filters" role="group" aria-label="Transparency witness filters">
          <FilterButton active={filter === "all"} onClick={() => setFilter("all")} label="All" count={catalog?.returnedCount ?? 0} />
          <FilterButton active={filter === "witnessed"} onClick={() => setFilter("witnessed")} label="Witnessed" count={catalog?.summary.witnessed ?? 0} />
          <FilterButton active={filter === "attention"} onClick={() => setFilter("attention")} label="Attention" count={attention} />
        </div>
        <button className="secondary-button signature-evidence-import" type="button" disabled={importing || loading} onClick={() => void importPack()}>
          {importing ? <LoaderCircle className="spin" size={13} /> : <FolderInput size={13} />}{importing ? "Importing…" : "Import witness pack"}
        </button>
        <button className="secondary-button verification-center-refresh" type="button" disabled={loading || importing} onClick={() => void refresh()}>
          {loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{loading ? "Verifying…" : "Refresh"}
        </button>
      </div>

      <section className="verification-center-summary transparency-witness-summary" aria-label="Transparency witness summary">
        <SummaryStat icon={Waypoints} label="Witnessed" value={catalog?.summary.witnessed ?? 0} tone="witnessed" />
        <SummaryStat icon={BadgeCheck} label="Current" value={catalog?.summary.current ?? 0} tone="current" />
        <SummaryStat icon={ShieldAlert} label="Rejected" value={catalog?.summary.rejected ?? 0} tone="rejected" />
        <SummaryStat icon={XCircle} label="Invalid" value={catalog?.summary.invalid ?? 0} tone="invalid" />
        <div className="verification-center-snapshot"><span>Pinned witnessed checkpoint</span><strong>{catalog ? `tree ${formatCount(catalog.policy.anchorTreeSize)} · ${catalog.policy.witnessQuorum}-of-${catalog.policy.witnessCount}` : "—"}</strong><small>{catalog ? `${catalog.policy.origin} · ${shortHash(catalog.policy.anchorBodySha256)}` : "Loading policy"}</small></div>
      </section>

      <div className="verification-center-body transparency-witness-body">
        <aside className="verification-center-list" aria-label="Transparency witness pack results">
          <header><div><strong>Witness packs</strong><span>Content-addressed · immutable imports</span></div><b>{visibleEntries.length}</b></header>
          {loading && !catalog && <div className="verification-center-loading"><LoaderCircle className="spin" size={19} /><strong>Verifying append-only evidence</strong><span>No log or witness connection is permitted.</span></div>}
          {!loading && error && <div className="verification-center-error" role="alert"><CircleAlert size={16} /><div><strong>Witness catalog unavailable</strong><span>{error}</span></div><button type="button" onClick={() => void refresh()}><RefreshCw size={12} />Retry</button></div>}
          {!loading && !error && catalog && visibleEntries.length === 0 && <div className="verification-center-empty"><FileArchive size={20} /><strong>No matching witness pack</strong><span>{catalog.returnedCount ? "Change the search or status filter." : "Import an exact six-file offline witness pack for review."}</span></div>}
          {visibleEntries.length > 0 && <div className="verification-center-listbox" role="listbox" aria-label="Offline transparency witness packs">
            {visibleEntries.map((entry) => <WitnessResult key={entry.directoryName} entry={entry} selected={entry.directoryName === selected?.directoryName} onSelect={() => setSelectedDirectory(entry.directoryName)} />)}
          </div>}
          <div className="verification-center-list-boundary"><LockKeyhole size={12} /><span>Import copies exact bytes only. Fetch, submission, signing, cosigning, and checkpoint advancement are unavailable.</span></div>
        </aside>
        <main className="verification-center-detail">
          {selected ? <WitnessDetail entry={selected} actionError={actionError} onReveal={() => void reveal()} /> : !loading && !error && <div className="verification-center-detail-empty"><ShieldCheck size={23} /><strong>Select a witness pack</strong><span>The signed checkpoint, quorum, and Merkle proof chain will appear here.</span></div>}
        </main>
      </div>

      <footer className="verification-center-footer transparency-witness-footer">
        <LockKeyhole size={13} /><span>{catalog?.boundary ?? "Offline only · checkpoint state cannot advance from this surface."}</span>
        <span><kbd>Tab</kbd> move <kbd>Esc</kbd> close</span>
      </footer>
    </section>
  </div>;
}

function WitnessResult({ entry, selected, onSelect }: { entry: TransparencyWitnessEntry; selected: boolean; onSelect: () => void }) {
  const Icon = stateIcon(entry.state);
  return <button type="button" role="option" aria-selected={selected} className={`verification-bundle-result transparency-witness-result is-${entry.state} ${selected ? "is-active" : ""}`} onClick={onSelect}>
    <span className="verification-bundle-result-icon"><Icon size={14} /></span>
    <span className="verification-bundle-result-copy">
      <span><strong>{entry.state === "witnessed" ? "Append-only checkpoint" : entry.state === "current" ? "Pinned checkpoint match" : entry.state === "rejected" ? "Transparency conflict" : "Unreadable witness pack"}</strong><em>{stateLabel(entry.state)}</em></span>
      <code>{entry.checkpoint ? `tree ${formatCount(entry.anchor?.treeSize ?? "0")} → ${formatCount(entry.checkpoint.treeSize)}` : entry.packId ?? entry.directoryName}</code>
      <small>{entry.witnessQuorum ? `${entry.witnessQuorum.verified}-of-${entry.witnessQuorum.configured} witnesses` : "Witnesses unavailable"}{entry.observedModifiedAt ? ` · ${formatTime(entry.observedModifiedAt)}` : ""}</small>
    </span>
  </button>;
}

function WitnessDetail({ entry, actionError, onReveal }: { entry: TransparencyWitnessEntry; actionError?: string; onReveal: () => void }) {
  const Icon = stateIcon(entry.state);
  const stages = witnessStages(entry.checks);
  const passed = stages.filter((stage) => stage.state === "passed").length;
  return <>
    <header className={`verification-detail-hero transparency-witness-hero is-${entry.state}`}>
      <span><Icon size={18} /></span>
      <div><small>{stateKicker(entry.state)}</small><h3>{stateTitle(entry.state)}</h3><p>{stateSummary(entry.state, passed)}</p></div>
      <div className="verification-identity-badge signature-identity-badge transparency-quorum-badge"><Network size={12} /><span><strong>{entry.witnessQuorum ? `${entry.witnessQuorum.verified}-of-${entry.witnessQuorum.configured} witnesses` : "Quorum unavailable"}</strong><small>{entry.witnessQuorum ? `Policy requires ${entry.witnessQuorum.required}` : "No configured quorum"}</small></span></div>
    </header>
    <div className="verification-detail-scroll transparency-witness-scroll">
      <section className="signature-stage-chain transparency-stage-chain" aria-label="Six-stage transparency proof chain">
        <header><div><strong>Independent transparency chain</strong><span>Pack → log signature → witness quorum → leaf inclusion → append-only consistency → fork guard</span></div><b>{passed}/6</b></header>
        <div>{stages.map((stage, index) => {
          const StageIcon = stage.icon;
          const StatusIcon = stage.state === "passed" ? BadgeCheck : stage.state === "failed" ? XCircle : CircleAlert;
          return <article className={`is-${stage.state}`} key={stage.id}><span className="signature-stage-index">0{index + 1}</span><StageIcon size={15} /><div><small>{stage.kicker}</small><strong>{stage.label}</strong><p>{stage.detail}</p></div><StatusIcon className="signature-stage-status" size={14} /></article>;
        })}</div>
      </section>

      <section className="transparency-checkpoint-table" aria-label="Pinned and candidate checkpoints">
        <header><div><strong>Checkpoint continuity</strong><span>Tree size and root are read only from verified signed notes.</span></div><b>{entry.logKeyId ? `LOG ${entry.logKeyId}` : "LOG KEY UNKNOWN"}</b></header>
        <div className="transparency-checkpoint-head"><span>Checkpoint</span><span>Tree size</span><span>Merkle root</span><span>Body digest</span><span>State</span></div>
        <CheckpointRow label="Pinned anchor" checkpoint={entry.anchor} state={checkState(entry.checks, "anchor-checkpoint")} />
        <CheckpointRow label="Candidate" checkpoint={entry.checkpoint} state={aggregate(entry.checks, ["checkpoint-format", "log-signature", "rollback-protection", "fork-detection"])} />
      </section>

      <section className="transparency-witness-quorum" aria-label="Witness cosignature quorum">
        <header><div><strong>Independent witness quorum</strong><span>Unknown signatures are ignored; configured invalid signatures fail closed.</span></div><b>{entry.witnessQuorum ? `${entry.witnessQuorum.verified}/${entry.witnessQuorum.required}` : "0/0"}</b></header>
        <div>{(entry.witnesses ?? []).map((witness) => <article className={`is-${witness.state}`} key={`${witness.name}:${witness.keyId}`}><span><KeyRound size={12} /></span><div><strong>{witness.name}</strong><code>{witness.keyId}</code><small>{witness.signedAt ? formatTime(witness.signedAt) : witness.detail}</small></div><em>{witness.state === "verified" ? <BadgeCheck size={11} /> : <XCircle size={11} />}{witness.state}</em></article>)}</div>
      </section>

      <section className="verification-facts signature-evidence-facts transparency-witness-facts" aria-label="Bound transparency facts">
        <header><strong>Bound proof facts</strong><span>Proof counts and leaf bytes are shown separately from the trust decision.</span></header>
        <div>
          <Fact label="Pack ID" value={entry.packId ?? entry.directoryName} mono />
          <Fact label="Checkpoint origin" value={entry.checkpoint?.origin ?? "Unavailable"} mono />
          <Fact label="Included leaf" value={entry.inclusion ? `index ${formatCount(entry.inclusion.logIndex)} · ${shortHash(entry.inclusion.leafSha256)}` : "Unavailable"} mono />
          <Fact label="Inclusion path" value={entry.inclusion ? `${entry.inclusion.proofHashCount} hashes · tree ${formatCount(entry.inclusion.treeSize)}` : "Unavailable"} />
          <Fact label="Consistency range" value={entry.consistency ? `${formatCount(entry.consistency.oldSize)} → ${formatCount(entry.consistency.newSize)}` : "Unavailable"} />
          <Fact label="Consistency path" value={entry.consistency ? `${entry.consistency.proofHashCount} hashes` : "Unavailable"} />
        </div>
      </section>

      <section className={`verification-diagnostics ${entry.diagnostics.length ? "has-findings" : ""}`} aria-label="Transparency diagnostics">
        <header><strong>{entry.diagnostics.length ? "Transparency diagnostics" : "No transparency diagnostic"}</strong><span>{entry.diagnostics.length ? `${entry.diagnostics.length} tamper or continuity finding${entry.diagnostics.length === 1 ? "" : "s"}` : "All required offline checkpoint and Merkle stages passed."}</span></header>
        {entry.diagnostics.map((item) => { const [code, ...detail] = item.split(":"); return <article key={item}><XCircle size={13} /><div><code>{code}</code><strong>Checkpoint rejected</strong><p>{detail.join(":").trim() || item}</p></div></article>; })}
      </section>

      <div className="verification-auth-boundary signature-auth-boundary transparency-auth-boundary"><LockKeyhole size={13} /><div><strong>Evidence is deliberately separate from witness state</strong><span>This center verifies supplied bytes only. It cannot contact a witness, publish or cosign a checkpoint, persist a newer witness state, replace policy, or authorize a release.</span></div></div>
    </div>
    <footer className="verification-detail-footer">
      <span><LockKeyhole size={12} />Offline snapshot · exactly six files · no network fallback.</span>
      {actionError && <em role="alert">{actionError}</em>}
      <button className="secondary-button" type="button" disabled={!entry.relativePath} onClick={onReveal}><FolderOpen size={13} />Reveal witness pack</button>
    </footer>
  </>;
}

function witnessStages(checks: TransparencyWitnessCheck[]) {
  return [
    { id: "pack", icon: FileArchive, kicker: "Exact bytes", label: "Immutable pack", state: aggregate(checks, ["directory", "entries", "checksums", "source-record", "policy-anchor", "anchor-checkpoint"]), detail: detailFor(checks, "anchor-checkpoint") },
    { id: "log", icon: FileCheck2, kicker: "Signed note", label: "Log checkpoint", state: aggregate(checks, ["checkpoint-format", "log-signature"]), detail: detailFor(checks, "log-signature") },
    { id: "witness", icon: Network, kicker: "Independent views", label: "Witness quorum", state: aggregate(checks, ["witness-quorum", "witness-time"]), detail: detailFor(checks, "witness-quorum") },
    { id: "inclusion", icon: TreePine, kicker: "Exact leaf", label: "Merkle inclusion", state: aggregate(checks, ["leaf-binding", "inclusion-structure", "inclusion-proof"]), detail: detailFor(checks, "inclusion-proof") },
    { id: "consistency", icon: GitCompareArrows, kicker: "Append only", label: "Merkle consistency", state: aggregate(checks, ["consistency-structure", "consistency-proof", "rollback-protection"]), detail: detailFor(checks, "consistency-proof") },
    { id: "fork", icon: GitFork, kicker: "Split view", label: "Split-view detection", state: aggregate(checks, ["fork-detection"]), detail: detailFor(checks, "fork-detection") },
  ];
}

function CheckpointRow({ label, checkpoint, state }: { label: string; checkpoint?: TransparencyWitnessEntry["checkpoint"]; state: TransparencyWitnessCheck["state"] }) {
  const Icon = state === "passed" ? BadgeCheck : state === "failed" ? XCircle : CircleAlert;
  return <div className={`transparency-checkpoint-row is-${state}`}><strong>{label}</strong><code>{checkpoint ? formatCount(checkpoint.treeSize) : "—"}</code><code title={checkpoint?.rootHash}>{checkpoint ? shortHash(checkpoint.rootHash) : "Unavailable"}</code><code title={checkpoint?.bodySha256}>{checkpoint ? shortHash(checkpoint.bodySha256) : "Unavailable"}</code><em><Icon size={11} />{state === "passed" ? "Verified" : state === "failed" ? "Rejected" : "Blocked"}</em></div>;
}

function aggregate(checks: TransparencyWitnessCheck[], ids: TransparencyWitnessCheck["id"][]): TransparencyWitnessCheck["state"] {
  const states = ids.map((id) => checkState(checks, id));
  if (states.includes("failed")) return "failed";
  if (states.includes("not-checked")) return "not-checked";
  return "passed";
}

function checkState(checks: TransparencyWitnessCheck[], id: TransparencyWitnessCheck["id"]): TransparencyWitnessCheck["state"] { return checks.find((check) => check.id === id)?.state ?? "not-checked"; }
function detailFor(checks: TransparencyWitnessCheck[], id: TransparencyWitnessCheck["id"]): string { return checks.find((check) => check.id === id)?.detail ?? "Not checked."; }
function FilterButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) { return <button type="button" aria-pressed={active} onClick={onClick}><span>{label}</span><b>{count}</b></button>; }
function SummaryStat({ icon: Icon, label, value, tone }: { icon: typeof BadgeCheck; label: string; value: number; tone: string }) { return <div className={`verification-summary-stat is-${tone}`}><span><Icon size={13} />{label}</span><strong>{value}</strong></div>; }
function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div><span>{label}</span>{mono ? <code title={value}>{value}</code> : <strong>{value}</strong>}</div>; }
function stateIcon(state: TransparencyWitnessState) { return state === "witnessed" ? Waypoints : state === "current" ? BadgeCheck : state === "rejected" ? ShieldAlert : XCircle; }
function stateLabel(state: TransparencyWitnessState) { return state === "witnessed" ? "Witnessed" : state === "current" ? "Current" : state === "rejected" ? "Rejected" : "Invalid"; }
function stateKicker(state: TransparencyWitnessState) { return state === "witnessed" ? "Append-only continuity verified" : state === "current" ? "Pinned checkpoint match" : state === "rejected" ? "Tamper signal retained" : "Structural rejection"; }
function stateTitle(state: TransparencyWitnessState) { return state === "witnessed" ? "Witnessed checkpoint verified" : state === "current" ? "Pinned checkpoint is current" : state === "rejected" ? "Checkpoint continuity rejected" : "Witness pack invalid"; }
function stateSummary(state: TransparencyWitnessState, passed: number) {
  if (state === "witnessed") return "Log signature, witness quorum, inclusion, and append-only consistency all passed against the pinned checkpoint.";
  if (state === "current") return "Candidate exactly matches the pinned tree size and root; no witness-state advance is required.";
  return `${passed}/6 transparency stages passed; rollback, fork, or proof evidence failed closed and remains visible.`;
}
function shortHash(value: string): string { return value.length > 16 ? `${value.slice(0, 9)}…${value.slice(-7)}` : value; }
function formatCount(value: string): string { try { return BigInt(value).toLocaleString(); } catch { return value; } }
function formatTime(value: string): string { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Observed"; }
function friendlyError(error: unknown): string { const message = error instanceof Error ? error.message : String(error); return message.length > 240 ? `${message.slice(0, 239)}…` : message; }
