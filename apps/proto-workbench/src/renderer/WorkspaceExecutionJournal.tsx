import {useCallback,useEffect,useRef,useState} from "react";
import type {JournalApi,JournalRecord} from "../shared/execution-journal.ts";
import type {PolicySurface} from "../shared/tool-policy.ts";
import {workbenchApi} from "./mock-api.ts";
import {useWorkbenchStore} from "./store.ts";
import {ExecutionReconciliation} from "./ExecutionReconciliation.tsx";
import "./workspace-execution-journal.css";

const surfaces:PolicySurface[]=["chat","harness","compute","workflow","design","chemistry","validation","figure","system","legacy"];
type Inspection=Awaited<ReturnType<JournalApi["inspect"]>>;

export function WorkspaceExecutionJournal({onClose}:{onClose:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null),generation=useRef(0),inspectionGeneration=useRef(0),selectedOperation=useRef("");
  const [records,setRecords]=useState<JournalRecord[]>([]),[total,setTotal]=useState(0),[unknown,setUnknown]=useState(0);
  const [surface,setSurface]=useState<PolicySurface|"all">("all"),[pendingOnly,setPendingOnly]=useState(true),[offset,setOffset]=useState(0);
  const [busy,setBusy]=useState(true),[error,setError]=useState(""),[inspection,setInspection]=useState<Inspection>();
  const refresh=useCallback(async()=>{
    const ticket=++generation.current;setBusy(true);setError("");
    try{
      const result=await workbenchApi().journal.list({...(surface!=="all"?{surface}:{}),...(pendingOnly?{state:"effect-unknown" as const}:{}),limit:50,offset});
      if(ticket!==generation.current)return;
      setRecords(result.records);setTotal(result.total);setUnknown(result.unknownEffects);
      const recovery=await workbenchApi().app.getStartupRecovery();
      if(ticket===generation.current)useWorkbenchStore.setState({startupRecovery:recovery});
    }catch(reason){if(ticket===generation.current)setError(reason instanceof Error?reason.message:String(reason));}
    finally{if(ticket===generation.current)setBusy(false);}
  },[surface,pendingOnly,offset]);
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;dialog.current?.showModal();return()=>{generation.current++;inspectionGeneration.current++;selectedOperation.current="";previous?.focus();};},[]);
  useEffect(()=>{void refresh();},[refresh]);
  async function inspect(operationId:string){const ticket=++inspectionGeneration.current;selectedOperation.current=operationId;setError("");try{const result=await workbenchApi().journal.inspect({operationId});if(ticket===inspectionGeneration.current)setInspection(result);}catch(reason){if(ticket===inspectionGeneration.current)setError(String(reason));}}
  async function reconciled(operationId:string){if(selectedOperation.current===operationId)await inspect(operationId);await refresh();}
  return <dialog ref={dialog} className="workspace-journal" aria-labelledby="workspace-journal-title" onCancel={onClose}>
    <header><div><h2 id="workspace-journal-title">Workspace execution journal</h2><p>Saved execution and effect reviews across every work surface.</p></div><button type="button" onClick={onClose} aria-label="Close execution journal">Close</button></header>
    <div className="workspace-journal-controls"><label>Surface<select value={surface} onChange={event=>{setSurface(event.target.value as PolicySurface|"all");setOffset(0);inspectionGeneration.current++;selectedOperation.current="";setInspection(undefined);}}><option value="all">All surfaces</option>{surfaces.map(value=><option value={value} key={value}>{value}</option>)}</select></label><label><input type="checkbox" checked={pendingOnly} onChange={event=>{setPendingOnly(event.target.checked);setOffset(0);}}/>Needs effect review</label><button type="button" onClick={()=>void refresh()} disabled={busy}>Refresh</button></div>
    <p role="status">{unknown} operation{unknown===1?"":"s"} with an unknown effect in this workspace. {busy?"Reading journal…":`${total} matching records.`}</p>
    {error&&<p role="alert">{error}</p>}
    <div className="workspace-journal-content">
      <ol className="workspace-journal-list" aria-label="Execution records">{records.map(record=><li key={record.operationId}><button type="button" className={inspection?.record?.operationId===record.operationId?"selected":""} onClick={()=>void inspect(record.operationId)}><strong>{record.capabilityId??record.tool}</strong><span>{record.scope.surface} · {record.state} · {record.outcome??"outcome not established"}</span><code>{record.operationId}</code><small>Updated {new Date(record.updatedAt).toLocaleString()}</small></button></li>)}</ol>
      {inspection?.record&&<section className="workspace-journal-inspection" aria-label="Execution inspection"><h3>{inspection.record.capabilityId??inspection.record.tool}</h3><dl><dt>Operation</dt><dd>{inspection.record.operationId}</dd><dt>Backend tool</dt><dd>{inspection.record.tool}</dd><dt>Scope</dt><dd>{inspection.record.scope.surface} / {inspection.record.scope.scopeId}</dd><dt>State / outcome</dt><dd>{inspection.record.state} / {inspection.record.outcome??"not established"}</dd><dt>Arguments SHA-256</dt><dd>{inspection.record.argumentsSha256}</dd><dt>Policy decision</dt><dd>{inspection.record.decision?.reason??inspection.record.decisionId??"No recorded decision"}</dd><dt>Created</dt><dd>{inspection.record.createdAt}</dd></dl>
        {inspection.record.state==="effect-unknown"&&<ExecutionReconciliation key={inspection.record.operationId} operationId={inspection.record.operationId} onReconciled={()=>void reconciled(inspection.record!.operationId)}/>}
        {!!inspection.reconciliations?.length&&<><h4>Effect review history</h4><ul>{inspection.reconciliations.map(item=><li key={item.id}><strong>{item.verdict}</strong> · {item.actor} · {item.reconciledAt}<code>{item.evidenceRef}</code></li>)}</ul></>}
        {inspection.record.receipt&&<details><summary>Saved receipt (bounded preview)</summary><pre>{JSON.stringify(inspection.record.receipt,null,2).slice(0,30000)}</pre></details>}
      </section>}
    </div>
    {!busy&&!records.length&&<p>No operations match these filters.</p>}
    <footer><button disabled={busy||offset===0} onClick={()=>setOffset(Math.max(0,offset-50))}>Previous</button><span>{total?offset+1:0}–{Math.min(offset+50,total)} of {total}</span><button disabled={busy||offset+50>=total} onClick={()=>setOffset(offset+50)}>Next</button></footer>
  </dialog>;
}
