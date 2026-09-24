import { MethodIcon } from "./workbench-icons.ts";
import { EvidenceStandingView } from "./EvidenceStandingView.tsx";
import { ArrowLeft, ArrowUpRight, Check, ChevronRight, Download, FileJson2, FlaskConical, LoaderCircle, Play, RotateCcw, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ComputeCatalog, ComputeMaturity, ComputeRequest, ComputeRun, ComputeTool } from "../shared/compute.ts";
import type { ComputeStudyOpenedRun } from "../shared/compute-studies.ts";
import { workbenchApi, workbenchDataMode } from "./mock-api.ts";
import { useWorkbenchStore } from "./store.ts";
import type { ComputeSection } from "./WorkspaceNavigation.tsx";
import { categoryFor, computeInputsChanged, ComputeInputError, domainTitles, fieldsFor, requestArguments, toolMatches } from "./compute-presentation.ts";
import { ComputeField } from "./ComputeField.tsx";
import { ComputeResultViews } from "./ComputeResultViews.tsx";
import { downloadLocalComputeArtifact, readLocalComputeArtifact } from "./compute-preview.ts";
import { readVerifiedComputeResult } from "./compute-result-reader.ts";
import { ProteinComparisonResults } from "./ProteinComparisonPanel.tsx";
import { proteinStudy } from "./protein-comparison.ts";
import { StructurePredictionResult } from "./StructurePredictionResult.tsx";
import { validateStructurePrediction } from "./structure-prediction.ts";
import { ResearchStudyPanel, RunRecordStatus } from "./ResearchStudyPanel.tsx";
import { createResearchStudyStore } from "./research-study-state.ts";
import {RnaSeqStudyFields,RnaSeqStudyResults} from "./RnaSeqStudyResults.tsx";
import {validateRnaSeqStudy} from "./rnaseq-study.ts";

const label = (text: string) => text.replaceAll("_", " ").replace(/^./, c => c.toUpperCase());
const pretty = (value: unknown) => typeof value === "number" ? Number.isInteger(value) ? value.toLocaleString() : value !== 0 && Math.abs(value) < .001 ? value.toExponential(4) : Number(value.toPrecision(6)).toLocaleString() : String(value ?? "Not defined");
type SessionResult = { tool: ComputeTool; request: ComputeRequest; receipt: ComputeRun; at: string; saved?:ComputeStudyOpenedRun };

