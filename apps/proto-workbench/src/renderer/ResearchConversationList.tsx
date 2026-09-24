import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, MessageCircle, RefreshCw, X } from "lucide-react";
import { useResearchChat } from "./research-chat-store.ts";
import { SESSION_WINDOW_LIMIT } from "./research-chat-paging.ts";
import { useWorkbenchStore } from "./store.ts";
import "./research-chat-paging.css";

/** Compact navigation opens on demand; desktop keeps the original inline list. */
export function ResearchConversationNavigation({emptyText}:{emptyText:string}) {
  const [open,setOpen]=useState(false);
  const workspace=useWorkbenchStore(state=>state.settings.workspacePath);
  const dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const id=useId();
  useEffect(()=>setOpen(false),[workspace]);
  useEffect(()=>{
    const element=dialog.current;
    if(open&&element&&!element.open)element.showModal();
    return()=>{if(element?.open)element.close();};
  },[open]);
  const close=()=>{setOpen(false);trigger.current?.focus();};
  return <>
    <ResearchConversationList emptyText={emptyText}/>
    <button ref={trigger} type="button" className="research-conversations-open" aria-label="Open conversations" title="Open conversations" aria-haspopup="dialog" aria-expanded={open} aria-controls={open?id:undefined} onClick={()=>setOpen(true)}><MessageCircle size={18}/></button>
    {open&&createPortal(<dialog ref={dialog} id={id} className="research-conversation-dialog" aria-label="Conversations" onCancel={close} onClick={event=>{if(event.target===event.currentTarget)close();}}>
      <div className="research-conversation-dialog-content"><header><h2>Conversations</h2><button type="button" className="chat-icon-button" aria-label="Close conversations" onClick={close}><X size={17}/></button></header><ResearchConversationList emptyText={emptyText} onSelect={close}/></div>
    </dialog>,document.body)}
  </>;
}

export function ResearchConversationList({emptyText,onSelect}:{emptyText:string;onSelect?():void}) {
  const chat=useResearchChat();
  const selected=chat.session;
  const selectedOutside=selected&&!chat.sessions.some(item=>item.id===selected.id);
  return <div className="sidebar-secondary research-conversation-list" aria-label="Saved conversations">
    <div className="sidebar-chapter">CONVERSATIONS</div>
    {selectedOutside&&<div className="research-list-current"><small>OPEN CONVERSATION · OUTSIDE THIS LIST PAGE</small><div className="sidebar-recent" aria-current="page"><MessageCircle size={13}/><span>{selected.title}</span>{selected.status==="generating"&&<span aria-label="Unfinished response recorded">…</span>}</div></div>}
    {chat.sessions.map(summary=>{const item=summary.id===selected?.id?selected:summary;return <button type="button" key={item.id} className="sidebar-recent" title={item.title} aria-current={selected?.id===item.id?"page":undefined} onClick={()=>{void chat.select(item.id);onSelect?.();}}><MessageCircle size={13}/><span>{item.title}</span>{item.status==="generating"&&<span className="chat-sidebar-running" aria-label="Unfinished response recorded">…</span>}</button>;})}
    {!chat.sessions.length&&!chat.listBusy&&<p className="sidebar-note">{chat.listIndexingPending?"Saved conversations are still being indexed.":emptyText}</p>}
    <div className="research-list-paging">
      {chat.listIndexingPending>0&&<p role="status">Indexing {chat.listIndexingPending} saved conversation{chat.listIndexingPending===1?"":"s"}. Unindexed records have not been checked yet.</p>}
      {chat.listChanged&&<p role="status">The conversation list changed. Refresh to show the latest list; your loaded pages stay here until then.</p>}
      {chat.listWindowOffset>0&&<p>Older group · after {chat.listWindowOffset} conversations.</p>}
      {chat.listError&&<p role="alert">{chat.listError}</p>}
      {chat.listNextCursor&&!chat.listChanged&&chat.sessions.length<SESSION_WINDOW_LIMIT&&<button type="button" className="chat-text-button" disabled={chat.listBusy} onClick={()=>void chat.loadOlderSessions()}><ChevronDown size={13}/>Load older conversations</button>}
      {chat.listNextCursor&&!chat.listChanged&&chat.sessions.length>=SESSION_WINDOW_LIMIT&&<><p>{SESSION_WINDOW_LIMIT} conversations are loaded. The next older group replaces this list window; your open conversation stays open.</p><button type="button" className="chat-text-button" disabled={chat.listBusy} onClick={()=>void chat.nextSessionWindow()}><ChevronDown size={13}/>Show next older group</button></>}
      <button type="button" className="chat-text-button" disabled={chat.listBusy} onClick={()=>void chat.reloadSessions()}><RefreshCw size={12}/>{chat.listWindowOffset?"Back to newest conversations":"Refresh conversation list"}</button>
      {chat.listBusy&&<p role="status">Loading conversation list…</p>}
    </div>
  </div>;
}
