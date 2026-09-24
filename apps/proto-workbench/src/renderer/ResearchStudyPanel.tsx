import {useEffect,useMemo,useReducer,useState} from "react";
import {useStore} from "zustand";
import type {StoreApi} from "zustand/vanilla";
import {FolderOpen,Plus,RefreshCw} from "lucide-react";
import type {ComputeStudy,ComputeStudyOpenedRun} from "../shared/compute-studies.ts";
import {compareStudyJson,displayComparedValue} from "./research-study-comparison.ts";
import {STUDY_RUN_WINDOW,reduceStudyEditorDraft,studyEditorDraft,type ResearchStudyState} from "./research-study-state.ts";
import "./research-study.css";
import {ResearchFigurePanel} from "./ResearchFigurePanel.tsx";
import {createResearchFigureStore} from "./research-figure-state.ts";
import {workbenchApi} from "./mock-api.ts";
import {ResearchWorkflowPanel} from "./ResearchWorkflowPanel.tsx";
import {createResearchWorkflowStore,workflowResultMatches} from "./research-workflow-state.ts";
import type {WorkflowStepExecution} from "../shared/research-workflows.ts";

const figureStores=new WeakMap<StoreApi<ResearchStudyState>,ReturnType<typeof createResearchFigureStore>>();
const workflowStores=new WeakMap<StoreApi<ResearchStudyState>,ReturnType<typeof createResearchWorkflowStore>>();

type Props={store:StoreApi<ResearchStudyState>;onOpen:(run:ComputeStudyOpenedRun)=>void;runToLink?:string};
const time=(value?:string)=>value?new Date(value).toLocaleString():"Date not recorded";