export function ComputeWorkspace({ section, hidden, navigationRevision }: { section: ComputeSection; hidden: boolean; navigationRevision: number }) {
  const workspace = useWorkbenchStore(s => s.settings.workspacePath);
  const enabled = useWorkbenchStore(s => s.settings.modules.enabledOptional.includes("analysis.biomni"));
  const [catalog, setCatalog] = useState<ComputeCatalog>();
  const [selected, setSelected] = useState<ComputeTool>();
  const [fields, setFields] = useState<Record<string,string>>({});
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [availability, setAvailability] = useState("all");
  const [fieldError, setFieldError] = useState<ComputeInputError>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<SessionResult>();
  const [notebook,setNotebook]=useState(false);
  const [resultTab, setResultTab] = useState<"result" | "input" | "provenance">("result");
  const revision = useRef(0);
  const workspaceRevision = useRef(0);
  const runOperation=useRef(0);
  const currentWorkspace=useRef(workspace);currentWorkspace.current=workspace;
  const studyStore=useMemo(()=>{const store=createResearchStudyStore(input=>workbenchApi().compute.studies(input));store.getState().activate(workspace);return store;},[workspace]);
  const preview = workbenchDataMode() === "preview" && catalog?.execution !== "local" && !import.meta.env?.DEV;
  useEffect(() => { let live = true; setCatalog(undefined); setSelected(undefined); setResult(undefined); setError(""); setNotebook(false);setBusy(false); revision.current++;
    workspaceRevision.current++;runOperation.current++;
    void workbenchApi().compute.catalog().then(value => {if(live) setCatalog(value);}).catch(e => {if(live) setError(String(e));});
    return () => {live = false; revision.current++; workspaceRevision.current++;runOperation.current++;};
  }, [workspace]);
  useEffect(() => {setSelected(undefined);setNotebook(false); setError(""); setFieldError(undefined); setCategory("all"); revision.current++; setLoading(false);}, [section, navigationRevision]);
  const loadFields = (tool: ComputeTool, arguments_ = tool.example ?? {}) => {setFields(fieldsFor(tool, arguments_)); setFieldError(undefined);};
  const select = async (id: string) => {
    const token = ++revision.current; setLoading(true);setNotebook(false); setSelected(undefined); setError(""); setResult(undefined);
    try { const detail = await workbenchApi().compute.catalog(id); if(token !== revision.current) return;
      if(!detail.ok || !detail.tools[0]?.input_schema) throw new Error("Tool schema is unavailable.");
      setSelected(detail.tools[0]); loadFields(detail.tools[0]); setResultTab("result");
    } catch(e) {if(token === revision.current) setError(String(e));} finally {if(token === revision.current) setLoading(false);}
  };
  const run = async () => {
    if(!selected || busy) return;
    setError(""); setFieldError(undefined); setBusy(true); const token = revision.current, workspaceToken = workspaceRevision.current, operation=++runOperation.current;
    try {
      const arguments_ = requestArguments(selected, fields);
      const request = {tool:selected.id, arguments:arguments_};
      const receipt = await workbenchApi().compute.run(request);
      if(!receipt.ok) throw new Error(receipt.diagnostics?.map(d=>d.message).join(" · ") || "The computation did not complete.");
      if(receipt.tool === "analyze_protein_comparison" || selected.id === "analyze_protein_comparison") {
        receipt.result=await readVerifiedComputeResult(receipt,import.meta.env?.DEV ? readLocalComputeArtifact : workbenchApi().files.read,"analyze_protein_comparison");
        proteinStudy(receipt.result,request.arguments.aligned_sequences);
      }
      if(receipt.tool === "import_colabfold_result" || selected.id === "import_colabfold_result") {
        receipt.result=await readVerifiedComputeResult(receipt,import.meta.env?.DEV ? readLocalComputeArtifact : workbenchApi().files.read,"import_colabfold_result");
        validateStructurePrediction(receipt.result,request.arguments,receipt);
      }
      if(receipt.tool === "analyze_rnaseq_study" || selected.id === "analyze_rnaseq_study") {
        receipt.result=await readVerifiedComputeResult(receipt,import.meta.env?.DEV ? readLocalComputeArtifact : workbenchApi().files.read,"analyze_rnaseq_study");
        validateRnaSeqStudy(receipt.result,request.arguments,receipt);
      }
      if(workspaceToken !== workspaceRevision.current) return;
      const entry = {tool:selected, request, receipt, at:new Date().toISOString()};
      if(token === revision.current) {setResult(entry); setResultTab("result");}
    } catch(e) {if(token === revision.current) {
      setError(e instanceof Error ? e.message : String(e));
      if(e instanceof ComputeInputError) {setFieldError(e); document.getElementById(`compute-field-${e.field}`)?.focus();}
    }} finally {if(operation===runOperation.current&&workspaceToken===workspaceRevision.current)setBusy(false);}
  };
  const openSaved=(saved:ComputeStudyOpenedRun)=>{
    if(currentWorkspace.current!==workspace)return;
    if(saved.integrity.status!=="verified"||!saved.request||!saved.receipt){setError("Saved result integrity could not be verified.");return;}
    try {
      if(!saved.receipt.result)throw new Error("The saved result payload was not returned.");
      if(saved.request.tool==="analyze_protein_comparison")proteinStudy(saved.receipt.result,saved.request.arguments.aligned_sequences);
      if(saved.request.tool==="import_colabfold_result")validateStructurePrediction(saved.receipt.result,saved.request.arguments,saved.receipt);
      if(saved.request.tool==="analyze_rnaseq_study")validateRnaSeqStudy(saved.receipt.result,saved.request.arguments,saved.receipt);
      const current=catalog?.tools.find(tool=>tool.id===saved.request!.tool);
      const tool:ComputeTool=current??{id:saved.request.tool,title:label(saved.request.tool),description:"Saved computation record. Current method metadata is unavailable.",available:false,dependency:[],implementation:"not-recorded",upstream_functions:[],missing_dependencies:[]};
      revision.current++;setSelected(tool);loadFields(tool,saved.request.arguments);setResult({tool,request:saved.request,receipt:saved.receipt,at:saved.createdAt??saved.receipt.created_at??"",saved});setResultTab("result");setNotebook(false);setError("");
    }catch(error){setError(`Saved result cannot be displayed: ${error instanceof Error?error.message:String(error)}`);}
  };
  const showProjects=section==="history"||notebook;
  const domainTools = (catalog?.tools ?? []).filter(t => section === "all" || section === "history" || categoryFor(t).section === section);
  const categories = [...new Map(domainTools.map(t => [categoryFor(t).id, categoryFor(t)])).values()];
  const tools = domainTools.filter(t => (category === "all" || categoryFor(t).id === category) && toolMatches(t, query) &&
    (availability === "all" || availability === "files" ? availability !== "files" || Object.keys(t.file_inputs ?? {}).length > 0 : t.available));
  return <main id="compute-workspace" role="tabpanel" aria-labelledby="mode-compute" hidden={hidden} className="compute-workspace">
    {notebook || !selected ? <div className="analysis-library">
      <header className="analysis-library-heading"><span className="section-kicker">THE COMPUTATIONAL WORKBENCH</span><h1>{showProjects ? "Your research notebook." : section === "biology" ? "Make sense of biological data." : section === "statistics" ? "Look closer at your data." : section === "imaging" ? "From images to measurements." : section === "simulation" ? "Explore how systems change." : section === "chemistry" ? "A closer look at molecules." : "A space for analysis."}</h1><p>Explore a question. Choose a method. Keep the evidence.</p></header>
      {error && <div role="alert" className="analysis-error">{error}</div>}
      {showProjects ? <>{notebook&&result&&<button type="button" className="quiet-button" onClick={()=>setNotebook(false)}><ArrowLeft size={15}/> Return to result</button>}<ResearchStudyPanel key={workspace} store={studyStore} onOpen={openSaved} runToLink={notebook&&result&&!result.receipt.preview?result.receipt.run_id:undefined}/></> : <>
        <div className="analysis-library-toolbar"><label className="analysis-search"><Search size={17}/><input aria-label="Find an analysis" placeholder="Search methods, questions or file formats…" value={query} onChange={e=>setQuery(e.target.value)}/></label><span role="status">{tools.length} / {domainTools.length} methods</span></div>
        <div className="analysis-filters"><label>Collection<select aria-label="Analysis collection" value={category} onChange={e=>setCategory(e.target.value)}><option value="all">All collections</option>{categories.map(group=><option key={group.id} value={group.id}>{group.title} ({domainTools.filter(t=>categoryFor(t).id === group.id).length})</option>)}</select></label><label>Inputs & availability<select aria-label="Analysis availability" value={availability} onChange={e=>setAvailability(e.target.value)}><option value="all">All methods</option><option value="files">Uses workspace files</option>{!preview && <option value="ready">Dependencies installed</option>}</select></label>{(query || category !== "all" || availability !== "all") && <button type="button" className="quiet-button" onClick={()=>{setQuery("");setCategory("all");setAvailability("all");}}>Clear filters</button>}</div>
        {preview && <p className="analysis-catalog-note">Recorded examples · Desktop checks local dependencies and runs your own data.</p>}
        {loading && <div role="status" className="analysis-loading"><LoaderCircle className="spin" size={16}/> Opening analysis…</div>}
        {!catalog && !error && <div role="status" className="analysis-loading">Loading the local tool catalog…</div>}
        {categories.map(group => {const entries = tools.filter(t=>categoryFor(t).id === group.id); return entries.length > 0 && <section className="analysis-library-group" key={group.id}><div className="library-section-heading"><h2>{group.title}</h2><span>{entries.length} methods · {domainTitles[group.section]}</span></div><div className="analysis-methods">{entries.map(tool => <button type="button" key={tool.id} className="analysis-method" onClick={()=>void select(tool.id)} disabled={loading}><span className="analysis-method-icon"><MethodIcon size={19}/></span><span className="analysis-method-copy"><strong>{tool.title}</strong><small>{tool.description}</small><em>{preview ? "Recorded example" : tool.available ? "Dependencies installed" : "Dependencies required"} · {Object.keys(tool.file_inputs ?? {}).length ? "Workspace files" : "Data inputs"}</em></span><ArrowUpRight size={15}/></button>)}</div></section>;})}
        {catalog && !tools.length && <div className="analysis-empty"><h2>No matching methods.</h2><p>Try a different search or clear the collection and input filters.</p></div>}
        <footer className="analysis-library-footer"><FlaskConical size={15}/><span>Biomni adaptations & Proto calculations · Offline analysis with recorded provenance</span></footer>
      </>}
    </div> : <div className="analysis-desk">
      <header className="analysis-desk-heading"><button type="button" className="quiet-button" onClick={()=>{revision.current++;setSelected(undefined); setError("");}}><ArrowLeft size={15}/> {section === "history" ? "Research projects" : "Methods"}</button><div><span className="section-kicker">{categoryFor(selected).title}</span><h1>{selected.title}</h1></div><span className="analysis-local-tag">{result?.saved ? "Saved local record" : preview ? "Example preview" : "Local runtime"}</span></header>
      <div className="analysis-desk-body"><section className="analysis-inputs" aria-label="Analysis inputs"><div className="analysis-panel-title"><h2>Inputs & method</h2><button type="button" title="Restore example" aria-label="Restore example" disabled={busy||!!result?.saved} onClick={()=>{loadFields(selected); setError("");}}><RotateCcw size={15}/></button></div><p className="analysis-description">{selected.description}</p>{Object.keys(selected.file_inputs ?? {}).length > 0 && <p className="analysis-workspace-note">{preview ? "The example uses recorded file data. Paths below identify its inputs; no files are read by this preview." : <>Resolve input paths inside <code>{catalog?.workspace_path||workspace}</code>. File contents and hashes are recorded with each run.</>}</p>}
        {result?.saved ? <><h3>Saved input snapshot</h3><p className="analysis-description">These are the recorded inputs. The current catalog is not the method assessment saved with this run.</p><pre className="analysis-json">{JSON.stringify(result.request,null,2)}</pre><button type="button" className="quiet-button" onClick={()=>void select(result.request.tool)}>Open current method</button></> : <><MethodMaturity maturity={selected.maturity}/>
        <form onSubmit={e=>{e.preventDefault(); void run();}}>
          {selected.id==="analyze_rnaseq_study"?<RnaSeqStudyFields tool={selected} fields={fields} busy={busy} error={fieldError} onChange={(name,value)=>{setFields(previous=>({...previous,[name]:value}));setFieldError(undefined);setError("");}}/>:Object.keys(selected.input_schema?.properties ?? {}).map(key => <ComputeField key={`${selected.id}-${key}`} tool={selected} name={key} value={fields[key] ?? ""} busy={busy} error={fieldError?.field === key ? fieldError.message : undefined} onChange={value => {setFields(previous => ({...previous, [key]: value})); setFieldError(undefined); setError("");}} />)}
          {error && <div className="analysis-error" role="alert">{error}</div>}
          {!enabled && !preview && <p className="analysis-error">Enable Biomni computations in Settings to use this method.</p>}
          {!preview && !selected.available && <p className="analysis-error">Missing dependencies: {selected.missing_dependencies.join(", ")}</p>}
          <button className="primary-button analysis-run" type="submit" disabled={busy || (!preview && (!selected.available || !enabled))}>{busy ? <LoaderCircle className="spin" size={16}/> : <Play size={15}/>} {busy ? "Calculating…" : preview ? "Run example" : "Run analysis"}</button>
          <p className="analysis-footnote">{preview ? "Preview replays the supplied example. Use the desktop app for your own data." : "Inputs and results are saved with the method and provenance in your workspace."}</p>
        </form></>}
      </section><section className="analysis-output" aria-label="Analysis output"><div className="analysis-output-tabs" role="tablist" aria-label="Result views" onKeyDown={event => {if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || (event.target as HTMLElement).getAttribute("role") !== "tab") return; event.preventDefault(); const tabs = ["result", "input", "provenance"] as const; const index = tabs.indexOf(resultTab); const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3; setResultTab(tabs[next]); document.getElementById(`analysis-tab-${tabs[next]}`)?.focus();}}>{(["result","input","provenance"] as const).map(tab=><button type="button" key={tab} id={`analysis-tab-${tab}`} role="tab" aria-controls="analysis-result-panel" tabIndex={resultTab === tab ? 0 : -1} aria-selected={resultTab===tab} onClick={()=>setResultTab(tab)}>{tab === "result" ? "Results" : tab === "input" ? "Run inputs" : "Provenance"}</button>)}{result && <ResultDownload result={result}/>}</div>
        {!result ? <div className="analysis-empty"><FlaskConical size={30}/><span className="section-kicker">READY WHEN YOU ARE</span><h2>A result starts with a question.</h2><p>Review the inputs, then run the analysis.<br/>Your results and their provenance will appear here.</p><div className="analysis-empty-flow"><span>01 · Inputs</span><ChevronRight size={13}/><span>02 · Compute</span><ChevronRight size={13}/><span>03 · Review</span></div></div> : <div id="analysis-result-panel" className="analysis-result-body" role="tabpanel" aria-labelledby={`analysis-tab-${resultTab}`}><div className="analysis-result-status"><Check size={15}/><span>{result.saved ? "Saved run reopened" : result.receipt.preview ? "Example replay" : "Computation complete"} · {result.at ? new Date(result.at).toLocaleString() : "Date not recorded"}</span><small>Review required</small></div>
          {!result.saved&&computeInputsChanged(result.tool, fields, result.request.arguments) && <p className="analysis-workspace-note">Inputs have changed. These results still belong to the last run; run again to apply your edits.</p>}
          {!result.receipt.preview&&/^[a-f0-9]{32}$/.test(result.receipt.run_id??"")&&<button type="button" className="quiet-button" onClick={()=>setNotebook(true)}>Add result to research project</button>}
          {result.saved&&<RunRecordStatus run={result.saved}/>}
          {resultTab === "provenance" && <section aria-label="Recorded method assessment"><h3>Assessment saved with this run</h3><EvidenceStandingView standing={result.receipt.evidence_standing}/><MethodMaturity maturity={result.receipt.maturity}/></section>}
          {resultTab === "input" ? <><p className="analysis-description">Exact input snapshot for this result. Editing the form does not change this record.</p><pre className="analysis-json">{JSON.stringify(result.request,null,2)}</pre></> : resultTab === "provenance" ? <><h2>Every result has a history.</h2><dl className="analysis-provenance"><dt>Recorded method ID</dt><dd>{result.request.tool}</dd><dt>Implementation saved with run</dt><dd>{result.receipt.implementation??"Not recorded in this historical run"}</dd><dt>Implementation version</dt><dd>{result.receipt.implementation_version??"Not recorded"}</dd><dt>Upstream revision saved with run</dt><dd>{result.receipt.upstream_commit??"Not recorded"}</dd><dt>Upstream functions saved with run</dt><dd>{result.receipt.upstream_functions?JSON.stringify(result.receipt.upstream_functions):"Not recorded"}</dd><dt>Method references saved with run</dt><dd>{result.receipt.method_references?.join(" · ")||"Not recorded"}</dd><dt>Runtime saved with run</dt><dd>{result.receipt.runtime?JSON.stringify(result.receipt.runtime):"Not recorded"}</dd><dt>Run</dt><dd>{result.receipt.run_id ?? "Browser example replay — no workspace run"}</dd></dl>{result.receipt.artifacts?.map(item=>{const path=typeof item === "string" ? item : item.path; return <button className="analysis-artifact" type="button" key={path} onClick={()=>void (catalog?.execution === "local"&&workbenchDataMode() === "preview" ? downloadLocalComputeArtifact(path) : workbenchApi().files.reveal(path)).catch(e=>setError(String(e)))}><FileJson2 size={16}/><span>{path}</span><ArrowUpRight size={14}/></button>;})}</> : <ResultContent entry={result}/>}
        </div>}
      </section></div>
    </div>}
  </main>;
}

