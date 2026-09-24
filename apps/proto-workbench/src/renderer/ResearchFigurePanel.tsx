import {useEffect,useRef,useState} from "react";
import {useStore} from "zustand";
import type {StoreApi} from "zustand/vanilla";
import {ArrowDown,ArrowUp,Download,Plus,RefreshCw,Trash2} from "lucide-react";
import type {ComputeStudy} from "../shared/compute-studies.ts";
import type {FigurePanelDraft,FigurePanelView,FigurePoint,FigureSelector,FigureSeries} from "../shared/research-figures.ts";
import {captureFigureDownloadScope,figureDownloadScopeCurrent,figureScopeReady,moveFigurePanel,selectedFigure,type ResearchFigureState} from "./research-figure-state.ts";
import "./research-figure.css";

type Props={store:StoreApi<ResearchFigureState>;workspace:string;study?:ComputeStudy};
const selectorKey=(selector:FigureSelector)=>JSON.stringify(selector);
const sourceName=(selector:FigureSelector)=>`${selector.from}${selector.pointer||" (root)"}${selector.field?` → ${selector.field}`:""}`;
const axisTitle=(label:string,unit:string)=>`${label}${unit?` (${unit})`:""}`;
const colors=["#36749a","#987331","#846594","#4b826d","#b26966","#617383"];