export function ResearchStudyPanel({store,onOpen,runToLink}:Props) {
  const state=useStore(store);
  const figureStore=useMemo(()=>{let figures=figureStores.get(store);if(!figures){figures=createResearchFigureStore(input=>workbenchApi().compute.figures(input));figureStores.set(store,figures);}return figures;},[store]);
  const workflowStore=useMemo(()=>{let workflows=workflowStores.get(store);if(!workflows){workflows=createResearchWorkflowStore(input=>workbenchApi().compute.workflows(input),tool=>workbenchApi().compute.catalog(tool));workflowStores.set(store,workflows);}return workflows;},[store]);
  const [creating,setCreating]=useState(false);
  useEffect(()=>{
    const state=store.getState();void state.loadStudies("reset");
    if(state.selectedId)void state.select(state.selectedId);else void state.loadRuns("reset");
    return()=>store.getState().suspend();
  },[store]);
  const open=async(runId:string)=>{const opened=await store.getState().openRun(runId);if(opened)onOpen(opened);};
  const openWorkflowResult=async(step:WorkflowStepExecution)=>{if(!step.runId)throw Error("This step has no saved result identity.");const opened=await store.getState().openRun(step.runId);if(!opened)throw Error("The saved workflow result could not be opened in the current project.");if(!workflowResultMatches(step,opened))throw Error("Saved run bytes no longer match the binding recorded by this workflow execution.");onOpen(opened);};
  const selected=state.study;
  return <section className="research-study-panel" aria-label="Research projects">
    <p className="analysis-description">Name a research question and keep its saved computations together. Opening a run checks its local files again; matching files do not establish scientific validity.</p>
    <div className="research-study-layout">
      <aside className="research-study-list" aria-label="Saved research projects">
        <div className="research-study-heading"><h2>Research projects</h2><button type="button" className="quiet-button" onClick={()=>setCreating(true)}><Plus size={15}/> New project</button></div>
        <button type="button" className={`research-study-row ${!state.selectedId?"is-selected":""}`} onClick={()=>{setCreating(false);void state.select();}}><FolderOpen size={17}/><span><strong>All saved runs</strong><small>Workspace computation records</small></span></button>
        {selected&&!state.studies.rows.some(item=>item.id===selected.id)&&<button type="button" className="research-study-row is-selected" onClick={()=>setCreating(false)}><span><strong>{selected.name}</strong><small>Selected project · outside this page</small></span></button>}
        {state.studies.rows.map(item=><button type="button" key={item.id} className={`research-study-row ${state.selectedId===item.id?"is-selected":""}`} onClick={()=>{setCreating(false);void state.select(item.id);}}><span><strong>{item.name}</strong><small>{item.runCount} linked runs · {time(item.updatedAt)}</small></span></button>)}
        {!state.studies.busy&&!state.studies.rows.length&&<p className="research-study-muted">No saved projects in this page.</p>}
        {state.studies.error&&<p className="analysis-error" role="alert">{state.studies.error}</p>}
        {state.studies.changed&&<p role="status">The project list changed. Refresh to load its latest first page.</p>}
        <div className="research-study-actions"><button type="button" className="quiet-button" disabled={state.studies.busy} onClick={()=>void state.loadStudies("reset")}><RefreshCw size={14}/> Refresh projects</button>{state.studies.page?.nextCursor&&<button type="button" className="quiet-button" disabled={state.studies.busy||state.studies.changed} onClick={()=>void state.loadStudies("older")}>Load older projects</button>}</div>
      </aside>
      <div className="research-study-main">
        {state.error&&<p role="alert" className="analysis-error">{state.error}</p>}
        {creating?<StudyEditor key="new" busy={state.mutationBusy} onCancel={()=>setCreating(false)} onSave={async(name,question)=>{const saved=await state.create(name,question);if(saved)setCreating(false);return saved;}}/>:selected?<StudyEditor key={selected.id} study={selected} busy={state.mutationBusy} onSave={(name,question,revision)=>state.update(name,question,revision!)}/>:<div className="research-study-heading"><h2>{state.selectionBusy?"Opening project…":"Saved computations"}</h2></div>}
        {runToLink&&<section className="research-study-attach" aria-label="Add current result to project"><strong>Current result</strong><code>{runToLink}</code><p>{selected?`Link this saved run to “${selected.name}”.`:"Choose or create a research project to link this saved run."}</p><button type="button" className="quiet-button" disabled={!selected||state.mutationBusy||!!selected.links.find(link=>link.runId===runToLink)} onClick={()=>void state.link(runToLink)}>{selected?.links.some(link=>link.runId===runToLink)?"Linked to this project":"Add current result to project"}</button></section>}
        <div className="research-study-heading"><h3>{state.runMode==="linked"?"Runs linked to this project":"Workspace runs"}</h3>{selected&&<label>Show runs<select value={state.runMode} disabled={state.mutationBusy||state.selectionBusy} onChange={event=>void state.setRunMode(event.target.value as "all"|"linked")}><option value="linked">This project</option><option value="all">All workspace runs</option></select></label>}</div>
        <p className="research-study-muted">List entries are an index. Integrity and source-file freshness are checked when you open or compare a run.</p>
        {state.runs.error&&<p role="alert" className="analysis-error">{state.runs.error}</p>}
        {state.runs.changed&&<p role="status" className="research-study-notice">Saved runs changed. Your current page is retained. Refresh runs to load the latest first page.</p>}
        {!!state.runs.page?.indexingPending&&<p role="status">Indexing pending: {state.runs.page.indexingPending} records. Refresh to continue discovery.</p>}
        {state.runs.page?.discoveryTruncated&&<p className="research-study-notice">Workspace discovery reached its safety limit. This list is not a complete census of saved runs.</p>}
        <div className="research-study-actions"><button type="button" className="quiet-button" disabled={state.runs.busy} onClick={()=>void state.loadRuns("reset")}><RefreshCw size={14}/> Refresh runs</button><button type="button" className="quiet-button" disabled={state.compareIds.length!==2||state.openBusy} onClick={()=>void state.compare()}>Compare selected ({state.compareIds.length}/2)</button></div>
        <div className="research-study-runs">{state.runs.rows.map(run=>{
          const linked=!!selected?.links.some(link=>link.runId===run.runId),checked=state.compareIds.includes(run.runId);
          return <article className="research-study-run" key={run.runId}>
            <label className="research-study-check"><input type="checkbox" checked={checked} disabled={!checked&&state.compareIds.length>=2} onChange={()=>state.toggleCompare(run.runId)} aria-label={`Compare run ${run.runId}`}/></label>
            <div className="research-study-run-copy"><strong>{run.tool??"Method not recorded"}</strong><code>{run.runId}</code><small>{time(run.createdAt)} · {run.integrity.status==="not-checked"?"Record check pending":`Index status: ${run.integrity.status}`}</small></div>
            <div className="research-study-actions"><button type="button" className="quiet-button" disabled={state.openBusy} onClick={()=>void open(run.runId)}>Open result</button>{selected&&<button type="button" className="quiet-button" disabled={state.mutationBusy} onClick={()=>void state.link(run.runId,linked)}>{linked?"Unlink":"Link to project"}</button>}</div>
          </article>;
        })}</div>
        {!state.runs.busy&&!state.runs.rows.length&&<p className="research-study-muted">No saved runs in this page. Run an analysis, or view all workspace runs to link an existing record.</p>}
        {state.opened&&state.opened.integrity.status!=="verified"&&<RunRecordStatus run={state.opened}/>}
        <div className="research-study-actions"><span className="research-study-muted">{state.runs.busy?"Loading saved records…":`${state.runs.rows.length} entries shown${state.runs.offset?` · window starts at ${state.runs.offset+1}`:""}`}</span>{state.runs.page?.nextCursor&&<button type="button" className="quiet-button" disabled={state.runs.busy||state.runs.changed} onClick={()=>void state.loadRuns(state.runs.rows.length>=STUDY_RUN_WINDOW?"next":"older")}>{state.runs.rows.length>=STUDY_RUN_WINDOW?"Next run window":"Load older runs"}</button>}</div>
        {state.comparison&&<StudyComparison runs={state.comparison}/>}
        <ResearchWorkflowPanel store={workflowStore} workspace={state.workspace} study={selected} onOpenResult={openWorkflowResult}/>
        <ResearchFigurePanel store={figureStore} workspace={state.workspace} study={selected}/>
      </div>
    </div>
  </section>;
}

