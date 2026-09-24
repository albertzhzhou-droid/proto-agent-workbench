import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, BookOpen, Check, ChevronDown, Code2, Copy, FileText, Lightbulb, ListChecks, LoaderCircle, Paperclip, Plus, RefreshCw, Square, X, Wrench, Workflow } from "lucide-react";
import { diffLines } from "diff";
import { useResearchChat } from "./research-chat-store.ts";
import { useWorkbenchStore } from "./store.ts";
import type { ResearchActivity, ResearchDocument, ResearchDocumentPage } from "../shared/research-chat.ts";
import { ExecutionReconciliation } from "./ExecutionReconciliation.tsx";
import { ResearchStatePanel } from "./ResearchStatePanel.tsx";
import { ResearchClaimsPanel } from "./ResearchClaimsPanel.tsx";
import "./research-chat-paging.css";
import { researchActivityPresentation } from "./research-chat-paging.ts";

export function ChatWorkspace({hidden,edition='proto'}: {hidden:boolean;edition?:'proto'|'chem'}) {
  const chat = useResearchChat();
  const workspace = useWorkbenchStore(state => state.settings.workspacePath);
  const [documentsOpen,setDocumentsOpen] = useState(false);
  const [stateOpen,setStateOpen] = useState(false);
  const [claimsOpen,setClaimsOpen] = useState(false);
  const [modelOpen,setModelOpen] = useState(false);
  const [editing,setEditing] = useState<ResearchDocument>();
  const [notice,setNotice] = useState("");
  const [importing,setImporting] = useState(false);
  const [confirmRecovery,setConfirmRecovery] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const upload = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const modelMenu = useRef<HTMLDivElement>(null);
  const loaded = chat.models.find(model => model.id === chat.selectedModel);
  const connected = Boolean(loaded?.workbenchInstance && loaded.loadedInstances?.some(instance => instance.id === loaded.workbenchInstance?.id));
  const generating = chat.session?.status === "generating";
  const execution = chat.session?.execution;
  const executionBlocked = !!execution&&execution.status!=="none";
  useEffect(()=>setConfirmRecovery(false),[workspace,chat.session?.id,execution?.status]);

  useEffect(() => { chat.reset(); setEditing(undefined); setDocumentsOpen(false); setStateOpen(false); void useResearchChat.getState().refresh(); }, [workspace]);
  useEffect(() => {
    if (hidden) return;
    void chat.refreshModels();
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (disposed) return;
      if (document.visibilityState === "visible") await useResearchChat.getState().refresh();
      // Idle reads now reopen citation sources. Schedule after completion so
      // large sources cannot create overlapping refreshes; streaming stays responsive.
      if (!disposed) timer = setTimeout(() => void poll(), useResearchChat.getState().session?.status === "generating" ? 850 : 5000);
    };
    void poll();
    const models = setInterval(() => {if (document.visibilityState === "visible") void chat.refreshModels();}, 10_000);
    return () => {disposed=true;clearTimeout(timer);clearInterval(models);};
  }, [hidden,workspace]);
  useEffect(() => {
    if (nearBottom.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [chat.session?.messages.at(-1)?.content, chat.session?.id, generating]);
  useEffect(() => {setEditing(undefined);setNotice("");setStateOpen(false);setClaimsOpen(false);nearBottom.current=true;}, [chat.session?.id]);
  useEffect(() => {if(documentsOpen){setStateOpen(false);setClaimsOpen(false);}}, [documentsOpen]);
  useEffect(() => {
    if (!composer.current) return;
    composer.current.style.height = "auto";
    composer.current.style.height = `${Math.min(composer.current.scrollHeight,220)}px`;
  }, [chat.draft]);
  useEffect(()=>{const close=(event:PointerEvent)=>{if(modelMenu.current&&!modelMenu.current.contains(event.target as Node))setModelOpen(false);};document.addEventListener("pointerdown",close);return()=>document.removeEventListener("pointerdown",close);},[]);
  async function importText(name:string,content:string) {
    try {
      if (!useResearchChat.getState().session) await chat.newChat();
      const sessionId = useResearchChat.getState().session!.id;
      const result = await chat.request({action:"document",sessionId,name,content});
      const doc = result.session?.documents.at(-1);
      if (doc) {chat.selectDocuments([...new Set([...useResearchChat.getState().selectedDocuments,doc.id])].slice(-8));setEditing(doc);setDocumentsOpen(true);}
    } catch(error) {setNotice(error instanceof Error ? error.message : String(error));}
  }
  async function importFile(file:File) {
    setImporting(true);
    try {
      if (!/\.(pdf|docx|xlsx)$/i.test(file.name)) {
        if(file.size>128000) throw new Error("Choose a text or notebook document smaller than 128 KB.");
        await importText(file.name,await file.text());return;
      }
      if(file.size>20*1024*1024) throw new Error("PDF, DOCX and XLSX attachments can be up to 20 MiB.");
      if (!useResearchChat.getState().session) await chat.newChat();
      const sessionId=useResearchChat.getState().session!.id;
      const base64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error("The selected file could not be read."));reader.onload=()=>resolve(String(reader.result).split(",")[1]);reader.readAsDataURL(file);});
      const result=await chat.request({action:"import",sessionId,name:file.name,base64});
      const doc=result.session?.documents.at(-1);
      if(doc){chat.selectDocuments([...new Set([...useResearchChat.getState().selectedDocuments,doc.id])].slice(-8));setEditing(doc);setDocumentsOpen(true);setNotice("");}
    } catch(error) {setNotice(error instanceof Error?error.message:String(error));}
    finally {setImporting(false);}
  }
  const choosePrompt = (value:string) => {chat.setDraft(value);composer.current?.focus();};
  return <section id="chat-workspace" role="tabpanel" aria-labelledby="mode-chat" hidden={hidden} className={`chat-workspace${documentsOpen||stateOpen||claimsOpen ? " has-document-panel" : ""}`}>
    <div className="chat-main">
      <div className="chat-session-bar">
        <span className="chat-session-title">{chat.session?.title ?? "Research conversations"}</span>
        {chat.session && <button type="button" className="chat-text-button" onClick={() => {setStateOpen(!stateOpen);setDocumentsOpen(false);setClaimsOpen(false);setModelOpen(false);}} aria-expanded={stateOpen}><ListChecks size={15}/>Research state</button>}
        {chat.session && <button type="button" className="chat-text-button" onClick={() => {setClaimsOpen(!claimsOpen);setStateOpen(false);setDocumentsOpen(false);setModelOpen(false);}} aria-expanded={claimsOpen}><FileText size={15}/>Claims & sources</button>}
        {chat.session && <button type="button" className="chat-text-button" onClick={() => {setDocumentsOpen(!documentsOpen);setModelOpen(false);}} aria-expanded={documentsOpen}><BookOpen size={15}/>Documents{chat.session.documents.length > 0 && <span>{chat.session.documents.length}</span>}</button>}
      </div>
      <div className="chat-scroll" ref={scroller} onScroll={() => {const el=scroller.current;nearBottom.current=Boolean(el && el.scrollHeight-el.scrollTop-el.clientHeight<120);}}>
        {!chat.session?.messages.length ? <div className="chat-welcome">
          <span className="chat-overline">A SPACE TO THINK</span>
          <h1>{edition==='chem'?'What will you discover?':'What are you exploring?'}</h1>
          <p>{edition==='chem'?'Explore molecules, reactions and the models that explain them.':'From a question to evidence, analysis and discovery.'}<br/>Work through it with your local model.</p>
          <div className="chat-starters">
            <button type="button" onClick={() => choosePrompt(edition==='chem'?"帮我分析一个化学研究问题。先了解目标和已有数据，再用统一科学工具目录寻找可用的分子、反应或动力学算子，区分计算结果和假设。":"帮我梳理一个科研问题：先问我研究背景，再提出几个可检验的假设，并区分已有证据与推测。") }><Lightbulb size={19}/><strong>{edition==='chem'?'Explore chemistry':'Explore a question'}</strong><span>Hypotheses, evidence and next questions</span></button>
            <button type="button" onClick={() => {upload.current?.click();}}><FileText size={19}/><strong>Read & refine</strong><span>Bring a document into the conversation</span></button>
            <button type="button" onClick={() => {useResearchChat.setState({workflow:"analysis"});choosePrompt(edition==='chem'?"使用统一工具目录中的化学动力学算子，运行一个可逆反应的示例模拟，保存浓度和速率曲线，并解释参数假设、守恒检查以及3D场景的含义。":"帮我分析数据并生成一份可复现的报告。先查看工作区中可用的数据，制定分析计划，再使用实际可用的计算工具执行和检查结果。");} }><Code2 size={19}/><strong>{edition==='chem'?'Simulate & analyze':'Analyze & build'}</strong><span>{edition==='chem'?'Reactions, kinetics and reproducible results':'Data, code and reproducible results'}</span></button>
          </div>
        </div> : <div className="chat-transcript" aria-label="Conversation">
          {chat.messagePage?.nextCursor && <button type="button" className="chat-text-button chat-load-older-messages" disabled={chat.messagePageBusy} onClick={()=>void chat.loadOlderMessages()}>{chat.messagePageBusy?"Loading earlier messages…":`Load ${chat.messagePage.startIndex} earlier message${chat.messagePage.startIndex===1?"":"s"}`}</button>}
          {chat.session.messages.map(message => <article key={message.id} className={`research-message ${message.role}${message.state === "streaming" ? " is-streaming" : ""}`}>
            <div className="chat-message-label">{message.role === "user" ? "You" : edition==='chem'?'Chem':'Proto'}<span>{message.role === "assistant" ? message.state === "blocked" ? "Blocked" : message.state === "stopped" ? "Stopped" : message.state === "incomplete-evidence" ? "Incomplete evidence" : message.state === "error" ? "Response failed" : message.state === "complete" ? "Response finished" : "" : ""}</span></div>
            {message.state==="blocked"&&message.blocked&&<section className="chat-evidence" aria-label="Blocked research response"><strong>Work blocked</strong><p>{message.blocked.reason}</p><ul>{message.blocked.unmetRequirements.map((requirement,index)=><li key={index}>{requirement}</li>)}</ul></section>}
            {!!message.activity?.length && <div className="chat-tool-activity" aria-label="Research tool activity">{message.activity.map(item=>{const presentation=researchActivityPresentation(item.status,execution?.status,item.cached);return <details key={item.id} className={`chat-tool-call ${presentation.unconfirmed?"unconfirmed":item.status}`}><summary>{presentation.spinning?<LoaderCircle className="spin" size={13}/>:presentation.unconfirmed?<Wrench size={13}/>:item.status==="complete"?<Check size={13}/>:<X size={13}/>}<span>{item.tool==="science_run"?String(item.input.name):item.tool.replaceAll("_"," ")}</span><small>{item.execution?.state==="effect-unknown"?"Effect unknown":item.execution?.state.startsWith("reconciled-")?item.execution.state.replaceAll("-"," "):presentation.label}</small></summary><div>{item.execution&&<p className="chat-context-note">Operation: {item.execution.operationId} · {item.execution.state} · {item.execution.outcome??"outcome unconfirmed"}</p>}{item.execution?.state==="effect-unknown"&&<ExecutionReconciliation operationId={item.execution.operationId} onReconciled={()=>void chat.refresh()}/>} {item.interruption&&<p className="chat-context-note">{item.interruption.message}</p>}<strong>Input</strong><pre>{JSON.stringify(item.input,null,2)}</pre>{item.output&&<><strong>Result</strong><pre>{item.output}</pre></>}{item.artifactPath&&<button type="button" onClick={()=>{void chat.request({action:"read",sessionId:chat.session!.id,path:item.artifactPath!}).then(result=>{setEditing(result.session?.documents.at(-1));setDocumentsOpen(true);}).catch(error=>setNotice(String(error)));}}><FileText size={12}/>Open saved result</button>}</div></details>;})}</div>}
            {message.role === "assistant" && <ResearchEvidenceCards activity={message.activity ?? []}/>}
            {message.role === "assistant" && message.content && <p className="chat-interpretation-note">Model interpretation · Not independently checked</p>}
            {message.modelBinding&&<details className="chat-interpretation-note"><summary>Model instance · {message.modelBinding.instanceId}</summary><p>Fingerprint: {message.modelBinding.modelFingerprint??"Not available"} · Context: {message.modelBinding.contextLength}</p>{message.policyGrant&&<p>Send authorization: {message.policyGrant.risks.join(", ")||"Local fixed tools only"}</p>}</details>}
            <ChatMarkdown content={message.content} onDocument={(language,content) => void importText(`draft.${language === "python" ? "py" : language === "javascript" ? "js" : language === "typescript" ? "ts" : language === "r" ? "r" : language === "json" ? "json" : "md"}`,content)}/>
            {!message.content && message.state === "streaming" && <div className="chat-thinking">{execution?.status==="owned"||execution?.status==="live-elsewhere"?<><LoaderCircle className="spin" size={15}/>Thinking…</>:<>Unfinished response recorded</>}</div>}
            {message.documents?.length ? <div className="chat-message-documents">{message.documents.map(doc => <span key={doc.id}><FileText size={12}/>{doc.name} · r{doc.revision}</span>)}</div> : null}
            {message.role === "assistant" && message.content && message.state !== "streaming" && <CopyButton content={message.content}/>}
          </article>)}
        </div>}
      </div>
      <div className="chat-compose-area">
        {chat.recoveryIssueCount>0&&<details className="chat-recovery-notice"><summary>{chat.recoveryIssueCount} conversation recovery notice{chat.recoveryIssueCount===1?"":"s"}</summary><p>Original records are retained. Review these notices before continuing affected conversations.{chat.recoveryIssueCount>chat.recoveryIssues.length&&` Showing ${chat.recoveryIssues.length} of ${chat.recoveryIssueCount} notices.`}</p>{chat.recoveryIssues.map(issue=><p key={`${issue.sessionId}:${issue.code}`}><strong>{issue.sessionId}</strong> · {issue.message}</p>)}</details>}
        {execution&&execution.status!=="none"&&execution.status!=="owned"&&<div className="chat-execution-notice" role="status"><p>{execution.reason}</p>{execution.canRecover&&<><p>Mark the unfinished response interrupted and preserve its saved outputs. This does not replay tools or resume generation.</p>{execution.status==="owner-unknown"&&<label><input type="checkbox" checked={confirmRecovery} onChange={event=>setConfirmRecovery(event.target.checked)}/>I confirm no other app or preview is still running this conversation.</label>}<button type="button" className="chat-text-button" disabled={chat.busy||execution.status==="owner-unknown"&&!confirmRecovery} onClick={()=>void chat.recover(execution.status==="owner-unknown"?true:undefined)}>Mark interrupted · preserve outputs</button></>}</div>}
        {!!chat.session?.plan?.length && <details className="chat-research-plan"><summary><Workflow size={14}/><span>Research plan</span><small>{chat.session.plan.filter(item=>item.status==="completed").length} / {chat.session.plan.length}</small></summary><ol>{chat.session.plan.map((item,index)=><li key={index}><span>{item.status==="completed"?<Check size={12}/>:item.status==="in_progress"?<LoaderCircle size={12}/>:index+1}</span><div>{item.content}<small>{item.status.replaceAll("_"," ")}</small></div></li>)}</ol></details>}
        {(chat.error || chat.session?.error || notice) && <div className="chat-inline-error" role="alert">{notice || chat.error || chat.session?.error}<button type="button" aria-label="Dismiss message" onClick={() => {setNotice("");useResearchChat.setState({error:undefined,session:chat.session ? {...chat.session,error:undefined}:undefined});}}><X size={13}/></button></div>}
        {chat.session?.context && chat.session.context.omittedMessages > 0 && <p className="chat-context-note">{chat.session.context.omittedMessages} earlier messages are outside the model context. The full conversation is still saved.</p>}
        <form className="chat-composer" onSubmit={event => {event.preventDefault();nearBottom.current=true;void chat.send();}}>
          {!!chat.selectedDocuments.length && <div className="chat-attached">{chat.session?.documents.filter(doc => chat.selectedDocuments.includes(doc.id)).map(doc => <span key={doc.id}><FileText size={13}/>{doc.name}<button type="button" aria-label={`Detach ${doc.name}`} onClick={() => chat.selectDocuments(chat.selectedDocuments.filter(id => id !== doc.id))}><X size={12}/></button></span>)}</div>}
          <textarea ref={composer} aria-label="Message local model" placeholder="Ask, explore, or work through an idea…" value={chat.draft} onChange={event => chat.setDraft(event.target.value)} maxLength={32000} rows={2} onKeyDown={event => {if(event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {event.preventDefault();if(connected && !generating && !executionBlocked && !chat.busy) {nearBottom.current=true;void chat.send();}}}}/>
          <div className="chat-composer-toolbar">
            <button type="button" className="chat-icon-button" disabled={importing} title="Attach PDF, DOCX, XLSX, text or code" aria-label="Attach a document" onClick={() => upload.current?.click()}>{importing?<LoaderCircle className="spin" size={19}/>:<Plus size={19}/>}</button>
            <div className="chat-model-picker" ref={modelMenu}>
              <button type="button" className="chat-model-trigger" aria-expanded={modelOpen} aria-controls="chat-model-menu" onClick={() => setModelOpen(!modelOpen)}><span>{loaded?.name ?? "Choose local model"}</span><ChevronDown size={13}/></button>
              {modelOpen && <div className="chat-model-menu" id="chat-model-menu" onKeyDown={event => {if(event.key === "Escape") setModelOpen(false);}}>
                <div className="chat-menu-heading"><strong>LM Studio</strong><button type="button" aria-label="Refresh Chat models" onClick={() => void chat.refreshModels()}><RefreshCw size={14}/></button><button type="button" aria-label="Close model menu" onClick={() => setModelOpen(false)}><X size={14}/></button></div>
                <p>Models reported by your local server.</p>
                {chat.modelError && <p role="alert">{chat.modelError}</p>}
                {!chat.models.length && <p>No models are currently available.</p>}
                <div className="chat-model-options">{chat.models.map(model => <button type="button" key={model.id} onClick={() => chat.setModel(model.id)} aria-pressed={chat.selectedModel === model.id}><span>{model.name}<small>{model.loadedInstances?.length ? `${model.loadedInstances.length} loaded instance(s)` : "Not loaded"}</small></span>{chat.selectedModel === model.id && <Check size={14}/>}</button>)}</div>
                {loaded && <div className="chat-model-action">{connected ? <span>Connected · {loaded.workbenchInstance?.contextLength?.toLocaleString()} context</span> : loaded.loadedInstances?.length ? loaded.loadedInstances.map(instance => <button type="button" key={instance.id} disabled={chat.busy} onClick={() => void chat.connect(instance.id)}>Connect {instance.id}</button>) : <button type="button" disabled={chat.busy} onClick={() => void chat.connect()}>{chat.busy ? "Loading…" : "Load & connect"}</button>}</div>}
              </div>}
            </div>
            <span className="chat-local-status">{connected ? "Local" : "Not connected"}</span>
            {generating ? <button type="button" className="chat-submit" aria-label="Stop response" disabled={!execution?.canCancel||chat.busy} title={execution?.canCancel?"Stop this app’s response":execution?.reason??"Execution ownership is not available."} onClick={() => void chat.cancel()}><Square size={15}/></button> : <button type="submit" className="chat-submit" aria-label="Send message" disabled={!chat.draft.trim() || !connected || chat.busy || executionBlocked}>{chat.busy ? <LoaderCircle className="spin" size={16}/> : <ArrowUp size={18}/>}</button>}
          </div>
        </form>
        <div className="chat-workflow-controls"><label><Workflow size={12}/><select aria-label="Research workflow" value={chat.workflow} onChange={event=>useResearchChat.setState({workflow:event.target.value as typeof chat.workflow})}><option value="explore">Explore</option><option value="literature">Literature review</option><option value="analysis">Data & computation</option><option value="reproduce">Reproduce a result</option></select></label><label title="Unified OpenScience research, Biomni computation, Chem operators and DSH context workflow"><input type="checkbox" checked={chat.toolsEnabled} onChange={event=>useResearchChat.setState({toolsEnabled:event.target.checked})}/><Wrench size={12}/>Research tools</label><label><input type="checkbox" checked={chat.networkEnabled} disabled={!chat.toolsEnabled} onChange={event=>useResearchChat.setState({networkEnabled:event.target.checked})}/>Network</label><label><input type="checkbox" checked={chat.codeExecutionEnabled} disabled={!chat.toolsEnabled} onChange={event=>useResearchChat.setState({codeExecutionEnabled:event.target.checked})}/>Code execution</label></div>
        <div className="chat-footnote"><span>{chat.toolsEnabled&&chat.networkEnabled?"Local model · Tools may query scientific databases":"Local model · Network tools disabled"}</span>{chat.session?.context && <span title={chat.session.context.method}>{chat.session.context.inputTokens.toLocaleString()} / {chat.session.context.contextLength.toLocaleString()} context{chat.session.context.omittedMessages?` · ${chat.session.context.omittedMessages} earlier messages omitted` : ""}</span>}</div>
        {chat.session?.context?.retention?.omittedRanges.length ? <details className="chat-context-retention"><summary>Context omissions & source hashes</summary><p>Source transcript SHA-256: <code>{chat.session.context.retention.sourceTranscriptSha256}</code></p>{chat.session.context.retention.omittedRanges.map(range=><p key={`${range.startMessageId}:${range.endMessageId}`}>Messages {range.startIndex}–{range.endIndex} · {range.messageCount} omitted · SHA-256 <code>{range.sha256}</code> · {range.receiptMessageIds.length} source message(s) hold saved receipt paths</p>)}</details> : null}
        {importing&&<p className="chat-context-note" role="status">Reading document and preserving its source…</p>}
        <input ref={upload} type="file" hidden accept=".pdf,.docx,.xlsx,.txt,.md,.csv,.json,.ipynb,.py,.r,.R,.ts,.tsx,.js,.mjs,.css,.html,.yaml,.yml,.tex" onChange={event => {const file=event.target.files?.[0];if(file)void importFile(file);event.target.value="";}}/>
      </div>
    </div>
    {documentsOpen && <DocumentPanel editing={editing} onEdit={setEditing} onClose={() => setDocumentsOpen(false)} onImport={() => upload.current?.click()} onNotice={setNotice}/>}
    {stateOpen && chat.session && <ResearchStatePanel key={chat.session.id} session={chat.session} transcriptIncomplete={Boolean(chat.messagePage?.nextCursor)} onClose={() => setStateOpen(false)} onSave={async(state,expectedRevision)=>(await chat.request({action:"research_state",sessionId:chat.session!.id,state,expectedRevision})).session}/>}
    {claimsOpen && chat.session && <ResearchClaimsPanel key={`${workspace}:${chat.session.id}`} workspace={workspace} session={chat.session} request={chat.request} onClose={()=>setClaimsOpen(false)} onDocuments={()=>{setClaimsOpen(false);setDocumentsOpen(true);}}/>}
  </section>;
}

