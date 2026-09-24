import { useEffect, useState } from "react";
import { Plus, Save, X } from "lucide-react";
import type { ResearchChatSession, ResearchMessage } from "../shared/research-chat.ts";
import { emptyResearchState, RESEARCH_SESSION_SCHEMA, type ResearchState, type SourcedResearchText } from "../shared/research-session-state.ts";
import "./research-state.css";

export function ResearchStatePanel({session,onSave,onClose,transcriptIncomplete=false}: {
  session:ResearchChatSession;
  transcriptIncomplete?:boolean;
  onSave(state:ResearchState,expectedRevision:number):Promise<ResearchChatSession|undefined>;
  onClose():void;
}) {
  const [saved,setSaved]=useState(()=>structuredClone(session.researchState??emptyResearchState()));
  const [draft,setDraft]=useState(()=>structuredClone(saved));
  const [revision,setRevision]=useState(session.revision??0);
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const dirty=JSON.stringify(saved)!==JSON.stringify(draft);
  const supported=session.payloadSchema===RESEARCH_SESSION_SCHEMA&&Number.isSafeInteger(session.revision)&&session.revision!>0;
  useEffect(()=>{if(!dirty&&(session.revision??0)>=revision){const state=structuredClone(session.researchState??emptyResearchState());setSaved(state);setDraft(structuredClone(state));setRevision(session.revision??0);}},[session.revision,dirty,revision]);
  const users=session.messages.filter(message=>message.role==="user"&&message.content.trim());
  const messages=session.messages.filter(message=>message.content.trim()&&message.state!=="streaming");
  const from=(source:ResearchMessage):SourcedResearchText=>({text:source.content.slice(0,2000),sourceMessageId:source.id,sourceRole:source.role});
  const reset=()=>{const state=structuredClone(session.researchState??emptyResearchState());setSaved(state);setDraft(structuredClone(state));setRevision(session.revision??0);setError("");};
  const save=async()=>{
    setBusy(true);setError("");
    try {
      const next=await onSave(draft,revision);
      if(!next?.researchState||next.id!==session.id||!next.revision||next.revision<=revision)throw new Error("The runtime did not return a newer saved state for this conversation.");
      const state=structuredClone(next.researchState);setSaved(state);setDraft(structuredClone(state));setRevision(next.revision);
    } catch(value){setError(value instanceof Error?value.message:String(value));}
    finally{setBusy(false);}
  };
  const locked=busy||session.status==="generating"||!supported;
  return <aside className="chat-document-panel research-state-panel" aria-label="Research state editor">
    <header><h2>Research state</h2><button type="button" className="chat-icon-button" aria-label="Close research state" onClick={onClose}><X size={16}/></button></header>
    <div className="research-state-content">
      <p>Keep source quotations available when older turns leave the model context. Only your messages can become confirmed constraints.</p>
      {!supported&&<p role="status">This runtime does not expose persistent research state.</p>}
      {transcriptIncomplete&&<p role="status">Earlier transcript pages are not loaded. Close this panel and load earlier messages to inspect or select older sources.</p>}
      {!messages.length&&<p role="status">Send a message first, then select quotations from this conversation.</p>}
      {session.status==="generating"&&<p role="status">Finish or stop the current response before editing saved state.</p>}
      {dirty&&revision!==session.revision&&<p role="status">The saved conversation changed. Reload saved state before applying this draft.</p>}
      <fieldset disabled={locked}>
        <legend>Research question</legend>
        <StateQuote label="Question" value={draft.question} messages={messages} onChange={question=>setDraft({...draft,question})}/>
      </fieldset>
      <fieldset disabled={locked}>
        <legend>Confirmed constraints <small>{draft.confirmedConstraints.length}/24</small></legend>
        {draft.confirmedConstraints.map((entry,index)=><div className="research-state-item" key={entry.id}><StateQuote label={`Constraint ${index+1}`} value={entry} messages={users} onChange={value=>setDraft({...draft,confirmedConstraints:value?draft.confirmedConstraints.map(item=>item.id===entry.id?{...value,id:entry.id,sourceRole:"user"}:item):draft.confirmedConstraints.filter(item=>item.id!==entry.id)})}/></div>)}
        <button type="button" className="chat-text-button" disabled={!users.length||draft.confirmedConstraints.length>=24} onClick={()=>setDraft({...draft,confirmedConstraints:[...draft.confirmedConstraints,{...from(users.at(-1)!),id:crypto.randomUUID(),sourceRole:"user"}]})}><Plus size={13}/>Add user quotation</button>
      </fieldset>
      <fieldset disabled={locked}>
        <legend>Open questions <small>{draft.openQuestions.length}/12</small></legend>
        {draft.openQuestions.map((entry,index)=><div className="research-state-item" key={index}><StateQuote label={`Open question ${index+1}`} value={entry} messages={messages} onChange={value=>setDraft({...draft,openQuestions:value?draft.openQuestions.map((item,i)=>i===index?value:item):draft.openQuestions.filter((_,i)=>i!==index)})}/></div>)}
        <button type="button" className="chat-text-button" disabled={!messages.length||draft.openQuestions.length>=12} onClick={()=>setDraft({...draft,openQuestions:[...draft.openQuestions,from(messages.at(-1)!)]})}><Plus size={13}/>Add question quotation</button>
      </fieldset>
      <fieldset disabled={locked}><legend>Next step</legend><StateQuote label="Next step" value={draft.nextStep} messages={messages} onChange={nextStep=>setDraft({...draft,nextStep})}/></fieldset>
      <p>Assistant quotations remain proposals. Editing a quotation must preserve an exact excerpt from its source message. Documents cannot confirm constraints.</p>
      {error&&<p className="chat-inline-error" role="alert">{error}</p>}
    </div>
    <footer><span>Saved revision {revision||"unavailable"}{dirty?" · Unsaved draft":""}</span><div><button type="button" className="chat-text-button" disabled={busy} onClick={reset}>Reload saved state</button><button type="button" className="primary-button" disabled={locked||!dirty||revision!==session.revision} onClick={()=>void save()}><Save size={14}/>{busy?"Saving…":"Save state"}</button></div></footer>
  </aside>;
}

function StateQuote({label,value,messages,onChange}: {label:string;value:SourcedResearchText|null;messages:ResearchMessage[];onChange(value:SourcedResearchText|null):void}) {
  const source=messages.find(message=>message.id===value?.sourceMessageId);
  return <div className="research-state-quote"><label>{label} source<select aria-label={`${label} source`} value={value?.sourceMessageId??""} onChange={event=>{
    const selected=messages.find(message=>message.id===event.target.value);
    onChange(selected?{text:selected.content.slice(0,2000),sourceMessageId:selected.id,sourceRole:selected.role}:null);
  }}><option value="">Not set</option>{messages.map(message=><option key={message.id} value={message.id}>{message.role==="user"?"You":"Assistant proposal"} · {message.content.replace(/\s+/g," ").slice(0,70)}</option>)}</select></label>
    {value&&<><label>{label} quotation<textarea aria-label={`${label} quotation`} value={value.text} maxLength={2000} rows={3} onChange={event=>onChange({...value,text:event.target.value})}/></label><small>{source?.role==="user"?"User message":"Assistant proposal"} · {source?.createdAt?new Date(source.createdAt).toLocaleString():"Source unavailable"}</small>{source&&<details><summary>View source message</summary><pre>{source.content}</pre></details>}{(!source||!source.content.includes(value.text)||!value.text.trim())&&<p className="analysis-error">Choose an exact, nonempty quotation from the selected message.</p>}</>}
  </div>;
}