export function ResearchFigurePanel({store,workspace,study}:Props) {
  const state=useStore(store),editor=selectedFigure(state);
  const [newRun,setNewRun]=useState(""),[acknowledge,setAcknowledge]=useState(false),[rebindIds,setRebindIds]=useState<string[]>([]);
  const [verifiedLinks,setVerifiedLinks]=useState<Record<string,{url:string;name:string;bytes:number;scope:ReturnType<typeof captureFigureDownloadScope>}>>({});
  const blobUrls=useRef(new Set<string>()),linkGeneration=useRef(0);
  useEffect(()=>{
    const release=()=>{linkGeneration.current++;for(const url of blobUrls.current)URL.revokeObjectURL(url);blobUrls.current.clear();};
    release();setVerifiedLinks({});return release;
  },[store,workspace,study?.id,study?.revision,state.selectedKey,editor?.baseline?.revision,editor?.draft,state.exported?.exportId]);
  useEffect(()=>{store.getState().activate(workspace,study);void store.getState().list();const current=selectedFigure(store.getState());if(current?.baseline)void store.getState().select(current.key);},[store,workspace,study?.id,study?.revision]);
  useEffect(()=>()=>store.getState().suspend(),[store]);
  useEffect(()=>{setAcknowledge(false);setRebindIds([]);setNewRun("");},[state.selectedKey,study?.id,state.inspection]);
  useEffect(()=>{for(const runId of new Set(editor?.draft.panels.map(panel=>panel.runId)??[]))if(!state.series[runId]&&!state.seriesBusy[runId])void store.getState().loadSeries(runId);},[store,state.selectedKey,editor?.draft.panels.length,study?.revision]);
  if(!study)return null;
  if(!figureScopeReady(state,workspace,study))return <section className="research-figures" aria-label="Research figure boards" aria-busy="true"><h2>Build a figure from saved data</h2><p role="status">Opening figure boards for this project…</p><button type="button" className="quiet-button" disabled><Plus size={15}/> New figure board</button></section>;
  const disabled=!!state.busy||state.opening;
  const draft=editor?.draft;
  const updatePanel=(id:string,change:Partial<FigurePanelDraft>)=>{if(draft)state.edit({panels:draft.panels.map(panel=>panel.id===id?{...panel,...change}:panel)});};
  const addPanel=()=>{
    const numeric=state.series[newRun]?.find(series=>series.kind==="numeric");if(!draft||draft.panels.length>=6||!numeric)return;
    state.edit({panels:[...draft.panels,{id:crypto.randomUUID(),runId:newRun,title:`Panel ${draft.panels.length+1}`,kind:"line",xLabel:"Observation index",yLabel:"",xUnit:"",yUnit:"",y:numeric.selector}]});
  };
  const download=async(file:NonNullable<typeof state.exported>["files"][number])=>{
    const scope=captureFigureDownloadScope(store.getState()),generation=linkGeneration.current;
    const verified=await store.getState().download(file);if(!verified)return;
    if(generation!==linkGeneration.current||!figureDownloadScopeCurrent(scope,store.getState()))return;
    const url=URL.createObjectURL(new Blob([verified.bytes],{type:verified.mimeType}));blobUrls.current.add(url);
    setVerifiedLinks(previous=>{const old=previous[file.format];if(old){URL.revokeObjectURL(old.url);blobUrls.current.delete(old.url);}return {...previous,[file.format]:{url,name:verified.name,bytes:verified.bytes.length,scope}};});
    const anchor=document.createElement("a");anchor.href=url;anchor.download=verified.name;anchor.hidden=true;document.body.appendChild(anchor);anchor.click();anchor.remove();
  };
  return <section className="research-figures" aria-label="Research figure boards">
    <div className="research-study-heading"><div><p className="research-figure-eyebrow">Figures & methods</p><h2>Build a figure from saved data</h2></div><div className="research-study-actions"><button type="button" className="quiet-button" disabled={disabled} onClick={()=>state.create()}><Plus size={15}/> New figure board</button><button type="button" className="quiet-button" disabled={state.listBusy} onClick={()=>void state.list()}><RefreshCw size={14}/> Refresh figures</button></div></div>
    <p className="research-study-muted">Use numeric series from runs linked to this project. Captions, axis labels and units are your annotations. Saved data and method records remain attached to each panel.</p>
    <div className="research-figure-list" aria-label="Saved figure boards">
      {state.figures.map(figure=>{const cached=state.editors.find(item=>item.key===figure.id);return <button type="button" className={`research-figure-choice ${state.selectedKey===figure.id?"is-selected":""}`} key={figure.id} onClick={()=>void state.select(figure.id)}><strong>{figure.title}</strong><small>{figure.panelCount} panels · revision {figure.revision}{cached?.dirty?" · unsaved edits retained":""}</small></button>;})}
      {state.editors.filter(item=>!item.baseline).map(item=><button type="button" className={`research-figure-choice ${state.selectedKey===item.key?"is-selected":""}`} key={item.key} onClick={()=>void state.select(item.key)}><strong>{item.draft.title||"Untitled draft"}</strong><small>Unsaved draft · retained in this workspace session</small></button>)}
      {state.editors.filter(item=>item.baseline&&!state.figures.some(figure=>figure.id===item.key)).map(item=><button type="button" className={`research-figure-choice ${state.selectedKey===item.key?"is-selected":""}`} key={item.key} onClick={()=>void state.select(item.key)}><strong>{item.draft.title}</strong><small>Saved board in this session{item.dirty?" · unsaved edits retained":""}</small></button>)}
      {!state.figures.length&&!state.editors.length&&!state.listBusy&&<p className="research-study-muted">No figure boards yet. Link a saved computation above, then create a board.</p>}
    </div>
    {state.error&&<p className="analysis-error" role="alert">{state.error}</p>}
    {state.notice&&<p className="research-study-notice" role="status">{state.notice}</p>}
    {state.opening&&<p role="status">Opening saved figure board…</p>}
    {editor&&draft&&<>
      <form className="research-figure-editor" aria-label="Figure board editor" onSubmit={event=>{event.preventDefault();void state.save();}}>
        <fieldset disabled={disabled}><legend>Figure board</legend>
          <label>Figure title<input required maxLength={160} value={draft.title} onChange={event=>state.edit({title:event.target.value})}/></label>
          <label>Caption · authored by you<textarea maxLength={4000} rows={3} value={draft.caption} onChange={event=>state.edit({caption:event.target.value})} placeholder="Describe what the panels show and the limits of interpretation."/></label>
          <label className="research-figure-compact">Layout<select value={draft.columns} onChange={event=>state.edit({columns:Number(event.target.value) as 1|2})}><option value={1}>One column</option><option value={2}>Two columns</option></select></label>
          {draft.panels.map((panel,index)=>{
            const series=state.series[panel.runId]??[],numeric=series.filter(item=>item.kind==="numeric"),xSeries=series.filter(item=>panel.kind==="bar"||item.kind==="numeric");
            const linked=study.links.some(link=>link.runId===panel.runId);
            return <fieldset className="research-figure-panel-editor" key={panel.id}><legend>Panel {String.fromCharCode(65+index)}</legend>
              <div className="research-study-actions"><button type="button" className="quiet-button" aria-label={`Move panel ${index+1} earlier`} disabled={index===0} onClick={()=>state.edit({panels:moveFigurePanel(draft.panels,panel.id,-1)})}><ArrowUp size={14}/></button><button type="button" className="quiet-button" aria-label={`Move panel ${index+1} later`} disabled={index===draft.panels.length-1} onClick={()=>state.edit({panels:moveFigurePanel(draft.panels,panel.id,1)})}><ArrowDown size={14}/></button><button type="button" className="quiet-button" onClick={()=>state.edit({panels:draft.panels.filter(item=>item.id!==panel.id)})}><Trash2 size={14}/> Remove panel {index+1}</button></div>
              <p className="research-figure-source">Saved run <code>{panel.runId}</code></p>
              {!linked&&<p className="research-study-notice" role="status">This run is no longer linked to the project. Relink it above before saving or exporting this panel.</p>}
              <div className="research-figure-fields"><label>Panel title<input required maxLength={160} value={panel.title} onChange={event=>updatePanel(panel.id,{title:event.target.value})}/></label><label>Chart type<select value={panel.kind} onChange={event=>updatePanel(panel.id,{kind:event.target.value as FigurePanelDraft["kind"]})}><option value="line">Line · recorded order</option><option value="scatter">Scatter</option><option value="bar">Bar</option></select></label>
                <SeriesSelect label="Y data · numeric" series={numeric} selected={panel.y} busy={state.seriesBusy[panel.runId]} onChange={selector=>{if(selector)updatePanel(panel.id,{y:selector});}}/>
                <SeriesSelect label="X data" series={xSeries} selected={panel.x} busy={state.seriesBusy[panel.runId]} allowIndex onChange={selector=>{const next={...panel};if(selector)next.x=selector;else delete next.x;state.edit({panels:draft.panels.map(item=>item.id===panel.id?next:item)});}}/>
                <label>X label · authored<input maxLength={120} value={panel.xLabel} onChange={event=>updatePanel(panel.id,{xLabel:event.target.value})}/></label><label>X unit · authored<input maxLength={64} value={panel.xUnit} onChange={event=>updatePanel(panel.id,{xUnit:event.target.value})}/></label>
                <label>Y label · authored<input maxLength={120} value={panel.yLabel} onChange={event=>updatePanel(panel.id,{yLabel:event.target.value})}/></label><label>Y unit · authored<input maxLength={64} value={panel.yUnit} onChange={event=>updatePanel(panel.id,{yUnit:event.target.value})}/></label>
              </div>
              {state.seriesTruncated[panel.runId]&&<p className="research-study-muted">The host reached its series discovery limit. This menu shows a bounded subset of the saved JSON.</p>}
              {!state.series[panel.runId]&&!state.seriesBusy[panel.runId]&&linked&&<button type="button" className="quiet-button" onClick={()=>void state.loadSeries(panel.runId)}>Retry data series</button>}
            </fieldset>;
          })}
          <div className="research-figure-add"><label>Add a panel from a linked run<select value={newRun} disabled={draft.panels.length>=6} onChange={event=>{setNewRun(event.target.value);if(event.target.value)void state.loadSeries(event.target.value);}}><option value="">Choose a saved run</option>{study.links.map(link=><option value={link.runId} key={link.runId}>{link.binding.tool} · {link.runId}</option>)}</select></label><button type="button" className="quiet-button" disabled={draft.panels.length>=6||!state.series[newRun]?.some(series=>series.kind==="numeric")} onClick={addPanel}><Plus size={15}/> Add panel ({draft.panels.length}/6)</button></div>
          {newRun&&state.seriesBusy[newRun]&&<p role="status">Checking saved data and discovering selectable series…</p>}
          {newRun&&state.series[newRun]&&!state.series[newRun].some(series=>series.kind==="numeric")&&<p className="research-study-notice">This saved run has no supported numeric series. A numeric scalar, when available, is represented as one recorded point.</p>}
          <div className="research-study-actions"><button type="submit" className="quiet-button" disabled={!draft.panels.length||!!editor.remoteRevision}>{state.busy==="save"?"Saving figure…":"Save and inspect figure"}</button><span className="research-study-muted">{editor.dirty?"Unsaved edits · retained while navigating this workspace session":`Saved revision ${editor.baseline?.revision}`}</span></div>
        </fieldset>
      </form>
      {editor.baseline&&<div className="research-study-actions"><button type="button" className="quiet-button" disabled={disabled} onClick={()=>void state.reload()}>{editor.dirty?"Discard figure edits and reload saved figure":"Reload saved figure"}</button><button type="button" className="quiet-button" disabled={disabled||editor.dirty||state.inspectionBusy} onClick={()=>void state.inspect()}><RefreshCw size={14}/> Check saved sources</button></div>}
      {editor.remoteRevision&&<p className="research-study-notice" role="status">A newer saved revision ({editor.remoteRevision}) is available. Your draft started from revision {editor.baseline?.revision}. Reload saved figure before editing again.</p>}
      {editor.dirty&&<p className="research-study-muted">Save this draft to preview its exact saved selections. An earlier figure is not displayed as if it includes these edits.</p>}
      {state.inspectionBusy&&<p role="status">Verifying panel bindings and original source files…</p>}
      {state.inspection&&<section aria-label="Saved figure preview" className="research-figure-preview">
        <h3>{state.inspection.figure.title}</h3><p className="research-study-muted">Saved revision {state.inspection.figure.revision} · preview from verified saved values. Matching hashes do not establish scientific validity.</p>
        <div className={`research-figure-canvas columns-${state.inspection.figure.columns}`}>{state.inspection.figure.panels.map((panel,index)=><FigurePreview key={panel.id} panel={panel} view={state.inspection!.panels.find(view=>view.id===panel.id)} index={index}/>)}</div>
        {state.inspection.figure.caption&&<p className="research-figure-caption"><strong>Authored caption. </strong>{state.inspection.figure.caption}</p>}
        <details className="research-figure-methods"><summary>Methods draft from saved run records</summary><p className="research-study-muted">Review this record-derived draft before use. It does not infer experimental conditions, causal claims or scientific validity.</p><pre>{state.inspection.methodsMarkdown}</pre></details>
        <div className="research-figure-rebind"><details><summary>Explicitly refresh selected panel bindings</summary><p>Use this only when you intend to bind a panel to the project’s current saved run artifacts. Saving titles or labels alone retains the earlier hashes. Original source-file changes are reported separately.</p>{state.inspection.figure.panels.map((panel,index)=><label className="research-study-checkbox" key={panel.id}><input type="checkbox" checked={rebindIds.includes(panel.id)} disabled={disabled} onChange={event=>setRebindIds(ids=>event.target.checked?[...ids,panel.id]:ids.filter(id=>id!==panel.id))}/>Panel {String.fromCharCode(65+index)} · {panel.title}</label>)}<button type="button" className="quiet-button" disabled={disabled||!rebindIds.length} onClick={()=>void state.rebind(rebindIds)}>Refresh selected source bindings</button></details></div>
        {state.inspection.requiresSourceAcknowledgement&&<label className="research-figure-ack"><input type="checkbox" checked={acknowledge} onChange={event=>setAcknowledge(event.target.checked)}/>I acknowledge the original source files changed or could not all be checked. Export the recorded values with this status retained.</label>}
        <div className="research-study-actions"><button type="button" className="quiet-button" disabled={disabled||!state.inspection.canExport||(state.inspection.requiresSourceAcknowledgement&&!acknowledge)} onClick={()=>void state.export(acknowledge)}><Download size={15}/>{state.busy==="export"?"Generating bundle…":"Generate SVG, PDF, data & methods bundle"}</button></div>
        {!state.inspection.canExport&&<p className="research-study-notice">Export is unavailable while a panel has changed bindings, unavailable records or an invalid data selection. Inspect its status above.</p>}
      </section>}
      {state.exports.length>0&&<section className="research-figure-export-history" aria-label="Saved export history"><h3>Export history</h3><p className="research-study-muted">Reopen a saved bundle by its figure revision and export date. Downloads check the recorded bytes; they do not rerun source checks from the time of export.</p><div className="research-study-actions">{state.exports.map(exported=><button type="button" key={exported.exportId} className="quiet-button" aria-pressed={state.exported?.exportId===exported.exportId} onClick={()=>state.showExport(exported.exportId)}>Revision {exported.figureRevision} · {new Date(exported.createdAt).toLocaleString()}</button>)}</div></section>}
      {state.exported&&<section className="research-figure-exports" aria-label="Figure export files"><h3>Saved export bundle</h3><p>Figure revision {state.exported.figureRevision} · {new Date(state.exported.createdAt).toLocaleString()}</p>{(state.exported.figureRevision!==editor.baseline?.revision||editor.dirty)&&<p className="research-study-notice">Historical export. This bundle belongs to saved figure revision {state.exported.figureRevision}; it does not include the current editor changes.</p>}<ul>{state.exported.files.map(file=>{const prepared=verifiedLinks[file.format],visible=prepared&&figureDownloadScopeCurrent(prepared.scope,state);return <li key={file.format}><button type="button" className="quiet-button" disabled={!!state.downloadBusy} onClick={()=>void download(file)}><Download size={14}/>{state.downloadBusy===file.format?"Verifying…":`Download ${file.format.toUpperCase()}`}</button>{visible&&<span role="status"><a href={prepared.url} download={prepared.name}>Save verified {file.format.toUpperCase()}</a> · {prepared.bytes.toLocaleString()} verified bytes. Use this link if the automatic download did not start.</span>}<code>{file.path}</code><small>{file.bytes.toLocaleString()} bytes · SHA-256 {file.sha256}</small></li>;})}</ul><details><summary>Export manifest</summary><code>{state.exported.manifestPath}</code><p><code>{state.exported.manifestSha256}</code></p></details></section>}
    </>}
  </section>;
}