function MethodMaturity({maturity}: {maturity?: ComputeMaturity}) {
  if (!maturity) return <p className="analysis-workspace-note">No maturity assessment is recorded here for this method.</p>;
  const titles = {
    "method-implementation": "Method implementation",
    "numerical-reference-tested": "Numerical reference checks",
    demonstration: "Demonstration method",
    heuristic: "Heuristic method",
  };
  return <section aria-label="Method maturity">
    <p className="analysis-method-note"><strong>{titles[maturity.method_stage]}</strong> · Scientific validity for your dataset has not been established.</p>
    <details className="analysis-detail" open={maturity.method_stage === "demonstration" || maturity.method_stage === "heuristic"}>
      <summary>Applicability & limitations</summary>
      <div className="analysis-limitations"><h3>Intended scope</h3><ul>{maturity.applicability.map((item, index) => <li key={index}>{item}</li>)}</ul>
        <h3>Known limitations</h3><ul>{maturity.known_limitations.map((item, index) => <li key={index}>{item}</li>)}</ul>
        <p className="analysis-footnote">Dependency availability is separate from method maturity. These labels do not confer scientific approval.</p>
        {maturity.evidence.length > 0 && <details className="analysis-detail"><summary>Evidence inventory · {maturity.evidence.length} references</summary>
          <p className="analysis-footnote">These references identify implementation source or test definitions. They are not live acceptance results or evidence that tests passed for this run.</p>
          <ul>{maturity.evidence.map((entry, index) => <li key={index}><code>{entry.path}</code><p>{entry.scope}</p>{entry.test_ids?.map(id => <p key={id}><code>{id}</code></p>)}</li>)}</ul>
        </details>}
      </div>
    </details>
  </section>;
}

