import {WORKSPACE_MODE_ICONS} from './workbench-icons.ts';
import type {WorkbenchMode} from './WorkspaceNavigation.tsx';

export function WorkspaceModeSwitch({mode,onMode,edition='proto'}:{mode:WorkbenchMode;onMode(mode:WorkbenchMode):void;edition?:'proto'|'chem'}) {
  const modes:WorkbenchMode[]=['chat','design','compute'];
  return <div className="workspace-mode-switch" role="tablist" aria-label="Workbench mode" onKeyDown={event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();
    const next=event.key==='Home'?'chat':event.key==='End'?'compute':modes[(modes.indexOf(mode)+(event.key==='ArrowRight'?1:2))%3];
    onMode(next);document.getElementById(`mode-${next}`)?.focus();
  }}>
    {modes.map(value=>{const Icon=WORKSPACE_MODE_ICONS[value];const label=value==='chat'?'Chat':value==='design'?'Design':'Compute';return <button key={value} id={`mode-${value}`} type="button" role="tab" aria-selected={mode===value} aria-controls={value==='chat'?'chat-workspace':`${edition==='chem'?'chem-':''}${value}-workspace`} tabIndex={mode===value?0:-1} onClick={()=>onMode(value)} title={value==='compute'?'Computation':label}><Icon size={15}/><span>{label}</span></button>;})}
  </div>;
}
