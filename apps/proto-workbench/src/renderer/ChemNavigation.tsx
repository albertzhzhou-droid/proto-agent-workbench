import {Atom,Boxes,Calculator,CircleHelp,Cuboid,Database,ChartNoAxesCombined,Code2,FileText,History,Layers,Library,PanelsTopLeft,Repeat2,Settings,SlidersHorizontal,SquarePen,Waypoints} from 'lucide-react';
import {WorkspaceModeSwitch} from './WorkspaceModeSwitch.tsx';
import {useResearchChat} from './research-chat-store.ts';
import type {WorkbenchMode} from './WorkspaceNavigation.tsx';
import {ResearchConversationNavigation} from './ResearchConversationList.tsx';

export type ChemDesignTarget={view:'design'|'structure'|'xdl';section:string;revision:number};
export type ChemComputeSection='analysis'|'statistics'|'chemical-data'|'simulator'|'operators'|'history';
export type ChemUtility='models'|'settings'|'help';
export const CHEM_DESIGN_LINKS=[
  {label:'Design canvas',view:'design',section:'spatial',icon:PanelsTopLeft},
  {label:'Candidate libraries',view:'design',section:'candidates',icon:Layers},
  {label:'Interface reactions',view:'design',section:'interfaces',icon:Waypoints},
  {label:'Molecular refinement',view:'design',section:'refinement',icon:SlidersHorizontal},
  {label:'Structure & coordinates',view:'structure',section:'lab',icon:Cuboid},
  {label:'Quantum calculations',view:'structure',section:'calculations',icon:Atom},
  {label:'Source & evidence',view:'structure',section:'source',icon:Code2},
  {label:'XDL documents',view:'xdl',section:'xdl',icon:FileText},
] as const;
export function ChemNavigation({mode,onMode,target,onTarget,section,onSection,utility,onUtility}:{mode:WorkbenchMode;onMode(value:WorkbenchMode):void;target:ChemDesignTarget;onTarget(view:ChemDesignTarget['view'],section:string):void;section:ChemComputeSection;onSection(value:ChemComputeSection):void;utility:ChemUtility|null;onUtility(value:ChemUtility):void}) {
  const chat=useResearchChat();
  const analyses=[{id:'analysis',label:'Analysis',icon:ChartNoAxesCombined},{id:'statistics',label:'Statistics',icon:Calculator},{id:'chemical-data',label:'Chemical data',icon:Database},{id:'simulator',label:'Reaction simulator',icon:Repeat2},{id:'operators',label:'All operators',icon:Library},{id:'history',label:'Run history',icon:History}] as const;
  return <aside className="workspace-sidebar chem-family-sidebar">
    <div className="workspace-wordmark"><span>Chem<span className="wordmark-dot">.</span></span></div>
    <WorkspaceModeSwitch edition="chem" mode={mode} onMode={onMode}/>
    {mode==='chat'?<>
      <nav className="chat-sidebar-nav" aria-label="Chat navigation"><button type="button" title="New chat" onClick={()=>void chat.newChat()}><SquarePen size={17}/><span>New chat</span></button></nav>
      <ResearchConversationNavigation emptyText="Questions, chemical models and the evidence behind them."/>
    </>:<>
      <div className="sidebar-chapter">{mode==='design'?'CHEMISTRY WORKSPACE':'COMPUTATION'}</div>
      <nav aria-label={mode==='design'?'Chem Design navigation':'Chem Compute navigation'}>{mode==='design'?CHEM_DESIGN_LINKS.map(({label,view,section:value,icon:Icon})=><button type="button" key={`${view}:${value}`} title={label} aria-current={!utility&&target.view===view&&target.section===value?'page':undefined} onClick={()=>onTarget(view,value)}><Icon size={17}/><span>{label}</span></button>):analyses.map(({id,label,icon:Icon})=><button key={id} type="button" title={label} aria-current={section===id?'page':undefined} onClick={()=>onSection(id)}><Icon size={17}/><span>{label}</span></button>)}</nav>
      <div className="sidebar-secondary"><div className="sidebar-chapter">RESEARCH CONTEXT</div><p className="sidebar-note">From molecular structure to a response you can inspect.<br/><br/>Shared tools, saved methods and reproducible results.</p></div>
    </>}
    <div className="sidebar-utilities">
      <button type="button" title="Models" onClick={()=>onUtility('models')} aria-current={utility==='models'?'page':undefined}><Boxes size={16}/><span>Local models</span></button>
      <button type="button" title="Settings" onClick={()=>onUtility('settings')} aria-current={utility==='settings'?'page':undefined}><Settings size={16}/><span>Settings</span></button>
      <button type="button" title="Help" onClick={()=>onUtility('help')} aria-current={utility==='help'?'page':undefined}><CircleHelp size={16}/><span>Help & documentation</span></button>
      <div className="sidebar-edition">CHEM WORKBENCH<span>Local edition · Shared research tools</span></div>
    </div>
  </aside>;
}