function ResultContent({entry}: {entry:SessionResult}) {
  const result=entry.receipt.result ?? {};
  if(result.study_schema === "proto-agent.protein-comparison.v1") return <ProteinComparisonResults study={proteinStudy(result,entry.request.arguments.aligned_sequences)}/>;
  if(result.schema_version === "proto-agent.structure-prediction-import.v1") return <StructurePredictionResult result={result} requested={entry.request.arguments} receipt={entry.receipt}/>;
  if(entry.request.tool === "analyze_rnaseq_study") return <RnaSeqStudyResults result={result} requested={entry.request.arguments} receipt={entry.receipt}/>;
  const priority=["p_value","statistic","degrees_of_freedom","coefficient","r_squared","mean","standard_deviation","base_pair_count","stem_count","vmax","km","mean_difference","n"];
  const rank=(key:string)=>priority.includes(key) ? priority.indexOf(key) : 100;
  const metrics=Object.entries(result).filter(([key,value])=>typeof value === "number" && !key.includes("standard_error")).sort(([a],[b])=>rank(a)-rank(b)).slice(0,6);
  return <><div className="analysis-metrics">{metrics.map(([key,value])=><div key={key}><span>{label(key)}</span><strong>{pretty(value)}</strong></div>)}</div>{categoryFor(entry.tool).id === "statistics" && <ObservationPlot request={entry.request}/>}<ComputeResultViews result={result}/>{result.preview_omitted === true && typeof result.stored_in === "string" && <div className="analysis-workspace-note"><p>The full result is saved in your workspace. It exceeds the inline preview limit.</p><code>{result.stored_in}</code><p>Open the result from Provenance to inspect the complete data.</p></div>}{typeof result.method === "string" && <p className="analysis-method-note">{result.method}</p>}<details className="analysis-detail" open={!metrics.length}><summary>Complete result <FileJson2 size={14}/></summary><pre className="analysis-json">{JSON.stringify(result,null,2)}</pre></details>{Array.isArray(result.limitations) && <div className="analysis-limitations"><h3>Interpretation notes</h3><ul>{result.limitations.map((item,index)=><li key={index}>{String(item)}</li>)}</ul></div>}</>;
}

