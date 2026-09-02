import {
  ArrowLeft,
  BadgeCheck,
  CircleAlert,
  FileKey,
  Fingerprint,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  ShieldCheck,
  ScanSearch,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type {
  TrustPolicyAuthorityInput,
  TrustPolicyCatalog,
  TrustPolicyCatalogEntry,
  TrustPolicyExportReceipt,
  TrustPolicyPreview,
  TrustPolicyRequest,
} from "../shared/contracts.ts";
import { workbenchApi, workbenchDataMode } from "./mock-api.ts";

type PolicyFilter = "all" | "valid" | "attention";
type PolicyMode = "catalog" | "builder";
type DraftAuthority = TrustPolicyAuthorityInput & { clientId: string };

interface PolicyDraft {
  name: string;
  description: string;
  pinCurrentModuleManifest: boolean;
  authorities: DraftAuthority[];
}

const EMPTY_DRAFT: PolicyDraft = {
  name: "",
  description: "",
  pinCurrentModuleManifest: true,
  authorities: [{
    clientId: "authority-1",
    kind: "keyless",
    name: "Release workflow",
    issuer: "https://token.actions.githubusercontent.com",
    subject: "",
  }],
};

export function TrustPolicyCenter({ onBack, onClose, onEvidence }: { onBack: () => void; onClose: () => void; onEvidence?: () => void }) {
  const [catalog, setCatalog] = useState<TrustPolicyCatalog>();
  const [selectedDirectory, setSelectedDirectory] = useState<string>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PolicyFilter>("all");
  const [mode, setMode] = useState<PolicyMode>("catalog");
  const [draft, setDraft] = useState<PolicyDraft>(EMPTY_DRAFT);
  const [preview, setPreview] = useState<TrustPolicyPreview>();
  const [receipt, setReceipt] = useState<TrustPolicyExportReceipt>();
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<"preview" | "export">();
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [revealError, setRevealError] = useState<string>();
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const generationRef = useRef(0);

  const refresh = async (preferredPolicyId?: string) => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(undefined);
    setRevealError(undefined);
    try {
      const next = await workbenchApi().harness.listTrustPolicies();
      if (generation !== generationRef.current) return;
      setCatalog(next);
      setSelectedDirectory((current) => {
        const preferred = preferredPolicyId ?? current;
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
  // The catalog read is triggered by an explicit user-opened audit surface.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleEntries = useMemo(() => {
    const normalized = query.normalize("NFKC").trim().toLocaleLowerCase();
    return (catalog?.entries ?? []).filter((entry) => {
      if (filter === "valid" && entry.state !== "valid") return false;
      if (filter === "attention" && entry.state === "valid") return false;
      if (!normalized) return true;
      const corpus = [
        entry.directoryName,
        entry.policyId,
        entry.name,
        entry.description,
        entry.state,
        ...entry.diagnostics.flatMap((item) => [item.code, item.title]),
        ...(entry.authorities ?? []).flatMap((authority) => authority.kind === "keyless"
          ? [authority.name, authority.certificateIssuer, authority.certificateIdentity]
          : [authority.name, authority.publicKeySha256]),
      ].filter(Boolean).join(" ").toLocaleLowerCase();
      return normalized.split(/\s+/u).every((token) => corpus.includes(token));
    });
  }, [catalog, filter, query]);

  const selected = visibleEntries.find((entry) => entry.directoryName === selectedDirectory) ?? visibleEntries[0];
  const request = policyRequest(draft);
  const canPreview = policyDraftReady(request);

  const updateDraft = (updater: (current: PolicyDraft) => PolicyDraft) => {
    setDraft(updater);
    setPreview(undefined);
    setReceipt(undefined);
    setActionError(undefined);
  };

  const previewPolicy = async () => {
    if (!canPreview) return;
    setAction("preview");
    setActionError(undefined);
    try {
      setPreview(await workbenchApi().harness.previewTrustPolicy(request));
      setReceipt(undefined);
    } catch (previewError) {
      setActionError(friendlyError(previewError));
    } finally {
      setAction(undefined);
    }
  };

  const exportPolicy = async () => {
    if (!preview) return;
    setAction("export");
    setActionError(undefined);
    try {
      const nextReceipt = await workbenchApi().harness.exportTrustPolicy({ ...request, expectedPolicyDigest: preview.policyDigest });
      setReceipt(nextReceipt);
      await refresh(nextReceipt.policyId);
      setMode("catalog");
    } catch (exportError) {
      setActionError(friendlyError(exportError));
    } finally {
      setAction(undefined);
    }
  };

  const reveal = async () => {
    if (!selected?.relativePath) return;
    setRevealError(undefined);
    try {
      await workbenchApi().files.reveal(selected.relativePath);
    } catch (openError) {
      setRevealError(friendlyError(openError));
    }
  };

  const beginPolicy = () => {
    setDraft(structuredClone(EMPTY_DRAFT));
    setPreview(undefined);
    setReceipt(undefined);
    setActionError(undefined);
    setMode("builder");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])") ?? [])];
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

  return <div className="verification-center-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} className="verification-center-dialog trust-policy-center-dialog" role="dialog" aria-modal="true" aria-labelledby="trust-policy-center-title" onKeyDown={handleKeyDown}>
      <header className="verification-center-heading trust-policy-center-heading">
        <span className="verification-center-mark" aria-hidden="true"><KeyRound size={17} /></span>
        <div><span className="eyebrow">Publisher trust rules</span><h2 id="trust-policy-center-title">Trust Policy Center</h2><p>Define exact identities after cryptographic verification—never infer trust from policy text alone.</p></div>
        <div className="verification-center-heading-meta">
          {workbenchDataMode() === "preview" && <b>Fixture catalog</b>}
          <code title={catalog?.digest}>{catalog ? shortHash(catalog.digest) : "Not scanned"}</code>
          {onEvidence && <button className="secondary-button trust-policy-evidence" type="button" onClick={onEvidence}><ScanSearch size={13} />Evidence</button>}
          <button className="secondary-button trust-policy-back" type="button" onClick={onBack}><ArrowLeft size={13} />Bundles</button>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close Trust Policy Center"><X size={15} /></button>
        </div>
      </header>

      <div className="verification-center-toolbar trust-policy-toolbar">
        <label className="verification-center-search">
          <Search size={14} />
          <input ref={searchRef} value={query} maxLength={160} disabled={mode === "builder"} onChange={(event) => setQuery(event.target.value)} aria-label="Search trust policies" placeholder="Search policy, authority, identity, or diagnostic…" />
          {query && mode === "catalog" && <button type="button" onClick={() => setQuery("")} aria-label="Clear policy search"><X size={13} /></button>}
        </label>
        <div className="verification-center-filters" role="group" aria-label="Trust Policy result filters">
          <PolicyFilterButton active={filter === "all"} disabled={mode === "builder"} onClick={() => setFilter("all")} label="All" count={catalog?.returnedCount ?? 0} />
          <PolicyFilterButton active={filter === "valid"} disabled={mode === "builder"} onClick={() => setFilter("valid")} label="Policy intact" count={catalog?.summary.valid ?? 0} />
          <PolicyFilterButton active={filter === "attention"} disabled={mode === "builder"} onClick={() => setFilter("attention")} label="Attention" count={(catalog?.summary.tampered ?? 0) + (catalog?.summary.invalid ?? 0)} />
        </div>
        <button className="secondary-button trust-policy-new" type="button" onClick={mode === "builder" ? () => setMode("catalog") : beginPolicy}>
          {mode === "builder" ? <ArrowLeft size={13} /> : <Plus size={13} />}{mode === "builder" ? "Catalog" : "New policy"}
        </button>
        <button className="secondary-button verification-center-refresh" type="button" disabled={loading || mode === "builder"} onClick={() => void refresh()}>
          {loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{loading ? "Scanning…" : "Refresh"}
        </button>
      </div>

      <section className="verification-center-summary trust-policy-summary" aria-label="Trust Policy summary">
        <PolicySummary icon={BadgeCheck} label="Policy intact" value={catalog?.summary.valid ?? 0} tone="verified" />
        <PolicySummary icon={ShieldAlert} label="Tampered" value={catalog?.summary.tampered ?? 0} tone="tampered" />
        <PolicySummary icon={XCircle} label="Invalid" value={catalog?.summary.invalid ?? 0} tone="invalid" />
        <PolicySummary icon={Fingerprint} label="Authorities" value={catalog?.summary.authorities ?? 0} tone="unsigned" />
        <div className="verification-center-snapshot"><span>Catalog scope</span><strong>{catalog ? `${catalog.returnedCount}/${catalog.scannedDirectoryCount}` : "—"}</strong><small>{catalog?.truncated ? `Bounded at ${catalog.limits.maxDirectories}` : "All matching policies"}</small></div>
      </section>

      <div className="verification-center-body trust-policy-body">
        <aside className="verification-center-list trust-policy-list" aria-label="Trust Policy catalog">
          <header><div><strong>Trust policies</strong><span>Immutable rules · never auto-activated</span></div><b>{visibleEntries.length}</b></header>
          {loading && !catalog && <div className="verification-center-loading"><LoaderCircle className="spin" size={19} /><strong>Reading policy artifacts</strong><span>No file is created or changed.</span></div>}
          {!loading && error && <div className="verification-center-error" role="alert"><CircleAlert size={16} /><div><strong>Policy catalog unavailable</strong><span>{error}</span></div><button type="button" onClick={() => void refresh()}><RefreshCw size={12} />Retry</button></div>}
          {!loading && !error && catalog && visibleEntries.length === 0 && <div className="verification-center-empty"><FileKey size={20} /><strong>No matching policy</strong><span>{catalog.returnedCount ? "Change the search or status filter." : "Create an immutable Trust Policy to define exact authority constraints."}</span></div>}
          {visibleEntries.length > 0 && <div className="verification-center-listbox" role="listbox" aria-label="Trust Policies">
            {visibleEntries.map((entry) => <PolicyResult key={entry.directoryName} entry={entry} selected={entry.directoryName === selected?.directoryName} onSelect={() => { setMode("catalog"); setSelectedDirectory(entry.directoryName); }} />)}
          </div>}
          <div className="verification-center-list-boundary"><LockKeyhole size={12} /><span>Exact rules only. No regex, private key, secret, or activation state is stored.</span></div>
        </aside>

        <main className="verification-center-detail trust-policy-detail">
          {mode === "builder"
            ? <PolicyBuilder draft={draft} preview={preview} receipt={receipt} action={action} error={actionError} canPreview={canPreview} onUpdate={updateDraft} onPreview={() => void previewPolicy()} onExport={() => void exportPolicy()} />
            : selected
              ? <PolicyDetail entry={selected} revealError={revealError} onReveal={() => void reveal()} onCreate={beginPolicy} />
              : !loading && !error && <div className="verification-center-detail-empty"><ShieldCheck size={23} /><strong>Select or create a Trust Policy</strong><span>Rules constrain verified identities only after signature and trusted-time checks succeed.</span><button className="secondary-button" type="button" onClick={beginPolicy}><Plus size={13} />New policy</button></div>}
        </main>
      </div>

      <footer className="verification-center-footer">
        <LockKeyhole size={13} /><span>{catalog?.boundary ?? "A policy is a rule set—not signature evidence, key material, or an activated trust decision."}</span>
        <span><kbd>Tab</kbd> move <kbd>Esc</kbd> close</span>
      </footer>
    </section>
  </div>;
}

function PolicyBuilder({ draft, preview, receipt, action, error, canPreview, onUpdate, onPreview, onExport }: {
  draft: PolicyDraft;
  preview?: TrustPolicyPreview;
  receipt?: TrustPolicyExportReceipt;
  action?: "preview" | "export";
  error?: string;
  canPreview: boolean;
  onUpdate: (updater: (current: PolicyDraft) => PolicyDraft) => void;
  onPreview: () => void;
  onExport: () => void;
}) {
  const updateAuthority = (clientId: string, next: DraftAuthority) => onUpdate((current) => ({
    ...current,
    authorities: current.authorities.map((authority) => authority.clientId === clientId ? next : authority),
  }));
  const addAuthority = () => onUpdate((current) => current.authorities.length >= 8 ? current : ({
    ...current,
    authorities: [...current.authorities, {
      clientId: `authority-${Date.now()}-${current.authorities.length}`,
      kind: "keyless",
      name: `Authority ${current.authorities.length + 1}`,
      issuer: "https://token.actions.githubusercontent.com",
      subject: "",
    }],
  }));
  const removeAuthority = (clientId: string) => onUpdate((current) => current.authorities.length === 1 ? current : ({
    ...current,
    authorities: current.authorities.filter((authority) => authority.clientId !== clientId),
  }));

  return <>
    <header className="verification-detail-hero trust-policy-builder-hero">
      <span><FileKey size={18} /></span>
      <div><small>Immutable policy draft</small><h3>Define exact authorities</h3><p>Any listed authority may satisfy the policy—but only after independent cryptographic verification.</p></div>
      <div className="verification-identity-badge"><ShieldAlert size={12} /><span><strong>Rules only</strong><small>No trust activated</small></span></div>
    </header>
    <div className="verification-detail-scroll trust-policy-builder-scroll">
      <section className="trust-policy-form" aria-label="Trust Policy builder">
        <header><div><strong>Policy identity</strong><span>Content changes produce a new policy ID; existing artifacts are never overwritten.</span></div>{preview && <code>{shortHash(preview.policyDigest)}</code>}</header>
        <div className="trust-policy-form-grid">
          <label><span>Policy name</span><input autoFocus value={draft.name} maxLength={96} onChange={(event) => onUpdate((current) => ({ ...current, name: event.target.value }))} placeholder="Release identity policy" /></label>
          <label className="trust-policy-description"><span>Description</span><textarea value={draft.description} maxLength={512} onChange={(event) => onUpdate((current) => ({ ...current, description: event.target.value }))} placeholder="Explain when this exact identity set should be used." /></label>
          <label className="trust-policy-pin"><input type="checkbox" checked={draft.pinCurrentModuleManifest} onChange={(event) => onUpdate((current) => ({ ...current, pinCurrentModuleManifest: event.target.checked }))} /><span><strong>Pin current module manifest</strong><small>Restrict this policy to bundles produced by the currently verified module set.</small></span></label>
        </div>
      </section>

      <section className="trust-policy-authorities" aria-label="Trust Policy authorities">
        <header><div><strong>Exact authorities</strong><span>Any-of · 1–8 identities · no regular expressions</span></div><button className="secondary-button" type="button" disabled={draft.authorities.length >= 8} onClick={addAuthority}><Plus size={12} />Add authority</button></header>
        <div>{draft.authorities.map((authority, index) => <AuthorityEditor key={authority.clientId} authority={authority} index={index} removable={draft.authorities.length > 1} onChange={(next) => updateAuthority(authority.clientId, next)} onRemove={() => removeAuthority(authority.clientId)} />)}</div>
      </section>

      <section className="trust-policy-verification-contract" aria-label="Trust Policy verification contract">
        <header><strong>Verification contract</strong><span>Policy evaluation starts only after every required cryptographic input is validated.</span></header>
        <div>
          <ContractItem icon={BadgeCheck} title="Artifact digest" detail="Decision Bundle subject and bytes must bind." />
          <ContractItem icon={Fingerprint} title="Exact authority" detail="Issuer + subject or public-key SHA-256." />
          <ContractItem icon={KeyRound} title="Signed time" detail="Signed log promise or trusted timestamp required." />
          <ContractItem icon={LockKeyhole} title="Offline input" detail="Policy evaluation performs no network fetch." />
        </div>
      </section>

      {preview && <div className="trust-policy-preview-card"><BadgeCheck size={15} /><div><strong>Policy preview ready</strong><span>{preview.policyId} · {preview.verification.authorities.length} exact {preview.verification.authorities.length === 1 ? "authority" : "authorities"}</span><small>This is still a rule artifact; no bundle signature has been evaluated.</small></div></div>}
      {receipt && <div className="trust-policy-preview-card is-exported"><Save size={15} /><div><strong>{receipt.reused ? "Exact policy reused" : "Immutable policy exported"}</strong><span>{receipt.relativePath}</span></div></div>}
      {error && <div className="verification-center-error trust-policy-action-error" role="alert"><CircleAlert size={15} /><div><strong>Policy action failed</strong><span>{error}</span></div></div>}
    </div>
    <footer className="verification-detail-footer trust-policy-builder-footer">
      <span><LockKeyhole size={12} />Export writes one immutable rule artifact under build/trust-policies; it does not activate trust.</span>
      <button className="secondary-button" type="button" disabled={!canPreview || Boolean(action)} onClick={onPreview}>{action === "preview" ? <LoaderCircle className="spin" size={13} /> : <ShieldCheck size={13} />}Preview policy</button>
      <button className="primary-button" type="button" disabled={!preview || Boolean(action)} onClick={onExport}>{action === "export" ? <LoaderCircle className="spin" size={13} /> : <Save size={13} />}Export immutable policy</button>
    </footer>
  </>;
}

function AuthorityEditor({ authority, index, removable, onChange, onRemove }: { authority: DraftAuthority; index: number; removable: boolean; onChange: (next: DraftAuthority) => void; onRemove: () => void }) {
  const switchKind = (kind: "keyless" | "public-key") => {
    if (kind === "keyless") onChange({ clientId: authority.clientId, kind, name: authority.name, issuer: "https://token.actions.githubusercontent.com", subject: "" });
    else onChange({ clientId: authority.clientId, kind, name: authority.name, publicKeySha256: "" });
  };
  return <article className="trust-policy-authority-card">
    <header><span>{authority.kind === "keyless" ? <Fingerprint size={13} /> : <KeyRound size={13} />}<strong>Authority {index + 1}</strong></span><select aria-label={`Authority ${index + 1} type`} value={authority.kind} onChange={(event) => switchKind(event.target.value as "keyless" | "public-key")}><option value="keyless">Keyless identity</option><option value="public-key">Public-key digest</option></select><button className="icon-button" type="button" disabled={!removable} onClick={onRemove} aria-label={`Remove authority ${index + 1}`}><Trash2 size={13} /></button></header>
    <div>
      <label><span>Label</span><input value={authority.name} maxLength={64} onChange={(event) => onChange({ ...authority, name: event.target.value })} placeholder="Release workflow" /></label>
      {authority.kind === "keyless" ? <>
        <label><span>Certificate issuer · exact</span><input value={authority.issuer} maxLength={512} onChange={(event) => onChange({ ...authority, issuer: event.target.value })} placeholder="https://token.actions.githubusercontent.com" /></label>
        <label className="trust-policy-authority-wide"><span>Certificate identity · exact</span><input value={authority.subject} maxLength={512} onChange={(event) => onChange({ ...authority, subject: event.target.value })} placeholder="https://github.com/org/repo/.github/workflows/release.yml@refs/heads/main" /></label>
      </> : <label className="trust-policy-authority-wide"><span>Public key SHA-256</span><input value={authority.publicKeySha256} maxLength={64} onChange={(event) => onChange({ ...authority, publicKeySha256: event.target.value.toLocaleLowerCase() })} placeholder="64 lowercase hexadecimal characters" /></label>}
    </div>
  </article>;
}

function PolicyDetail({ entry, revealError, onReveal, onCreate }: { entry: TrustPolicyCatalogEntry; revealError?: string; onReveal: () => void; onCreate: () => void }) {
  const valid = entry.state === "valid";
  const Icon = valid ? BadgeCheck : entry.state === "tampered" ? ShieldAlert : XCircle;
  return <>
    <header className={`verification-detail-hero trust-policy-detail-hero is-${entry.state}`}>
      <span><Icon size={18} /></span>
      <div><small>{valid ? "Canonical rule artifact" : entry.state === "tampered" ? "Policy integrity failure" : "Policy structural failure"}</small><h3>{valid ? entry.name : entry.state === "tampered" ? "Policy tampering detected" : "Policy rejected"}</h3><p>{valid ? `${entry.authorities?.length ?? 0} exact ${(entry.authorities?.length ?? 0) === 1 ? "authority" : "authorities"}; no signature has been evaluated.` : "This policy cannot participate in an identity decision."}</p></div>
      <div className="verification-identity-badge"><ShieldAlert size={12} /><span><strong>Not activated</strong><small>No identity verified</small></span></div>
    </header>
    <div className="verification-detail-scroll">
      {valid && <>
        <section className="trust-policy-readiness" aria-label="Trust Policy readiness">
          <header><div><strong>Identity verification readiness</strong><span>Rules are ready; cryptographic evidence is still absent.</span></div><b>1/4 ready</b></header>
          <div>
            <ReadinessItem state="ready" title="Policy artifact" detail="Canonical digest and checksum matched." />
            <ReadinessItem state="waiting" title="Signature bundle" detail="No DSSE/Sigstore bundle evaluated." />
            <ReadinessItem state="waiting" title="Trusted root & time" detail="No signed time evidence evaluated." />
            <ReadinessItem state="waiting" title="Authority match" detail="Exact identity rules have not run." />
          </div>
        </section>
        <section className="trust-policy-authority-list" aria-label="Configured Trust Policy authorities">
          <header><strong>Configured authorities</strong><span>Any one may satisfy the policy after cryptographic verification.</span></header>
          <div>{entry.authorities?.map((authority) => <article key={`${authority.kind}:${authority.name}`}><span>{authority.kind === "keyless" ? <Fingerprint size={14} /> : <KeyRound size={14} />}</span><div><strong>{authority.name}</strong><small>{authority.kind === "keyless" ? "Keyless identity · transparency log required" : "Pinned public-key digest"}</small><code>{authority.kind === "keyless" ? authority.certificateIssuer : shortHash(authority.publicKeySha256)}</code>{authority.kind === "keyless" && <code>{authority.certificateIdentity}</code>}</div></article>)}</div>
        </section>
        <section className="verification-facts trust-policy-facts" aria-label="Trust Policy facts">
          <header><strong>Policy scope</strong><span>Exact policy facts from the canonical artifact.</span></header>
          <div>
            <PolicyFact label="Policy ID" value={entry.policyId ?? entry.directoryName} mono />
            <PolicyFact label="Policy digest" value={entry.policyDigest ? shortHash(entry.policyDigest) : "Unavailable"} mono />
            <PolicyFact label="Current JSON SHA-256" value={entry.policySha256 ? shortHash(entry.policySha256) : "Unavailable"} mono />
            <PolicyFact label="Decision Bundle media" value="Pinned" />
            <PolicyFact label="in-toto Statement" value="v1" />
            <PolicyFact label="Module manifest" value={entry.moduleManifestSha256 ? shortHash(entry.moduleManifestSha256) : "Any verified manifest"} mono={Boolean(entry.moduleManifestSha256)} />
          </div>
        </section>
      </>}
      <section className={`verification-diagnostics ${entry.diagnostics.length ? "has-findings" : ""}`} aria-label="Trust Policy diagnostics">
        <header><strong>{entry.diagnostics.length ? "Policy diagnostics" : "No policy diagnostic"}</strong><span>{entry.diagnostics.length ? `${entry.diagnostics.length} fail-closed finding${entry.diagnostics.length === 1 ? "" : "s"}` : "The policy artifact is canonical and content-addressed."}</span></header>
        {entry.diagnostics.map((item) => <article key={`${item.code}:${item.title}`}><XCircle size={13} /><div><code>{item.code}</code><strong>{item.title}</strong><p>{item.detail}</p></div></article>)}
      </section>
      <div className="verification-auth-boundary"><Fingerprint size={13} /><div><strong>A policy is not proof of identity</strong><span>Publisher identity remains unverified until a supported signature bundle, artifact digest, trusted root, signed time evidence, and one exact authority all verify together.</span></div></div>
    </div>
    <footer className="verification-detail-footer">
      <span><LockKeyhole size={12} />Catalog snapshot only · policies are never selected or activated automatically.</span>
      {revealError && <em role="alert">{revealError}</em>}
      <button className="secondary-button" type="button" onClick={onCreate}><Plus size={13} />New policy</button>
      <button className="secondary-button" type="button" disabled={!entry.relativePath} onClick={onReveal}><FolderOpen size={13} />Reveal policy</button>
    </footer>
  </>;
}

function PolicyResult({ entry, selected, onSelect }: { entry: TrustPolicyCatalogEntry; selected: boolean; onSelect: () => void }) {
  const Icon = entry.state === "valid" ? BadgeCheck : entry.state === "tampered" ? ShieldAlert : XCircle;
  return <button type="button" role="option" aria-selected={selected} className={`verification-bundle-result trust-policy-result is-${entry.state} ${selected ? "is-active" : ""}`} onClick={onSelect}>
    <span className="verification-bundle-result-icon"><Icon size={14} /></span>
    <span className="verification-bundle-result-copy"><span><strong>{entry.name ?? "Unreadable policy"}</strong><em>{entry.state === "valid" ? "Policy intact" : entry.state === "tampered" ? "Tampered" : "Invalid"}</em></span><code>{entry.policyId ?? entry.directoryName}</code><small>{entry.state === "valid" ? `${entry.authorities?.length ?? 0} exact ${(entry.authorities?.length ?? 0) === 1 ? "authority" : "authorities"} · not activated` : "Cannot evaluate identity"}{entry.observedModifiedAt ? ` · ${formatTime(entry.observedModifiedAt)}` : ""}</small></span>
  </button>;
}

function PolicyFilterButton({ active, disabled, onClick, label, count }: { active: boolean; disabled: boolean; onClick: () => void; label: string; count: number }) {
  return <button type="button" disabled={disabled} aria-pressed={active} onClick={onClick}><span>{label}</span><b>{count}</b></button>;
}

function PolicySummary({ icon: Icon, label, value, tone }: { icon: typeof BadgeCheck; label: string; value: number; tone: string }) {
  return <div className={`verification-summary-stat is-${tone}`}><span><Icon size={13} />{label}</span><strong>{value}</strong></div>;
}

function ContractItem({ icon: Icon, title, detail }: { icon: typeof BadgeCheck; title: string; detail: string }) {
  return <article><Icon size={13} /><div><strong>{title}</strong><span>{detail}</span></div></article>;
}

function ReadinessItem({ state, title, detail }: { state: "ready" | "waiting"; title: string; detail: string }) {
  const Icon = state === "ready" ? BadgeCheck : CircleAlert;
  return <article className={`is-${state}`}><Icon size={13} /><div><strong>{title}</strong><span>{detail}</span></div></article>;
}

function PolicyFact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><span>{label}</span>{mono ? <code title={value}>{value}</code> : <strong>{value}</strong>}</div>;
}

function policyRequest(draft: PolicyDraft): TrustPolicyRequest {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    pinCurrentModuleManifest: draft.pinCurrentModuleManifest,
    authorities: draft.authorities.map(({ clientId: _clientId, ...authority }) => authority.kind === "keyless" ? {
      ...authority,
      name: authority.name.trim(),
      issuer: authority.issuer.trim(),
      subject: authority.subject.trim(),
    } : {
      ...authority,
      name: authority.name.trim(),
      publicKeySha256: authority.publicKeySha256.trim().toLocaleLowerCase(),
    }),
  };
}

function policyDraftReady(request: TrustPolicyRequest): boolean {
  if (!request.name || !request.description || !request.authorities.length) return false;
  return request.authorities.every((authority) => authority.name && (authority.kind === "keyless"
    ? /^https:\/\/[^\s]+$/u.test(authority.issuer) && Boolean(authority.subject) && !/\s/u.test(authority.subject)
    : /^[a-f0-9]{64}$/.test(authority.publicKeySha256)));
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
