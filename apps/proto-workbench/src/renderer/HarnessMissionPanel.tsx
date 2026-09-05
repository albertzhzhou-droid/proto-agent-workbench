import { useEffect, useState } from "react";
import { ArrowUpRight, CheckCircle2, CircleAlert, FileCheck2, LoaderCircle, Pause, Play, RotateCcw, Timer, Workflow } from "lucide-react";
import { HARNESS_DEFAULTS, type HarnessProjection } from "../shared/harness.ts";
import { workbenchApi } from "./mock-api.ts";
import { useWorkbenchStore } from "./store.ts";
import { newestHarnessProjection } from "./harness-projection.ts";

const active = new Set(["preparing", "generating", "executing", "checkpointing", "validating", "recovering"]);
export function HarnessMissionPanel() {
  const runId = useWorkbenchStore(state => state.selectedRunId);
  const events = useWorkbenchStore(state => state.events);
  const isAgentRunning = useWorkbenchStore(state => state.isAgentRunning);
  const currentThreadId = useWorkbenchStore(state => state.thread?.id);
  const openArtifact = useWorkbenchStore(state => state.openEvidenceArtifact);
  const [saved, setSaved] = useState<HarnessProjection>();
  const [error, setError] = useState<string>();
  const latest = [...events].reverse().find(event => event.runId === runId && event.payload?.harness);
  const eventCheckpoint = latest?.payload?.harness as HarnessProjection | undefined;
  const checkpoint = newestHarnessProjection(runId, eventCheckpoint, saved);
  useEffect(() => {
    let current = true;
    setSaved(undefined); setError(undefined);
    void workbenchApi().harness.listExecutions().then(items => {if (current) setSaved(items.find(item => item.runId === runId));}).catch(reason => {if (current) setError(String(reason));});
    return () => {current = false;};
  }, [runId]);
  const resume = async () => {
    if (!checkpoint) return;
    try {
      setError(undefined);
      await workbenchApi().harness.resumeExecution(checkpoint.runId);
      useWorkbenchStore.setState({isAgentRunning: true, agentStartedAt: Date.now()});
    } catch (reason) {setError(String(reason));}
  };
  const pause = async () => {
    if (!checkpoint) return;
    try {setError(undefined); await workbenchApi().harness.pauseExecution(checkpoint.runId);}
    catch (reason) {setError(String(reason));}
  };
  if (!checkpoint) return <section className="mission-overview is-empty"><div className="mission-symbol"><Workflow size={24}/></div><div><span className="eyebrow">LOCAL SCIENCE · TRACEABLE EXECUTION</span><h2>Your question. A verifiable result.</h2><p>Read sources, work with reviewed materials, and follow each artifact from design to evidence.</p></div><div className="mission-defaults"><strong>32,768</strong><span>Qwen context</span><strong>2 hours</strong><span>Active task budget</span></div></section>;
  const running = active.has(checkpoint.state);
  const settling = !running && isAgentRunning && currentThreadId === checkpoint.threadId && checkpoint.state !== "queued";
  const budgets = checkpoint.budgets ?? HARNESS_DEFAULTS;
  const remainingMinutes = Math.max(0, Math.ceil((budgets.activeTimeMs - checkpoint.activeTimeMs) / 60_000));
  const used = checkpoint === eventCheckpoint && typeof latest?.payload?.contextUsed === "number" ? latest.payload.contextUsed : checkpoint.contextUsed;
  const recovery = checkpoint.recoveryCounters;
  const recoveryDetails = recovery ? [
    ["Transport retries", recovery.transportRetries], ["Output repairs", recovery.outputRepairs],
    ["Progress repairs", recovery.progressRepairs], ["Checkpoint resumes", recovery.resumes],
    ["Instance rebinds", recovery.instanceRebinds], ["Journal reconciliations", recovery.journalReconciliations],
  ].filter(([, count]) => Number(count) > 0) : [];
  return <section className={`mission-overview is-${checkpoint.state}`} aria-label="Autonomous execution">
    <div className="mission-topline"><span className="eyebrow"><Workflow size={13}/> MISSION CONTROL</span><span className={`mission-status is-${checkpoint.state}`}>{running ? <LoaderCircle size={13} className="spin"/> : checkpoint.state === "completed" ? <CheckCircle2 size={13}/> : <CircleAlert size={13}/>} {checkpoint.state.replaceAll("-", " ")}</span></div>
    <div className="mission-summary"><h2>{checkpoint.state === "completed" ? "Verified and ready to inspect" : running ? latest?.summary ?? "Working through the task" : checkpoint.state === "queued" ? "Waiting for an execution slot" : "Your work is saved"}</h2><p>{checkpoint.error?.message ?? (checkpoint.state === "completed" ? "Completion is backed by reopened artifacts and validation receipts." : "Each operation is checkpointed with its inputs, full result and artifact digests.")}</p></div>
    <div className="mission-metrics"><div><Timer size={15}/><strong>{remainingMinutes}<small>min left</small></strong></div><div><strong>{checkpoint.round}<small>/ {budgets.maxRounds} rounds</small></strong></div><div title={checkpoint.tokenCountMethod === "conservative-estimate" ? "Conservative token estimate" : checkpoint.tokenCountMethod ? "Tokens counted with the loaded model" : "Context token count is not yet available"}><strong>{used?.toLocaleString() ?? "—"}<small>/ {checkpoint.contextTokens.toLocaleString()} context{checkpoint.tokenCountMethod === "conservative-estimate" ? " · estimated" : ""}</small></strong><span className="context-meter"><i style={{width: `${Math.min(100, ((used ?? 0) / checkpoint.contextTokens) * 100)}%`}}/></span></div><div><strong>{checkpoint.resultCount}<small>saved results</small></strong></div><div title={`Task limit: ${budgets.maxGeneratedTokens.toLocaleString()} generated tokens`}><strong>{(checkpoint.generatedTokens + (checkpoint.inFlightGenerationTokens ?? 0)).toLocaleString()}<small>output tokens{checkpoint.inFlightGenerationTokens ? " · in progress" : ""}</small></strong></div></div>
    {(checkpoint.deliveredPaths.length > 0 || checkpoint.resumable && !running && !settling) && <div className="mission-actions">{checkpoint.deliveredPaths.map(path => <button type="button" key={path} onClick={() => void openArtifact(path)} title={path}><FileCheck2 size={14}/>{path.split(/[\\/]/).at(-1)}<ArrowUpRight size={12}/></button>)}{checkpoint.resumable && !running && !settling && checkpoint.state !== "queued" && <button className="mission-resume" type="button" onClick={() => void resume()}><RotateCcw size={14}/>Resume saved task<Play size={12}/></button>}</div>}
    {recoveryDetails.length > 0 && <dl className="mission-recovery" aria-label="Recorded retries and recovery">{recoveryDetails.map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{count}</dd></div>)}</dl>}
    {settling && <p className="mission-settling" role="status"><LoaderCircle size={13} className="spin"/>Task state saved. Waiting for owned tools to close.</p>}
    {error && <p role="alert" className="mission-error">{error}</p>}
    {(running || checkpoint.state === "queued") && <div className="mission-actions"><button type="button" onClick={() => void pause()}><Pause size={14}/>Pause task</button></div>}
  </section>;
}