function StudyEditor({study,busy,onSave,onCancel}:{study?:ComputeStudy;busy:boolean;onSave:(name:string,question:string,revision?:number)=>Promise<boolean>;onCancel?:()=>void}) {
  const [draft,dispatch]=useReducer(reduceStudyEditorDraft,study,studyEditorDraft);
  const {name,question,baseline,saved}=draft;
  useEffect(()=>{if(study)dispatch({type:"record",study});},[study?.revision]);
  const changedElsewhere=!!study&&baseline!==study.revision;
  return <form className="research-study-editor" onSubmit={async event=>{event.preventDefault();const submitted=draft;dispatch({type:"saving"});const ok=await onSave(submitted.name,submitted.question,submitted.baseline);if(ok)dispatch({type:"accepted",submitted});}}>
    <h2>{study?"Research question":"New research project"}</h2>
    <label>Project name<input required maxLength={120} value={name} onChange={event=>dispatch({type:"edit",field:"name",value:event.target.value})}/></label>
    <label>Research question<textarea maxLength={8000} rows={3} value={question} onChange={event=>dispatch({type:"edit",field:"question",value:event.target.value})} placeholder="What are you investigating, and what evidence would help?"/></label>
    {changedElsewhere&&<div className="research-study-notice" role="status"><p>The saved project is now revision {study.revision}; this draft began at revision {baseline}. Your text has been retained. Reload saved text before editing again.</p><details><summary>Current saved text</summary><strong>{study.name}</strong><p className="research-study-question">{study.question||"No research question recorded."}</p></details><button type="button" className="quiet-button" onClick={()=>dispatch({type:"reload",study})}>Discard draft and reload saved text</button></div>}
    <div className="research-study-actions"><button type="submit" className="quiet-button" disabled={busy||changedElsewhere||!name.trim()}>{busy?"Saving…":study?"Save project details":"Create project"}</button>{onCancel&&<button type="button" className="quiet-button" onClick={onCancel}>Cancel</button>}{saved&&<span role="status">Project details saved.</span>}{study&&<small>Revision {study.revision} · {study.runCount} linked runs</small>}</div>
  </form>;
}