function ObservationPlot({request}: {request:ComputeRequest}) {
  const canvas=useRef<HTMLCanvasElement>(null);
  const arrays=Object.entries(request.arguments).filter((entry):entry is [string,number[]]=>Array.isArray(entry[1]) && entry[1].length > 0 && entry[1].every(v=>typeof v === "number" && Number.isFinite(v))).slice(0,3);
  useEffect(()=>{
    const el=canvas.current; if(!el || !arrays.length) return;
    const draw=()=>{const width=el.clientWidth,height=250,dpr=window.devicePixelRatio || 1; el.width=width*dpr; el.height=height*dpr; const ctx=el.getContext("2d"); if(!ctx) return;ctx.scale(dpr,dpr);const theme=getComputedStyle(el);const ink=theme.color,line=theme.getPropertyValue("--line");const all=arrays.flatMap(([,v])=>v);let min=Math.min(...all),max=Math.max(...all);const pad=(max-min || 1)*.15;min-=pad;max+=pad;const left=56,right=width-24,top=25,bottom=205;ctx.font='11px "Proto Mono"' ;ctx.fillStyle=ink;ctx.textAlign="right";
      for(let i=0;i<5;i++){const y=top+(bottom-top)*i/4;ctx.strokeStyle=line;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();ctx.fillText(pretty(max-(max-min)*i/4),left-10,y+4);}
      ctx.textAlign="center";ctx.fillStyle=ink;ctx.fillText("Observation order",(left+right)/2,220);
      arrays.forEach(([name,values],series)=>{ctx.fillStyle=[ink,"#7e898f","#9b9690"][series];values.slice(0,1000).forEach((value,index)=>{const count=Math.max(...arrays.map(([,v])=>Math.min(v.length,1000)));const x=left+(right-left)*(index+.5)/count;const y=bottom-(value-min)/(max-min)*(bottom-top);ctx.beginPath();ctx.arc(x,y,3.1,0,Math.PI*2);ctx.fill();});ctx.textAlign="left";ctx.fillRect(left+series*150,231,8,8);ctx.fillText(label(name),left+14+series*150,239);});
    };draw();const observer=new ResizeObserver(draw);observer.observe(el);const themeObserver=new MutationObserver(draw);themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:["data-theme"]});return()=>{observer.disconnect();themeObserver.disconnect();};
  },[request]);
  if(!arrays.length) return null;
  return <figure className="analysis-figure"><figcaption><span>Input observations</span><small>Value by observation order · first 1,000 per series</small></figcaption><canvas ref={canvas} role="img" aria-label={`Input observation plot for ${arrays.map(([k])=>label(k)).join(", ")}. Exact values are available in Run inputs.`}/></figure>;
}

function ResultDownload({result}:{result:SessionResult}){
  const [url,setUrl]=useState<string>();
  useEffect(()=>{
    const objectUrl=URL.createObjectURL(new Blob([JSON.stringify(result.receipt,null,2)],{type:"application/json"}));
    setUrl(objectUrl);
    return()=>URL.revokeObjectURL(objectUrl);
  },[result]);
  return <a className="analysis-download" href={url} download={`${result.request.tool}${result.receipt.preview ? "-example" : "-result"}.json`} title="Download run record JSON" aria-disabled={!url}><Download size={15}/><span>JSON</span></a>;
}
