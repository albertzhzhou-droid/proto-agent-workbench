import {ArrowLeft, ArrowUpRight, FlaskConical, Search} from 'lucide-react';
import {useState, type ReactNode} from 'react';
import {MethodIcon} from './workbench-icons.ts';
import type {ChemScienceOperator} from '../shared/chem-science.ts';

const title=(name:string)=>name==='chemical-data'?'Chemical data':name.replace(/^./,c=>c.toUpperCase());
export function ChemToolLibrary({operators,loading,search,onSearch,onSelect}:{operators:ChemScienceOperator[];loading:boolean;search:string;onSearch:(value:string)=>void;onSelect:(operator:ChemScienceOperator)=>void}){
  const [collection,setCollection]=useState('all');
  const categories=Array.from(new Set(operators.map(item=>item.category)));
  const visible=operators.filter(item=>(collection==='all'||item.category===collection)&&search.toLowerCase().trim().split(/\s+/).every(word=>`${item.id} ${item.title} ${item.description} ${item.category}`.toLowerCase().includes(word)));
  const collections=['all',...categories];
  return <div className="chem-tool-library analysis-library">
    <div className="analysis-library-toolbar"><label className="analysis-search"><Search size={17}/><input aria-label="Search chemistry operators" placeholder="Search methods, questions or molecules…" value={search} onChange={e=>onSearch(e.target.value)}/></label><span role="status">{visible.length} / {operators.length} methods</span></div>
    <div className="chem-collection-tabs" role="tablist" aria-label="Chemistry collections" onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const index=collections.indexOf(collection),next=event.key==='Home'?0:event.key==='End'?collections.length-1:(index+(event.key==='ArrowRight'?1:collections.length-1))%collections.length;setCollection(collections[next]);document.getElementById(`chem-collection-${collections[next]}`)?.focus();}}>{collections.map(item=><button type="button" key={item} id={`chem-collection-${item}`} role="tab" aria-selected={collection===item} aria-controls="chem-method-cards" tabIndex={collection===item?0:-1} onClick={()=>setCollection(item)}>{item==='all'?'All collections':title(item)}</button>)}</div>
    <div id="chem-method-cards" role="tabpanel" aria-labelledby={`chem-collection-${collection}`}>
      {categories.map(group=>{const entries=visible.filter(item=>item.category===group);return entries.length>0&&<section className="analysis-library-group" key={group}><div className="library-section-heading"><h2>{title(group)}</h2><span>{entries.length} methods</span></div><div className="analysis-methods">{entries.map(item=><button type="button" className="analysis-method" key={item.id} onClick={()=>onSelect(item)}><span className="analysis-method-icon"><MethodIcon size={19}/></span><span className="analysis-method-copy"><strong>{item.title}</strong><small>{item.description}</small><em>{item.available?'Local dependencies available':'Dependencies required'} · Shared with Chat</em></span><ArrowUpRight size={15}/></button>)}</div></section>;})}
      {!visible.length&&<div className="analysis-empty"><FlaskConical size={28}/><h2>{loading?'Discovering local methods…':'No matching methods.'}</h2><p>{loading?'Reading the chemistry runtime catalog.':'Choose another collection or edit your search.'}</p></div>}
    </div>
  </div>;
}

export function ChemToolDesk({operator,onBack,inputs,result,inputRecord,provenance,hasResult}:{operator:ChemScienceOperator;onBack:()=>void;inputs:ReactNode;result:ReactNode;inputRecord:ReactNode;provenance:ReactNode;hasResult:boolean}){
  const [view,setView]=useState<'result'|'input'|'provenance'>('result');
  const views=['result','input','provenance'] as const;
  return <div className="analysis-desk chem-tool-desk"><header className="analysis-desk-heading"><button className="quiet-button" onClick={onBack}><ArrowLeft size={15}/>Methods</button><div><span className="section-kicker">{title(operator.category)}</span><h1>{operator.title}</h1></div><span className="analysis-local-tag">Local runtime</span></header>
    <div className="analysis-desk-body"><section className="analysis-inputs" aria-label="Chemistry inputs">{inputs}</section><section className="analysis-output" aria-label="Chemistry output"><div className="analysis-output-tabs" role="tablist" aria-label="Chemistry result views" onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const i=views.indexOf(view),next=event.key==='Home'?0:event.key==='End'?2:(i+(event.key==='ArrowRight'?1:2))%3;setView(views[next]);document.getElementById(`chem-result-tab-${views[next]}`)?.focus();}}>{views.map(tab=><button key={tab} id={`chem-result-tab-${tab}`} role="tab" aria-selected={view===tab} aria-controls="chem-result-panel" tabIndex={view===tab?0:-1} onClick={()=>setView(tab)}>{tab==='result'?'Results':tab==='input'?'Run inputs':'Provenance'}</button>)}</div>
      <div className="analysis-result-body" id="chem-result-panel" role="tabpanel" aria-labelledby={`chem-result-tab-${view}`}>{hasResult?(view==='result'?result:view==='input'?inputRecord:provenance):<div className="analysis-empty"><FlaskConical size={30}/><span className="section-kicker">READY WHEN YOU ARE</span><h2>A result starts with a question.</h2><p>Review the inputs, then run the analysis.<br/>Your results and their provenance will appear here.</p></div>}</div>
    </section></div></div>;
}