export function RunRecordStatus({run}:{run:ComputeStudyOpenedRun}) {
  return <section className="research-study-record" aria-label="Saved run verification"><h3>Saved run record</h3><p><strong>Internal record: {run.integrity.status}</strong> · {run.integrity.message}</p><p>Source files now: <strong>{run.sourceFreshness.status}</strong>. Source changes are separate from the saved record's integrity.</p><p className="research-study-muted">These are unsigned local artifacts. Matching hashes identify recorded bytes; they do not prove independent execution or scientific accuracy.</p>{run.sourceFreshness.details.length>0&&<details><summary>Source-file checks</summary>{run.sourceFreshness.details.map((file,index)=><div key={`${file.name}-${index}`}><p><code>{file.path}</code> · {file.status}</p><small>{file.message}</small><dl><dt>Saved SHA-256</dt><dd><code>{file.expectedSha256}</code></dd>{file.actualSha256&&<><dt>Current SHA-256</dt><dd><code>{file.actualSha256}</code></dd></>}</dl></div>)}</details>}{run.integrity.hashes&&<details><summary>Recorded artifact SHA-256</summary><dl>{Object.entries(run.integrity.hashes).map(([key,value])=><div key={key}><dt>{key}</dt><dd><code>{value}</code></dd></div>)}</dl></details>}</section>;
}

function StudyComparison({runs}:{runs:[ComputeStudyOpenedRun,ComputeStudyOpenedRun]}) {
  const [left,right]=runs,same=left.request?.tool===right.request?.tool;
  return <section className="research-study-comparison" aria-label="Saved run comparison"><h2>Compare recorded values</h2><p>No unit conversions, significance tests or scientific equivalence are inferred. Array positions are compared as recorded.</p><div className="research-study-comparison-records">{runs.map((run,index)=><div key={run.runId}><h3>{index===0?"A":"B"} · {run.request?.tool}</h3><code>{run.runId}</code><RunRecordStatus run={run}/></div>)}</div>{same?<><ComparisonFields title="Input fields" left={left.request?.arguments} right={right.request?.arguments}/><ComparisonFields title="Result fields" left={left.receipt?.result} right={right.receipt?.result}/></>:<><p className="research-study-notice">Different methods. Fields are not aligned across these tools; inspect the original records side by side.</p><div className="research-study-comparison-records">{runs.map(run=><div key={run.runId}><h3>{run.request?.tool}</h3><details><summary>Original inputs</summary><pre>{JSON.stringify(run.request,null,2)}</pre></details><details><summary>Original result</summary><pre>{JSON.stringify(run.receipt?.result,null,2)}</pre></details></div>)}</div></>}</section>;
}
function ComparisonFields({title,left,right}:{title:string;left:unknown;right:unknown}) {
  const comparison=useMemo(()=>compareStudyJson(left,right),[left,right]);
  const [differencesOnly,setDifferencesOnly]=useState(false),rows=comparison.rows.filter(row=>!differencesOnly||row.changed);
  return <section><h3>{title}</h3><label className="research-study-checkbox"><input type="checkbox" checked={differencesOnly} onChange={event=>setDifferencesOnly(event.target.checked)}/> Show differing fields only</label>{comparison.truncated&&<p className="research-study-notice">Display is bounded to the first 200 fields and 12 nesting levels. Additional fields have not been compared here. Open each run for its complete result.</p>}<div className="research-study-table"><table><thead><tr><th>JSON pointer (array indices start at 0)</th><th>A · exact recorded value</th><th>B · exact recorded value</th><th>Match</th></tr></thead><tbody>{rows.map(row=><tr key={row.pointer}><th><code>{row.pointer||"(root)"}</code></th><td><code>{displayComparedValue(row.left)}</code></td><td><code>{displayComparedValue(row.right)}</code></td><td>{row.changed?"Different":"Same value"}</td></tr>)}</tbody></table></div>{!rows.length&&<p>No differing fields in the displayed subset.</p>}</section>;
}
