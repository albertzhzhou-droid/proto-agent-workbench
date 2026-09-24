import { BookOpen, Boxes, Calculator, ChevronRight, ClipboardCheck, Database, FlaskConical, FolderKanban, History, LayoutGrid, Library, Microscope, PanelsTopLeft, ScanLine, Settings, Workflow, CircleHelp, Fingerprint } from "lucide-react";
import { useWorkbenchStore, type AppView } from "./store.ts";
import type { ComputeDomain } from "../shared/compute.ts";
import { SquarePen } from "lucide-react";
import { useResearchChat } from "./research-chat-store.ts";
import { WorkspaceModeSwitch } from "./WorkspaceModeSwitch.tsx";
import { ResearchConversationNavigation } from "./ResearchConversationList.tsx";

export type WorkbenchMode = "design" | "compute" | "chat";
export type ComputeSection = "all" | ComputeDomain | "history";
export function WorkspaceNavigation({ mode, onMode, section, onSection }: {
  mode: WorkbenchMode; onMode(mode: WorkbenchMode): void;
  section: ComputeSection; onSection(section: ComputeSection): void;
}) {
  const currentView = useWorkbenchStore(s => s.currentView);
  const chat = useResearchChat();
  const navigate = useWorkbenchStore(s => s.navigate);
  const runs = useWorkbenchStore(s => s.runs);
  const selectRun = useWorkbenchStore(s => s.selectRun);
  const selectedRunId = useWorkbenchStore(s => s.selectedRunId);
  const showArchived = useWorkbenchStore(s => s.showArchived);
  const setShowArchived = useWorkbenchStore(s => s.setShowArchived);
  const route = (view: AppView) => { onMode("design"); navigate(view); };
  const designNav = [
    {label:"Overview", view:"launchpad", icon:LayoutGrid},
    {label:"Design studio", view:"designs", icon:PanelsTopLeft},
    {label:"Research runs", view:"runs", icon:Workflow},
    {label:"Workspaces", view:"workspaces", icon:FolderKanban},
    {label:"Materials", view:"materials", icon:Database},
    {label:"Sources", view:"sources", icon:BookOpen},
    {label:"Reviews", view:"reviews", icon:ClipboardCheck},
  ] as const;
  const computeNav = [
    {label:"All analyses", section:"all", icon:Library},
    {label:"Statistics", section:"statistics", icon:Calculator},
    {label:"Biological data", section:"biology", icon:Microscope},
    {label:"Systems & simulations", section:"simulation", icon:Workflow},
    {label:"Imaging & microscopy", section:"imaging", icon:ScanLine},
    {label:"Chemistry", section:"chemistry", icon:FlaskConical},
    {label:"Research projects", section:"history", icon:History},
  ] as const;
  return <aside className="workspace-sidebar">
    <div className="workspace-wordmark"><span>Proto<span className="wordmark-dot">.</span></span></div>
    <WorkspaceModeSwitch mode={mode} onMode={onMode}/>
    {mode === "chat" && <nav className="chat-sidebar-nav" aria-label="Chat navigation"><button type="button" onClick={() => void chat.newChat()} title="New chat"><SquarePen size={17}/><span>New chat</span></button></nav>}
    <div className="sidebar-chapter" hidden={mode === "chat"}>{mode === "design" ? "WORKSPACE" : "BIOMNI · LOCAL ANALYSIS"}</div>
    <nav hidden={mode === "chat"} aria-label={mode === "design" ? "Design navigation" : "Compute navigation"}>
      {mode === "design" ? designNav.map(({label,view,icon:Icon}) => <button type="button" key={view} title={label} aria-label={label} aria-current={currentView === view ? "page" : undefined} onClick={() => route(view)}><Icon size={17}/><span>{label}</span></button>) : computeNav.map(({label,section:value,icon:Icon}) => <button type="button" key={value} title={label} aria-label={label} aria-current={section === value ? "page" : undefined} onClick={() => onSection(value)}><Icon size={17}/><span>{label}</span></button>)}
    </nav>
    {mode === "chat" && <ResearchConversationNavigation emptyText="An open notebook for your research ideas."/>}
    <div className="sidebar-secondary" hidden={mode === "chat"}>
      <div className="sidebar-chapter">{mode === "design" ? "RECENT RESEARCH" : "RESEARCH CONTEXT"}</div>
      {mode === "design" ? runs.slice(0,5).map(run => <button type="button" key={run.runId} className="sidebar-recent" title={run.title} aria-current={selectedRunId === run.runId && currentView === "runs" ? "page" : undefined} onClick={() => {onMode("design"); void selectRun(run.runId);}}><span>{run.title}</span><ChevronRight size={12}/></button>) : <p className="sidebar-note">From data to a result you can trace.<br/><br/>Each desktop analysis keeps its inputs, method and provenance in your workspace.</p>}
    </div>
    <div className="sidebar-utilities">
      {mode === "design" && <button type="button" onClick={() => void setShowArchived(!showArchived)} title={showArchived ? "Hide archived runs" : "Show archived runs"}><History size={16}/><span>{showArchived ? "Hide archived runs" : "Show archived runs"}</span></button>}
      <button type="button" onClick={() => window.dispatchEvent(new Event("proto:evidence"))} title="Search evidence"><Fingerprint size={16}/><span>Evidence search</span><kbd>⇧ F</kbd></button>
      <button type="button" onClick={() => route("models")} aria-current={currentView === "models" && mode === "design" ? "page" : undefined} title="Models"><Boxes size={16}/><span>Local models</span></button>
      <button type="button" onClick={() => route("settings")} aria-current={currentView === "settings" && mode === "design" ? "page" : undefined} title="Settings"><Settings size={16}/><span>Settings</span></button>
      <button type="button" onClick={() => route("help")} aria-current={currentView === "help" && mode === "design" ? "page" : undefined} title="Help"><CircleHelp size={16}/><span>Help & documentation</span></button>
      <div className="sidebar-edition">PROTO WORKBENCH <span>Local edition</span></div>
    </div>
  </aside>;
}