function SeriesSelect({label,series,selected,busy,allowIndex,onChange}:{label:string;series:FigureSeries[];selected?:FigureSelector;busy?:boolean;allowIndex?:boolean;onChange:(selector?:FigureSelector)=>void}) {
  const key=selected?selectorKey(selected):"",present=series.some(item=>selectorKey(item.selector)===key);
  return <label>{label}<select value={key} disabled={busy} onChange={event=>onChange(series.find(item=>selectorKey(item.selector)===event.target.value)?.selector)}>{allowIndex&&<option value="">Observation index (1-based)</option>}{selected&&!present&&<option value={key}>{sourceName(selected)} · {busy?"loading":"selection unavailable"}</option>}{series.map(item=><option key={selectorKey(item.selector)} value={selectorKey(item.selector)}>{item.label} · {item.length} {item.kind} values</option>)}</select></label>;
}

function FigurePreview({panel,view,index}:{panel:FigurePanelDraft;view?:FigurePanelView;index:number}) {
  const points=view?.points,visible=points?.slice(0,2000),valid=(view?.status==="ready"||view?.status==="source-changed")&&visible?.length&&visible.every(point=>Number.isFinite(point.y)&&(typeof point.x==="string"||Number.isFinite(point.x)));
  return <figure className="research-figure-chart"><figcaption><strong>{String.fromCharCode(65+index)}. {panel.title}</strong></figcaption><p className="research-figure-status"><strong>{view?.status??"unavailable"}</strong> · {view?.message??"No panel inspection returned."}</p>{valid?<><Plot panel={panel} points={visible!} color={colors[index%colors.length]}/>{points!.length>2000&&<p className="research-study-notice">Preview shows the first 2,000 of {points!.length.toLocaleString()} recorded points. Export retains all selected points.</p>}<p className="research-study-muted">{points!.length.toLocaleString()} points · X: {panel.x?sourceName(panel.x):"1-based observation index"} · Y: {sourceName(panel.y)}</p><details><summary>Recorded point values</summary><div className="research-figure-data"><table><thead><tr><th>Observation</th><th>X</th><th>Y</th></tr></thead><tbody>{points!.slice(0,100).map((point,row)=><tr key={row}><th>{row+1}</th><td>{String(point.x)}</td><td>{String(point.y)}</td></tr>)}</tbody></table></div>{points!.length>100&&<p className="research-study-muted">First 100 rows shown. The exported CSV contains all selected values.</p>}</details></>:<p className="research-study-notice">Verified point values are unavailable for this panel.</p>}{view?.sourceFreshness&&<details><summary>Original source files: {view.sourceFreshness.status}</summary>{view.sourceFreshness.details.map((source,row)=><p key={row}><code>{source.path}</code> · {source.status}<br/>{source.message}</p>)}</details>}</figure>;
}