export function ResearchEvidenceCards({activity}:{activity:ResearchActivity[]}) {
  return <>{activity.filter(item => item.evidence && !item.evidence.diagnostics.includes("OPERATOR_NOT_PROJECTED") && item.status !== "running").map(item => {
    const evidence = item.evidence!;
    return <section className="chat-evidence" key={item.id} aria-label="Saved tool receipt evidence">
      <div className="chat-evidence-heading"><FileText size={14}/><strong>{evidence.status === "bound-facts" ? "Receipt-bound facts" : evidence.status === "unlocatable" ? "Saved values without a scientific quantity binding" : "Receipt facts unavailable"}</strong></div>
      {evidence.status === "bound-facts" ? <>
        <p>These fields match the saved tool receipt. They do not verify the model interpretation or the scientific method.</p>
        <div className="chat-evidence-table"><table><caption>{evidence.facts[0]?.operator.replaceAll("_", " ")}</caption><thead><tr><th scope="col">Subject</th><th scope="col">Quantity</th><th scope="col">Value</th><th scope="col">Unit</th></tr></thead><tbody>{evidence.facts.map(fact => <tr key={fact.id}><th scope="row"><code>{fact.subjectId}</code><small>{Object.entries(fact.context).map(([key,value]) => `${key.replaceAll("_", " ")}: ${value}`).join(" · ")}</small></th><td>{fact.quantity}</td><td><code>{fact.value}</code></td><td>{fact.unit}</td></tr>)}</tbody></table></div>
      </> : evidence.status === "unlocatable" ? <><p>The receipt retains these values. Missing identity or unit metadata, missing values, and numeric representation limits prevent a scientific fact claim.</p><div className="chat-evidence-table"><table><thead><tr><th scope="col">Saved value</th><th scope="col">Source</th><th scope="col">Limitation</th></tr></thead><tbody>{evidence.unlocatableValues?.map((value,index)=><tr key={index}><td><code>{value.valueText??"Missing"}</code></td><td><code>{value.resultPath}#{value.resultPointer}</code></td><td>{value.reason.replaceAll("_"," ").toLowerCase()}{value.missingReason&&<small>{value.missingReason}</small>}</td></tr>)}</tbody></table></div></> : <p>{evidence.status === "mismatch" ? "The saved receipt could not be matched to its recorded digest and contract. No facts are bound." : "This receipt has not been checked for a supported fact projection."}</p>}
      <details><summary>Receipt source and checks</summary><dl><dt>Saved receipt</dt><dd>{item.artifactPath ?? "No saved receipt"}</dd><dt>Recorded SHA256</dt><dd>{item.artifactSha256 ?? "Not recorded in this conversation"}</dd><dt>Scope</dt><dd>Saved tool receipt fields only · Model interpretation remains unreviewed</dd></dl>
        {!!evidence.diagnostics.length && <p>{evidence.diagnostics.join(" · ")}</p>}
        {evidence.facts.map(fact => <div className="chat-evidence-locator" key={fact.id}><code>{fact.subjectId}</code><span>Identity: {fact.identityPointer}</span><span>Value: {fact.valuePointer}</span><span>Unit: {fact.unitSource}</span></div>)}
      </details>
    </section>;
  })}</>;
}

function CopyButton({content}:{content:string}) {
  const [copied,setCopied]=useState(false);
  return <button type="button" className="chat-copy" onClick={() => {void navigator.clipboard.writeText(content).then(() => {setCopied(true);setTimeout(() => setCopied(false),1800);}).catch(() => setCopied(false));}} aria-label="Copy response">{copied ? <Check size={13}/> : <Copy size={13}/>}<span>{copied ? "Copied" : "Copy"}</span></button>;
}

function inline(text:string):ReactNode {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https:\/\/[^\s)]+\)|https:\/\/[^\s<>\u3000-\u303f\uff00-\uffef]+)/g).map((part,index) => {
    if(part.startsWith("`")) return <code key={index}>{part.slice(1,-1)}</code>;
    if(part.startsWith("**")) return <strong key={index}>{part.slice(2,-2)}</strong>;
    const link=part.match(/^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/);
    const href=link?.[2]??(part.startsWith("https://")?part.replace(/[.,;:)]+$/,""):undefined);
    if(href) {
      try {const url=new URL(href);if(url.username||url.password||url.protocol!=="https:")return part;}catch{return part;}
      return <a key={index} href={href} target="_blank" rel="noopener noreferrer" onClick={event=>{if(window.workbench){event.preventDefault();void window.workbench.chat.request({action:"open_link",url:href}).catch(()=>navigator.clipboard.writeText(href));}}}>{link?.[1]??href}</a>;
    }
    return part;
  });
}
function ChatMarkdown({content,onDocument}:{content:string;onDocument(language:string,content:string):void}) {
  const blocks = content.split(/(```[\s\S]*?(?:```|$))/g);
  return <div className="chat-markdown">{blocks.map((block,index) => {
    if(block.startsWith("```")) {
      const newline=block.indexOf("\n"); const language=block.slice(3,newline<0?undefined:newline).trim(); const code=newline<0?"":block.slice(newline+1).replace(/```$/,"").trimEnd();
      return <div className="chat-code" key={index}><div><span>{language || "text"}</span><button type="button" onClick={() => onDocument(language,code)}><FileText size={12}/>Open as document</button><CopyButton content={code}/></div><pre><code>{code}</code></pre></div>;
    }
    return block.split(/\n\s*\n/).filter(Boolean).map((paragraph,line) => {
      const rows=paragraph.trim().split("\n");
      const cells=(row:string)=>row.trim().replace(/^\|/,"").replace(/\|$/,"").split(/(?<!\\)\|/).map(cell=>cell.trim().replaceAll("\\|","|"));
      if(rows.length>1&&rows[0].includes("|")&&cells(rows[1]).every(cell=>/^:?-{3,}:?$/.test(cell))) {
        const headings=cells(rows[0]);
        return <div className="chat-table-scroll" key={`${index}-${line}`}><table><thead><tr>{headings.map((cell,i)=><th key={i}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.slice(2).map((row,i)=><tr key={i}>{cells(row).map((cell,j)=><td key={j}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>;
      }
      if (/^#{1,4} /.test(paragraph)) return <h3 key={`${index}-${line}`}>{inline(paragraph.replace(/^#{1,4} /,""))}</h3>;
      if (paragraph.split("\n").every(item => /^\s*(?:[-*]|\d+\.) /.test(item))) return <ul key={`${index}-${line}`}>{paragraph.split("\n").map((item,i) => <li key={i}>{inline(item.replace(/^\s*(?:[-*]|\d+\.) /,""))}</li>)}</ul>;
      return <p key={`${index}-${line}`}>{inline(paragraph)}</p>;
    });
  })}</div>;
}

function DocumentPanel({editing,onEdit,onClose,onImport,onNotice}:{editing?:ResearchDocument;onEdit(doc:ResearchDocument|undefined):void;onClose():void;onImport():void;onNotice(value:string):void}) {
  const chat=useResearchChat();
  const [draft,setDraft]=useState(""); const [review,setReview]=useState(false); const [path,setPath]=useState(""); const [working,setWorking]=useState(false);
  useEffect(() => {setDraft(editing?.content ?? "");setReview(false);},[editing?.id,editing?.revision]);
  async function save() {
    if(!editing || !chat.session) return;setWorking(true);
    try {const result=await chat.request({action:"document",sessionId:chat.session.id,documentId:editing.id,expectedRevision:editing.revision,name:editing.name,content:draft});onEdit(result.session?.documents.find(doc=>doc.id===editing.id));setReview(false);}
    catch(error) {onNotice(String(error));}finally{setWorking(false);}
  }
  async function read() {
    setWorking(true);
    try {if(!useResearchChat.getState().session) await chat.newChat();const result=await chat.request({action:"read",sessionId:useResearchChat.getState().session!.id,path});onEdit(result.session?.documents.at(-1));setPath("");}
    catch(error) {onNotice(String(error));}finally{setWorking(false);}
  }
  return <aside className="chat-documents" aria-label="Conversation documents">
    <header><BookOpen size={16}/><strong>Documents</strong><button type="button" aria-label="Close documents" onClick={onClose}><X size={16}/></button></header>
    <div className="chat-document-list">{chat.session?.documents.map(doc=><div key={doc.id} className={editing?.id===doc.id?"is-selected":""}><input type="checkbox" aria-label={`Include ${doc.name} in next message`} checked={chat.selectedDocuments.includes(doc.id)} onChange={event=>chat.selectDocuments(event.target.checked?[...chat.selectedDocuments,doc.id].slice(-8):chat.selectedDocuments.filter(id=>id!==doc.id))}/><button type="button" onClick={()=>onEdit(doc)}><FileText size={14}/><span>{doc.name}</span><small>r{doc.revision}</small></button></div>)}</div>
    <div className="chat-document-import"><button type="button" onClick={onImport}><Paperclip size={13}/>Attach document</button><button type="button" onClick={()=>{onEdit({id:"",name:"notes.md",content:"",revision:0});}}>New document</button></div>
    <form className="chat-document-path" onSubmit={event=>{event.preventDefault();void read();}}><input aria-label="Workspace document path" value={path} onChange={event=>setPath(event.target.value)} placeholder="Workspace path, e.g. papers/study.pdf"/><button type="submit" disabled={!path.trim()||working}>{working?"Reading…":"Read"}</button></form>
    {editing?.extraction ? <ParsedDocumentView key={editing.id} document={editing} onNotice={onNotice} onDraft={content=>onEdit({id:"",name:editing.name.replace(/\.[^.]+$/,"")+"-notes.md",content,revision:0})}/> : editing ? <div className="chat-document-editor">
      <div className="chat-document-heading"><input aria-label="Document name" value={editing.name} onChange={event=>onEdit({...editing,name:event.target.value})}/><span>r{editing.revision}</span></div>
      {review ? <div className="chat-document-diff" aria-label="Document changes">{diffLines(editing.content,draft).map((part,index)=><pre key={index} className={part.added?"added":part.removed?"removed":""}>{part.added?"+ ":part.removed?"− ":"  "}{part.value}</pre>)}</div> : <textarea aria-label="Document text" value={draft} onChange={event=>setDraft(event.target.value)} spellCheck={false}/>}
      <div className="chat-document-actions">{review ? <><button type="button" onClick={()=>setReview(false)}>Keep editing</button><button type="button" disabled={working} onClick={()=>{if(editing.id) void save();else {setWorking(true);void (async()=>{if(!useResearchChat.getState().session)await chat.newChat();const result=await chat.request({action:"document",sessionId:useResearchChat.getState().session!.id,name:editing.name,content:draft});onEdit(result.session?.documents.at(-1));})().catch(error=>onNotice(String(error))).finally(()=>setWorking(false));}}}>Save revision</button></> : <><button type="button" disabled={draft===editing.content&&!!editing.id} onClick={()=>setReview(true)}>Review changes</button><button type="button" disabled={!editing.id||draft!==editing.content||working} onClick={()=>{setWorking(true);void chat.request({action:"export",sessionId:chat.session!.id,documentId:editing.id,expectedRevision:editing.revision}).then(result=>onNotice(`Exported: ${result.exportPath}`)).catch(error=>onNotice(String(error))).finally(()=>setWorking(false));}}>Export</button></>}</div>
      <p>Saved revisions stay in this conversation. Exports go to build/chat in your workspace. Select a document to include it in your next message.</p>
    </div> : <div className="chat-document-empty"><FileText size={28}/><h2>A place for sources & drafts</h2><p>Read PDF papers, Word documents and spreadsheets with source locations, or revise text and code.</p></div>}
  </aside>;
}

function ParsedDocumentView({document,onNotice,onDraft}:{document:ResearchDocument;onNotice(value:string):void;onDraft(content:string):void}) {
  const chat=useResearchChat();
  const [page,setPage]=useState<ResearchDocumentPage>();const [working,setWorking]=useState(false);const [offset,setOffset]=useState(0);const [history,setHistory]=useState<number[]>([]);
  const extraction=document.extraction!;
  useEffect(()=>{
    let cancelled=false;setWorking(true);
    void chat.request({action:"document_read",sessionId:chat.session!.id,documentId:document.id,startUnit:offset,limit:5}).then(result=>{if(!cancelled)setPage(result.documentPage);}).catch(error=>{if(!cancelled)onNotice(String(error));}).finally(()=>{if(!cancelled)setWorking(false);});
    return()=>{cancelled=true;};
  },[document.id,offset]);
  return <div className="chat-parsed-document">
    <div className="chat-parsed-heading"><strong>{document.name}</strong><span>{extraction.format.toUpperCase()} · {(extraction.sourceBytes/1024).toFixed(1)} KB · {extraction.unitCount} sections</span></div>
    <details className="chat-document-provenance"><summary>Source & extraction</summary><dl><dt>Source SHA-256</dt><dd>{document.sourceSha256}</dd><dt>Preserved original</dt><dd>{extraction.sourcePath}</dd><dt>Full text</dt><dd>{extraction.textPath}</dd><dt>Structured extraction</dt><dd>{extraction.extractionPath}</dd></dl><p>The conversation receives an indexed excerpt. Research tools can read every extracted section. Source files remain unchanged.</p></details>
    {!!extraction.warnings.length&&<details className="chat-document-warnings"><summary>Reading notes ({extraction.warnings.length})</summary>{extraction.warnings.map((warning,index)=><p key={index}>{warning}</p>)}</details>}
    <div className="chat-document-pagination"><button type="button" disabled={working||!history.length} onClick={()=>{setOffset(history.at(-1)!);setHistory(history.slice(0,-1));}}>Previous</button><span>{working?"Reading…":page?.units.length?`${page.startUnit+1}–${page.startUnit+page.units.length} / ${page.totalUnits}`:"No text"}</span><button type="button" disabled={working||page?.nextUnit==null} onClick={()=>{setHistory([...history,offset]);setOffset(page!.nextUnit!);}}>Next</button></div>
    <div className="chat-extracted-sections" aria-label="Parsed document contents" aria-busy={working}>{page?.units.map(unit=><section key={unit.index}><h3>{unit.locator}</h3>{unit.cells?.length?<div className="chat-table-scroll"><table><thead><tr><th>Cell</th><th>Value</th><th>Formula</th></tr></thead><tbody>{unit.cells.map(cell=><tr key={cell.address}><td>{cell.address}</td><td>{cell.value}</td><td>{cell.formula??""}</td></tr>)}</tbody></table></div>:<pre>{unit.text||"No selectable text in this section."}</pre>}</section>)}</div>
    <div className="chat-document-actions"><button type="button" disabled={!page?.units.length} onClick={()=>onDraft(page!.units.map(unit=>`[${unit.locator}]\n${unit.text}`).join("\n\n"))}>Create draft from this page</button><button type="button" onClick={()=>onNotice(`Complete extracted text: ${extraction.textPath}`)}>Full text path</button></div>
  </div>;
}
