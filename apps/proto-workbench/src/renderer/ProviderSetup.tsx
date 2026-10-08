import { Check, CircleAlert, Cloud, LoaderCircle, RefreshCw, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ProviderSetupOverview,
  ProviderSetupRequest,
  ProviderSetupResult,
  ProviderSetupStatus,
  ProviderVerifyRequest,
  ProviderVerifyResult,
} from "../shared/provider-setup.ts";
import { workbenchApi, workbenchDataMode } from "./mock-api.ts";
import {
  buildRequest,
  categorySentence,
  custodyLine,
  defaultProvider,
  detectionLabel,
  formFromStatus,
  isDirty,
  nextActionText,
  providerName,
  rankLabel,
  validateForm,
  verificationSummary,
  verifyTarget,
  type ProviderForm,
} from "./provider-setup-presentation.ts";

function formatWhen(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function messageOf(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/^(?:Error invoking remote method '[^']+':\s*)?(?:Error:\s*)?/i, "");
}

type Busy = "load" | "save" | "verify" | undefined;

/**
 * One owner of setup state for both the Settings section and the Launchpad strip. Each action is
 * a single helper call; none of them takes or returns a key.
 */
function useProviderSetup() {
  const [overview, setOverview] = useState<ProviderSetupOverview>();
  const [busy, setBusy] = useState<Busy>("load");
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<ProviderSetupResult>();
  const [verdict, setVerdict] = useState<ProviderVerifyResult>();

  const refresh = useCallback(async () => {
    setBusy("load");
    setError(undefined);
    try {
      setOverview(await workbenchApi().providerSetup.overview());
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(undefined);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setStatus = (status: ProviderSetupStatus) => setOverview((current) => (current ? { ...current, status } : current));

  return {
    overview,
    busy,
    error,
    saved,
    verdict,
    refresh,
    async save(request: ProviderSetupRequest) {
      setBusy("save");
      setError(undefined);
      setVerdict(undefined);
      try {
        const result = await workbenchApi().providerSetup.apply(request);
        setSaved(result);
        setStatus(result.status);
        return result;
      } catch (failure) {
        setError(messageOf(failure));
        return undefined;
      } finally {
        setBusy(undefined);
      }
    },
    async verify(request: ProviderVerifyRequest) {
      setBusy("verify");
      setError(undefined);
      setSaved(undefined);
      try {
        const result = await workbenchApi().providerSetup.verify(request);
        setVerdict(result);
        if (result.status) setStatus(result.status);
        else await refresh();
        return result;
      } catch (failure) {
        setError(messageOf(failure));
        return undefined;
      } finally {
        setBusy(undefined);
      }
    },
  };
}

function StatusChip({ status }: { status: ProviderSetupStatus | undefined }) {
  const summary = verificationSummary(status?.verification, formatWhen);
  return (
    <span className={`provider-chip is-${summary.tone}`}>
      {summary.tone === "ok" ? <Check size={11} aria-hidden="true" /> : summary.tone === "fail" ? <CircleAlert size={11} aria-hidden="true" /> : null}
      {summary.label}
    </span>
  );
}

export function ProviderSetupSection({ onWorkspaceNeeded }: { onWorkspaceNeeded?: () => void }) {
  const setup = useProviderSetup();
  const { overview } = setup;
  const [form, setForm] = useState<ProviderForm>();
  const [confirming, setConfirming] = useState(false);

  const status = overview?.status;
  const catalog = overview?.catalog;
  // Seed the form once the overview arrives, and again after a save changes what is stored.
  const savedSignature = JSON.stringify(status?.configuration ?? null);
  useEffect(() => {
    if (overview) setForm(formFromStatus(overview.status, defaultProvider(overview.catalog, overview.detection)));
  }, [Boolean(overview), savedSignature]);

  const entry = catalog?.providers.find((candidate) => candidate.id === form?.provider);
  const problem = form && catalog ? validateForm(form, catalog) : undefined;
  const dirty = form ? isDirty(form, status) : false;
  const target = status && catalog ? verifyTarget(status, catalog) : undefined;
  const keyPresent = status?.credential_present ?? (entry ? overview?.detection.providers[entry.id]?.credential_present : undefined);
  const busy = setup.busy;
  const desktop = workbenchDataMode() === "desktop";
  const ordered = useMemo(() => [...(catalog?.providers ?? [])].sort((a, b) => a.security_rank - b.security_rank), [catalog]);

  const patch = (change: Partial<ProviderForm>) => setForm((current) => (current ? { ...current, ...change } : current));

  const save = async () => {
    if (!form || !catalog) return;
    await setup.save(buildRequest(form, catalog, Boolean(status?.initialized)));
  };
  const verify = async () => {
    if (!target) return;
    setConfirming(false);
    await setup.verify({ provider: target.provider, approveNetwork: true, ...(target.approveHost ? { approveHost: target.approveHost } : {}) });
  };

  return (
    <section className="settings-section provider-setup" aria-labelledby="provider-setup-title">
      <div className="settings-section-title">
        <Cloud size={17} aria-hidden="true" />
        <div>
          <h2 id="provider-setup-title">Model provider setup</h2>
          <p>Choose how this workspace reaches a model. Proto records the variable name, never the key. Chat in this release still runs against LM Studio.</p>
        </div>
        <button className="quiet-button compact-command provider-refresh" type="button" onClick={() => void setup.refresh()} disabled={busy !== undefined} aria-label="Check setup again">
          <RefreshCw className={busy === "load" ? "spin" : undefined} size={12} />Recheck
        </button>
      </div>

      {setup.error && (
        <div className="provider-alert" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          <span>{setup.error}</span>
          {setup.error.includes("Choose a workspace") && onWorkspaceNeeded && <button className="secondary-button compact-command" type="button" onClick={onWorkspaceNeeded}>Choose workspace</button>}
        </div>
      )}

      {!overview && busy === "load" && <p className="provider-loading" role="status"><LoaderCircle className="spin" size={14} />Reading setup state</p>}

      {overview && form && catalog && (
        <>
          <div className={`provider-summary is-${verificationSummary(status?.verification, formatWhen).tone}`}>
            <div>
              <strong>{status?.initialized && status.provider ? providerName(status.provider) : "No provider saved"}</strong>
              <span>{status?.initialized ? `Saved in ${status.directory}` : "Nothing is configured for this workspace yet."}</span>
            </div>
            <StatusChip status={status} />
            <dl>
              <div><dt>Model</dt><dd>{status?.configuration?.provider.model ?? "Not set"}</dd></div>
              <div><dt>Host</dt><dd>{target?.host ?? status?.configuration?.provider.host ?? "—"}</dd></div>
              <div><dt>Workspace</dt><dd>{overview.detection.workspace_writable === false ? "Not writable" : "Writable"}</dd></div>
            </dl>
          </div>

          <fieldset className="provider-options">
            <legend>Provider</legend>
            {ordered.map((candidate) => {
              const found = detectionLabel(candidate, overview.detection);
              return (
                <label key={candidate.id} className={`provider-option${form.provider === candidate.id ? " is-selected" : ""}`}>
                  <input type="radio" name="provider" value={candidate.id} checked={form.provider === candidate.id} onChange={() => patch({ provider: candidate.id })} />
                  <span className="provider-option-body">
                    <strong>{providerName(candidate.id)}</strong>
                    <small>{custodyLine(candidate)}</small>
                  </span>
                  <span className="provider-option-tags">
                    <em>{rankLabel(candidate)}</em>
                    {found && <em className={found.endsWith("not set") || found.endsWith("not found") ? "is-missing" : "is-found"}>{found}</em>}
                  </span>
                </label>
              );
            })}
          </fieldset>

          <div className="provider-fields">
            {entry?.kind === "api_gateway" && (
              <>
                <div className="settings-field">
                  <label htmlFor="provider-base-url">Gateway address</label>
                  <input id="provider-base-url" type="url" inputMode="url" spellCheck={false} autoComplete="off" placeholder="https://gateway.example.com/v1" value={form.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} />
                  <output>HTTPS only</output>
                </div>
                <div className="settings-field">
                  <label id="provider-protocol-label">API protocol</label>
                  <div className="segmented-control" role="group" aria-labelledby="provider-protocol-label">
                    {catalog.gateway_protocols.map((protocol) => (
                      <button key={protocol} type="button" className={form.protocol === protocol ? "is-selected" : ""} aria-pressed={form.protocol === protocol} onClick={() => patch({ protocol })}>{protocol}</button>
                    ))}
                  </div>
                  <output />
                </div>
              </>
            )}
            {entry && entry.kind !== "subscription_cli" && (
              <div className="settings-field">
                <label htmlFor="provider-model">Model ID</label>
                <input id="provider-model" type="text" spellCheck={false} autoComplete="off" placeholder={entry.requires.includes("model") ? "Required" : "Optional — checked when you verify"} value={form.model} onChange={(event) => patch({ model: event.target.value })} />
                <output>{entry.requires.includes("model") ? "Required" : "Optional"}</output>
              </div>
            )}
            {entry?.kind === "subscription_cli" && (
              <div className="settings-field">
                <label id="provider-credential-label">Sign-in location</label>
                <div className="segmented-control" role="group" aria-labelledby="provider-credential-label">
                  {catalog.credential_modes.map((mode) => (
                    <button key={mode} type="button" className={form.credentialMode === mode ? "is-selected" : ""} aria-pressed={form.credentialMode === mode} onClick={() => patch({ credentialMode: mode })}>{mode === "isolated" ? "Isolated to this workspace" : "Shared CLI profile"}</button>
                  ))}
                </div>
                <output>{form.credentialMode === "isolated" ? `Set ${entry.home_environment} to the workspace folder` : "Shared with every project"}</output>
              </div>
            )}
            <div className="settings-field">
              <label id="provider-python-label">Python profile</label>
              <div className="segmented-control" role="group" aria-labelledby="provider-python-label">
                {catalog.python_profiles.map((profile) => (
                  <button key={profile.id} type="button" title={profile.summary} className={form.pythonProfile === profile.id ? "is-selected" : ""} aria-pressed={form.pythonProfile === profile.id} onClick={() => patch({ pythonProfile: profile.id })}>{profile.id}</button>
                ))}
              </div>
              <output>{catalog.python_profiles.find((profile) => profile.id === form.pythonProfile)?.summary}</output>
            </div>
            <div className="settings-field">
              <label id="provider-r-label">R profile</label>
              <div className="segmented-control" role="group" aria-labelledby="provider-r-label">
                {catalog.r_profiles.map((profile) => (
                  <button key={profile.id} type="button" title={profile.summary} className={form.rProfile === profile.id ? "is-selected" : ""} aria-pressed={form.rProfile === profile.id} onClick={() => patch({ rProfile: profile.id })}>{profile.id}</button>
                ))}
              </div>
              <output>{catalog.r_profiles.find((profile) => profile.id === form.rProfile)?.summary}</output>
            </div>
          </div>

          {entry && (entry.kind === "api_key_env" || entry.kind === "api_gateway") && keyPresent === false && (
            <p className="provider-hint">
              {entry.credential_environment} is not visible to this app. Export it in the shell that starts Proto, or in your system environment, then choose Recheck. Proto never asks for or stores the key.
            </p>
          )}

          <div className="provider-actions">
            <button className="primary-button" type="button" onClick={() => void save()} disabled={busy !== undefined || Boolean(problem) || !dirty}>
              {busy === "save" ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}{status?.initialized ? "Save changes" : "Save provider"}
            </button>
            {target?.viaApp && (
              <button className="secondary-button" type="button" onClick={() => setConfirming(true)} disabled={busy !== undefined || dirty || keyPresent === false || !desktop} aria-expanded={confirming}>
                Verify with provider…
              </button>
            )}
            {problem && dirty && <span className="provider-problem" role="note">{problem}</span>}
            {!problem && dirty && status?.initialized && <span className="provider-problem" role="note">Unsaved changes. Save before verifying.</span>}
            {target && !target.viaApp && <span className="provider-problem" role="note">This workspace names a custom key variable ({target.variable}). Verify it from the command line: proto-agent init verify --approve-network</span>}
            {!desktop && target?.viaApp && <span className="provider-problem" role="note">Live checks need the desktop app.</span>}
          </div>

          {confirming && target && (
            <div className="provider-confirm" role="alertdialog" aria-labelledby="provider-confirm-title" aria-describedby="provider-confirm-body">
              <strong id="provider-confirm-title">Send one request to {target.host}?</strong>
              <p id="provider-confirm-body">
                Proto reads {target.variable} from this app&apos;s environment and sends it to {target.host} to check the key
                {status?.configuration?.provider.model ? ` and the model ${status.configuration.provider.model}` : ""}. Redirects are refused, nothing is stored, and the result shows only the provider&apos;s status.
              </p>
              <div className="provider-confirm-actions">
                <button className="primary-button" type="button" onClick={() => void verify()}>Send request</button>
                <button className="secondary-button" type="button" onClick={() => setConfirming(false)}>Cancel</button>
              </div>
            </div>
          )}

          <div className="provider-outcome" role="status" aria-live="polite">
            {busy === "verify" && <p><LoaderCircle className="spin" size={13} />Waiting for {target?.host}…</p>}
            {setup.verdict && busy !== "verify" && (
              <p className={setup.verdict.ok ? "is-ok" : "is-fail"}>
                {setup.verdict.ok ? <Check size={13} aria-hidden="true" /> : <CircleAlert size={13} aria-hidden="true" />}
                {setup.verdict.code === "CREDENTIAL_MISSING" || setup.verdict.code === "NETWORK_NOT_APPROVED" || setup.verdict.code === "HOST_NOT_APPROVED"
                  ? `${setup.verdict.message ?? "The request was not sent."} No request was made.`
                  : categorySentence(setup.verdict.category)}
                {setup.verdict.metrics.network_requests === 1 && setup.verdict.http_status ? ` (HTTP ${setup.verdict.http_status})` : ""}
              </p>
            )}
            {setup.saved && (
              <p className="is-ok">
                <Check size={13} aria-hidden="true" />
                {!setup.saved.apply.changed
                  ? "Already saved — nothing to change."
                  : setup.saved.apply.written.length > 0
                    ? `Saved ${setup.saved.apply.written.length} file${setup.saved.apply.written.length === 1 ? "" : "s"}.`
                    : "Saved for this session."}
              </p>
            )}
            {setup.saved?.apply.warnings.map((warning) => <p key={warning} className="is-warn"><CircleAlert size={13} aria-hidden="true" />{warning}</p>)}
          </div>

          {status && status.next.length > 0 && (
            <ul className="provider-next" aria-label="Next steps">
              {status.next.map((action) => <li key={`${action.code}:${action.variable ?? action.executable ?? ""}`}>{nextActionText(action)}</li>)}
            </ul>
          )}
          {status && status.issues.length > 0 && (
            <ul className="provider-issues" aria-label="Setup problems">
              {status.issues.map((issue) => <li key={`${issue.code}:${issue.message}`}><CircleAlert size={12} aria-hidden="true" /><span>{issue.message}</span></li>)}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** Compact status for the Launchpad. It informs; it never gates the LM Studio readiness steps. */
export function ProviderSetupStrip({ onOpen }: { onOpen: () => void }) {
  const [status, setStatus] = useState<ProviderSetupStatus>();
  const [name, setName] = useState<string>();
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let live = true;
    workbenchApi().providerSetup.overview().then(
      (overview) => {
        if (!live) return;
        setStatus(overview.status);
        setName(overview.status.provider ? providerName(overview.status.provider) : undefined);
      },
      () => live && setUnavailable(true),
    );
    return () => { live = false; };
  }, []);
  if (unavailable) return null;
  const summary = verificationSummary(status?.verification, formatWhen);
  return (
    <section className="provider-strip" aria-label="Model provider">
      <span className="provider-strip-icon" aria-hidden="true"><Cloud size={15} /></span>
      <div>
        <strong>Model provider</strong>
        <span>{status ? (status.initialized ? `${name} · ${summary.label}` : "Not set up — optional; chat uses LM Studio today.") : "Reading setup state"}</span>
      </div>
      <button className="secondary-button compact-command" type="button" onClick={onOpen}>{status?.initialized ? "Review" : "Set up"}</button>
    </section>
  );
}