function Plot({panel,points,color}:{panel:FigurePanelDraft;points:FigurePoint[];color:string}) {
  const W=640,H=350,L=68,R=22,T=20,B=70,w=W-L-R,h=H-T-B,bar=panel.kind==="bar";
  const values=points.map(point=>point.y),yLow=Math.min(...values,...(bar?[0]:[])),yHigh=Math.max(...values,...(bar?[0]:[]));
  const xs=points.map((point,index)=>typeof point.x==="number"?point.x:index+1),xLow=Math.min(...xs),xHigh=Math.max(...xs);
  // Normalize by a common magnitude before subtraction to avoid overflow for finite values.
  const scale=(value:number,low:number,high:number)=>{if(low===high)return .5;const magnitude=Math.max(Math.abs(low),Math.abs(high),Number.MIN_VALUE);return (value/magnitude-low/magnitude)/(high/magnitude-low/magnitude);};
  const x=(point:FigurePoint,index:number)=>L+(bar?(index+.5)/points.length:scale(typeof point.x==="number"?point.x:index+1,xLow,xHigh))*w;
  const y=(value:number)=>T+(1-scale(value,yLow,yHigh))*h,base=y(0);
  const format=(value:number)=>Number.isInteger(value)&&Math.abs(value)<1e6?String(value):value.toPrecision(3);
  return <svg className="research-figure-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${panel.title}: ${panel.kind} chart of ${points.length} recorded points`}>
    <title>{panel.title}</title><desc>Exact saved selected values in recorded order. Axis labels and units are user authored.</desc>
    <line x1={L} x2={L} y1={T} y2={T+h} stroke="currentColor"/><line x1={L} x2={L+w} y1={T+h} y2={T+h} stroke="currentColor"/>
    {(yLow===yHigh?[.5]:[0,.5,1]).map((position,index)=>{const magnitude=Math.max(Math.abs(yLow),Math.abs(yHigh),1),value=(yLow/magnitude*(1-position)+yHigh/magnitude*position)*magnitude;return <g key={index}><line x1={L-4} x2={L+w} y1={T+(1-position)*h} y2={T+(1-position)*h} stroke="currentColor" opacity={.13}/><text x={L-8} y={T+(1-position)*h+4} textAnchor="end">{format(value)}</text></g>;})}
    {panel.kind==="line"&&<polyline points={points.map((point,index)=>`${x(point,index)},${y(point.y)}`).join(" ")} fill="none" stroke={color} strokeWidth={2}/>}
    {points.map((point,index)=>bar?<rect key={index} x={x(point,index)-w/points.length*.36} y={Math.min(base,y(point.y))} width={w/points.length*.72} height={Math.abs(base-y(point.y))} fill={color}><title>{String(point.x)}: {String(point.y)}</title></rect>:<circle key={index} cx={x(point,index)} cy={y(point.y)} r={panel.kind==="scatter"?2.7:points.length<100?2:1} fill={color}><title>{String(point.x)}: {String(point.y)}</title></circle>)}
    {(bar?points.map((point,index)=>({label:String(point.x),position:x(point,index)})).filter((_,index)=>index===0||index===points.length-1||points.length<=8):xLow===xHigh?[{label:format(xLow),position:L+w/2}]:[{label:format(xLow),position:L},{label:format(xHigh),position:L+w}]).map((tick,index)=><text key={index} x={tick.position} y={T+h+20} textAnchor="middle">{tick.label.length>18?`${tick.label.slice(0,17)}…`:tick.label}</text>)}
    <text x={L+w/2} y={H-15} textAnchor="middle" className="research-figure-axis">{axisTitle(panel.xLabel,panel.xUnit)}</text><text transform={`translate(15 ${T+h/2}) rotate(-90)`} textAnchor="middle" className="research-figure-axis">{axisTitle(panel.yLabel,panel.yUnit)}</text>
  </svg>;
}
